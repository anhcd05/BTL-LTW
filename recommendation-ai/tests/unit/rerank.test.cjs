const test = require('node:test');
const assert = require('node:assert/strict');
const { rerank } = require('./helpers.cjs');

const USER = 'user-0';
const base = { userId: USER, seed: 'user-0:2026-11-21', liked: new Set(), recent: new Set() };
const c = (trackId, artistId, score, sources = ['CF']) => ({ trackId, artistId, score, sources });

test('sorts by score and caps one item per artist', () => {
  const { selected, decisions } = rerank.rerank(
    [c('t1', 'a1', 0.9), c('t2', 'a1', 0.8), c('t3', 'a2', 0.7), c('t4', 'a3', 0.95)],
    { ...base, limit: 5, explore: false },
  );
  assert.deepEqual(selected.map((s) => s.trackId), ['t4', 't1', 't3']);
  assert.deepEqual(selected.map((s) => s.position), [1, 2, 3]);
  assert.deepEqual(decisions.get('t2'), { decision: 'DROPPED', dropReason: 'ARTIST_CAP' });
});

test('maxPerArtist allows more than one item per artist when requested', () => {
  const { selected } = rerank.rerank([c('t1', 'a1', 0.9), c('t2', 'a1', 0.8), c('t3', 'a1', 0.7)], {
    ...base,
    limit: 5,
    explore: false,
    maxPerArtist: 2,
  });
  assert.deepEqual(selected.map((s) => s.trackId), ['t1', 't2']);
});

test('excludes liked, own and recently listened tracks with drop reasons', () => {
  const { selected, decisions } = rerank.rerank(
    [c('liked', 'a1', 0.99), c('own', USER, 0.98), c('recent', 'a2', 0.97), c('ok', 'a3', 0.1)],
    { ...base, limit: 5, explore: false, liked: new Set(['liked']), recent: new Set(['recent']) },
  );
  assert.deepEqual(selected.map((s) => s.trackId), ['ok']);
  assert.equal(decisions.get('liked').dropReason, 'LIKED');
  assert.equal(decisions.get('own').dropReason, 'OWN');
  assert.equal(decisions.get('recent').dropReason, 'RECENT');
});

test('extra regular candidates beyond the limit are BELOW_CUTOFF', () => {
  const list = Array.from({ length: 7 }, (_, i) => c(`t${i}`, `a${i}`, 1 - i / 10));
  const { selected, decisions } = rerank.rerank(list, { ...base, limit: 5, explore: false });
  assert.equal(selected.length, 5);
  assert.equal(decisions.get('t5').dropReason, 'BELOW_CUTOFF');
  assert.equal(decisions.get('t6').dropReason, 'BELOW_CUTOFF');
});

const regular = (n) => Array.from({ length: n }, (_, i) => c(`r${i}`, `ra${i}`, 0.9 - i / 100));
const pool = (n) => Array.from({ length: n }, (_, i) => c(`x${i}`, `xa${i}`, 0.01, ['EXPLORE']));

test('slot 5 is EXPLORE when at least 4 regular candidates exist', () => {
  const { selected, decisions } = rerank.rerank([...regular(6), ...pool(3)], { ...base, limit: 5, explore: true });
  assert.equal(selected.length, 5);
  assert.deepEqual(selected.slice(0, 4).map((s) => s.trackId), ['r0', 'r1', 'r2', 'r3']);
  assert.equal(selected[4].explore, true);
  assert.equal(selected[4].position, 5);
  assert.match(selected[4].trackId, /^x/);
  assert.equal(decisions.get('r4').dropReason, 'BELOW_CUTOFF');
  const unpicked = ['x0', 'x1', 'x2'].filter((id) => id !== selected[4].trackId);
  for (const id of unpicked) assert.equal(decisions.get(id).dropReason, 'BELOW_CUTOFF');
});

test('no explore slot with fewer than 4 regular candidates', () => {
  const { selected } = rerank.rerank([...regular(3), ...pool(3)], { ...base, limit: 5, explore: true });
  assert.deepEqual(selected.map((s) => s.trackId), ['r0', 'r1', 'r2']);
  assert.ok(selected.every((s) => !s.explore));
});

test('reserved slot returns to regular items when the pool is empty or blocked by the artist cap', () => {
  const empty = rerank.rerank(regular(6), { ...base, limit: 5, explore: true });
  assert.deepEqual(empty.selected.map((s) => s.trackId), ['r0', 'r1', 'r2', 'r3', 'r4']);
  assert.equal(empty.decisions.get('r4').decision, 'SELECTED');
  const sameArtist = [c('x0', 'ra0', 0.01, ['EXPLORE'])];
  const blocked = rerank.rerank([...regular(6), ...sameArtist], { ...base, limit: 5, explore: true });
  assert.equal(blocked.selected.length, 5);
  assert.ok(blocked.selected.every((s) => !s.explore));
});

test('explore pick is deterministic for a seed and ignores input order', () => {
  const input = [...regular(5), ...pool(10)];
  const a = rerank.rerank(input, { ...base, limit: 5, explore: true });
  const b = rerank.rerank([...input].reverse(), { ...base, limit: 5, explore: true });
  assert.equal(a.selected[4].trackId, b.selected[4].trackId);
  const picks = new Set();
  for (let day = 1; day <= 20; day++)
    picks.add(rerank.rerank(input, { ...base, seed: `user-0:2026-11-${day}`, limit: 5, explore: true }).selected[4].trackId);
  assert.ok(picks.size > 1, 'different days should rotate the exploration pick');
});

test('a track that is also a regular candidate is not explore-only', () => {
  assert.equal(rerank.isExploreOnly({ sources: ['EXPLORE'] }), true);
  assert.equal(rerank.isExploreOnly({ sources: ['CF', 'EXPLORE'] }), false);
  assert.equal(rerank.isExploreOnly({ sources: [] }), false);
});

test('ties break by track id and duplicates are ignored', () => {
  const { selected } = rerank.rerank([c('b', 'a1', 0.5), c('a', 'a2', 0.5), c('a', 'a3', 0.9)], {
    ...base,
    limit: 5,
    explore: false,
  });
  assert.deepEqual(selected.map((s) => s.trackId), ['a', 'b']);
});

test('every candidate receives a decision', () => {
  const input = [...regular(8), ...pool(4), c('liked', 'z', 1)];
  const { decisions } = rerank.rerank(input, { ...base, limit: 5, explore: true, liked: new Set(['liked']) });
  assert.equal(decisions.size, input.length);
});
