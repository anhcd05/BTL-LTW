// Fix round 1: SKIPPED exclusion, terminal-event age window, signed impression tokens.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { rerank, engagement } = require('./helpers.cjs');

const dist = process.env.RECO_AI_DIST || path.join(__dirname, '..', '..', 'dist');
const features = require(path.join(dist, 'features.js'));

const base = { userId: 'u', seed: 'u:2026-11-21', liked: new Set(), recent: new Set() };
const c = (trackId, artistId, score) => ({ trackId, artistId, score, sources: ['CF'] });

test('rerank drops recently skipped tracks with SKIPPED (option exported from ./features)', () => {
  const { selected, decisions } = features.rerank([c('s', 'a1', 0.99), c('ok', 'a2', 0.5)], {
    ...base,
    limit: 5,
    explore: false,
    skipped: new Set(['s']),
  });
  assert.deepEqual(selected.map((x) => x.trackId), ['ok']);
  assert.deepEqual(decisions.get('s'), { decision: 'DROPPED', dropReason: 'SKIPPED' });
  // Optional: omitting it keeps the previous behaviour.
  assert.equal(rerank.rerank([c('s', 'a1', 0.99)], { ...base, limit: 5, explore: false }).selected.length, 1);
  // Liked still wins over skipped as the reported reason.
  const both = features.rerank([c('s', 'a1', 1)], { ...base, limit: 5, explore: false, liked: new Set(['s']), skipped: new Set(['s']) });
  assert.equal(both.decisions.get('s').dropReason, 'LIKED');
});

test('terminal events are bounded by max(15 min, 2·duration) after startedAtMs', () => {
  const ok = engagement.engagementTimingValid;
  const MIN = 60_000;
  assert.equal(engagement.maxTerminalAgeMs(200), 15 * MIN);
  assert.equal(engagement.maxTerminalAgeMs(1800), 3600_000);
  assert.equal(ok('complete', 14 * MIN, 200), true, 'within 15 minutes');
  assert.equal(ok('complete', 16 * MIN, 200), false, 'stale terminal event');
  assert.equal(ok('complete', 50 * MIN, 1800), true, '30-min track completes after token expiry');
  assert.equal(ok('complete', 61 * MIN, 1800), false);
  assert.equal(ok('start', 16 * MIN, 200), true, 'start is bounded by normal JWT expiry, not here');
});

const SECRET = 'test-secret';
const U = 'aaaaaaaa-0000-4000-8000-000000000001';
const R = 'bbbbbbbb-0000-4000-8000-000000000002';
const T1 = 'cccccccc-0000-4000-8000-000000000003';
const T2 = 'cccccccc-0000-4000-8000-000000000004';
const served = { userId: U, requestId: R, modelVersion: 'lr-1', items: [{ trackId: T1, reason: 'LISTENED' }, { trackId: T2, reason: 'EXPLORE' }, { trackId: T1.toUpperCase(), reason: 'FOLLOW' }] };

test('impression token round-trips the served request, model and tracks', () => {
  const token = features.signImpressionToken(SECRET, served);
  const claims = features.verifyImpressionToken(SECRET, token, { userId: U, requestId: R });
  assert.equal(claims.modelVersion, 'lr-1');
  assert.deepEqual(claims.items, [{ trackId: T1, reason: 'LISTENED' }, { trackId: T2, reason: 'EXPLORE' }], 'deduplicated, lower-cased');
  assert.ok(features.verifyImpressionToken(SECRET, token, { userId: U.toUpperCase(), requestId: R.toUpperCase() }));
});

test('forged, foreign, tampered or expired impression tokens are rejected', () => {
  const token = features.signImpressionToken(SECRET, served);
  const verify = (t, e = { userId: U, requestId: R }) => features.verifyImpressionToken(SECRET, t, e);
  assert.equal(features.verifyImpressionToken('other-secret', token, { userId: U, requestId: R }), null, 'wrong key');
  assert.equal(verify(token, { userId: 'aaaaaaaa-0000-4000-8000-000000000009', requestId: R }), null, 'other user');
  assert.equal(verify(token, { userId: U, requestId: 'bbbbbbbb-0000-4000-8000-000000000009' }), null, 'other request');
  const [body, sig] = token.split('.');
  const payload = JSON.parse(Buffer.from(body, 'base64url').toString());
  payload.t.push(['cccccccc-0000-4000-8000-000000000099', 'TRENDING']);
  assert.equal(verify(`${Buffer.from(JSON.stringify(payload)).toString('base64url')}.${sig}`), null, 'added track');
  assert.equal(verify(`${body}.${sig}x`), null, 'bad signature');
  assert.equal(verify(`${body}.${sig}.x`), null, 'extra segment');
  assert.equal(verify('garbage'), null);
  const old = features.signImpressionToken(SECRET, { ...served, nowMs: Date.now() - features.IMPRESSION_TOKEN_TTL_MS - 1000 });
  assert.equal(verify(old), null, 'expired');
});
