// Server entry point (`@infosound/recommendation-ai/server`). Importing it loads @infosound/database.
export {
  hybridRecommendations,
  recommendationShelves,
  recommendationExplain,
  MIN_INTERACTIONS,
  MAX_CANDIDATES,
  SHELF_SIZE,
} from './engine';
export type {
  RecoItem,
  RecoResult,
  RecoReason,
  RecoOptions,
  ExplainCandidate,
  ExplainPayload,
  FallbackReason,
  Shelf,
  ShelfKind,
  Shelves,
} from './engine';
export {
  recordEngagement,
  recordImpressions,
  recordClick,
  engagementTimingValid,
  terminalTokenId,
} from './tracking';
export type { EngagementEvent, EngagementStatus, EngagementInput, ImpressionInput, ClickInput } from './tracking';
export { maxTerminalAgeMs, LISTEN_TOKEN_TTL_MS } from './engagement-rules';
export { signImpressionToken, verifyImpressionToken, IMPRESSION_TOKEN_TTL_MS } from './impression-token';
export type { ImpressionClaims, ServedItem } from './impression-token';
export { clearEmbeddingCache } from './embeddings';
export { buildIndex, contentCandidates } from './vectors';
export type { EmbeddingIndex, EmbeddingRow } from './vectors';
export * from './feature-set';
export * from './math';
export * from './scoring';
export * from './taste';
export { pickReason, sourceContributions, SOURCE_REASON } from './reasons';
export type { CandidateSource } from './reasons';
export { rerank, pickExplore, isExploreOnly, exclusionReason } from './rerank';
export type { DropReason, RankedCandidate, RerankOptions, RerankResult } from './rerank';
