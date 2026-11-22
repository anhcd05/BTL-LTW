// Tier 3: business rules on top of the ranker score. Pure and deterministic for a given seed.
import { seededRandom } from './math';
import type { CandidateSource } from './reasons';

export type DropReason = 'LIKED' | 'RECENT' | 'OWN' | 'SKIPPED' | 'ARTIST_CAP' | 'BELOW_CUTOFF';

export type RankedCandidate = {
  trackId: string;
  artistId: string;
  score: number;
  sources: readonly CandidateSource[];
  /**
   * Content-guided exploration: for explore-only candidates, the engine sets this to features.content_sim
   * when the track has an embedding (and the user a taste vector); undefined otherwise.
   */
  exploreScore?: number;
};

export type RerankOptions = {
  limit: number;
  /** Maximum selected items per artist (default 1). */
  maxPerArtist?: number;
  /** Reserve the last slot for an exploration pick when enough regular candidates exist. */
  explore: boolean;
  /** Seed for the exploration pick, e.g. dailySeed(userId, now). */
  seed: string;
  userId: string;
  liked: ReadonlySet<string>;
  recent: ReadonlySet<string>;
  /** Tracks this user recently skipped more than completed (last 14 days). */
  skipped?: ReadonlySet<string>;
};

export type Decision = {
  decision: 'SELECTED' | 'DROPPED';
  dropReason?: DropReason;
  position?: number;
};

export type Selected<T extends RankedCandidate> = T & { position: number; explore: boolean };

export type RerankResult<T extends RankedCandidate> = {
  selected: Selected<T>[];
  decisions: Map<string, Decision>;
};

/** Explore-pool members are candidates that only came from the exploration source. */
export function isExploreOnly(candidate: Pick<RankedCandidate, 'sources'>): boolean {
  return candidate.sources.length > 0 && candidate.sources.every((source) => source === 'EXPLORE');
}

export function exclusionReason(
  candidate: RankedCandidate,
  options: Pick<RerankOptions, 'userId' | 'liked' | 'recent' | 'skipped'>,
): DropReason | null {
  if (options.liked.has(candidate.trackId)) return 'LIKED';
  if (candidate.artistId === options.userId) return 'OWN';
  if (options.recent.has(candidate.trackId)) return 'RECENT';
  if (options.skipped?.has(candidate.trackId)) return 'SKIPPED';
  return null;
}

export function byScore(a: RankedCandidate, b: RankedCandidate): number {
  return b.score - a.score || (a.trackId < b.trackId ? -1 : a.trackId > b.trackId ? 1 : 0);
}

/**
 * exclude liked / own / listened in the last 14 days / recently skipped → sort by score → ≤ maxPerArtist per artist →
 * `limit` slots; the last slot is EXPLORE when ≥ limit−1 regular items survive and the pool has an
 * eligible track by a not-yet-selected artist. See pickExplore for the (deterministic) choice.
 */
/**
 * EXPLORE pick (item cold start, "Release Radar"-style): the eligible pool track with the highest
 * exploreScore (content similarity); ties broken by the seeded random. If no eligible track has a score
 * (no embeddings), a seeded-random pick over all eligible tracks. Deterministic per seed.
 */
export function pickExplore<T extends RankedCandidate>(eligible: readonly T[], seed: string): T | null {
  if (!eligible.length) return null;
  const sorted = [...eligible].sort((a, b) => (a.trackId < b.trackId ? -1 : a.trackId > b.trackId ? 1 : 0));
  const scored = sorted.filter((c) => typeof c.exploreScore === 'number' && Number.isFinite(c.exploreScore));
  let pool: readonly T[] = sorted;
  if (scored.length) {
    const best = Math.max(...scored.map((c) => c.exploreScore!));
    pool = scored.filter((c) => c.exploreScore === best);
  }
  const random = seededRandom(seed);
  return pool[Math.floor(random() * pool.length)]!;
}

export function rerank<T extends RankedCandidate>(
  candidates: readonly T[],
  options: RerankOptions,
): RerankResult<T> {
  const limit = Math.max(0, Math.floor(options.limit));
  const maxPerArtist = Math.max(1, options.maxPerArtist ?? 1);
  const decisions = new Map<string, Decision>();
  const seen = new Set<string>();
  const regular: T[] = [];
  const pool: T[] = [];
  for (const candidate of candidates) {
    if (seen.has(candidate.trackId)) continue;
    seen.add(candidate.trackId);
    const dropReason = exclusionReason(candidate, options);
    if (dropReason) {
      decisions.set(candidate.trackId, { decision: 'DROPPED', dropReason });
      continue;
    }
    (isExploreOnly(candidate) ? pool : regular).push(candidate);
  }
  regular.sort(byScore);

  // Artist cap first so the explore rule counts what could actually be shown.
  const perArtist = new Map<string, number>();
  const capped: T[] = [];
  for (const candidate of regular) {
    const count = perArtist.get(candidate.artistId) ?? 0;
    if (count >= maxPerArtist) {
      decisions.set(candidate.trackId, { decision: 'DROPPED', dropReason: 'ARTIST_CAP' });
      continue;
    }
    perArtist.set(candidate.artistId, count + 1);
    capped.push(candidate);
  }

  let exploreSlot = options.explore && limit >= 2 && capped.length >= limit - 1;
  const regularSlots = exploreSlot ? limit - 1 : limit;
  const chosen = capped.slice(0, regularSlots);
  for (const candidate of capped.slice(regularSlots))
    decisions.set(candidate.trackId, { decision: 'DROPPED', dropReason: 'BELOW_CUTOFF' });

  let explorePick: T | null = null;
  if (exploreSlot) {
    const chosenArtists = new Set(chosen.map((candidate) => candidate.artistId));
    explorePick = pickExplore(
      pool.filter((candidate) => !chosenArtists.has(candidate.artistId)),
      options.seed,
    );
    if (!explorePick) exploreSlot = false;
  }
  if (!exploreSlot && options.explore && regularSlots < limit) {
    // No eligible exploration track: give the reserved slot back to the next regular item.
    const next = capped[regularSlots];
    if (next) {
      chosen.push(next);
      decisions.delete(next.trackId);
    }
  }
  for (const candidate of pool)
    if (candidate !== explorePick)
      decisions.set(candidate.trackId, { decision: 'DROPPED', dropReason: 'BELOW_CUTOFF' });

  const selected: Selected<T>[] = chosen.map((candidate, index) => ({
    ...candidate,
    position: index + 1,
    explore: false,
  }));
  if (explorePick) selected.push({ ...explorePick, position: selected.length + 1, explore: true });
  for (const item of selected)
    decisions.set(item.trackId, { decision: 'SELECTED', position: item.position });
  return { selected, decisions };
}
