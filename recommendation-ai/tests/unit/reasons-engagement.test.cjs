const test = require('node:test');
const assert = require('node:assert/strict');
const { reasons, scoring, features, engagement } = require('./helpers.cjs');

const ORDER = features.FEATURE_ORDER;

test('pickReason chooses the source with the highest contribution', () => {
  const r = reasons.pickReason({
    sources: ['CF', 'FOLLOW'],
    contributions: { CF: 0.2, FOLLOW: 0.9 },
    cfSeedTitle: 'Seed',
  });
  assert.deepEqual(r, { reason: 'FOLLOW' });
});

test('CF yields LISTENED with the seed title; CONTENT yields SIMILAR with an optional title', () => {
  assert.deepEqual(
    reasons.pickReason({ sources: ['CF', 'CONTENT'], contributions: { CF: 1, CONTENT: 0.1 }, cfSeedTitle: 'Bài A' }),
    { reason: 'LISTENED', seedTitle: 'Bài A' },
  );
  assert.deepEqual(
    reasons.pickReason({ sources: ['CONTENT'], contributions: { CONTENT: 0.4 }, similarSeedTitle: 'Bài B' }),
    { reason: 'SIMILAR', seedTitle: 'Bài B' },
  );
  assert.deepEqual(reasons.pickReason({ sources: ['CONTENT'], contributions: { CONTENT: 0.4 } }), { reason: 'SIMILAR' });
});

test('ties follow priority CF > CONTENT > FOLLOW > TRENDING; explore overrides', () => {
  assert.equal(
    reasons.pickReason({ sources: ['TRENDING', 'FOLLOW'], contributions: { TRENDING: 0.5, FOLLOW: 0.5 } }).reason,
    'FOLLOW',
  );
  assert.equal(
    reasons.pickReason({ sources: ['CF'], contributions: { CF: 5 }, explore: true, cfSeedTitle: 'x' }).reason,
    'EXPLORE',
  );
  assert.equal(reasons.pickReason({ sources: ['EXPLORE'], contributions: {} }).reason, 'EXPLORE');
});

test('negative contributions still pick the least negative present source', () => {
  assert.equal(
    reasons.pickReason({ sources: ['CF', 'TRENDING'], contributions: { CF: -0.5, TRENDING: -0.1 } }).reason,
    'TRENDING',
  );
});

test('sourceContributions uses w·x of each source feature only for present sources', () => {
  const weights = ORDER.map((name) => ({ cf_score: 2, content_sim: 1, follows_artist: 0.5, popularity: 3 })[name] ?? 0);
  const model = scoring.parseModel({ version: 'v', featureNames: [...ORDER], weights, bias: 0 });
  const x = Object.fromEntries(ORDER.map((n) => [n, 0.5]));
  const out = reasons.sourceContributions(['CF', 'TRENDING', 'EXPLORE'], x, model);
  assert.deepEqual(out, { CF: 1, TRENDING: 1.5 });
});

test('engagement timing: skip < min(30, D/2), complete >= 0.6·D', () => {
  const ok = engagement.engagementTimingValid;
  assert.equal(ok('start', 0, 200), true);
  assert.equal(ok('skip', 29_999, 200), true);
  assert.equal(ok('skip', 30_000, 200), false);
  assert.equal(ok('skip', 9_999, 20), true, 'short track uses D/2');
  assert.equal(ok('skip', 10_000, 20), false);
  assert.equal(ok('complete', 119_999, 200), false);
  assert.equal(ok('complete', 120_000, 200), true);
  assert.equal(ok('start', -1, 200), false);
  assert.equal(ok('complete', 1e9, 0), false);
});

test('terminal token marker is a deterministic UUID different from the token id', () => {
  const id = '6f1c2f8e-3d4b-4c5a-9e7f-0123456789ab';
  const marker = engagement.terminalTokenId(id);
  assert.match(marker, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-a[0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.notEqual(marker, id);
  assert.equal(marker, engagement.terminalTokenId(id.toUpperCase()));
});
