// DB-free entry point (`@infosound/recommendation-ai/features`): pure feature, scoring, taste,
// re-rank and reason logic shared with recommendation-ai/batch. It must never import
// @infosound/database, ./repository, ./engine, ./tracking or ./embeddings (guarded by a unit test).
export * from './feature-set';
export { cosine, sigmoid, seededRandom, dailySeed, dot, norm, normalize, clamp01, hashString } from './math';
export type { Vector } from './math';
export { parseModel, scoreFeatures, linearScore, modelWeightsInOrder } from './scoring';
export type { RankerModel, ModelRow } from './scoring';
export {
  tasteVector,
  meanVector,
  interactionWeight,
  lastInteractionAt,
  decay,
  isPositive,
  TASTE_WEIGHTS,
  TASTE_HALF_LIFE_DAYS,
} from './taste';
export type { TrackInteraction } from './taste';
export { pickReason, sourceContributions, SOURCE_PRIORITY, SOURCE_FEATURE, SOURCE_REASON } from './reasons';
export type { CandidateSource, RecoReason, SourceContributions, ReasonInput } from './reasons';
export { rerank, pickExplore, isExploreOnly, exclusionReason, byScore } from './rerank';
export type { DropReason, RankedCandidate, RerankOptions, RerankResult, Decision, Selected } from './rerank';
export { buildIndex, contentCandidates } from './vectors';
export type { EmbeddingIndex, EmbeddingRow } from './vectors';
export {
  engagementTimingValid,
  terminalTokenId,
  SKIP_MAX_SECONDS,
  COMPLETE_FRACTION,
  LISTEN_TOKEN_TTL_MS,
  maxTerminalAgeMs,
} from './engagement-rules';
export type { EngagementEvent } from './engagement-rules';
export { signImpressionToken, verifyImpressionToken, IMPRESSION_TOKEN_TTL_MS } from './impression-token';
export type { ImpressionClaims, ServedItem } from './impression-token';
