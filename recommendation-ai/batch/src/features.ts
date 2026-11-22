import {
  FEATURE_ORDER,
  type FeatureInput,
  type Features,
  type TrackInteraction,
  buildFeatures,
  cosine,
  featureVector,
  interactionWeight,
  isPositive,
  meanVector,
  tasteVector,
  topGenres as topGenresOf,
} from '@infosound/recommendation-ai/features';
import { DAY_MS, type PairStat, type Snapshot, type SnapTrack, isCfPositive, pairIndex } from './snapshot';

/**
 * Training-side feature extraction. ONE implementation is shared with serving: every feature formula,
 * the taste vector, interaction weights, top genres and the CF normalisation come from
 * `@infosound/recommendation-ai/features` (buildFeatures / tasteVector / interactionWeight / topGenres /
 * cfFeature via buildFeatures). This module only computes the raw inputs from the in-memory
 * aggregate snapshot, including the offline CF co-occurrence counts (same formula as the serving SQL in
 * recommendation-ai/src/repository.ts cfCandidates) and the leave-pair-out statistics.
 */
export { FEATURE_ORDER };
export type FeatureName = (typeof FEATURE_ORDER)[number];
export type FeatureVector = Features;

export const RECENT_DAYS = 14;
/** repository.ts LIMITS.survey: the survey cold start uses the top-200 matching tracks by play_count. */
export const SURVEY_LIMIT = 200;

export type FeatureContext = {
  now: number;
  nowDate: Date;
  tracks: SnapTrack[];
  trackIdx: Map<string, number>;
  pairs: Map<string, Map<string, PairStat>>;
  /** CF positive set per user (track indices): likes ∪ listens ∪ completes>0 ∪ playlist tracks. */
  cfSets: Map<string, Set<number>>;
  /** n_i = number of users with i in their CF positive set. */
  n: Float64Array;
  /** cooc[i*T+j] = number of users with both i and j in their CF positive sets. */
  cooc: Float64Array;
  starts: Float64Array;
  skips: Float64Array;
  playCount: Float64Array;
  maxPlayCount: number;
  /** Unit-length embeddings by track index (null when missing). */
  emb: (Float32Array | null)[];
  /** Same vectors keyed by track id, as the shared taste helpers expect. */
  embById: Map<string, Float32Array>;
  /** Distinct users shown each track in [UTC day start − 30 d, day start) (explore pool ordering, as repository.ts). */
  impressions: Float64Array;
  follows: Map<string, Set<string>>;
  prefs: Map<string, { genreIds: Set<string>; artistIds: Set<string> }>;
  taste: Map<string, Float64Array | null>;
  survey: Map<string, Float64Array | null>;
  cfBase: Map<string, Float64Array>;
};

function normalise(v: Float32Array): Float32Array {
  let s = 0;
  for (const x of v) s += x * x;
  const n = Math.sqrt(s);
  if (!n) return v;
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i += 1) out[i] = v[i] / n;
  return out;
}

const date = (ms: number | null): Date | null => (ms === null ? null : new Date(ms));

/** Aggregate pair → the shared TrackInteraction shape (what serving's loadInteractions returns). */
export function toInteraction(trackId: string, p: PairStat): TrackInteraction {
  return {
    trackId,
    likedAt: p.liked ? date(p.likedAt) : null,
    plays: p.plays,
    listenedAt: date(p.lastListenedAt),
    completes: p.completes,
    skips: p.skips,
    engagedAt: date(p.lastEventAt),
    inPlaylist: p.inPlaylist,
  };
}

/** Taste weight of a pair (shared interactionWeight). */
export function tasteWeight(p: PairStat, now: number): number {
  return interactionWeight(toInteraction('', p), new Date(now));
}

export function buildContext(s: Snapshot): FeatureContext {
  const T = s.tracks.length;
  const trackIdx = new Map(s.tracks.map((t, i) => [t.id, i]));
  const pairs = pairIndex(s);
  const cfSets = new Map<string, Set<number>>();
  const n = new Float64Array(T);
  const cooc = new Float64Array(T * T);
  const starts = new Float64Array(T);
  const skips = new Float64Array(T);
  for (const [user, m] of pairs) {
    const set = new Set<number>();
    for (const [trackId, p] of m) {
      const i = trackIdx.get(trackId);
      if (i === undefined) continue;
      starts[i] += p.starts;
      skips[i] += p.skips;
      if (isCfPositive(p)) set.add(i);
    }
    cfSets.set(user, set);
    const list = [...set];
    for (const i of list) {
      n[i] += 1;
      for (const j of list) if (i !== j) cooc[i * T + j] += 1;
    }
  }
  const playCount = Float64Array.from(s.tracks, (t) => t.playCount);
  const maxPlayCount = playCount.reduce((a, b) => Math.max(a, b), 0);
  const emb = s.tracks.map((t) => {
    const v = s.embeddings.get(t.id);
    return v ? normalise(v) : null;
  });
  const embById = new Map<string, Float32Array>();
  s.tracks.forEach((t, i) => {
    if (emb[i]) embById.set(t.id, emb[i]!);
  });
  const follows = new Map<string, Set<string>>();
  for (const f of s.follows) {
    let set = follows.get(f.userId);
    if (!set) follows.set(f.userId, (set = new Set()));
    set.add(f.authorId);
  }
  const prefs = new Map(
    s.preferences.map((p) => [p.userId, { genreIds: new Set(p.genreIds), artistIds: new Set(p.artistIds) }]),
  );
  return {
    now: s.now.getTime(),
    nowDate: s.now,
    tracks: s.tracks,
    trackIdx,
    pairs,
    cfSets,
    n,
    cooc,
    starts,
    skips,
    playCount,
    maxPlayCount,
    emb,
    embById,
    impressions: Float64Array.from(s.tracks, (t) => {
      const dayStart = Math.floor(s.now.getTime() / DAY_MS) * DAY_MS;
      const shown = s.impressions.filter((i) => i.trackId === t.id && i.shownAt.getTime() >= dayStart - 30 * DAY_MS && i.shownAt.getTime() < dayStart);
      return new Set(shown.map((i) => i.userId)).size;
    }),
    follows,
    prefs,
    taste: new Map(),
    survey: new Map(),
    cfBase: new Map(),
  };
}

function interactions(ctx: FeatureContext, user: string, excludeTrack: string | null): TrackInteraction[] {
  const out: TrackInteraction[] = [];
  for (const [trackId, p] of ctx.pairs.get(user) ?? [])
    if (trackId !== excludeTrack && ctx.trackIdx.has(trackId)) out.push(toInteraction(trackId, p));
  return out;
}

/** Survey cold start (repository.ts surveyTrackIds + shared meanVector). */
export function surveyTaste(ctx: FeatureContext, user: string): Float64Array | null {
  if (ctx.survey.has(user)) return ctx.survey.get(user)!;
  const pref = ctx.prefs.get(user);
  let v: Float64Array | null = null;
  if (pref && (pref.genreIds.size || pref.artistIds.size)) {
    const ids = ctx.tracks
      .map((t, i) => ({ t, i }))
      .filter(({ t }) => pref.artistIds.has(t.authorId) || t.genres.some((g) => pref.genreIds.has(g)))
      .sort((a, b) => ctx.playCount[b.i] - ctx.playCount[a.i] || (a.t.id < b.t.id ? -1 : 1))
      .slice(0, SURVEY_LIMIT)
      .map(({ t }) => t.id);
    v = meanVector(ids, ctx.embById);
  }
  ctx.survey.set(user, v);
  return v;
}

/** taste(u): shared tasteVector, else the survey cold start (engine.ts runPipeline). */
export function userTaste(ctx: FeatureContext, user: string, excludeTrack: string | null = null): Float64Array | null {
  if (excludeTrack === null && ctx.taste.has(user)) return ctx.taste.get(user)!;
  const v = tasteVector(interactions(ctx, user, excludeTrack), ctx.embById, ctx.nowDate) ?? surveyTaste(ctx, user);
  if (excludeTrack === null) ctx.taste.set(user, v);
  return v;
}

/** Serving eligibility (repository.ts unseenBy / rerank exclusion): not own, not liked, not listened in 14 days. */
export function servingEligible(ctx: FeatureContext, user: string, k: number): boolean {
  const t = ctx.tracks[k];
  if (t.authorId === user) return false;
  const p = ctx.pairs.get(user)?.get(t.id);
  if (!p) return true;
  if (p.liked) return false;
  return !(p.lastListenedAt !== null && ctx.now - p.lastListenedAt < RECENT_DAYS * DAY_MS);
}

/**
 * Raw CF score of every track, same formula as the serving SQL: Σ_{i∈S, i≠k} cooc_{−u}(i,k)/sqrt(n_i·n_k),
 * where cooc_{−u} excludes the user's own co-occurrence (= cooc − [k∈S]) and n counts every user.
 */
export function cfRaw(ctx: FeatureContext, user: string): Float64Array {
  const cached = ctx.cfBase.get(user);
  if (cached) return cached;
  const T = ctx.tracks.length;
  const out = new Float64Array(T);
  const seeds = ctx.cfSets.get(user) ?? new Set<number>();
  for (const i of seeds) {
    if (!ctx.n[i]) continue;
    for (let k = 0; k < T; k += 1) {
      if (k === i || !ctx.n[k]) continue;
      const c = ctx.cooc[i * T + k] - (seeds.has(k) ? 1 : 0);
      if (c > 0) out[k] += c / Math.sqrt(ctx.n[i] * ctx.n[k]);
    }
  }
  ctx.cfBase.set(user, out);
  return out;
}

/** engine.ts weightedGenres: Σ max(interactionWeight, inPlaylist ? 1 : 0) over positive pairs. */
const topCache = new WeakMap<FeatureContext, Map<string, Set<string>>>();
export function userTopGenres(ctx: FeatureContext, user: string, excludeTrack: string | null = null): Set<string> {
  let cache = topCache.get(ctx);
  if (!cache) topCache.set(ctx, (cache = new Map()));
  if (excludeTrack === null && cache.has(user)) return cache.get(user)!;
  const weights = new Map<string, number>();
  for (const item of interactions(ctx, user, excludeTrack)) {
    if (!isPositive(item)) continue;
    const w = Math.max(interactionWeight(item, ctx.nowDate), item.inPlaylist ? 1 : 0);
    if (w <= 0) continue;
    for (const g of ctx.tracks[ctx.trackIdx.get(item.trackId)!].genres) weights.set(g, (weights.get(g) ?? 0) + w);
  }
  const top = topGenresOf(weights);
  if (excludeTrack === null) cache.set(user, top);
  return top;
}

export type FeatureOptions = {
  /** Remove the (user, track) pair's own interactions from every statistic (training only). */
  leavePairOut?: boolean;
};

/**
 * Raw inputs of buildFeatures for (user, track j). With leavePairOut the pair's own like/listen/
 * engagement/playlist rows are removed from CF, taste, top genres, play count and skip statistics,
 * i.e. the inputs serving would see had the pair never happened. cf max = max raw CF over the user's
 * serving-eligible tracks, which is what serving's cfFeature(score, maxCfScore) divides by.
 */
export function featureInput(ctx: FeatureContext, user: string, j: number, opts: FeatureOptions = {}): FeatureInput {
  const T = ctx.tracks.length;
  const track = ctx.tracks[j];
  const pair = ctx.pairs.get(user)?.get(track.id);
  const lpo = !!opts.leavePairOut && !!pair;
  const seeds = ctx.cfSets.get(user) ?? new Set<number>();
  const jIsSeed = lpo && seeds.has(j);

  const base = cfRaw(ctx, user);
  const rawFor = (k: number): number => {
    if (!jIsSeed) return base[k];
    if (k === j) {
      const nj = ctx.n[j] - 1;
      if (nj <= 0) return 0;
      let s = 0;
      for (const i of seeds) {
        if (i === j || !ctx.n[i]) continue;
        const c = ctx.cooc[i * T + j] - 1;
        if (c > 0) s += c / Math.sqrt(ctx.n[i] * nj);
      }
      return s;
    }
    const c = ctx.cooc[j * T + k] - (seeds.has(k) ? 1 : 0);
    return c > 0 && ctx.n[k] ? base[k] - c / Math.sqrt(ctx.n[j] * ctx.n[k]) : base[k];
  };
  let maxCf = 0;
  for (let k = 0; k < T; k += 1) {
    if (!(lpo && k === j) && !servingEligible(ctx, user, k)) continue;
    const r = rawFor(k);
    if (r > maxCf) maxCf = r;
  }

  const e = ctx.emb[j];
  const taste = e ? userTaste(ctx, user, lpo ? track.id : null) : null;
  const pref = ctx.prefs.get(user);
  const skips = Math.max(0, ctx.skips[j] - (lpo ? pair!.skips : 0));
  return {
    cfScore: rawFor(j),
    maxCfScore: maxCf,
    contentCosine: taste && e ? cosine(taste, e) : null,
    followsArtist: !!ctx.follows.get(user)?.has(track.authorId),
    surveyMatch: !!pref && (pref.artistIds.has(track.authorId) || track.genres.some((g) => pref.genreIds.has(g))),
    trackGenres: track.genres,
    topGenres: userTopGenres(ctx, user, lpo ? track.id : null),
    playCount: Math.max(0, ctx.playCount[j] - (lpo ? pair!.plays : 0)),
    maxPlayCount: ctx.maxPlayCount,
    publishedAt: track.publishedAt,
    skips,
    starts: Math.max(skips, ctx.starts[j] - (lpo ? pair!.starts : 0)),
    now: ctx.nowDate,
  };
}

/** Feature vector via the shared buildFeatures. */
export function features(ctx: FeatureContext, user: string, j: number, opts: FeatureOptions = {}): Features {
  return buildFeatures(featureInput(ctx, user, j, opts));
}

export const toArray = (f: Features): number[] => featureVector(f);
export { cosine };
