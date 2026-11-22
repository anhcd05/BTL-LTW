import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { type TrainedModel, trainFromSnapshot } from './dataset';
import { type Embedder, hashEmbedder, passageText } from './embedder';
import { loadE5 } from './e5';
import { FEATURE_ORDER, type FeatureContext, buildContext, cfRaw } from './features';
import { coverage, exposureGini, gini, intraListDiversity, meanStd, ndcgAtK, precisionAtK, recallAtK } from './metrics';
import { contentScores, hybrid, interactionCount, rankBy, rulesBaseline, sharedExploreIsContentGuided, trendingScores, unseenExclusion } from './recommend';
import { createRng, shuffle } from './rng';
import { DAY_MS, type Snapshot } from './snapshot';
import { GENRES, type World, discoveryPositives, generateWorld, genreName, truncateHistory, worldSnapshot } from './world';

const K = 5;
/** Global cutoffs (days before world "now"): test = [now−10d, now), validation = [now−17d, now−10d). */
export const TEST_DAYS = 10;
export const VALIDATION_DAYS = 7;
/** engine.ts MIN_INTERACTIONS: fewer interactions ⇒ serving falls back to the current rules. */
const MIN_INTERACTIONS = 3;
/** Item cold start: share of tracks released after T_c. User cold start: users whose history is truncated. */
export const COLD_SHARE = 0.15;
export const COLD_USERS = 10;

/** 'Hybrid (LR + re-rank)' = the current design with the content-guided EXPLORE slot; 'Hybrid (random explore)' = the previous one. */
export const METHODS = ['Random', 'Popularity', 'Rules (current SQL)', 'CF-only', 'Content-only', 'Hybrid (LR + re-rank)', 'Hybrid (random explore)', 'Hybrid w/o explore', 'Oracle (latent)'] as const;
type Method = (typeof METHODS)[number];
const METRICS = ['P@5', 'Recall@5', 'NDCG@5', 'Coverage@5', 'Gini(exposure)', 'ILD', 'SimCTR', 'StuffedExposure'] as const;
type Metric = (typeof METRICS)[number];
type MetricRow = Record<Metric, number>;
const PAIRS: [Method, Method][] = [
  ['Hybrid (LR + re-rank)', 'CF-only'],
  ['Hybrid (LR + re-rank)', 'Rules (current SQL)'],
  ['Hybrid (LR + re-rank)', 'Hybrid w/o explore'],
  ['Hybrid (LR + re-rank)', 'Hybrid (random explore)'],
];

export type EvaluateOptions = { seeds: number[]; now: Date; embedder: 'auto' | 'e5' | 'hash'; outDir: string; log: (line: string) => void; label?: string };

async function pickEmbedder(choice: EvaluateOptions['embedder'], log: (l: string) => void): Promise<{ embedder: Embedder; note: string }> {
  if (choice === 'hash') return { embedder: hashEmbedder(), note: 'hash-bow FALLBACK requested with --embedder hash — content/ILD numbers are NOT e5 numbers' };
  try {
    const embedder = await loadE5();
    return { embedder, note: `multilingual-e5-small (${embedder.modelId})` };
  } catch (error) {
    if (choice === 'e5') throw error;
    log(`evaluate: e5 unavailable (${(error as Error).message.split('\n')[0]}); falling back to hash-bow embeddings`);
    return { embedder: hashEmbedder(), note: 'hash-bow FALLBACK (e5 model not available in this environment) — content/ILD numbers are NOT e5 numbers' };
  }
}

function percentile(sorted: number[], q: number): number {
  if (!sorted.length) return NaN;
  return sorted[Math.min(sorted.length - 1, Math.floor(q * (sorted.length - 1)))];
}

/** Two-sided 97.5% quantiles of Student's t for df = 1..30 (beyond: normal). */
const T975 = [12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262, 2.228, 2.201, 2.179, 2.16, 2.145, 2.131, 2.12, 2.11, 2.101, 2.093, 2.086, 2.08, 2.074, 2.069, 2.064, 2.06, 2.056, 2.052, 2.048, 2.045, 2.042];
export function pairedCi(diffs: readonly number[]): { mean: number; sd: number; lo: number; hi: number; n: number } {
  const { mean, std } = meanStd(diffs);
  const n = diffs.length;
  const t = n >= 2 ? (T975[n - 2] ?? 1.96) : NaN;
  const half = (t * std) / Math.sqrt(n);
  return { mean, sd: std, lo: mean - half, hi: mean + half, n };
}

type Ctx = { world: World; ctx: FeatureContext; truth: Map<string, string[]>; worldIdx: Map<string, number>; userIdx: Map<string, number> };

function evaluateLists(lists: Map<string, string[]>, c: Ctx): MetricRow {
  const users = [...c.truth.keys()];
  const per = { p: [] as number[], r: [] as number[], n: [] as number[], ild: [] as number[], ctr: [] as number[] };
  const stuffed = new Set(c.world.tracks.filter((t) => t.stuffed).map((t) => t.id));
  let stuffedExposure = 0;
  for (const u of users) {
    const rec = lists.get(u) ?? [];
    const rel = new Set(c.truth.get(u));
    per.p.push(precisionAtK(rec, rel, K));
    per.r.push(recallAtK(rec, rel, K));
    per.n.push(ndcgAtK(rec, rel, K));
    per.ild.push(intraListDiversity(rec.slice(0, K), (id) => c.ctx.emb[c.ctx.trackIdx.get(id)!] ?? undefined));
    for (const id of rec.slice(0, K)) {
      per.ctr.push(c.world.clickProb(c.userIdx.get(u)!, c.worldIdx.get(id)!));
      if (stuffed.has(id)) stuffedExposure += 1;
    }
  }
  const all = users.map((u) => lists.get(u) ?? []);
  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
  return {
    'P@5': mean(per.p),
    'Recall@5': mean(per.r),
    'NDCG@5': mean(per.n),
    'Coverage@5': coverage(all, c.ctx.tracks.length, K),
    'Gini(exposure)': exposureGini(all, c.ctx.tracks.map((t) => t.id), K),
    ILD: mean(per.ild),
    SimCTR: mean(per.ctr),
    StuffedExposure: stuffedExposure,
  };
}

function setup(
  world: World,
  embeddings: Map<string, Float32Array>,
  from: number,
  to: number,
  opts: { catalogueBefore?: number; truth?: Map<string, string[]> } = {},
): Ctx & { snapshot: Snapshot } {
  const snapshot = worldSnapshot(world, embeddings, { before: from, catalogueBefore: opts.catalogueBefore });
  return {
    world,
    snapshot,
    ctx: buildContext(snapshot),
    truth: opts.truth ?? discoveryPositives(world, from, to),
    worldIdx: new Map(world.tracks.map((t) => [t.id, t.idx])),
    userIdx: new Map(world.users.map((u) => [u.id, u.idx])),
  };
}

/** All methods on one split. `only` restricts to a subset (validation/ablation runs). */
function runMethods(
  c: Ctx,
  model: TrainedModel,
  seed: number,
  only?: readonly Method[],
  drop?: ReadonlySet<string>,
  opts: { noFallback?: boolean } = {},
): { rows: Partial<Record<Method, MetricRow>>; fallbackUsers: number } {
  const { ctx, world } = c;
  const want = (m: Method) => !only || only.includes(m);
  const trending = trendingScores(ctx);
  const rng = createRng(seed).fork('random-baseline');
  const lists = new Map<Method, Map<string, string[]>>(METHODS.map((m) => [m, new Map()]));
  const nowMs = ctx.now;
  let fallbackUsers = 0;
  for (const user of [...c.truth.keys()].sort()) {
    const rules = rulesBaseline(ctx, user, unseenExclusion);
    const fallback = !opts.noFallback && interactionCount(ctx, user) < MIN_INTERACTIONS;
    if (fallback) fallbackUsers += 1;
    if (want('Random')) {
      const allowed = ctx.tracks.map((_, j) => j).filter((j) => !unseenExclusion(ctx, user, j));
      lists.get('Random')!.set(user, shuffle(rng, allowed).slice(0, K).map((j) => ctx.tracks[j].id));
    }
    if (want('Popularity')) lists.get('Popularity')!.set(user, rankBy(ctx, user, (j) => ctx.playCount[j], unseenExclusion));
    if (want('Rules (current SQL)')) lists.get('Rules (current SQL)')!.set(user, rules);
    if (want('CF-only')) {
      const cf = cfRaw(ctx, user);
      lists.get('CF-only')!.set(user, rankBy(ctx, user, (j) => cf[j], unseenExclusion));
    }
    if (want('Content-only')) {
      const content = contentScores(ctx, user);
      lists.get('Content-only')!.set(user, rankBy(ctx, user, (j) => content[j], unseenExclusion));
    }
    // Serving falls back to the rules for users with < 3 interactions; the hybrid rows do the same.
    if (want('Hybrid (LR + re-rank)'))
      lists.get('Hybrid (LR + re-rank)')!.set(user, fallback ? rules : hybrid(ctx, user, model.ranker, { exclude: unseenExclusion, explore: true, trending, drop }).map((r) => r.trackId));
    if (want('Hybrid (random explore)'))
      lists
        .get('Hybrid (random explore)')!
        .set(user, fallback ? rules : hybrid(ctx, user, model.ranker, { exclude: unseenExclusion, explore: true, trending, drop, exploreMode: 'random' }).map((r) => r.trackId));
    if (want('Hybrid w/o explore'))
      lists.get('Hybrid w/o explore')!.set(user, fallback ? rules : hybrid(ctx, user, model.ranker, { exclude: unseenExclusion, explore: false, trending, drop }).map((r) => r.trackId));
    if (want('Oracle (latent)')) {
      const u = c.userIdx.get(user)!;
      lists.get('Oracle (latent)')!.set(user, rankBy(ctx, user, (j) => world.utility(u, c.worldIdx.get(ctx.tracks[j].id)!, nowMs), unseenExclusion));
    }
  }
  const rows: Partial<Record<Method, MetricRow>> = {};
  for (const m of METHODS) if (want(m)) rows[m] = evaluateLists(lists.get(m)!, c);
  return { rows, fallbackUsers };
}

function permuted(embeddings: Map<string, Float32Array>, seed: number): Map<string, Float32Array> {
  const ids = [...embeddings.keys()].sort();
  const vectors = shuffle(createRng(seed).fork('permutation'), ids.map((id) => embeddings.get(id)!));
  return new Map(ids.map((id, i) => [id, vectors[i]]));
}

function sanity(world: World, snapshotTracks: { id: string; playCount: number }[]) {
  const genreTracks: Record<string, number> = {};
  const genrePlays: Record<string, number> = {};
  const plays = new Map(snapshotTracks.map((t) => [t.id, t.playCount]));
  for (const t of world.tracks)
    for (const g of t.genres) {
      genreTracks[genreName(g)] = (genreTracks[genreName(g)] ?? 0) + 1;
      genrePlays[genreName(g)] = (genrePlays[genreName(g)] ?? 0) + (plays.get(t.id) ?? 0);
    }
  const perArtist = world.artists.map((a) => world.tracks.filter((t) => t.artistIdx === a.idx).length).sort((a, b) => a - b);
  const artistPlays = world.artists
    .map((a) => world.tracks.filter((t) => t.artistIdx === a.idx).reduce((s, t) => s + (plays.get(t.id) ?? 0), 0))
    .sort((a, b) => a - b);
  const perUser = world.users.map((u) => world.events.filter((e) => e.userIdx === u.idx).length).sort((a, b) => a - b);
  const skips = world.events.filter((e) => e.kind === 'skip').length;
  const off = world.events.filter((e) => e.offTaste);
  const favFollows = world.follows.filter((f) => world.users[f.userIdx].favArtists.has(f.artistIdx)).length;
  const favTotal = world.users.reduce((s, u) => s + u.favArtists.size, 0);
  return {
    tracks: world.tracks.length,
    artists: world.artists.length,
    listeners: world.users.length,
    events: world.events.length,
    likes: world.likes.length,
    listens: world.listens.length,
    engagementRows: world.engagement.length,
    follows: world.follows.length,
    randomFollowShare: 1 - favFollows / Math.max(1, world.follows.length),
    favouritesUnfollowedShare: 1 - favFollows / Math.max(1, favTotal),
    playlists: world.playlists.length,
    surveyAnswers: world.preferences.length,
    offTasteShare: off.length / world.events.length,
    skipShare: skips / world.events.length,
    offTasteSkipShare: off.filter((e) => e.kind === 'skip').length / Math.max(1, off.length),
    genreTracks,
    genrePlays,
    tracksPerArtist: { min: perArtist[0], median: percentile(perArtist, 0.5), max: perArtist[perArtist.length - 1] },
    playsPerArtistGini: gini(artistPlays),
    eventsPerUser: {
      min: perUser[0],
      p25: percentile(perUser, 0.25),
      median: percentile(perUser, 0.5),
      p75: percentile(perUser, 0.75),
      p90: percentile(perUser, 0.9),
      max: perUser[perUser.length - 1],
      gini: gini(perUser),
    },
    dataGiniPlayCount: gini(snapshotTracks.map((t) => t.playCount)),
    stuffedTracks: world.tracks.filter((t) => t.stuffed).map((t) => ({ title: t.title, genres: t.genres, playCount: plays.get(t.id) ?? 0 })),
  };
}

type SeedResult = {
  seed: number;
  test: { users: number; positives: number; fallbackUsers: number; methods: Record<Method, MetricRow> };
  validation: {
    users: number;
    positives: number;
    base: { 'P@5': number; 'NDCG@5': number };
    ablations: Record<string, { 'P@5': number; 'NDCG@5': number; holdoutAUC: number }>;
    permutation: { contentP5: number; hybridP5: number; permutedContentP5: number; permutedHybridP5: number };
  };
  model: { raw: number[]; standardised: number[]; bias: number; preFitAUC: number; holdoutAUC: number; holdoutLogloss: number; nTrain: number; nHoldout: number };
  coldItems: {
    newTracks: number;
    users: number;
    positives: number;
    methods: Partial<Record<Method, MetricRow>>;
    permutation: { contentP5: number; hybridP5: number; permutedContentP5: number; permutedHybridP5: number };
    validation: { users: number; methods: Partial<Record<Method, MetricRow>> };
  };
  coldUsers: {
    users: number;
    keptInteractions: number;
    belowThreshold: number;
    positives: number;
    rules: MetricRow;
    hybridProduction: MetricRow;
    hybridForced: MetricRow;
  };
  sanity: ReturnType<typeof sanity>;
};

export async function runEvaluation(opts: EvaluateOptions): Promise<{ json: string; md: string }> {
  const { embedder, note } = await pickEmbedder(opts.embedder, opts.log);
  // Reports made without e5 are always labelled, so they cannot be mistaken for the real run.
  const label = opts.label ?? (embedder.kind === 'hash' ? 'hash-fallback' : undefined);
  const perSeed: SeedResult[] = [];
  const nowMs = opts.now.getTime();
  const testFrom = nowMs - TEST_DAYS * DAY_MS;
  const valFrom = testFrom - VALIDATION_DAYS * DAY_MS;

  for (const seed of opts.seeds) {
    const started = Date.now();
    const world = generateWorld({ seed, now: opts.now });
    const vectorsOf = await embedder.embed(world.tracks.map((t) => passageText({ title: t.title, description: t.description, lyrics: t.lyrics })));
    const embeddings = new Map(world.tracks.map((t, i) => [t.id, vectorsOf[i]]));

    // ---- Validation (design / ablation / controls only): train < valFrom, truth in [valFrom, testFrom).
    const val = setup(world, embeddings, valFrom, testFrom);
    const { model: valModel } = trainFromSnapshot(val.snapshot, { seed });
    const valRows = runMethods(val, valModel, seed, ['Content-only', 'Hybrid w/o explore']).rows;
    const ablations: SeedResult['validation']['ablations'] = {};
    for (const name of FEATURE_ORDER) {
      const { model: reduced } = trainFromSnapshot(val.snapshot, { seed, drop: [name] });
      const row = runMethods(val, reduced, seed, ['Hybrid w/o explore'], new Set([name])).rows['Hybrid w/o explore']!;
      ablations[`-${name}`] = { 'P@5': row['P@5'], 'NDCG@5': row['NDCG@5'], holdoutAUC: reduced.metrics.holdout.auc };
    }
    // Permutation control: embeddings shuffled across tracks → content signal destroyed.
    const valPerm = setup(world, permuted(embeddings, seed), valFrom, testFrom);
    const { model: permModel } = trainFromSnapshot(valPerm.snapshot, { seed });
    const permRows = runMethods(valPerm, permModel, seed, ['Content-only', 'Hybrid w/o explore']).rows;

    // ---- Test (touched once): train < testFrom, truth = discoveries in [testFrom, now).
    const test = setup(world, embeddings, testFrom, nowMs);
    const { model } = trainFromSnapshot(test.snapshot, { seed });
    const testRun = runMethods(test, model, seed);
    // ---- Item cold start: same seed, 15 % of tracks released in [T_c, T_c + 3 d). The catalogue at
    // recommendation time contains them (no plays / co-occurrence yet); truth = discoveries of new tracks only.
    const coldWorld = generateWorld({ seed, now: opts.now, coldShare: COLD_SHARE, coldFrom: testFrom });
    const sameText = coldWorld.tracks.every((t, i) => t.id === world.tracks[i].id && t.description === world.tracks[i].description);
    const coldEmbeddings = sameText
      ? embeddings
      : new Map(
          (await embedder.embed(coldWorld.tracks.map((t) => passageText({ title: t.title, description: t.description, lyrics: t.lyrics })))).map((v, i) => [coldWorld.tracks[i].id, v]),
        );
    const newIds = new Set(coldWorld.tracks.filter((t) => t.lateRelease).map((t) => t.id));
    const coldTruth = discoveryPositives(coldWorld, testFrom, nowMs, { includeLaterReleases: true, onlyTracks: newIds });
    const cold = setup(coldWorld, coldEmbeddings, testFrom, nowMs, { catalogueBefore: nowMs, truth: coldTruth });
    const { model: coldModel } = trainFromSnapshot(cold.snapshot, { seed });
    const coldMethods: Method[] = ['Random', 'Popularity', 'Rules (current SQL)', 'CF-only', 'Content-only', 'Hybrid (LR + re-rank)', 'Hybrid (random explore)', 'Hybrid w/o explore'];
    const coldRows = runMethods(cold, coldModel, seed, coldMethods).rows;
    const coldPerm = setup(coldWorld, permuted(coldEmbeddings, seed), testFrom, nowMs, { catalogueBefore: nowMs, truth: coldTruth });
    const { model: coldPermModel } = trainFromSnapshot(coldPerm.snapshot, { seed });
    const coldPermRows = runMethods(coldPerm, coldPermModel, seed, ['Content-only', 'Hybrid (LR + re-rank)']).rows;

    // ---- Item cold start on VALIDATION (same construction one week earlier: release in [T_v, T_v + 3 d),
    // train < T_v, truth = new-track discoveries in [T_v, T_c)). Used to check the explore design decision.
    const coldValWorld = generateWorld({ seed, now: opts.now, coldShare: COLD_SHARE, coldFrom: valFrom });
    const coldValNew = new Set(coldValWorld.tracks.filter((t) => t.lateRelease).map((t) => t.id));
    const coldValTruth = discoveryPositives(coldValWorld, valFrom, testFrom, { includeLaterReleases: true, onlyTracks: coldValNew });
    const coldVal = setup(coldValWorld, coldEmbeddings, valFrom, testFrom, { catalogueBefore: testFrom, truth: coldValTruth });
    const { model: coldValModel } = trainFromSnapshot(coldVal.snapshot, { seed });
    const coldValRows = runMethods(coldVal, coldValModel, seed, ['Rules (current SQL)', 'Hybrid (LR + re-rank)', 'Hybrid (random explore)']).rows;

    // ---- User cold start: ~10 test users' pre-cutoff history truncated to 2–3 tracks (+ a noisy survey).
    const pickRng = createRng(seed).fork('cold-users');
    const pickedIds = shuffle(pickRng, [...test.truth.keys()].sort()).slice(0, COLD_USERS);
    const pickedIdx = pickedIds.map((id) => test.userIdx.get(id)!);
    const truncated = truncateHistory(world, pickedIdx, testFrom, pickRng.fork('truncate'));
    const coldUserTruth = new Map(pickedIds.map((id) => [id, test.truth.get(id)!]));
    const cu = setup(truncated.world, embeddings, testFrom, nowMs, { truth: coldUserTruth });
    const { model: cuModel } = trainFromSnapshot(cu.snapshot, { seed });
    const cuProd = runMethods(cu, cuModel, seed, ['Rules (current SQL)', 'Hybrid (LR + re-rank)']);
    const cuForced = runMethods(cu, cuModel, seed, ['Hybrid (LR + re-rank)'], undefined, { noFallback: true });

    perSeed.push({
      seed,
      test: {
        users: test.truth.size,
        positives: [...test.truth.values()].reduce((a, b) => a + b.length, 0),
        fallbackUsers: testRun.fallbackUsers,
        methods: testRun.rows as Record<Method, MetricRow>,
      },
      validation: {
        users: val.truth.size,
        positives: [...val.truth.values()].reduce((a, b) => a + b.length, 0),
        base: { 'P@5': valRows['Hybrid w/o explore']!['P@5'], 'NDCG@5': valRows['Hybrid w/o explore']!['NDCG@5'] },
        ablations,
        permutation: {
          contentP5: valRows['Content-only']!['P@5'],
          hybridP5: valRows['Hybrid w/o explore']!['P@5'],
          permutedContentP5: permRows['Content-only']!['P@5'],
          permutedHybridP5: permRows['Hybrid w/o explore']!['P@5'],
        },
      },
      model: {
        raw: model.weights,
        standardised: model.standardisedWeights,
        bias: model.bias,
        preFitAUC: model.metrics.train.auc,
        holdoutAUC: model.metrics.holdout.auc,
        holdoutLogloss: model.metrics.holdout.logloss,
        nTrain: model.metrics.refit.n,
        nHoldout: model.metrics.holdout.n,
      },
      coldItems: {
        newTracks: newIds.size,
        users: coldTruth.size,
        positives: [...coldTruth.values()].reduce((a, b) => a + b.length, 0),
        methods: coldRows,
        permutation: {
          contentP5: coldRows['Content-only']!['P@5'],
          hybridP5: coldRows['Hybrid (LR + re-rank)']!['P@5'],
          permutedContentP5: coldPermRows['Content-only']!['P@5'],
          permutedHybridP5: coldPermRows['Hybrid (LR + re-rank)']!['P@5'],
        },
        validation: { users: coldValTruth.size, methods: coldValRows },
      },
      coldUsers: {
        users: pickedIds.length,
        keptInteractions: [...truncated.kept.values()].reduce((a, b) => a + b, 0) / Math.max(1, truncated.kept.size),
        belowThreshold: cuProd.fallbackUsers,
        positives: [...coldUserTruth.values()].reduce((a, b) => a + b.length, 0),
        rules: cuProd.rows['Rules (current SQL)']!,
        hybridProduction: cuProd.rows['Hybrid (LR + re-rank)']!,
        hybridForced: cuForced.rows['Hybrid (LR + re-rank)']!,
      },
      sanity: sanity(world, worldSnapshot(world).tracks),
    });
    const m = testRun.rows;
    opts.log(
      `evaluate: seed ${seed} (${((Date.now() - started) / 1000).toFixed(1)} s) test users ${test.truth.size} — P@5 hybrid ${m['Hybrid (LR + re-rank)']!['P@5'].toFixed(3)}, ` +
        `CF ${m['CF-only']!['P@5'].toFixed(3)}, rules ${m['Rules (current SQL)']!['P@5'].toFixed(3)}, popularity ${m.Popularity!['P@5'].toFixed(3)}, oracle ${m['Oracle (latent)']!['P@5'].toFixed(3)}`,
    );
  }

  const agg = (get: (s: SeedResult) => number) => meanStd(perSeed.map(get));
  const summary = Object.fromEntries(METHODS.map((m) => [m, Object.fromEntries(METRICS.map((metric) => [metric, agg((s) => s.test.methods[m][metric])]))]));
  const paired = PAIRS.map(([a, b]) => ({
    comparison: `${a} − ${b}`,
    'P@5': pairedCi(perSeed.map((s) => s.test.methods[a]['P@5'] - s.test.methods[b]['P@5'])),
    'NDCG@5': pairedCi(perSeed.map((s) => s.test.methods[a]['NDCG@5'] - s.test.methods[b]['NDCG@5'])),
  }));
  const ablationSummary = Object.fromEntries(
    FEATURE_ORDER.map((name) => [
      `-${name}`,
      {
        'P@5': agg((s) => s.validation.ablations[`-${name}`]['P@5']),
        'ΔP@5 vs full': pairedCi(perSeed.map((s) => s.validation.ablations[`-${name}`]['P@5'] - s.validation.base['P@5'])),
        'NDCG@5': agg((s) => s.validation.ablations[`-${name}`]['NDCG@5']),
        holdoutAUC: agg((s) => s.validation.ablations[`-${name}`].holdoutAUC),
      },
    ]),
  );
  const permutation = {
    contentP5: agg((s) => s.validation.permutation.contentP5),
    permutedContentP5: agg((s) => s.validation.permutation.permutedContentP5),
    contentDrop: pairedCi(perSeed.map((s) => s.validation.permutation.contentP5 - s.validation.permutation.permutedContentP5)),
    hybridP5: agg((s) => s.validation.permutation.hybridP5),
    permutedHybridP5: agg((s) => s.validation.permutation.permutedHybridP5),
    hybridDrop: pairedCi(perSeed.map((s) => s.validation.permutation.hybridP5 - s.validation.permutation.permutedHybridP5)),
  };
  const modelSummary = {
    preFitAUC: agg((s) => s.model.preFitAUC),
    holdoutAUC: agg((s) => s.model.holdoutAUC),
    holdoutLogloss: agg((s) => s.model.holdoutLogloss),
    raw: Object.fromEntries(FEATURE_ORDER.map((name, k) => [name, agg((s) => s.model.raw[k])])),
    standardised: Object.fromEntries(FEATURE_ORDER.map((name, k) => [name, agg((s) => s.model.standardised[k])])),
  };
  const COLD_ITEM_METHODS: Method[] = ['Random', 'Popularity', 'Rules (current SQL)', 'CF-only', 'Content-only', 'Hybrid (LR + re-rank)', 'Hybrid (random explore)', 'Hybrid w/o explore'];
  const coldItems = {
    newTracks: agg((s) => s.coldItems.newTracks),
    users: agg((s) => s.coldItems.users),
    positives: agg((s) => s.coldItems.positives),
    summary: Object.fromEntries(
      COLD_ITEM_METHODS.map((m) => [m, { 'P@5': agg((s) => s.coldItems.methods[m]!['P@5']), 'NDCG@5': agg((s) => s.coldItems.methods[m]!['NDCG@5']), 'Coverage@5': agg((s) => s.coldItems.methods[m]!['Coverage@5']) }]),
    ),
    paired: ([
      ['Content-only', 'CF-only'],
      ['Hybrid (LR + re-rank)', 'CF-only'],
      ['Hybrid (LR + re-rank)', 'Rules (current SQL)'],
      ['Hybrid (LR + re-rank)', 'Popularity'],
      ['Content-only', 'Random'],
      ['Hybrid (LR + re-rank)', 'Hybrid (random explore)'],
    ] as [Method, Method][]).map(([a, b]) => ({
      comparison: `${a} − ${b}`,
      'P@5': pairedCi(perSeed.map((s) => s.coldItems.methods[a]!['P@5'] - s.coldItems.methods[b]!['P@5'])),
      'NDCG@5': pairedCi(perSeed.map((s) => s.coldItems.methods[a]!['NDCG@5'] - s.coldItems.methods[b]!['NDCG@5'])),
    })),
    validation: {
      users: agg((s) => s.coldItems.validation.users),
      summary: Object.fromEntries(
        (['Rules (current SQL)', 'Hybrid (LR + re-rank)', 'Hybrid (random explore)'] as Method[]).map((m) => [
          m,
          { 'P@5': agg((s) => s.coldItems.validation.methods[m]!['P@5']), 'NDCG@5': agg((s) => s.coldItems.validation.methods[m]!['NDCG@5']) },
        ]),
      ),
      paired: ([
        ['Hybrid (LR + re-rank)', 'Hybrid (random explore)'],
        ['Hybrid (LR + re-rank)', 'Rules (current SQL)'],
      ] as [Method, Method][]).map(([a, b]) => ({
        comparison: `${a} − ${b}`,
        'P@5': pairedCi(perSeed.map((s) => s.coldItems.validation.methods[a]!['P@5'] - s.coldItems.validation.methods[b]!['P@5'])),
        'NDCG@5': pairedCi(perSeed.map((s) => s.coldItems.validation.methods[a]!['NDCG@5'] - s.coldItems.validation.methods[b]!['NDCG@5'])),
      })),
    },
    permutation: {
      contentP5: agg((s) => s.coldItems.permutation.contentP5),
      permutedContentP5: agg((s) => s.coldItems.permutation.permutedContentP5),
      contentDrop: pairedCi(perSeed.map((s) => s.coldItems.permutation.contentP5 - s.coldItems.permutation.permutedContentP5)),
      hybridP5: agg((s) => s.coldItems.permutation.hybridP5),
      permutedHybridP5: agg((s) => s.coldItems.permutation.permutedHybridP5),
      hybridDrop: pairedCi(perSeed.map((s) => s.coldItems.permutation.hybridP5 - s.coldItems.permutation.permutedHybridP5)),
    },
  };
  const coldUsers = {
    users: agg((s) => s.coldUsers.users),
    keptInteractions: agg((s) => s.coldUsers.keptInteractions),
    belowThreshold: agg((s) => s.coldUsers.belowThreshold),
    positives: agg((s) => s.coldUsers.positives),
    summary: Object.fromEntries(
      (['rules', 'hybridProduction', 'hybridForced'] as const).map((k) => [k, { 'P@5': agg((s) => s.coldUsers[k]['P@5']), 'NDCG@5': agg((s) => s.coldUsers[k]['NDCG@5']) }]),
    ) as ColdUsersReport['summary'],
    paired: {
      'P@5': pairedCi(perSeed.map((s) => s.coldUsers.hybridForced['P@5'] - s.coldUsers.rules['P@5'])),
      'NDCG@5': pairedCi(perSeed.map((s) => s.coldUsers.hybridForced['NDCG@5'] - s.coldUsers.rules['NDCG@5'])),
    },
  };
  const users = {
    test: agg((s) => s.test.users),
    testPositives: agg((s) => s.test.positives),
    testFallbackUsers: agg((s) => s.test.fallbackUsers),
    validation: agg((s) => s.validation.users),
    validationPositives: agg((s) => s.validation.positives),
    listeners: perSeed[0]?.sanity.listeners ?? 0,
  };
  const generatedAt = new Date();
  const report = {
    generatedAt: generatedAt.toISOString(),
    label: label ?? null,
    honesty: HONESTY,
    protocol: PROTOCOL,
    embedder: note,
    seeds: opts.seeds,
    worldNow: opts.now.toISOString(),
    cutoffs: { validationFrom: new Date(valFrom).toISOString(), testFrom: new Date(testFrom).toISOString(), testTo: opts.now.toISOString() },
    k: K,
    users,
    summary,
    paired,
    ablations: ablationSummary,
    permutation,
    coldItems,
    coldUsers,
    exploreContentGuided: sharedExploreIsContentGuided(),
    model: modelSummary,
    perSeed,
  };
  const json = JSON.stringify(report, null, 2);
  const md = markdown(report, perSeed[0]);
  const stamp = generatedAt.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z') + (label ? `-${label}` : '');
  await mkdir(opts.outDir, { recursive: true });
  await writeFile(join(opts.outDir, `eval-${stamp}.json`), json + '\n', 'utf8');
  await writeFile(join(opts.outDir, `eval-${stamp}.md`), md, 'utf8');
  opts.log(`evaluate: wrote ${join(opts.outDir, `eval-${stamp}.json`)} and .md`);
  return { json, md };
}

export const HONESTY =
  'Results are on synthetic data and prove only that the pipeline works and each tier contributes under the simulation ' +
  'assumptions. CTR is simulated. Never claim real-user effectiveness.';

const PROTOCOL = [
  `Each seed regenerates the synthetic world in memory (same generator as \`seed\`); no database is touched.`,
  `ONE global cutoff: everything the models see (plays, likes, play_count, skip stats, CF co-occurrence, trending, taste, follows, playlists, survey, catalogue) is strictly before T_c = now − ${TEST_DAYS} d.`,
  'Test = discovery: (user, track) pairs whose FIRST play is at/after T_c, positive within [T_c, now) (like OR completes >= 1 OR qualified plays >= 2), on tracks already published at T_c. Users with no such pair are excluded.',
  `Validation = the same construction one week earlier (train < T_c − ${VALIDATION_DAYS} d, truth in [T_c − ${VALIDATION_DAYS} d, T_c)); ablations and the permutation control run ONLY on validation; the test is used once, for the main table.`,
  'All methods rank only tracks the user has no pre-cutoff pair with (not own). The hybrid applies the shared re-rank (<= 1 per artist, slot-5 EXPLORE, SKIPPED rule) and falls back to the rules for users with < 3 interactions, like serving.',
  'The LR is trained with the same code as `train` (labels with leave-pair-out features; diagnostic AUC on the snapshot\'s own last 7 days; stored model refit on all pairs).',
  'Recall@5 now differs from P@5 because the number of discoveries per user varies (it was identical under the old fixed 5-per-user split).',
  'SimCTR = mean simulated click probability sigmoid((U − 0.55)/0.08) of recommended items under the latent utility U at T_c.',
].join(' ');

const SHOWS = [
  'The pipeline runs end to end on aggregate tables shaped like the real ones, with no leakage across a global time cutoff.',
  'Whether, under the simulator\'s assumptions, the hybrid ranks future discoveries better than single signals and the current SQL rules: see the computed verdicts below (a CI that includes 0 means no detectable difference at this sample size).',
  'Whether content similarity carries information beyond genre in this world: the permutation control (shuffled embeddings) on validation.',
];

const sig = (x: ReturnType<typeof pairedCi>) => (x.lo > 0 ? 1 : x.hi < 0 ? -1 : 0);
function interpretation(r: Report): string {
  const abl = r.ablations['-content_sim']['ΔP@5 vs full'];
  const perm = r.permutation as unknown as { hybridDrop: ReturnType<typeof pairedCi> };
  const warm =
    sig(abl) === 0 && sig(perm.hybridDrop) === 0
      ? `In warm start, content adds no measurable signal beyond CF and genre (dropping content_sim: ΔP@5 ${abl.mean.toFixed(3)}, CI ${abl.lo.toFixed(3)} … ${abl.hi.toFixed(3)}; shuffling embeddings changes hybrid P@5 by ${perm.hybridDrop.mean.toFixed(3)}, CI ${perm.hybridDrop.lo.toFixed(3)} … ${perm.hybridDrop.hi.toFixed(3)}).`
      : `In warm start, content shows a measurable effect (dropping content_sim: ΔP@5 ${abl.mean.toFixed(3)}, CI ${abl.lo.toFixed(3)} … ${abl.hi.toFixed(3)}; permutation hybrid drop ${perm.hybridDrop.mean.toFixed(3)}, CI ${perm.hybridDrop.lo.toFixed(3)} … ${perm.hybridDrop.hi.toFixed(3)}).`;
  const c = r.coldItems;
  const contentVsCf = c.paired[0]['P@5'];
  const s = c.summary;
  const coldNums = `Content-only P@5 ${s['Content-only']['P@5'].mean.toFixed(3)} vs CF-only ${s['CF-only']['P@5'].mean.toFixed(3)} (Δ ${contentVsCf.mean.toFixed(3)}, CI ${contentVsCf.lo.toFixed(3)} … ${contentVsCf.hi.toFixed(3)}); permutation drop ${c.permutation.contentDrop.mean.toFixed(3)}, CI ${c.permutation.contentDrop.lo.toFixed(3)} … ${c.permutation.contentDrop.hi.toFixed(3)}; Hybrid ${s['Hybrid (LR + re-rank)']['P@5'].mean.toFixed(3)}, Rules ${s['Rules (current SQL)']['P@5'].mean.toFixed(3)}, Popularity ${s.Popularity['P@5'].mean.toFixed(3)}`;
  const cold =
    sig(contentVsCf) > 0 && sig(c.permutation.contentDrop) > 0
      ? ` Its value appears in item cold start: on discoveries of tracks released after the cutoff, ${coldNums}.`
      : ` In item cold start content does NOT show a reliable advantage either: ${coldNums}.`;
  const vsRules = c.paired[2]['P@5'];
  const w = r.model.standardised;
  const rules =
    sig(vsRules) < 0
      ? ` On new tracks the hybrid is WORSE than the current rules (Δ ${vsRules.mean.toFixed(3)}, CI ${vsRules.lo.toFixed(3)} … ${vsRules.hi.toFixed(3)}): the rules order genre matches newest-first, which surfaces new releases, while the LR trained on warm data (standardised weights recency ${w.recency.mean.toFixed(2)}, popularity ${w.popularity.mean.toFixed(2)}, cf_score ${w.cf_score.mean.toFixed(2)}) pushes items without plays or co-occurrence down; only the EXPLORE slot and FOLLOW/CONTENT candidates reach them.`
      : sig(vsRules) > 0
        ? ` On new tracks the hybrid beats the current rules (Δ ${vsRules.mean.toFixed(3)}, CI ${vsRules.lo.toFixed(3)} … ${vsRules.hi.toFixed(3)}).`
        : ` On new tracks the hybrid and the current rules are indistinguishable (Δ ${vsRules.mean.toFixed(3)}, CI ${vsRules.lo.toFixed(3)} … ${vsRules.hi.toFixed(3)}).`;
  const u = r.coldUsers.paired['P@5'];
  const users = ` For cold-start users (2–3 interactions + survey), forcing the hybrid instead of the production rules fallback gives Δ P@5 ${u.mean.toFixed(3)} (CI ${u.lo.toFixed(3)} … ${u.hi.toFixed(3)})${sig(u) === 0 ? ', i.e. no detectable difference: keeping the rules fallback below 3 interactions costs nothing measurable here.' : '.'}`;
  const ex = c.paired[5]['P@5'];
  const exv = c.validation.paired[0]['P@5'];
  const explore = !r.exploreContentGuided
    ? ' Content-guided EXPLORE could not be measured in this run (the installed shared rerank ignores exploreScore).'
    : ` Content-guided EXPLORE vs random EXPLORE on new tracks: test Δ ${ex.mean.toFixed(3)} (CI ${ex.lo.toFixed(3)} … ${ex.hi.toFixed(3)}), validation Δ ${exv.mean.toFixed(3)} (CI ${exv.lo.toFixed(3)} … ${exv.hi.toFixed(3)}); this design change was made after the cold-start test analysis.`;
  return warm + cold + rules + explore + users;
}

function verdict(name: string, x: ReturnType<typeof pairedCi>): string {
  if (!(x.n >= 2) || !Number.isFinite(x.lo)) return `${name}: not enough seeds for an interval.`;
  if (x.lo > 0) return `${name}: positive, the 95% CI excludes 0 (${x.lo.toFixed(3)} … ${x.hi.toFixed(3)}).`;
  if (x.hi < 0) return `${name}: negative, the 95% CI excludes 0 (${x.lo.toFixed(3)} … ${x.hi.toFixed(3)}).`;
  return `${name}: no detectable difference, the 95% CI includes 0 (${x.lo.toFixed(3)} … ${x.hi.toFixed(3)}).`;
}
const DOES_NOT_SHOW = [
  'Anything about real users: behaviour is generated from a utility = genre 40 % + artist loyalty 25 % + latent mood 20 % + noise 15 %, so the signals the recommender uses were designed to be predictive.',
  'Feature importances are NOT discoveries: the LR weights recover the generator\'s assumptions (follows ≈ latent favourite artists, genre overlap ≈ genre preference, content ≈ mood words written from the latent mood).',
  'The oracle is a reference, not a ceiling: it ranks by the latent utility, but discoveries are stochastic (softmax choice, random skips, off-taste plays), so a model can match or exceed it on some seeds and it is not an achievable bound.',
  'CTR is simulated, and a handful of synthetic seeds of 60 users give wide intervals; small differences are not meaningful.',
];

type MS = { mean: number; std: number };
type ColdItemsReport = {
  newTracks: MS;
  users: MS;
  positives: MS;
  summary: Record<string, Record<'P@5' | 'NDCG@5' | 'Coverage@5', MS>>;
  paired: { comparison: string; 'P@5': ReturnType<typeof pairedCi>; 'NDCG@5': ReturnType<typeof pairedCi> }[];
  permutation: { contentP5: MS; permutedContentP5: MS; contentDrop: ReturnType<typeof pairedCi>; hybridP5: MS; permutedHybridP5: MS; hybridDrop: ReturnType<typeof pairedCi> };
  validation: {
    users: MS;
    summary: Record<string, Record<'P@5' | 'NDCG@5', MS>>;
    paired: { comparison: string; 'P@5': ReturnType<typeof pairedCi>; 'NDCG@5': ReturnType<typeof pairedCi> }[];
  };
};
type ColdUsersReport = {
  users: MS;
  keptInteractions: MS;
  belowThreshold: MS;
  positives: MS;
  summary: Record<'rules' | 'hybridProduction' | 'hybridForced', Record<'P@5' | 'NDCG@5', MS>>;
  paired: { 'P@5': ReturnType<typeof pairedCi>; 'NDCG@5': ReturnType<typeof pairedCi> };
};
type Report = {
  generatedAt: string;
  label: string | null;
  embedder: string;
  seeds: number[];
  cutoffs: { validationFrom: string; testFrom: string; testTo: string };
  users: Record<string, number | { mean: number; std: number }>;
  summary: Record<string, Record<string, { mean: number; std: number }>>;
  paired: { comparison: string; 'P@5': ReturnType<typeof pairedCi>; 'NDCG@5': ReturnType<typeof pairedCi> }[];
  ablations: Record<string, { 'P@5': { mean: number; std: number }; 'ΔP@5 vs full': ReturnType<typeof pairedCi>; 'NDCG@5': { mean: number; std: number }; holdoutAUC: { mean: number; std: number } }>;
  permutation: Record<string, { mean: number; std?: number; sd?: number; lo?: number; hi?: number }>;
  coldItems: ColdItemsReport;
  coldUsers: ColdUsersReport;
  exploreContentGuided: boolean;
  model: { preFitAUC: { mean: number; std: number }; holdoutAUC: { mean: number; std: number }; holdoutLogloss: { mean: number; std: number }; raw: Record<string, { mean: number; std: number }>; standardised: Record<string, { mean: number; std: number }> };
};

function fmt(x: { mean: number; std: number }, digits = 3): string {
  return Number.isFinite(x.mean) ? `${x.mean.toFixed(digits)} ± ${x.std.toFixed(digits)}` : 'n/a';
}
function ci(x: ReturnType<typeof pairedCi>, digits = 3): string {
  return `${x.mean >= 0 ? '+' : ''}${x.mean.toFixed(digits)} (sd ${x.sd.toFixed(digits)}; 95% CI ${x.lo.toFixed(digits)} … ${x.hi.toFixed(digits)})`;
}

function markdown(r: Report, first: SeedResult): string {
  const lines: string[] = [];
  const u = r.users as Record<string, { mean: number; std: number }>;
  lines.push(`# InfoSound Reco — offline evaluation (${r.generatedAt})${r.label ? ` [${r.label}]` : ''}`, '');
  lines.push(`> **Honesty statement.** ${HONESTY}`, '');
  lines.push(`- Embeddings: **${r.embedder}**`);
  lines.push(`- Seeds: ${r.seeds.join(', ')} (n = ${r.seeds.length}; μ ± σ over seeds, σ = sample sd)`);
  lines.push(`- Cutoffs: validation from ${r.cutoffs.validationFrom}, test from ${r.cutoffs.testFrom} to ${r.cutoffs.testTo}`);
  lines.push(
    `- Test users with ≥ 1 discovery: ${fmt(u.test, 1)} of ${r.users.listeners} listeners (discoveries ${fmt(u.testPositives, 1)}; rules fallback for ${fmt(u.testFallbackUsers, 1)} users); validation users ${fmt(u.validation, 1)}`,
  );
  lines.push(`- Protocol: ${PROTOCOL}`, '');
  lines.push('## Test: methods (k = 5)', '');
  lines.push(`| Method | ${METRICS.join(' | ')} |`, `|---|${METRICS.map(() => '---').join('|')}|`);
  for (const m of METHODS) lines.push(`| ${m} | ${METRICS.map((metric) => fmt(r.summary[m][metric], metric === 'StuffedExposure' ? 1 : 3)).join(' | ')} |`);
  lines.push('', '## Test: paired per-seed differences (mean, sd, 95% t-interval)', '');
  lines.push('| Comparison | ΔP@5 | ΔNDCG@5 |', '|---|---|---|');
  for (const p of r.paired) lines.push(`| ${p.comparison} | ${ci(p['P@5'])} | ${ci(p['NDCG@5'])} |`);
  lines.push('', '## Learned ranker (test-split model)', '');
  lines.push(`- Diagnostic AUC: fit ${fmt(r.model.preFitAUC)}, last-7-days holdout ${fmt(r.model.holdoutAUC)}; holdout logloss ${fmt(r.model.holdoutLogloss)}`);
  lines.push('', '| Feature | raw weight | standardised weight (w·σ, comparable) |', '|---|---|---|');
  for (const name of FEATURE_ORDER) lines.push(`| ${name} | ${fmt(r.model.raw[name])} | ${fmt(r.model.standardised[name])} |`);
  lines.push('', '## Validation only: ablations (drop one feature, retrain, re-rank without explore)', '');
  lines.push('| Dropped | P@5 | ΔP@5 vs full model | NDCG@5 | holdout AUC |', '|---|---|---|---|---|');
  for (const [name, row] of Object.entries(r.ablations)) lines.push(`| ${name} | ${fmt(row['P@5'])} | ${ci(row['ΔP@5 vs full'])} | ${fmt(row['NDCG@5'])} | ${fmt(row.holdoutAUC)} |`);
  const p = r.permutation as unknown as Record<string, { mean: number; std: number } & ReturnType<typeof pairedCi>>;
  lines.push('', '## Validation only: permutation control (embeddings shuffled across tracks)', '');
  lines.push('| | P@5 real embeddings | P@5 shuffled | drop |', '|---|---|---|---|');
  lines.push(`| Content-only | ${fmt(p.contentP5)} | ${fmt(p.permutedContentP5)} | ${ci(p.contentDrop)} |`);
  lines.push(`| Hybrid w/o explore | ${fmt(p.hybridP5)} | ${fmt(p.permutedHybridP5)} | ${ci(p.hybridDrop)} |`);
  const ci0 = r.coldItems;
  lines.push('', '## Item cold start (15 % of tracks released after T_c; truth = discoveries of those new tracks)', '');
  lines.push(
    `- New tracks per seed ${fmt(ci0.newTracks, 1)}; users with ≥ 1 new-track discovery ${fmt(ci0.users, 1)}; discoveries ${fmt(ci0.positives, 1)}. ` +
      'Lists are ranked over the whole catalogue (old + new); the EXPLORE slot is unchanged (its pool is newest-first, so it often holds a new track — that is the product rule, not a tweak).',
  );
  lines.push('', '| Method | P@5 | NDCG@5 | Coverage@5 |', '|---|---|---|---|');
  for (const [m, row] of Object.entries(ci0.summary)) lines.push(`| ${m} | ${fmt(row['P@5'])} | ${fmt(row['NDCG@5'])} | ${fmt(row['Coverage@5'])} |`);
  lines.push('', '| Paired comparison | ΔP@5 | ΔNDCG@5 |', '|---|---|---|');
  for (const pr of ci0.paired) lines.push(`| ${pr.comparison} | ${ci(pr['P@5'])} | ${ci(pr['NDCG@5'])} |`);
  lines.push('', '| Permutation control (cold-start split) | P@5 real | P@5 shuffled | drop |', '|---|---|---|---|');
  lines.push(`| Content-only | ${fmt(ci0.permutation.contentP5)} | ${fmt(ci0.permutation.permutedContentP5)} | ${ci(ci0.permutation.contentDrop)} |`);
  lines.push(`| Hybrid | ${fmt(ci0.permutation.hybridP5)} | ${fmt(ci0.permutation.permutedHybridP5)} | ${ci(ci0.permutation.hybridDrop)} |`);
  const v = ci0.validation;
  lines.push('', '### Design iteration: content-guided EXPLORE (decided AFTER looking at the cold-start TEST results)', '');
  lines.push(
    '- The previous round showed new tracks are buried by the LR. The EXPLORE slot was therefore changed to pick, among the ' +
      'explore-only candidates (unseen, never listened, least-exposed, newest; ≤ 20), the one with the highest exploreScore = ' +
      'content_sim (seeded ties; random when nothing has an embedding). This decision was made after seeing test numbers, so the ' +
      'test rows above are no longer an untouched estimate for it. "Hybrid (random explore)" is the previous design, kept for the comparison.',
  );
  lines.push(
    `- Shared rerank honours exploreScore in this build: **${r.exploreContentGuided ? 'yes' : 'NO — content-guided and random explore are identical in this run; rerun once @infosound/recommendation-ai/features has the change'}**.`,
  );
  lines.push(`- Check on the VALIDATION split (same cold-start construction one week earlier; ${fmt(v.users, 1)} users with new-track discoveries):`, '');
  lines.push('| Method (validation, new tracks) | P@5 | NDCG@5 |', '|---|---|---|');
  for (const [m, row] of Object.entries(v.summary)) lines.push(`| ${m} | ${fmt(row['P@5'])} | ${fmt(row['NDCG@5'])} |`);
  lines.push('', '| Paired comparison (validation, new tracks) | ΔP@5 | ΔNDCG@5 |', '|---|---|---|');
  for (const pr of v.paired) lines.push(`| ${pr.comparison} | ${ci(pr['P@5'])} | ${ci(pr['NDCG@5'])} |`);
  const cu0 = r.coldUsers;
  lines.push('', '## User cold start (history truncated to 2–3 tracks + a noisy survey)', '');
  lines.push(
    `- ${fmt(cu0.users, 1)} users per seed, ${fmt(cu0.keptInteractions, 2)} interactions kept on average, ${fmt(cu0.positives, 1)} discoveries; ` +
      `${fmt(cu0.belowThreshold, 1)} of them are below the threshold. **The production API falls back to the rules for users with < 3 interactions** ` +
      '(engine.ts MIN_INTERACTIONS = 3), so "Hybrid (production)" equals Rules for those users; "Hybrid forced" ignores the threshold (taste from the few interactions, else the survey cold start).',
  );
  lines.push('', '| Method | P@5 | NDCG@5 |', '|---|---|---|');
  lines.push(`| Rules (survey-based fallback) | ${fmt(cu0.summary.rules['P@5'])} | ${fmt(cu0.summary.rules['NDCG@5'])} |`);
  lines.push(`| Hybrid (production, rules if < 3) | ${fmt(cu0.summary.hybridProduction['P@5'])} | ${fmt(cu0.summary.hybridProduction['NDCG@5'])} |`);
  lines.push(`| Hybrid forced (survey taste) | ${fmt(cu0.summary.hybridForced['P@5'])} | ${fmt(cu0.summary.hybridForced['NDCG@5'])} |`);
  lines.push('', `- Hybrid forced − Rules: ΔP@5 ${ci(cu0.paired['P@5'])}; ΔNDCG@5 ${ci(cu0.paired['NDCG@5'])}`);
  lines.push('', '## What this shows', '', ...SHOWS.map((x) => `- ${x}`));
  lines.push('', 'Verdicts computed from this run (P@5):', '');
  for (const pr of r.paired) lines.push(`- ${verdict(pr.comparison, pr['P@5'])}`);
  lines.push(`- ${verdict('Permutation control, Content-only (real − shuffled)', p.contentDrop)}`);
  lines.push(`- ${verdict('Permutation control, Hybrid (real − shuffled)', p.hybridDrop)}`);
  lines.push(`- ${verdict('Item cold start, Content-only − CF-only', ci0.paired[0]['P@5'])}`);
  lines.push(`- ${verdict('Item cold start, Hybrid − CF-only', ci0.paired[1]['P@5'])}`);
  lines.push(`- ${verdict('Item cold start, permutation (Content-only real − shuffled)', ci0.permutation.contentDrop)}`);
  lines.push(`- ${verdict('Warm start, Hybrid (content explore) − Hybrid (random explore)', r.paired[3]['P@5'])}`);
  lines.push(`- ${verdict('Item cold start, Hybrid (content explore) − Hybrid (random explore)', ci0.paired[5]['P@5'])}`);
  lines.push(`- ${verdict('Item cold start, Hybrid (content explore) − Rules', ci0.paired[2]['P@5'])}`);
  lines.push(`- ${verdict('Item cold start VALIDATION, Hybrid (content explore) − Hybrid (random explore)', v.paired[0]['P@5'])}`);
  lines.push(`- ${verdict('Item cold start VALIDATION, Hybrid (content explore) − Rules', v.paired[1]['P@5'])}`);
  lines.push(`- ${verdict('User cold start, Hybrid forced − Rules', cu0.paired['P@5'])}`);
  lines.push('', '**Interpretation (generated from the numbers above).** ' + interpretation(r));
  lines.push('', '## What this does NOT show', '', ...DOES_NOT_SHOW.map((x) => `- ${x}`));
  const s = first.sanity;
  lines.push('', `## Dataset sanity (seed ${first.seed})`, '');
  lines.push(
    `- ${s.tracks} tracks, ${s.artists} artists, ${s.listeners} listeners, ${s.events} play events; ${s.likes} likes, ${s.listens} listen rows, ` +
      `${s.engagementRows} engagement rows, ${s.follows} follows (${(100 * s.randomFollowShare).toFixed(0)}% random, ${(100 * s.favouritesUnfollowedShare).toFixed(0)}% of favourites unfollowed), ${s.playlists} playlists, ${s.surveyAnswers} (noisy) survey answers`,
  );
  lines.push(`- Off-taste plays ${(100 * s.offTasteShare).toFixed(1)}% (of which skipped ${(100 * s.offTasteSkipShare).toFixed(1)}%); overall skip share ${(100 * s.skipShare).toFixed(1)}%`);
  lines.push(`- Tracks per artist: min ${s.tracksPerArtist.min}, median ${s.tracksPerArtist.median}, max ${s.tracksPerArtist.max}; Gini of plays per artist ${s.playsPerArtistGini.toFixed(3)}`);
  const e = s.eventsPerUser;
  lines.push(`- Play events per user: min ${e.min}, p25 ${e.p25}, median ${e.median}, p75 ${e.p75}, p90 ${e.p90}, max ${e.max}; Gini ${e.gini.toFixed(3)}`);
  lines.push(`- Data Gini (play_count over tracks, full window): ${s.dataGiniPlayCount.toFixed(3)} — compare with Gini(exposure) per method`);
  lines.push(`- Keyword-stuffed demo tracks: ${s.stuffedTracks.map((t) => `"${t.title}" [${t.genres.join(', ')}] plays=${t.playCount}`).join('; ')} — see StuffedExposure`);
  lines.push('', '| Genre | tracks | plays |', '|---|---|---|');
  for (const g of GENRES) lines.push(`| ${g.name} | ${s.genreTracks[g.name] ?? 0} | ${s.genrePlays[g.name] ?? 0} |`);
  lines.push('', `_${HONESTY}_`, '');
  return lines.join('\n');
}
