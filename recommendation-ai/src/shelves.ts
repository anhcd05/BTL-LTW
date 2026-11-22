// Shelf assembly (pure, no DB): FOR_YOU first, then LISTENED ("because you listened to X"), FOLLOW, TRENDING.
// Every later shelf only draws from candidates not already placed on an earlier shelf, so no track is served twice.
import type { RecoReason } from './reasons';
import type { RankedCandidate, Selected } from './rerank';

export type RecoItem = { trackId: string; reason: RecoReason; seedTitle?: string; score: number; sources: string[] };
export type ShelfKind = 'LISTENED' | 'FOLLOW' | 'TRENDING' | 'FOR_YOU';
export type Shelf = { kind: ShelfKind; seedTitle?: string; items: RecoItem[] };
export const SHELF_ORDER: readonly ShelfKind[] = ['FOR_YOU', 'LISTENED', 'FOLLOW', 'TRENDING'];

export type ShelfCandidate = RankedCandidate & { cfSeedId: string | null };
export type ShelfDeps<T extends ShelfCandidate> = {
  size: number;
  /** The shared re-rank (exclusions, artist cap, explore slot), bound to the user's context. */
  rerank: (candidates: readonly T[], limit: number, explore: boolean, maxPerArtist: number) => Selected<T>[];
  /** Full reason selection for FOR_YOU items. */
  toItem: (candidate: Selected<T>) => RecoItem;
  /** Title of a seed track from the user's own history (null when unknown). */
  titleOf: (trackId: string | null) => string | null;
};

export function assembleShelves<T extends ShelfCandidate>(all: readonly T[], deps: ShelfDeps<T>): Shelf[] {
  const placed = new Set<string>();
  const remaining = (predicate: (candidate: T) => boolean) =>
    all.filter((candidate) => !placed.has(candidate.trackId) && predicate(candidate));
  const place = (selected: readonly Selected<T>[]) => selected.forEach((candidate) => placed.add(candidate.trackId));
  const plain = (candidate: T, reason: RecoReason, seedTitle?: string): RecoItem => ({
    trackId: candidate.trackId,
    reason,
    ...(seedTitle ? { seedTitle } : {}),
    score: candidate.score,
    sources: [...candidate.sources],
  });
  const shelves: Shelf[] = [];

  const forYou = deps.rerank(all, deps.size, true, 1);
  place(forYou);
  if (forYou.length) shelves.push({ kind: 'FOR_YOU', items: forYou.map((candidate) => deps.toItem(candidate)) });

  const fromCf = (candidate: T) => candidate.sources.includes('CF') && candidate.cfSeedId !== null;
  const seedId = deps.rerank(remaining(fromCf), deps.size, false, 1)[0]?.cfSeedId ?? null;
  const seedTitle = deps.titleOf(seedId);
  if (seedId && seedTitle) {
    const bySeed = deps.rerank(remaining((c) => fromCf(c) && c.cfSeedId === seedId), deps.size, false, 2);
    place(bySeed);
    if (bySeed.length)
      shelves.push({ kind: 'LISTENED', seedTitle, items: bySeed.map((c) => plain(c, 'LISTENED', seedTitle)) });
  }

  for (const kind of ['FOLLOW', 'TRENDING'] as const) {
    const ranked = deps.rerank(remaining((c) => c.sources.includes(kind)), deps.size, false, kind === 'FOLLOW' ? 3 : 1);
    place(ranked);
    if (ranked.length) shelves.push({ kind, items: ranked.map((c) => plain(c, kind)) });
  }
  return shelves;
}
