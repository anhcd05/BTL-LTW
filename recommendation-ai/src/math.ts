// Pure numeric helpers. No I/O, no database imports: safe for unit tests.

export type Vector = ArrayLike<number>;

export function dot(a: Vector, b: Vector): number {
  const n = Math.min(a.length, b.length);
  let sum = 0;
  for (let i = 0; i < n; i++) sum += a[i]! * b[i]!;
  return sum;
}

export function norm(a: Vector): number {
  return Math.sqrt(dot(a, a));
}

/** Cosine similarity in [-1, 1]; 0 when either vector is empty, zero or of a different length. */
export function cosine(a: Vector, b: Vector): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  const denominator = norm(a) * norm(b);
  if (!Number.isFinite(denominator) || denominator === 0) return 0;
  const value = dot(a, b) / denominator;
  return Math.max(-1, Math.min(1, value));
}

export function sigmoid(x: number): number {
  if (x >= 0) return 1 / (1 + Math.exp(-x));
  const e = Math.exp(x);
  return e / (1 + e);
}

export function clamp01(x: number): number {
  return Number.isFinite(x) ? Math.max(0, Math.min(1, x)) : 0;
}

/** Returns a unit-length copy, or null for a zero / non-finite vector. */
export function normalize(a: Vector): Float64Array | null {
  const length = norm(a);
  if (!Number.isFinite(length) || length === 0) return null;
  const out = new Float64Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = a[i]! / length;
  return out;
}

/** 32-bit FNV-1a hash of a string. */
export function hashString(value: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** Deterministic PRNG (mulberry32) seeded from a string; yields numbers in [0, 1). */
export function seededRandom(seed: string): () => number {
  let state = hashString(seed);
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Seed for the daily exploration slot: stable per user for one UTC calendar day. */
export function dailySeed(userId: string, now: Date): string {
  return `${userId}:${now.toISOString().slice(0, 10)}`;
}
