// Hybrid 3-tier pipeline: candidates (CF, content, follow, trending) → LR ranker → re-rank + reasons.
// Any missing prerequisite returns a typed failure; public entry points map it to null (caller falls back).
import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@infosound/database';
import { loadEmbeddingIndex, type EmbeddingIndex } from './embeddings';
import { buildFeatures, FEATURE_ORDER, topGenres, type Features } from './feature-set';
import { cosine, dailySeed } from './math';
import { contentCandidates } from './vectors';
import {
  pickReason,
  sourceContributions,
  type CandidateSource,
  type RecoReason,
  type SourceContributions,
} from './reasons';
import {
  cfCandidates,
  daysBefore,
  explorePool,
  followCandidates,
  LIMITS,
  loadActiveModel,
  loadFollowedArtists,
  loadInteractions,
  loadLikedIds,
  loadSkippedIds,
  loadSurvey,
  maxPublicPlayCount,
  RECENT_DAYS,
  surveyTrackIds,
  trackMetadata,
  trendingCandidates,
  type Db,
  type InteractionRow,
  type TrackMeta,
} from './repository';
import { rerank, type Decision, type DropReason, type RankedCandidate, type Selected } from './rerank';
import { assembleShelves, type RecoItem, type Shelf } from './shelves';
import { modelWeightsInOrder, parseModel, scoreFeatures, type RankerModel } from './scoring';
import { interactionWeight, isPositive, meanVector, tasteVector } from './taste';

export const MIN_INTERACTIONS = 3;
export const MAX_CANDIDATES = 150;
export const SHELF_SIZE = 10;

export type { RecoReason } from './reasons';
export type { RecoItem, Shelf, ShelfKind } from './shelves';
export type ExplainCandidate = {
  trackId: string;
  title: string;
  artistName: string;
  sources: string[];
  features: Record<string, number>;
  score: number;
  decision: 'SELECTED' | 'DROPPED';
  dropReason?: DropReason;
  position?: number;
};
export type RecoResult = { requestId: string; modelVersion: string; items: RecoItem[]; explain: ExplainCandidate[] };
export type Shelves = { requestId: string; modelVersion: string; shelves: Shelf[] };
export type FallbackReason = 'NO_MODEL' | 'NO_EMBEDDINGS' | 'FEW_INTERACTIONS' | 'NO_CANDIDATES' | 'ERROR';
export type ExplainPayload = {
  requestId: string | null;
  modelVersion: string | null;
  featureNames: string[];
  weights: number[];
  bias: number;
  fallback: boolean;
  fallbackReason?: FallbackReason;
  candidates: ExplainCandidate[];
};
export type RecoOptions = {
  limit?: number;
  now?: Date;
  /** Receives unexpected errors before the null fallback; never forward error text to clients. */
  onError?: (error: unknown) => void;
};

type Scored = RankedCandidate & {
  meta: TrackMeta;
  features: Features;
  contributions: SourceContributions;
  cfSeedId: string | null;
};
type Context = {
  userId: string;
  now: Date;
  model: RankerModel;
  index: EmbeddingIndex;
  interactions: InteractionRow[];
  liked: Set<string>;
  recent: Set<string>;
  skipped: Set<string>;
  candidates: Scored[];
  /** Explain-only: recently skipped tracks the candidate SQL already excluded (never ranked or served). */
  skippedOnly: Scored[];
};
type Pipeline = { ok: true; context: Context } | { ok: false; reason: FallbackReason; model: RankerModel | null };

const fail = (reason: FallbackReason, model: RankerModel | null): Pipeline => ({ ok: false, reason, model });

function weightedGenres(interactions: readonly InteractionRow[], now: Date): Map<string, number> {
  const weights = new Map<string, number>();
  for (const item of interactions) {
    if (!isPositive(item)) continue;
    const weight = Math.max(interactionWeight(item, now), item.inPlaylist ? 1 : 0);
    if (weight <= 0) continue;
    for (const genre of item.genres) weights.set(genre, (weights.get(genre) ?? 0) + weight);
  }
  return weights;
}

async function runPipeline(db: Db, userId: string, now: Date): Promise<Pipeline> {
  const model = parseModel(await loadActiveModel(db));
  if (!model) return fail('NO_MODEL', null);
  const [index, interactions, survey, followedList, likedIds, skippedIds] = await Promise.all([
    loadEmbeddingIndex(db, now.getTime()),
    loadInteractions(db, userId),
    loadSurvey(db, userId),
    loadFollowedArtists(db, userId),
    loadLikedIds(db, userId),
    loadSkippedIds(db, userId, now),
  ]);
  if (index.vectors.size === 0) return fail('NO_EMBEDDINGS', model);
  if (interactions.length < MIN_INTERACTIONS) return fail('FEW_INTERACTIONS', model);

  const recentSince = daysBefore(now, RECENT_DAYS).getTime();
  const liked = new Set(likedIds);
  const skipped = new Set(skippedIds);
  const recent = new Set(
    interactions.filter((i) => i.listenedAt && i.listenedAt.getTime() >= recentSince).map((i) => i.trackId),
  );
  const taste =
    tasteVector(interactions, index.vectors, now) ??
    meanVector(await surveyTrackIds(db, survey), index.vectors);

  const [cf, follow, trending, explore, maxPlayCount] = await Promise.all([
    cfCandidates(db, userId, now),
    followCandidates(db, userId),
    trendingCandidates(db, now),
    explorePool(db, userId, now),
    maxPublicPlayCount(db),
  ]);
  const content = taste
    ? contentCandidates(taste, index.vectors, new Set([...liked, ...recent, ...skipped]), LIMITS.content)
    : [];

  const sources = new Map<string, Set<CandidateSource>>();
  const add = (trackId: string, source: CandidateSource) => {
    const set = sources.get(trackId) ?? new Set<CandidateSource>();
    set.add(source);
    sources.set(trackId, set);
  };
  cf.slice(0, LIMITS.cf).forEach((row) => add(row.trackId, 'CF'));
  content.forEach((row) => add(row.trackId, 'CONTENT'));
  follow.slice(0, LIMITS.follow).forEach((id) => add(id, 'FOLLOW'));
  trending.slice(0, LIMITS.trending).forEach((id) => add(id, 'TRENDING'));
  [...sources.keys()].slice(MAX_CANDIDATES).forEach((id) => sources.delete(id));
  // The exploration pool only contributes tracks no other source found (explore-only candidates).
  explore.filter((id) => !sources.has(id)).slice(0, LIMITS.explore).forEach((id) => add(id, 'EXPLORE'));

  const skippedOnlyIds = new Set(skippedIds.filter((id) => !sources.has(id)));
  const metadata = await trackMetadata(db, [...sources.keys(), ...skippedOnlyIds]);
  const cfById = new Map(cf.map((row) => [row.trackId, row]));
  const maxCfScore = cf.reduce((max, row) => Math.max(max, Number(row.score) || 0), 0);
  const followed = new Set(followedList);
  const surveyGenres = new Set(survey.genreIds);
  const surveyArtists = new Set(survey.artistIds);
  const genresOfUser = topGenres(weightedGenres(interactions, now));
  const contentCosine = (trackId: string) => {
    const vector = index.vectors.get(trackId);
    return taste && vector ? cosine(taste, vector) : null;
  };

  const scored: Scored[] = metadata.map((meta) => {
    const cfRow = cfById.get(meta.trackId);
    const features = buildFeatures({
      cfScore: Number(cfRow?.score ?? 0),
      maxCfScore,
      contentCosine: contentCosine(meta.trackId),
      followsArtist: followed.has(meta.artistId),
      surveyMatch: surveyArtists.has(meta.artistId) || meta.genres.some((genre) => surveyGenres.has(genre)),
      trackGenres: meta.genres,
      topGenres: genresOfUser,
      playCount: Number(meta.playCount),
      maxPlayCount,
      publishedAt: meta.publishedAt,
      skips: Number(meta.skips),
      starts: Number(meta.starts),
      now,
    });
    const candidateSources = [...(sources.get(meta.trackId) ?? [])];
    return {
      trackId: meta.trackId,
      artistId: meta.artistId,
      score: scoreFeatures(model, features),
      sources: candidateSources,
      meta,
      features,
      contributions: sourceContributions(candidateSources, features, model),
      cfSeedId: cfRow?.seedId ?? null,
      // Content-guided EXPLORE pick; undefined without an embedding/taste ⇒ seeded-random fallback.
      ...(candidateSources.length === 1 && candidateSources[0] === 'EXPLORE' && contentCosine(meta.trackId) !== null
        ? { exploreScore: features.content_sim }
        : {}),
    };
  });
  const candidates = scored.filter((c) => !skippedOnlyIds.has(c.trackId));
  const skippedOnly = scored.filter((c) => skippedOnlyIds.has(c.trackId));
  if (!candidates.length) return fail('NO_CANDIDATES', model);
  return {
    ok: true,
    context: { userId, now, model, index, interactions, liked, recent, skipped, candidates, skippedOnly },
  };
}

/** Title of the liked (else positive) track most similar to the candidate; null without embeddings. */
function similarSeedTitle(context: Context, trackId: string): string | null {
  const vector = context.index.vectors.get(trackId);
  if (!vector) return null;
  const pool = context.interactions.filter((i) => i.likedAt);
  let best: { title: string; value: number } | null = null;
  for (const item of pool.length ? pool : context.interactions.filter(isPositive)) {
    const seed = context.index.vectors.get(item.trackId);
    if (!seed || item.trackId === trackId) continue;
    const value = cosine(seed, vector);
    if (!best || value > best.value) best = { title: item.title, value };
  }
  return best?.title ?? null;
}

function titleOf(context: Context, trackId: string | null): string | null {
  if (!trackId) return null;
  return context.interactions.find((item) => item.trackId === trackId)?.title ?? null;
}

function toItem(context: Context, candidate: Selected<Scored>): RecoItem {
  const reason = pickReason({
    sources: candidate.sources,
    contributions: candidate.contributions,
    explore: candidate.explore,
    cfSeedTitle: titleOf(context, candidate.cfSeedId),
    similarSeedTitle: candidate.sources.includes('CONTENT') ? similarSeedTitle(context, candidate.trackId) : null,
  });
  return { trackId: candidate.trackId, ...reason, score: candidate.score, sources: [...candidate.sources] };
}

function explainCandidates(context: Context, decisions: Map<string, Decision>): ExplainCandidate[] {
  for (const candidate of context.skippedOnly)
    decisions.set(candidate.trackId, { decision: 'DROPPED', dropReason: 'SKIPPED' });
  return [...context.candidates, ...context.skippedOnly]
    .sort((a, b) => b.score - a.score || (a.trackId < b.trackId ? -1 : 1))
    .map((candidate) => {
      const decision = decisions.get(candidate.trackId) ?? { decision: 'DROPPED', dropReason: 'BELOW_CUTOFF' };
      return {
        trackId: candidate.trackId,
        title: candidate.meta.title,
        artistName: candidate.meta.artistName,
        sources: [...candidate.sources],
        features: { ...candidate.features },
        score: candidate.score,
        decision: decision.decision,
        ...(decision.dropReason ? { dropReason: decision.dropReason } : {}),
        ...(decision.position ? { position: decision.position } : {}),
      };
    });
}

function rerankFor(context: Context, candidates: readonly Scored[], limit: number, explore: boolean, maxPerArtist = 1) {
  return rerank(candidates, {
    limit,
    explore,
    maxPerArtist,
    seed: dailySeed(context.userId, context.now),
    userId: context.userId,
    liked: context.liked,
    recent: context.recent,
    skipped: context.skipped,
  });
}

const clampLimit = (limit: number | undefined) => Math.max(1, Math.min(SHELF_SIZE, Math.floor(limit ?? 5)));

async function safely<T>(options: RecoOptions | undefined, run: () => Promise<T | null>): Promise<T | null> {
  try {
    return await run();
  } catch (error) {
    options?.onError?.(error);
    return null;
  }
}

export function hybridRecommendations(
  db: PrismaClient,
  userId: string,
  opts?: RecoOptions,
): Promise<RecoResult | null> {
  return safely(opts, async () => {
    const run = await runPipeline(db, userId, opts?.now ?? new Date());
    if (!run.ok) return null;
    const context = run.context;
    const { selected, decisions } = rerankFor(context, context.candidates, clampLimit(opts?.limit), true);
    if (!selected.length) return null;
    return {
      requestId: randomUUID(),
      modelVersion: context.model.version,
      items: selected.map((candidate) => toItem(context, candidate)),
      explain: explainCandidates(context, decisions),
    };
  });
}

export function recommendationShelves(
  db: PrismaClient,
  userId: string,
  opts?: RecoOptions,
): Promise<Shelves | null> {
  return safely(opts, async () => {
    const run = await runPipeline(db, userId, opts?.now ?? new Date());
    if (!run.ok) return null;
    const context = run.context;
    // FOR_YOU (with explore) first; LISTENED, FOLLOW, TRENDING then fill from the remaining candidates.
    const shelves: Shelf[] = assembleShelves(context.candidates, {
      size: SHELF_SIZE,
      rerank: (candidates, limit, explore, maxPerArtist) =>
        rerankFor(context, candidates, limit, explore, maxPerArtist).selected,
      toItem: (candidate) => toItem(context, candidate),
      titleOf: (trackId) => titleOf(context, trackId),
    });
    if (!shelves.length) return null;
    return { requestId: randomUUID(), modelVersion: context.model.version, shelves };
  });
}

/** Debug view for the current user only (scores included); the API gates it behind an env flag. */
export async function recommendationExplain(
  db: PrismaClient,
  userId: string,
  opts?: RecoOptions,
): Promise<ExplainPayload> {
  let run: Pipeline;
  try {
    run = await runPipeline(db, userId, opts?.now ?? new Date());
  } catch (error) {
    opts?.onError?.(error);
    run = fail('ERROR', null);
  }
  const model = run.ok ? run.context.model : run.model;
  const base = {
    modelVersion: model?.version ?? null,
    featureNames: [...FEATURE_ORDER],
    weights: model ? modelWeightsInOrder(model) : [],
    bias: model?.bias ?? 0,
  };
  if (!run.ok) return { requestId: null, ...base, fallback: true, fallbackReason: run.reason, candidates: [] };
  const context = run.context;
  const { selected, decisions } = rerankFor(context, context.candidates, clampLimit(opts?.limit), true);
  return {
    requestId: randomUUID(),
    ...base,
    fallback: selected.length === 0,
    ...(selected.length === 0 ? { fallbackReason: 'NO_CANDIDATES' as const } : {}),
    candidates: explainCandidates(context, decisions),
  };
}
