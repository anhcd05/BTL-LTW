/**
 * Deterministic pseudo-random utilities (no Math.random anywhere in the batch package).
 * sfc32 seeded through splitmix32 so that nearby seeds give unrelated streams.
 */
export type Rng = {
  next(): number; // [0,1)
  int(maxExclusive: number): number;
  normal(): number;
  fork(label: string): Rng;
  readonly seed: number;
};

function splitmix32(state: number): () => number {
  let s = state >>> 0;
  return () => {
    s = (s + 0x9e3779b9) >>> 0;
    let z = s;
    z = Math.imul(z ^ (z >>> 16), 0x85ebca6b) >>> 0;
    z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35) >>> 0;
    return (z ^ (z >>> 16)) >>> 0;
  };
}

/** FNV-1a 32-bit hash of a string; used to derive sub-stream seeds and stable per-pair noise. */
export function hash32(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** Uniform [0,1) value that depends only on the key (stable per (user, track) noise). */
export function hashUnit(key: string): number {
  const next = splitmix32(hash32(key));
  next();
  return next() / 4294967296;
}

export function createRng(seed: number): Rng {
  const init = splitmix32(seed >>> 0);
  let a = init();
  let b = init();
  let c = init();
  let d = init();
  let spare: number | null = null;
  const raw = (): number => {
    a >>>= 0;
    b >>>= 0;
    c >>>= 0;
    d >>>= 0;
    let t = (a + b) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    d = (d + 1) | 0;
    t = (t + d) | 0;
    c = (c + t) | 0;
    return (t >>> 0) / 4294967296;
  };
  for (let i = 0; i < 12; i += 1) raw();
  const rng: Rng = {
    seed: seed >>> 0,
    next: raw,
    int(maxExclusive: number): number {
      if (!Number.isInteger(maxExclusive) || maxExclusive <= 0) throw new RangeError('int(max) requires max >= 1');
      return Math.floor(raw() * maxExclusive);
    },
    normal(): number {
      if (spare !== null) {
        const value = spare;
        spare = null;
        return value;
      }
      let u = 0;
      while (u <= Number.EPSILON) u = raw();
      const v = raw();
      const r = Math.sqrt(-2 * Math.log(u));
      spare = r * Math.sin(2 * Math.PI * v);
      return r * Math.cos(2 * Math.PI * v);
    },
    fork(label: string): Rng {
      return createRng((hash32(label) ^ Math.imul(seed >>> 0, 0x27d4eb2d)) >>> 0);
    },
  };
  return rng;
}

/** Marsaglia–Tsang gamma sampler (shape > 0, scale 1). */
export function gamma(rng: Rng, shape: number): number {
  if (!(shape > 0)) throw new RangeError('gamma shape must be > 0');
  if (shape < 1) {
    const u = Math.max(rng.next(), Number.EPSILON);
    return gamma(rng, shape + 1) * u ** (1 / shape);
  }
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x: number;
    let v: number;
    do {
      x = rng.normal();
      v = 1 + c * x;
    } while (v <= 0);
    v = v * v * v;
    const u = rng.next();
    if (u < 1 - 0.0331 * x ** 4) return d * v;
    if (Math.log(Math.max(u, Number.EPSILON)) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}

export function dirichlet(rng: Rng, alpha: readonly number[]): number[] {
  const draws = alpha.map((a) => gamma(rng, Math.max(a, 1e-3)));
  const total = draws.reduce((s, x) => s + x, 0);
  return draws.map((x) => x / total);
}

/** Dirichlet perturbation around a probability vector p with concentration k (mean = p). */
export function perturb(rng: Rng, p: readonly number[], concentration: number, floor = 0.02): number[] {
  return dirichlet(
    rng,
    p.map((x) => concentration * x + floor),
  );
}

/** Normalised Zipf weights for ranks 1..n: w_r ∝ r^-s. */
export function zipfWeights(n: number, s: number): number[] {
  const raw = Array.from({ length: n }, (_, i) => (i + 1) ** -s);
  const total = raw.reduce((acc, x) => acc + x, 0);
  return raw.map((x) => x / total);
}

export function shuffle<T>(rng: Rng, items: readonly T[]): T[] {
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = rng.int(i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export function weightedIndex(rng: Rng, weights: readonly number[]): number {
  let total = 0;
  for (const w of weights) total += w > 0 ? w : 0;
  if (!(total > 0)) return rng.int(weights.length);
  let target = rng.next() * total;
  for (let i = 0; i < weights.length; i += 1) {
    const w = weights[i] > 0 ? weights[i] : 0;
    if (target < w) return i;
    target -= w;
  }
  return weights.length - 1;
}

export function pick<T>(rng: Rng, items: readonly T[]): T {
  return items[rng.int(items.length)];
}

/** k distinct indices sampled without replacement proportional to weights. */
export function sampleWithoutReplacement(rng: Rng, weights: readonly number[], k: number): number[] {
  const w = weights.slice();
  const out: number[] = [];
  for (let n = 0; n < k && n < w.length; n += 1) {
    if (!w.some((x) => x > 0)) break;
    const i = weightedIndex(rng, w);
    out.push(i);
    w[i] = 0;
  }
  return out;
}

/** Deterministic RFC 4122 v4-shaped UUID from the stream (demo rows get reproducible ids). */
export function uuidFrom(rng: Rng): string {
  const bytes = Array.from({ length: 16 }, () => rng.int(256));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
