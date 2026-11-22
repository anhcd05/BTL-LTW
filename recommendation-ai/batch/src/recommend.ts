import {
  FEATURE_ORDER,
  type RankedCandidate,
  type RankerModel,
  type RerankOptions,
  dailySeed,
  parseModel,
  rerank as sharedRerank,
  scoreFeatures,
} from '@infosound/recommendation-ai/features';
import { type FeatureContext, cfRaw, cosine, featureInput, features, servingEligible, userTaste } from './features';
import { DAY_MS, isLabelPositive } from './snapshot';

/**
 * In-memory mirror of DESIGN §1 used by `evaluate` (serving is recommendation-ai/src/engine.ts in SQL).
 * Limits follow recommendation-ai/src/repository.ts LIMITS.
 */
export const CANDIDATE_LIMIT = 150;
export const LIMITS = { cf: 50, content: 50, follow: 25, trending: 25, explore: 20 } as const;
export const SLOTS = 5;

export type Source = 'CF' | 'CONTENT' | 'FOLLOW' | 'TRENDING';
export type Ranked = { trackId: string; score: number; sources: Source[]; explore?: boolean };

export type Exclusion = (ctx: FeatureContext, user: string, j: number) => boolean;

/** DESIGN re-rank exclusion: liked, own tracks, listened in the last 14 days. */
export const servingExclusion: Exclusion = (ctx, user, j) => !servingEligible(ctx, user, j);

/** Evaluation protocol: every method ranks only tracks the user has no training-period pair with. */
export const unseenExclusion: Exclusion = (ctx, user, j) => {
  const t = ctx.tracks[j];
  return t.authorId === user || !!ctx.pairs.get(user)?.has(t.id);
};

const byId = (ctx: FeatureContext) => (a: number, b: number) => (ctx.tracks[a].id < ctx.tracks[b].id ? -1 : ctx.tracks[a].id > ctx.tracks[b].id ? 1 : 0);

function topBy(ctx: FeatureContext, values: Float64Array | number[], allowed: (j: number) => boolean, k: number): number[] {
  const idx: number[] = [];
  for (let j = 0; j < values.length; j += 1) if (allowed(j) && values[j] > 0) idx.push(j);
  const tie = byId(ctx);
  return idx.sort((a, b) => values[b] - values[a] || tie(a, b)).slice(0, k);
}

export function trendingScores(ctx: FeatureContext): Float64Array {
  const out = new Float64Array(ctx.tracks.length);
  for (const m of ctx.pairs.values())
    for (const [trackId, p] of m) {
      const j = ctx.trackIdx.get(trackId);
      if (j !== undefined && p.lastListenedAt !== null && ctx.now - p.lastListenedAt <= 7 * DAY_MS) out[j] += 1;
    }
  return out;
}

export function contentScores(ctx: FeatureContext, user: string): Float64Array {
  const taste = userTaste(ctx, user);
  return Float64Array.from(ctx.tracks, (_, j) => (taste && ctx.emb[j] ? (cosine(taste, ctx.emb[j]!) + 1) / 2 : 0));
}

/** Tier 1: CF ∪ CONTENT ∪ FOLLOW ∪ TRENDING, capped at 150 (first come, first kept). */
export function candidates(ctx: FeatureContext, user: string, exclude: Exclusion, trending = trendingScores(ctx)): Map<number, Set<Source>> {
  const allowed = (j: number) => !exclude(ctx, user, j);
  const out = new Map<number, Set<Source>>();
  const add = (list: number[], source: Source) => {
    for (const j of list) {
      if (!out.has(j) && out.size >= CANDIDATE_LIMIT) continue;
      let s = out.get(j);
      if (!s) out.set(j, (s = new Set()));
      s.add(source);
    }
  };
  add(topBy(ctx, cfRaw(ctx, user), allowed, LIMITS.cf), 'CF');
  add(topBy(ctx, contentScores(ctx, user), allowed, LIMITS.content), 'CONTENT');
  const followed = ctx.follows.get(user) ?? new Set<string>();
  const tie = byId(ctx);
  const byArtist = ctx.tracks.map((t, j) => ({ t, j })).filter(({ t, j }) => followed.has(t.authorId) && allowed(j));
  const newest = byArtist.slice().sort((a, b) => b.t.publishedAt.getTime() - a.t.publishedAt.getTime() || tie(a.j, b.j)).slice(0, Math.ceil(LIMITS.follow / 2));
  const played = byArtist.slice().sort((a, b) => b.t.playCount - a.t.playCount || tie(a.j, b.j)).slice(0, Math.floor(LIMITS.follow / 2));
  add([...newest, ...played].map((x) => x.j), 'FOLLOW');
  add(topBy(ctx, trending, allowed, LIMITS.trending), 'TRENDING');
  return out;
}

/**
 * Same definition as repository.ts explorePool + engine.ts: eligible (here: the evaluation exclusion) and never
 * listened, ordered by impressions in the last 30 days ASC, published_at DESC, id; LIMIT 20; THEN tracks
 * already found by another source are dropped (explore-only candidates).
 */
function explorePool(ctx: FeatureContext, user: string, exclude: Exclusion, candidateSet: ReadonlySet<number>): number[] {
  const tie = byId(ctx);
  return ctx.tracks
    .map((t, j) => ({ t, j }))
    .filter(({ t, j }) => !exclude(ctx, user, j) && !ctx.pairs.get(user)?.get(t.id)?.plays)
    .sort(
      (a, b) =>
        ctx.impressions[a.j] - ctx.impressions[b.j] || b.t.publishedAt.getTime() - a.t.publishedAt.getTime() || tie(a.j, b.j),
    )
    .slice(0, LIMITS.explore)
    .map(({ j }) => j)
    .filter((j) => !candidateSet.has(j));
}

export type ExploreMode = 'content' | 'random';

/**
 * True when the shared rerank honours `exploreScore` (content-guided EXPLORE). Probed behaviourally, so the
 * evaluator reports honestly whether the installed @infosound/recommendation-ai build has the change.
 */
let probed: boolean | null = null;
export function sharedExploreIsContentGuided(): boolean {
  if (probed !== null) return probed;
  const mk = (id: string, score: number, sources: RankedCandidate['sources'], exploreScore?: number) =>
    ({ trackId: id, artistId: `a-${id}`, score, sources, ...(exploreScore === undefined ? {} : { exploreScore }) }) as RankedCandidate;
  probed = true;
  for (let k = 0; k < 8 && probed; k += 1) {
    const regular = [1, 2, 3, 4].map((i) => mk(`r${i}`, 1 - i / 10, ['CF']));
    const pool = Array.from({ length: 6 }, (_, i) => mk(`e${i}`, 0, ['EXPLORE'], i === 4 ? 0.99 : 0.1));
    const { selected } = sharedRerank([...regular, ...pool], { limit: 5, explore: true, seed: `probe-${k}`, userId: 'u', liked: new Set(), recent: new Set() });
    probed = selected.some((c) => c.trackId === 'e4');
  }
  return probed;
}

/**
 * Tier 3 = the shared `rerank` from @infosound/recommendation-ai/features (liked/own/recent exclusion,
 * ≤ 1 per artist, slot 5 EXPLORE from the exploration pool, seeded by dailySeed(user, UTC date)).
 */
export function rerank(
  ctx: FeatureContext,
  user: string,
  scored: { j: number; score: number; sources: Source[] }[],
  exclude: Exclusion,
  opts: { explore: boolean; slots?: number; dateKey?: string; exploreScore?: (j: number) => number | undefined },
): Ranked[] {
  const candidateSet = new Set(scored.map((c) => c.j));
  const regular: RankedCandidate[] = scored.map((c) => ({
    trackId: ctx.tracks[c.j].id,
    artistId: ctx.tracks[c.j].authorId,
    score: c.score,
    sources: c.sources,
  }));
  // exploreScore (content-guided EXPLORE) is only set when requested; without it the shared rerank picks at random.
  const pool: RankedCandidate[] = explorePool(ctx, user, exclude, candidateSet).map(
    (j) =>
      ({
        trackId: ctx.tracks[j].id,
        artistId: ctx.tracks[j].authorId,
        score: 0,
        sources: ['EXPLORE'],
        ...(opts.exploreScore && opts.exploreScore(j) !== undefined ? { exploreScore: opts.exploreScore(j) } : {}),
      }) as RankedCandidate,
  );
  const liked = new Set<string>();
  const recent = new Set<string>();
  for (const [trackId, p] of ctx.pairs.get(user) ?? []) {
    if (p.liked) liked.add(trackId);
    if (p.lastListenedAt !== null && ctx.now - p.lastListenedAt < 14 * DAY_MS) recent.add(trackId);
  }
  // Serving's SKIPPED rule: skips > completes within the last 14 days. `skipped` is optional in the shared
  // RerankOptions; it is set through a widened type so older builds of the shared module still compile.
  const skipped = new Set<string>();
  for (const [trackId, p] of ctx.pairs.get(user) ?? [])
    if (p.skips > p.completes && p.lastEventAt !== null && ctx.now - p.lastEventAt < 14 * DAY_MS) skipped.add(trackId);
  const options: RerankOptions & { skipped?: ReadonlySet<string> } = {
    limit: opts.slots ?? SLOTS,
    explore: opts.explore,
    seed: opts.dateKey ? `${user}:${opts.dateKey}` : dailySeed(user, new Date(ctx.now)),
    userId: user,
    liked,
    recent,
  };
  options.skipped = skipped;
  const { selected } = sharedRerank([...regular, ...pool], options);
  return selected.map((c) => ({
    trackId: c.trackId,
    score: c.score,
    sources: c.sources.filter((x): x is Source => x !== 'EXPLORE'),
    ...(c.explore ? { explore: true } : {}),
  }));
}

/** Converts trained weights (FEATURE_ORDER) into the serving RankerModel via the shared parseModel. */
export function rankerFrom(version: string, weights: readonly number[], bias: number): RankerModel {
  const model = parseModel({ version, featureNames: [...FEATURE_ORDER], weights, bias });
  if (!model) throw new Error('trained model does not satisfy parseModel');
  return model;
}

export function hybrid(
  ctx: FeatureContext,
  user: string,
  model: RankerModel,
  opts: { exclude: Exclusion; explore: boolean; trending?: Float64Array; drop?: ReadonlySet<string>; exploreMode?: ExploreMode },
): Ranked[] {
  const cands = candidates(ctx, user, opts.exclude, opts.trending);
  const scored = [...cands.entries()].map(([j, sources]) => {
    const f = features(ctx, user, j);
    for (const name of opts.drop ?? []) f[name as keyof typeof f] = 0;
    return { j, score: scoreFeatures(model, f), sources: [...sources] };
  });
  // Serving (engine.ts): exploreScore = features.content_sim for explore-only candidates, only when a content cosine
  // exists (track embedding + user taste); otherwise undefined ⇒ the shared pickExplore falls back to seeded random.
  const exploreScore =
    (opts.exploreMode ?? 'content') === 'content'
      ? (j: number) => (featureInput(ctx, user, j).contentCosine !== null ? features(ctx, user, j).content_sim : undefined)
      : undefined;
  return rerank(ctx, user, scored, opts.exclude, { explore: opts.explore, exploreScore });
}

/** Simple "rank everything allowed by a score" helper for the single-signal baselines. */
export function rankBy(ctx: FeatureContext, user: string, score: (j: number) => number, exclude: Exclusion, k = SLOTS): string[] {
  const idx: number[] = [];
  for (let j = 0; j < ctx.tracks.length; j += 1) if (!exclude(ctx, user, j)) idx.push(j);
  return idx
    .map((j) => ({ j, s: score(j) }))
    .sort((a, b) => b.s - a.s || a.j - b.j)
    .slice(0, k)
    .map((x) => ctx.tracks[x.j].id);
}

/**
 * Reimplementation of the current SQL rules (apps/api/src/recommendations.ts
 * userRecommendationSelection): explicit survey → liked-genre weights → popular.
 */
export function rulesBaseline(ctx: FeatureContext, user: string, exclude: Exclusion, k = SLOTS): string[] {
  const allowed = ctx.tracks.map((_, j) => !exclude(ctx, user, j));
  const publishedDesc = (a: number, b: number) => ctx.tracks[b].publishedAt.getTime() - ctx.tracks[a].publishedAt.getTime();
  const idCmp = (a: number, b: number) => (ctx.tracks[a].id < ctx.tracks[b].id ? -1 : ctx.tracks[a].id > ctx.tracks[b].id ? 1 : 0);
  const pref = ctx.prefs.get(user);
  if (pref && (pref.genreIds.size || pref.artistIds.size)) {
    const matches = ctx.tracks
      .map((t, j) => ({
        j,
        artist: pref.artistIds.has(t.authorId) ? 1 : 0,
        genres: t.genres.filter((g) => pref.genreIds.has(g)).length,
      }))
      .filter((m) => allowed[m.j] && (m.artist || m.genres > 0))
      .sort(
        (a, b) =>
          b.genres + b.artist - (a.genres + a.artist) ||
          b.artist - a.artist ||
          ctx.playCount[b.j] - ctx.playCount[a.j] ||
          publishedDesc(a.j, b.j) ||
          idCmp(a.j, b.j),
      );
    return matches.slice(0, k).map((m) => ctx.tracks[m.j].id);
  }
  const weights = new Map<string, number>();
  for (const [trackId, p] of ctx.pairs.get(user) ?? []) {
    if (!p.liked) continue;
    const j = ctx.trackIdx.get(trackId);
    if (j === undefined) continue;
    for (const g of ctx.tracks[j].genres) weights.set(g, (weights.get(g) ?? 0) + 1);
  }
  if (weights.size) {
    const ranked = ctx.tracks
      .map((t, j) => {
        const w = t.genres.map((g) => weights.get(g) ?? 0).filter((x) => x > 0);
        return { j, max: Math.max(0, ...w), sum: w.reduce((a, b) => a + b, 0), count: w.length };
      })
      .filter((r) => allowed[r.j] && r.count > 0)
      .sort((a, b) => b.max - a.max || b.sum - a.sum || b.count - a.count || publishedDesc(a.j, b.j) || idCmp(a.j, b.j));
    return ranked.slice(0, k).map((r) => ctx.tracks[r.j].id);
  }
  return rankBy(ctx, user, (j) => ctx.playCount[j] + ctx.tracks[j].publishedAt.getTime() / 1e16, exclude, k);
}

/** Positives per user in the training context (for the "< 3 interactions ⇒ fallback" rule). */
export function interactionCount(ctx: FeatureContext, user: string): number {
  let n = 0;
  for (const p of ctx.pairs.get(user)?.values() ?? []) if (isLabelPositive(p) || p.plays > 0 || p.skips > 0) n += 1;
  return n;
}
