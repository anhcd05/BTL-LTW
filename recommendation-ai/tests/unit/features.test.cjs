const test = require('node:test');
const assert = require('node:assert/strict');
const { features } = require('./helpers.cjs');

const now = new Date('2026-11-21T00:00:00Z');
const daysAgo = (d) => new Date(now.getTime() - d * 86_400_000);

test('cf_score is normalised by the max over candidates', () => {
  assert.equal(features.cfFeature(2, 4), 0.5);
  assert.equal(features.cfFeature(4, 4), 1);
  assert.equal(features.cfFeature(0, 4), 0);
  assert.equal(features.cfFeature(1, 0), 0);
});

test('content_sim maps cosine (c+1)/2 and is 0 without an embedding', () => {
  assert.equal(features.contentFeature(1), 1);
  assert.equal(features.contentFeature(-1), 0);
  assert.equal(features.contentFeature(0), 0.5);
  assert.equal(features.contentFeature(null), 0);
  assert.equal(features.contentFeature(Number.NaN), 0);
});

test('popularity = log1p(plays)/log1p(max)', () => {
  assert.equal(features.popularityFeature(0, 100), 0);
  assert.equal(features.popularityFeature(100, 100), 1);
  assert.ok(Math.abs(features.popularityFeature(9, 99) - Math.log(10) / Math.log(100)) < 1e-12);
  assert.equal(features.popularityFeature(5, 0), 0);
});

test('recency = exp(-days/30); unpublished is 0; future clamps to 1', () => {
  assert.equal(features.recencyFeature(now, now), 1);
  assert.ok(Math.abs(features.recencyFeature(daysAgo(30), now) - Math.exp(-1)) < 1e-12);
  assert.equal(features.recencyFeature(null, now), 0);
  assert.equal(features.recencyFeature(daysAgo(-5), now), 1);
});

test('skip_rate is Laplace smoothed (skips+1)/(starts+2)', () => {
  assert.equal(features.skipRateFeature(0, 0), 0.5);
  assert.equal(features.skipRateFeature(1, 8), 0.2);
  assert.equal(features.skipRateFeature(8, 8), 0.9);
  assert.ok(features.skipRateFeature(5, 2) <= 1, 'skips > starts is clamped');
});

test('genre_overlap = |genres(j) ∩ top(u)| / |genres(j)|', () => {
  const top = new Set(['pop', 'rock']);
  assert.equal(features.genreOverlapFeature(['pop', 'jazz'], top), 0.5);
  assert.equal(features.genreOverlapFeature(['pop', 'pop'], top), 1);
  assert.equal(features.genreOverlapFeature([], top), 0);
  assert.equal(features.genreOverlapFeature(['pop'], new Set()), 0);
});

test('topGenres keeps the k heaviest positive genres with stable ties', () => {
  const weighted = new Map([['rock', 3], ['pop', 5], ['jazz', 3], ['edm', 1], ['bad', -2]]);
  assert.deepEqual([...features.topGenres(weighted, 3)], ['pop', 'jazz', 'rock']);
  assert.deepEqual([...features.topGenres(new Map([['bad', -1]]))], []);
});

test('buildFeatures produces every feature in [0,1] in FEATURE_ORDER', () => {
  const x = features.buildFeatures({
    cfScore: 3, maxCfScore: 6, contentCosine: 0.2, followsArtist: true, surveyMatch: false,
    trackGenres: ['pop'], topGenres: new Set(['pop']), playCount: 10, maxPlayCount: 1000,
    publishedAt: daysAgo(10), skips: 2, starts: 10, now,
  });
  const vector = features.featureVector(x);
  assert.equal(vector.length, features.FEATURE_ORDER.length);
  for (const value of vector) assert.ok(value >= 0 && value <= 1, `${value} in [0,1]`);
  assert.equal(x.cf_score, 0.5);
  assert.equal(x.follows_artist, 1);
  assert.equal(x.survey_match, 0);
  assert.equal(x.genre_overlap, 1);
  assert.ok(Math.abs(x.content_sim - 0.6) < 1e-12);
});
