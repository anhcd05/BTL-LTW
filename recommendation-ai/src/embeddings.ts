// Per-process cache of public track embeddings (unit length), refreshed after a short TTL.
import { loadPublicEmbeddings, type Db } from './repository';
import { buildIndex, type EmbeddingIndex } from './vectors';

export const EMBEDDING_TTL_MS = 60_000;
export type { EmbeddingIndex } from './vectors';

type Entry = { loadedAt: number; value: Promise<EmbeddingIndex> };
const cache = new WeakMap<object, Entry>();

export function loadEmbeddingIndex(db: Db, nowMs = Date.now()): Promise<EmbeddingIndex> {
  const entry = cache.get(db);
  if (entry && nowMs - entry.loadedAt < EMBEDDING_TTL_MS) return entry.value;
  const value = loadPublicEmbeddings(db).then(buildIndex);
  cache.set(db, { loadedAt: nowMs, value });
  // A failed load must not be cached for the whole TTL.
  value.catch(() => {
    if (cache.get(db)?.value === value) cache.delete(db);
  });
  return value;
}

export function clearEmbeddingCache(db: Db): void {
  cache.delete(db);
}
