// User taste vector: weighted, time-decayed sum of the embeddings of tracks the user interacted with.
import { normalize, type Vector } from './math';

const DAY_MS = 86_400_000;
export const TASTE_HALF_LIFE_DAYS = 30;
export const TASTE_WEIGHTS = { like: 3, complete: 2, listen: 1, skip: -1 } as const;

export type TrackInteraction = {
  trackId: string;
  likedAt: Date | null;
  plays: number;
  listenedAt: Date | null;
  completes: number;
  skips: number;
  engagedAt: Date | null;
  inPlaylist: boolean;
};

/** 0.5^(age / half-life); a missing or future timestamp counts as "now". */
export function decay(at: Date | null, now: Date, halfLifeDays = TASTE_HALF_LIFE_DAYS): number {
  if (!at) return 1;
  const ageDays = Math.max(0, (now.getTime() - at.getTime()) / DAY_MS);
  return Math.pow(0.5, ageDays / halfLifeDays);
}

/** Most recent timestamp of any signal on the pair (null when none is known). */
export function lastInteractionAt(item: TrackInteraction): Date | null {
  let latest: Date | null = null;
  for (const at of [item.likedAt, item.listenedAt, item.engagedAt])
    if (at && (!latest || at.getTime() > latest.getTime())) latest = at;
  return latest;
}

/**
 * (like 3 + complete 2 + listen 1·log1p(plays) + skip −1) · 0.5^(age/30d), with age taken from the
 * pair's most recent interaction — the same definition the trainer (recommendation-ai/batch) uses.
 */
export function interactionWeight(item: TrackInteraction, now: Date): number {
  let weight = 0;
  if (item.likedAt) weight += TASTE_WEIGHTS.like;
  if (item.completes > 0) weight += TASTE_WEIGHTS.complete;
  if (item.plays > 0) weight += TASTE_WEIGHTS.listen * Math.log1p(item.plays);
  if (item.skips > 0) weight += TASTE_WEIGHTS.skip;
  return weight === 0 ? 0 : weight * decay(lastInteractionAt(item), now);
}

/** A track counts towards CF seeds / top genres when the user showed a positive signal. */
export function isPositive(item: TrackInteraction): boolean {
  return item.likedAt !== null || item.plays > 0 || item.completes > 0 || item.inPlaylist;
}

/**
 * Σ w·emb(i), returned unit-length. Null when no interacted track has an embedding or the
 * weighted sum is zero / dominated by skips (caller then uses the survey cold start).
 */
export function tasteVector(
  interactions: readonly TrackInteraction[],
  embeddings: ReadonlyMap<string, Vector>,
  now: Date,
): Float64Array | null {
  let sum: Float64Array | null = null;
  let positiveMass = 0;
  for (const item of interactions) {
    const embedding = embeddings.get(item.trackId);
    if (!embedding) continue;
    const weight = interactionWeight(item, now);
    if (weight === 0) continue;
    if (!sum) sum = new Float64Array(embedding.length);
    if (embedding.length !== sum.length) continue;
    if (weight > 0) positiveMass += weight;
    for (let i = 0; i < sum.length; i++) sum[i] += weight * embedding[i]!;
  }
  if (!sum || positiveMass === 0) return null;
  return normalize(sum);
}

/** Unit-length mean of the given embeddings (survey cold start); null when none are available. */
export function meanVector(ids: Iterable<string>, embeddings: ReadonlyMap<string, Vector>): Float64Array | null {
  let sum: Float64Array | null = null;
  for (const id of ids) {
    const embedding = embeddings.get(id);
    if (!embedding) continue;
    if (!sum) sum = new Float64Array(embedding.length);
    if (embedding.length !== sum.length) continue;
    for (let i = 0; i < sum.length; i++) sum[i] += embedding[i]!;
  }
  return sum ? normalize(sum) : null;
}
