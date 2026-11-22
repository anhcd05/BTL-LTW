import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { createRng, dirichlet, hashUnit, perturb, sampleWithoutReplacement, shuffle, uuidFrom, weightedIndex, zipfWeights } from '../src/rng';

test('rng is deterministic per seed and differs across seeds', () => {
  const a = createRng(42);
  const b = createRng(42);
  const c = createRng(43);
  const xa = Array.from({ length: 20 }, () => a.next());
  const xb = Array.from({ length: 20 }, () => b.next());
  const xc = Array.from({ length: 20 }, () => c.next());
  assert.deepEqual(xa, xb);
  assert.notDeepEqual(xa, xc);
  assert.ok(xa.every((x) => x >= 0 && x < 1));
});

test('uniform and normal moments are plausible', () => {
  const r = createRng(7);
  const n = 100_000;
  let s = 0;
  let sn = 0;
  let sn2 = 0;
  for (let i = 0; i < n; i += 1) {
    s += r.next();
    const z = r.normal();
    sn += z;
    sn2 += z * z;
  }
  assert.ok(Math.abs(s / n - 0.5) < 0.01);
  assert.ok(Math.abs(sn / n) < 0.02);
  assert.ok(Math.abs(sn2 / n - 1) < 0.03);
});

test('fork gives independent but reproducible streams', () => {
  const x = createRng(1).fork('a').next();
  assert.equal(createRng(1).fork('a').next(), x);
  assert.notEqual(createRng(1).fork('b').next(), x);
});

test('zipf weights: normalised, monotone, ratio 2^s between rank 1 and 2', () => {
  const w = zipfWeights(200, 1.1);
  assert.ok(Math.abs(w.reduce((a, b) => a + b, 0) - 1) < 1e-12);
  for (let i = 1; i < w.length; i += 1) assert.ok(w[i] < w[i - 1]);
  assert.ok(Math.abs(w[0] / w[1] - 2 ** 1.1) < 1e-9);
  assert.ok(Math.abs(w[0] / w[9] - 10 ** 1.1) < 1e-9);
});

test('dirichlet sums to one with mean alpha/sum(alpha)', () => {
  const r = createRng(3);
  const alpha = [2, 1, 1];
  const mean = [0, 0, 0];
  const n = 20_000;
  for (let i = 0; i < n; i += 1) {
    const d = dirichlet(r, alpha);
    assert.ok(Math.abs(d.reduce((a, b) => a + b, 0) - 1) < 1e-9);
    d.forEach((x, k) => (mean[k] += x / n));
  }
  assert.ok(Math.abs(mean[0] - 0.5) < 0.01);
  assert.ok(Math.abs(mean[1] - 0.25) < 0.01);
});

test('perturb keeps the mean close to p', () => {
  const r = createRng(9);
  const p = [0.6, 0.3, 0.1];
  const mean = [0, 0, 0];
  const n = 5000;
  for (let i = 0; i < n; i += 1) perturb(r, p, 25, 0).forEach((x, k) => (mean[k] += x / n));
  mean.forEach((m, k) => assert.ok(Math.abs(m - p[k]) < 0.01));
});

test('shuffle is a permutation; weightedIndex follows weights; sampling without replacement is distinct', () => {
  const r = createRng(5);
  const s = shuffle(r, [1, 2, 3, 4, 5, 6]);
  assert.deepEqual([...s].sort(), [1, 2, 3, 4, 5, 6]);
  const counts = [0, 0, 0];
  for (let i = 0; i < 30_000; i += 1) counts[weightedIndex(r, [1, 0, 3])] += 1;
  assert.equal(counts[1], 0);
  assert.ok(Math.abs(counts[2] / counts[0] - 3) < 0.2);
  const picked = sampleWithoutReplacement(r, [1, 1, 1, 1], 3);
  assert.equal(new Set(picked).size, 3);
});

test('uuidFrom is v4-shaped and hashUnit is stable', () => {
  const id = uuidFrom(createRng(11));
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(hashUnit('u|t'), hashUnit('u|t'));
  assert.ok(hashUnit('u|t') >= 0 && hashUnit('u|t') < 1);
});
