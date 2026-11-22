// Round 2: content-guided EXPLORE pick (item cold start), via the shared DB-free ./features entry.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const dist = process.env.RECO_AI_DIST || path.join(__dirname, '..', '..', 'dist');
const { rerank, pickExplore } = require(path.join(dist, 'features.js'));

const base = { userId: 'u', seed: 'u:2026-11-21', liked: new Set(), recent: new Set(), limit: 5, explore: true };
const regular = Array.from({ length: 5 }, (_, i) => ({ trackId: `r${i}`, artistId: `ra${i}`, score: 0.9 - i / 100, sources: ['CF'] }));
const x = (trackId, artistId, exploreScore) => ({
  trackId, artistId, score: 0.01, sources: ['EXPLORE'], ...(exploreScore === undefined ? {} : { exploreScore }),
});

test('highest content similarity wins the explore slot', () => {
  const pool = [x('x0', 'xa0', 0.4), x('x1', 'xa1', 0.91), x('x2', 'xa2', 0.7), x('x3', 'xa3')];
  for (let day = 1; day <= 10; day++) {
    const { selected } = rerank([...regular, ...pool], { ...base, seed: `u:2026-11-${day}` });
    assert.equal(selected.length, 5);
    assert.equal(selected[4].trackId, 'x1', 'independent of the daily seed');
    assert.equal(selected[4].explore, true);
  }
});

test('ties are broken by the seeded random, deterministically', () => {
  const pool = [x('x0', 'xa0', 0.8), x('x1', 'xa1', 0.8), x('x2', 'xa2', 0.8), x('x3', 'xa3', 0.2)];
  const pick = (seed, input = pool) => pickExplore(input, seed).trackId;
  assert.equal(pick('u:2026-11-21'), pick('u:2026-11-21'));
  assert.equal(pick('u:2026-11-21'), pick('u:2026-11-21', [...pool].reverse()), 'input order does not matter');
  const picks = new Set(Array.from({ length: 30 }, (_, d) => pick(`u:day-${d}`)));
  assert.ok([...picks].every((id) => ['x0', 'x1', 'x2'].includes(id)), 'only tied best candidates');
  assert.ok(picks.size > 1, 'the seed rotates among ties');
});

test('no embeddings → previous seeded-random pick over all eligible tracks', () => {
  const pool = Array.from({ length: 8 }, (_, i) => x(`x${i}`, `xa${i}`));
  const withoutScores = rerank([...regular, ...pool], base).selected[4];
  // Reference: the pre-change algorithm (sort by id, one seeded draw).
  const { seededRandom } = require(path.join(dist, 'features.js'));
  const sorted = [...pool].sort((a, b) => (a.trackId < b.trackId ? -1 : 1));
  assert.equal(withoutScores.trackId, sorted[Math.floor(seededRandom(base.seed)() * sorted.length)].trackId);
  assert.equal(pickExplore([], 's'), null);
});

test('artist cap is still respected: the best-content track of an already chosen artist is skipped', () => {
  const pool = [x('x0', 'ra0', 0.99), x('x1', 'xa1', 0.5), x('x2', 'xa2', 0.3)];
  const { selected, decisions } = rerank([...regular, ...pool], base);
  assert.equal(selected[4].trackId, 'x1');
  assert.equal(new Set(selected.map((s) => s.artistId)).size, 5);
  assert.equal(decisions.get('x0').dropReason, 'BELOW_CUTOFF');
});

test('explore slot conditions are unchanged (needs ≥4 regular candidates)', () => {
  const { selected } = rerank([...regular.slice(0, 3), x('x0', 'xa0', 0.9)], base);
  assert.deepEqual(selected.map((s) => s.trackId), ['r0', 'r1', 'r2']);
});
