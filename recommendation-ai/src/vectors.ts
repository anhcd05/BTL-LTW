// Pure vector-index helpers (no I/O): embedding index construction and content candidate search.
import { dot, normalize } from './math';

export type EmbeddingRow = { trackId: string; model: string; dims: number; vector: number[] };
export type EmbeddingIndex = { model: string; dims: number; vectors: Map<string, Float64Array> };

/** Keeps only the dominant (model, dims) pair so vectors from a stale model never mix; unit length. */
export function buildIndex(rows: readonly EmbeddingRow[]): EmbeddingIndex {
  const groups = new Map<string, number>();
  for (const row of rows) {
    const key = `${row.model}\u0000${row.dims}`;
    groups.set(key, (groups.get(key) ?? 0) + 1);
  }
  let bestKey: string | null = null;
  let bestCount = 0;
  for (const [key, count] of groups)
    if (count > bestCount || (count === bestCount && (bestKey === null || key < bestKey))) {
      bestKey = key;
      bestCount = count;
    }
  const vectors = new Map<string, Float64Array>();
  if (bestKey === null) return { model: '', dims: 0, vectors };
  const [model, dimsText] = bestKey.split('\u0000') as [string, string];
  const dims = Number(dimsText);
  for (const row of rows) {
    if (row.model !== model || row.dims !== dims || !Array.isArray(row.vector) || row.vector.length !== dims) continue;
    const unit = normalize(row.vector);
    if (unit) vectors.set(row.trackId, unit);
  }
  return { model, dims, vectors };
}

/** Top-k tracks by dot product with a unit taste vector, skipping tracks the re-rank would drop. */
export function contentCandidates(
  taste: ArrayLike<number>,
  vectors: ReadonlyMap<string, ArrayLike<number>>,
  skip: ReadonlySet<string>,
  k: number,
): { trackId: string; cosine: number }[] {
  const out: { trackId: string; cosine: number }[] = [];
  for (const [trackId, vector] of vectors) {
    if (skip.has(trackId) || vector.length !== taste.length) continue;
    out.push({ trackId, cosine: dot(taste, vector) });
  }
  out.sort((a, b) => b.cosine - a.cosine || (a.trackId < b.trackId ? -1 : a.trackId > b.trackId ? 1 : 0));
  return out.slice(0, k);
}
