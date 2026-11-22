const test = require('node:test');
const assert = require('node:assert/strict');
const { math, taste, vectors } = require('./helpers.cjs');

const now = new Date('2026-11-21T00:00:00Z');
const daysAgo = (d) => new Date(now.getTime() - d * 86_400_000);
const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b}`);
const interaction = (trackId, extra = {}) => ({
  trackId, likedAt: null, plays: 0, listenedAt: null, completes: 0, skips: 0, engagedAt: null, inPlaylist: false, ...extra,
});

test('cosine handles identical, opposite, orthogonal, zero and mismatched vectors', () => {
  close(math.cosine([1, 2, 3], [2, 4, 6]), 1);
  close(math.cosine([1, 0], [-1, 0]), -1);
  close(math.cosine([1, 0], [0, 1]), 0);
  assert.equal(math.cosine([0, 0], [1, 1]), 0);
  assert.equal(math.cosine([1, 2], [1, 2, 3]), 0);
  assert.equal(math.cosine([], []), 0);
});

test('seededRandom is deterministic and in [0,1)', () => {
  const a = math.seededRandom('u:2026-11-21');
  const b = math.seededRandom('u:2026-11-21');
  const seqA = Array.from({ length: 50 }, a);
  assert.deepEqual(seqA, Array.from({ length: 50 }, b));
  assert.ok(seqA.every((x) => x >= 0 && x < 1));
  assert.notDeepEqual(seqA.slice(0, 5), Array.from({ length: 5 }, math.seededRandom('u:2026-11-22')));
  assert.equal(math.dailySeed('u', new Date('2026-11-21T23:59:59Z')), 'u:2026-11-21');
});

test('decay halves every 30 days', () => {
  close(taste.decay(now, now), 1);
  close(taste.decay(daysAgo(30), now), 0.5);
  close(taste.decay(daysAgo(60), now), 0.25);
  close(taste.decay(null, now), 1);
});

test('interaction weights: like 3, complete 2, listen log1p(plays), skip -1', () => {
  close(taste.interactionWeight(interaction('a', { likedAt: now }), now), 3);
  close(taste.interactionWeight(interaction('a', { completes: 4, engagedAt: now }), now), 2);
  close(taste.interactionWeight(interaction('a', { plays: 3, listenedAt: now }), now), Math.log1p(3));
  close(taste.interactionWeight(interaction('a', { skips: 2, engagedAt: now }), now), -1);
  close(taste.interactionWeight(interaction('a', { likedAt: daysAgo(30) }), now), 1.5);
});

test('decay uses the most recent signal on the pair (same as the trainer)', () => {
  const item = interaction('a', { likedAt: daysAgo(60), plays: 1, listenedAt: daysAgo(30) });
  close(taste.interactionWeight(item, now), (3 + Math.log1p(1)) * 0.5);
  assert.equal(taste.lastInteractionAt(item).getTime(), daysAgo(30).getTime());
  assert.equal(taste.lastInteractionAt(interaction('a')), null);
});

test('taste vector is the normalised weighted sum and skips push away', () => {
  const emb = new Map([['a', [1, 0]], ['b', [0, 1]], ['s', [0, 1]]]);
  const t1 = taste.tasteVector([interaction('a', { likedAt: now }), interaction('b', { plays: Math.E - 1, listenedAt: now })], emb, now);
  close(t1[0], 3 / Math.hypot(3, 1));
  close(t1[1], 1 / Math.hypot(3, 1));
  const t2 = taste.tasteVector([interaction('a', { likedAt: now }), interaction('s', { skips: 1, engagedAt: now })], emb, now);
  assert.ok(t2[1] < 0, 'skipped direction is negative');
});

test('taste vector is null without embeddings or with only skips (cold start)', () => {
  const emb = new Map([['a', [1, 0]]]);
  assert.equal(taste.tasteVector([interaction('x', { likedAt: now })], emb, now), null);
  assert.equal(taste.tasteVector([interaction('a', { skips: 1, engagedAt: now })], emb, now), null);
});

test('meanVector supports the survey cold start', () => {
  const emb = new Map([['a', [1, 0]], ['b', [0, 1]]]);
  const mean = taste.meanVector(['a', 'b', 'missing'], emb);
  close(mean[0], Math.SQRT1_2);
  close(mean[1], Math.SQRT1_2);
  assert.equal(taste.meanVector(['missing'], emb), null);
});

test('isPositive covers like, listen, complete and playlist', () => {
  assert.equal(taste.isPositive(interaction('a')), false);
  assert.equal(taste.isPositive(interaction('a', { skips: 3 })), false);
  assert.equal(taste.isPositive(interaction('a', { inPlaylist: true })), true);
  assert.equal(taste.isPositive(interaction('a', { completes: 1 })), true);
});

test('buildIndex keeps the dominant model/dims and unit-normalises', () => {
  const index = vectors.buildIndex([
    { trackId: 'a', model: 'e5', dims: 2, vector: [3, 4] },
    { trackId: 'b', model: 'e5', dims: 2, vector: [0, 2] },
    { trackId: 'c', model: 'old', dims: 3, vector: [1, 1, 1] },
    { trackId: 'd', model: 'e5', dims: 2, vector: [0, 0] },
    { trackId: 'e', model: 'e5', dims: 2, vector: [1] },
  ]);
  assert.equal(index.model, 'e5');
  assert.deepEqual([...index.vectors.keys()].sort(), ['a', 'b']);
  close(index.vectors.get('a')[0], 0.6);
  assert.equal(vectors.buildIndex([]).vectors.size, 0);
});

test('contentCandidates ranks by similarity and honours the skip set', () => {
  const index = vectors.buildIndex([
    { trackId: 'near', model: 'm', dims: 2, vector: [1, 0.1] },
    { trackId: 'far', model: 'm', dims: 2, vector: [-1, 0] },
    { trackId: 'liked', model: 'm', dims: 2, vector: [1, 0] },
  ]);
  const out = vectors.contentCandidates([1, 0], index.vectors, new Set(['liked']), 5);
  assert.deepEqual(out.map((x) => x.trackId), ['near', 'far']);
  assert.equal(vectors.contentCandidates([1, 0], index.vectors, new Set(), 1).length, 1);
});
