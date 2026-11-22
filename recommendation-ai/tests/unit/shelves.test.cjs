const test = require('node:test');
const assert = require('node:assert/strict');
const { rerank, shelves } = require('./helpers.cjs');

const USER = 'user-0';
const options = { userId: USER, seed: 'user-0:2026-11-22', liked: new Set(), recent: new Set() };
const deps = (titles = { s1: 'Seed One', s2: 'Seed Two' }) => ({
  size: 10,
  rerank: (candidates, limit, explore, maxPerArtist) =>
    rerank.rerank(candidates, { ...options, limit, explore, maxPerArtist }).selected,
  toItem: (c) => ({ trackId: c.trackId, reason: c.explore ? 'EXPLORE' : 'LISTENED', score: c.score, sources: [...c.sources] }),
  titleOf: (id) => (id ? titles[id] ?? null : null),
});
const c = (trackId, artistId, score, sources, cfSeedId = null) => ({ trackId, artistId, score, sources, cfSeedId });

// 40 candidates over 25 artists with overlapping sources (every track is in several source sets).
function world() {
  const out = [];
  for (let i = 0; i < 40; i += 1) {
    const sources = ['CF'];
    if (i % 2 === 0) sources.push('FOLLOW');
    if (i % 3 === 0) sources.push('TRENDING');
    if (i % 5 === 0) sources.push('CONTENT');
    out.push(c(`t${String(i).padStart(2, '0')}`, `a${i % 25}`, 1 - i / 100, sources, i % 4 === 0 ? 's2' : 's1'));
  }
  for (let i = 0; i < 5; i += 1) out.push(c(`x${i}`, `e${i}`, 0.01, ['EXPLORE']));
  return out;
}

test('FOR_YOU comes first, followed by LISTENED, FOLLOW, TRENDING', () => {
  const result = shelves.assembleShelves(world(), deps());
  assert.deepEqual(result.map((s) => s.kind), ['FOR_YOU', 'LISTENED', 'FOLLOW', 'TRENDING']);
  assert.equal(result[0].items.length, 10);
  assert.ok(result[0].items.some((item) => item.reason === 'EXPLORE'), 'FOR_YOU keeps the explore slot');
  assert.equal(result[1].seedTitle, 'Seed One');
  assert.ok(result[1].items.every((item) => item.reason === 'LISTENED' && item.seedTitle === 'Seed One'));
  assert.deepEqual(shelves.SHELF_ORDER, ['FOR_YOU', 'LISTENED', 'FOLLOW', 'TRENDING']);
});

test('no track appears on two shelves', () => {
  const result = shelves.assembleShelves(world(), deps());
  const ids = result.flatMap((s) => s.items.map((item) => item.trackId));
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(ids.length > 20);
});

test('later shelves only use remaining candidates and empty shelves are omitted', () => {
  // Every FOLLOW/TRENDING track is good enough to be taken by FOR_YOU, so those shelves end up empty.
  const all = [
    c('f1', 'a1', 0.9, ['CF', 'FOLLOW'], 's1'),
    c('f2', 'a2', 0.8, ['CF', 'TRENDING'], 's1'),
    c('l1', 'a3', 0.7, ['CF'], 's1'),
    c('l2', 'a3', 0.6, ['CF'], 's1'),
  ];
  const result = shelves.assembleShelves(all, deps());
  assert.deepEqual(result.map((s) => s.kind), ['FOR_YOU', 'LISTENED']);
  assert.deepEqual(result[0].items.map((i) => i.trackId), ['f1', 'f2', 'l1']);
  assert.deepEqual(result[1].items.map((i) => i.trackId), ['l2']);
});

test('LISTENED is omitted without a known seed title; nothing at all gives no shelves', () => {
  const all = [c('t1', 'a1', 0.9, ['CF'], 'unknown'), c('t2', 'a1', 0.8, ['CF'], 'unknown')];
  assert.deepEqual(shelves.assembleShelves(all, deps()).map((s) => s.kind), ['FOR_YOU']);
  assert.deepEqual(shelves.assembleShelves([], deps()), []);
});
