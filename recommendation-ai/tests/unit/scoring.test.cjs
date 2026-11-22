const test = require('node:test');
const assert = require('node:assert/strict');
const { features, scoring, math } = require('./helpers.cjs');

const ORDER = features.FEATURE_ORDER;
const row = (weights, bias = 0, names = [...ORDER]) => ({ version: 'v1', featureNames: names, weights, bias });
const zeros = () => Object.fromEntries(ORDER.map((name) => [name, 0]));

test('FEATURE_ORDER is the fixed contract order', () => {
  assert.deepEqual([...ORDER], [
    'cf_score', 'content_sim', 'follows_artist', 'survey_match',
    'genre_overlap', 'popularity', 'recency', 'skip_rate',
  ]);
});

test('scoreFeatures = sigmoid(b + w·x)', () => {
  const model = scoring.parseModel(row([1, 2, 0, 0, 0, 0, 0, -1], -0.5));
  const x = { ...zeros(), cf_score: 0.5, content_sim: 0.25, skip_rate: 0.5 };
  const expected = math.sigmoid(-0.5 + 0.5 + 0.5 - 0.5);
  assert.ok(Math.abs(scoring.scoreFeatures(model, x) - expected) < 1e-12);
  assert.equal(scoring.scoreFeatures(scoring.parseModel(row(ORDER.map(() => 0))), zeros()), 0.5);
});

test('weights are matched by name, not position', () => {
  const names = [...ORDER].reverse();
  const weights = names.map((name) => (name === 'cf_score' ? 3 : 0));
  const model = scoring.parseModel(row(weights, 0, names));
  assert.equal(model.weights.cf_score, 3);
  assert.deepEqual(scoring.modelWeightsInOrder(model), [3, 0, 0, 0, 0, 0, 0, 0]);
});

test('invalid model rows are rejected (caller falls back)', () => {
  assert.equal(scoring.parseModel(null), null);
  assert.equal(scoring.parseModel(row([1, 2, 3])), null, 'length mismatch');
  assert.equal(scoring.parseModel(row(ORDER.slice(1).map(() => 1), 0, ORDER.slice(1))), null, 'missing feature');
  assert.equal(scoring.parseModel(row(ORDER.map(() => Number.NaN))), null, 'non-finite weight');
  assert.equal(scoring.parseModel(row(ORDER.map(() => 1), Number.POSITIVE_INFINITY)), null, 'non-finite bias');
  assert.equal(scoring.parseModel({ ...row(ORDER.map(() => 1)), version: '' }), null, 'empty version');
  const dup = [...ORDER.slice(0, 7), 'cf_score'];
  assert.equal(scoring.parseModel(row(dup.map(() => 1), 0, dup)), null, 'duplicate name');
});

test('extra trained features are ignored at serving time', () => {
  const names = [...ORDER, 'future_feature'];
  const model = scoring.parseModel(row(names.map(() => 1), 0, names));
  assert.ok(model);
  assert.equal(Object.keys(model.weights).length, ORDER.length);
});

test('sigmoid is numerically stable', () => {
  assert.equal(math.sigmoid(0), 0.5);
  assert.ok(math.sigmoid(1000) <= 1 && math.sigmoid(1000) > 0.999);
  assert.ok(math.sigmoid(-1000) >= 0 && math.sigmoid(-1000) < 1e-10);
  assert.ok(Math.abs(math.sigmoid(2) + math.sigmoid(-2) - 1) < 1e-12);
});
