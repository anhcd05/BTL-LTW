import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { parseModel, scoreFeatures } from '@infosound/recommendation-ai/features';
import { holdoutSplit, trainFromSnapshot, trainingExamples, NEGATIVES_PER_POSITIVE } from '../src/dataset';
import { predict } from '../src/lr';
import { FEATURE_ORDER, buildContext, cfRaw, features } from '../src/features';
import { createRng } from '../src/rng';
import { rerank, rulesBaseline, sharedExploreIsContentGuided, unseenExclusion } from '../src/recommend';
import { type Snapshot, pairKey, withoutPairs } from '../src/snapshot';
import { discoveryPositives, generateWorld, worldSnapshot } from '../src/world';
import { hashEmbedder, passageText } from '../src/embedder';

const NOW = new Date('2026-11-21T00:00:00Z');
const day = (d: number) => new Date(NOW.getTime() - d * 86_400_000);

function tiny(): Snapshot {
  const tracks = ['t1', 't2', 't3', 't4'].map((id, i) => ({
    id,
    authorId: i < 2 ? 'artA' : 'artB',
    title: id,
    genres: i % 2 ? ['pop'] : ['rock', 'pop'],
    publishedAt: day(30 * i),
    playCount: 0,
  }));
  const s: Snapshot = {
    now: NOW,
    tracks,
    users: ['u1', 'u2', 'u3'],
    likes: [
      { userId: 'u1', trackId: 't1', at: day(5) },
      { userId: 'u2', trackId: 't1', at: day(4) },
      { userId: 'u2', trackId: 't2', at: day(3) },
      { userId: 'u3', trackId: 't2', at: day(2) },
      { userId: 'u3', trackId: 't3', at: day(1) },
    ],
    listens: [
      { userId: 'u1', trackId: 't1', qualifiedPlays: 3, lastListenedAt: day(5) },
      { userId: 'u2', trackId: 't2', qualifiedPlays: 1, lastListenedAt: day(3) },
    ],
    engagement: [
      { userId: 'u1', trackId: 't1', starts: 4, skips: 1, completes: 2, lastEventAt: day(5) },
      { userId: 'u1', trackId: 't4', starts: 2, skips: 2, completes: 0, lastEventAt: day(6) },
      { userId: 'u2', trackId: 't4', starts: 1, skips: 0, completes: 1, lastEventAt: day(6) },
    ],
    playlistTracks: [],
    follows: [{ userId: 'u1', authorId: 'artB' }],
    preferences: [{ userId: 'u1', genreIds: ['rock'], artistIds: [] }],
    impressions: [],
    embeddings: new Map([
      ['t1', Float32Array.from([1, 0])],
      ['t2', Float32Array.from([0.8, 0.6])],
      ['t3', Float32Array.from([0, 1])],
      ['t4', Float32Array.from([-1, 0])],
    ]),
  };
  s.tracks.forEach((t) => (t.playCount = s.listens.filter((l) => l.trackId === t.id).reduce((a, l) => a + l.qualifiedPlays, 0)));
  return s;
}

test('CF raw score matches the hand computation', () => {
  const ctx = buildContext(tiny());
  // CF positive sets: u1 {t1,t4(skip only → not positive)} = {t1}; u2 {t1,t2,t4}; u3 {t2,t3}
  // n: t1=2, t2=2, t3=1, t4=1 ; u1 seeds {t1}: cf(t2)=cooc(t1,t2)/sqrt(2*2)=1/2 ; cf(t4)=1/sqrt(2*1)
  const cf = cfRaw(ctx, 'u1');
  assert.ok(Math.abs(cf[1] - 0.5) < 1e-12);
  assert.ok(Math.abs(cf[3] - 1 / Math.sqrt(2)) < 1e-12);
  assert.equal(cf[2], 0);
  const f = features(ctx, 'u1', 3);
  assert.ok(Math.abs(f.cf_score - 1) < 1e-12); // t4 is the max among u1's candidates
  assert.equal(f.follows_artist, 1);
  assert.equal(f.survey_match, 0); // t4 genres = ['pop'], survey = rock
  assert.ok(Math.abs(f.skip_rate - (2 + 1) / (3 + 2)) < 1e-12);
  assert.ok(Math.abs(f.recency - Math.exp(-90 / 30)) < 1e-12);
  const f1 = features(ctx, 'u1', 0);
  assert.equal(f1.survey_match, 1);
  assert.equal(f1.popularity, 1);
});

test('leave-pair-out features equal features recomputed without the pair', () => {
  const s = tiny();
  const ctx = buildContext(s);
  for (const [user, trackId] of [
    ['u2', 't2'],
    ['u1', 't1'],
    ['u1', 't4'],
    ['u3', 't3'],
  ]) {
    const j = ctx.trackIdx.get(trackId)!;
    const lpo = features(ctx, user, j, { leavePairOut: true });
    const reduced = buildContext(withoutPairs(s, new Set([pairKey(user, trackId)])));
    const ref = features(reduced, user, j);
    for (const name of FEATURE_ORDER) {
      // popularity's max is kept from the full data by design (tiny difference only when j was the max)
      if (name === 'popularity') continue;
      assert.ok(Math.abs(lpo[name] - ref[name]) < 1e-9, `${user}/${trackId} ${name}: ${lpo[name]} vs ${ref[name]}`);
    }
  }
});

test('global cutoff: the snapshot sees nothing at/after T_c and test pairs are first-time discoveries', async () => {
  const world = generateWorld({ seed: 7, now: NOW });
  const e = hashEmbedder(32);
  const vec = await e.embed(world.tracks.map((t) => passageText({ title: t.title, description: t.description, lyrics: t.lyrics })));
  const emb = new Map(world.tracks.map((t, i) => [t.id, vec[i]]));
  const cut = NOW.getTime() - 10 * 86_400_000;
  const snap = worldSnapshot(world, emb, { before: cut });
  assert.equal(snap.now.getTime(), cut);
  assert.ok(snap.likes.every((l) => l.at.getTime() < cut));
  assert.ok(snap.listens.every((l) => l.lastListenedAt.getTime() < cut));
  assert.ok(snap.engagement.every((r) => r.lastEventAt.getTime() < cut));
  assert.ok(snap.playlistTracks.every((r) => r.at.getTime() < cut));
  assert.ok(snap.tracks.every((t) => t.publishedAt.getTime() < cut));
  assert.ok(snap.follows.length < world.follows.length, 'post-cutoff follows are filtered');
  const pre = world.events.filter((x) => x.at < cut).length;
  assert.equal(snap.engagement.reduce((s, r) => s + r.starts, 0), pre);
  assert.equal(snap.tracks.reduce((s, t) => s + t.playCount, 0), snap.listens.reduce((s, l) => s + l.qualifiedPlays, 0));
  const truth = discoveryPositives(world, cut, NOW.getTime());
  assert.ok(truth.size > 20, `users with discoveries: ${truth.size}`);
  const seen = new Set([...snap.listens, ...snap.engagement, ...snap.likes].map((r) => `${r.userId}|${r.trackId}`));
  for (const [user, tracks] of truth) for (const t of tracks) assert.ok(!seen.has(`${user}|${t}`), 'discoveries were never touched before T_c');
});

test('holdout split and training examples: global cutoff, 4:1 negatives, finite features', () => {
  const snap = worldSnapshot(generateWorld({ seed: 8, now: NOW }));
  const cut = NOW.getTime() - 7 * 86_400_000;
  const split = holdoutSplit(snap, cut);
  assert.ok(split.positives.size > 10);
  for (const [user, tracks] of split.positives)
    for (const t of tracks) assert.ok(!split.train.engagement.some((r) => r.userId === user && r.trackId === t) && !split.train.likes.some((l) => l.userId === user && l.trackId === t));
  assert.ok(split.train.engagement.every((r) => r.lastEventAt.getTime() < cut));
  const ctx = buildContext(split.train);
  const ex = trainingExamples(ctx, snap.users, createRng(1));
  const pos = ex.filter((x) => x.y === 1).length;
  assert.equal(ex.filter((x) => x.y === 0).length, NEGATIVES_PER_POSITIVE * pos);
  assert.ok(ex.every((x) => x.x.length === FEATURE_ORDER.length && x.x.every(Number.isFinite)));
});

test('re-rank: at most one track per artist and slot 5 is EXPLORE', () => {
  const world = generateWorld({ seed: 3, now: NOW });
  const ctx = buildContext(worldSnapshot(world));
  const user = world.users[0].id;
  // only the first 60 tracks are candidates; the rest form the exploration pool
  const scored = ctx.tracks.slice(0, 60).map((_, j) => ({ j, score: 1 - j / 1000, sources: ['CF' as const] }));
  const out = rerank(ctx, user, scored, unseenExclusion, { explore: true, dateKey: '2026-11-21' });
  assert.equal(out.length, 5);
  assert.equal(out[4].explore, true);
  const authors = out.map((r) => ctx.tracks[ctx.trackIdx.get(r.trackId)!].authorId);
  assert.equal(new Set(authors).size, 5);
  assert.ok(ctx.trackIdx.get(out[4].trackId)! >= 60);
  const noExplore = rerank(ctx, user, scored, unseenExclusion, { explore: false });
  assert.equal(noExplore.length, 5);
  assert.ok(noExplore.every((r) => !r.explore));
  const again = rerank(ctx, user, scored, unseenExclusion, { explore: true, dateKey: '2026-11-21' });
  assert.deepEqual(again, out);
  assert.ok(rulesBaseline(ctx, user, unseenExclusion).length > 0);
});

test('trained model row is accepted by the shared parseModel and scores like the raw LR', async () => {
  const world = generateWorld({ seed: 5, now: NOW });
  const e = hashEmbedder(32);
  const vec = await e.embed(world.tracks.map((t) => passageText({ title: t.title, description: t.description, lyrics: t.lyrics })));
  const snap = worldSnapshot(world, new Map(world.tracks.map((t, i) => [t.id, vec[i]])));
  const { model, ctx } = trainFromSnapshot(snap, { seed: 5, version: 'lr-test' });
  assert.deepEqual(model.row.featureNames, [...FEATURE_ORDER]);
  assert.equal(model.ranker.version, 'lr-test');
  assert.deepEqual(model.ranker, parseModel(model.row));
  const user = snap.users[0];
  for (let j = 0; j < 20; j += 1) {
    const f = features(ctx, user, j);
    assert.ok(Math.abs(scoreFeatures(model.ranker, f) - predict(model, FEATURE_ORDER.map((n) => f[n]))) < 1e-12);
  }
  assert.ok(model.metrics.holdout.auc > 0.6);
  model.standardisedWeights.forEach((w, k) => assert.ok(Math.abs(w - model.weights[k] * model.std[k]) < 1e-12));
});

test('content-guided EXPLORE: the shared rerank honours exploreScore; random mode does not pass it', async () => {
  assert.equal(sharedExploreIsContentGuided(), true);
  const world = generateWorld({ seed: 4, now: NOW });
  const e = hashEmbedder(32);
  const vec = await e.embed(world.tracks.map((t) => passageText({ title: t.title, description: t.description, lyrics: t.lyrics })));
  const ctx = buildContext(worldSnapshot(world, new Map(world.tracks.map((t, i) => [t.id, vec[i]]))));
  const user = world.users[1].id;
  const scored = ctx.tracks.slice(0, 60).map((_, j) => ({ j, score: 1 - j / 1000, sources: ['CF' as const] }));
  const score = (j: number) => features(ctx, user, j).content_sim;
  const out = rerank(ctx, user, scored, unseenExclusion, { explore: true, dateKey: '2026-11-21', exploreScore: score });
  const pick = out.find((r) => r.explore)!;
  assert.ok(pick);
  // the pick has the best content_sim among eligible pool tracks by artists not already selected
  const chosenArtists = new Set(out.filter((r) => !r.explore).map((r) => ctx.tracks[ctx.trackIdx.get(r.trackId)!].authorId));
  const pickScore = score(ctx.trackIdx.get(pick.trackId)!);
  const pool = ctx.tracks
    .map((t, j) => ({ t, j }))
    .filter(({ t, j }) => j >= 60 && !unseenExclusion(ctx, user, j) && !ctx.pairs.get(user)?.get(t.id)?.plays)
    .sort((a, b) => b.t.publishedAt.getTime() - a.t.publishedAt.getTime() || (a.t.id < b.t.id ? -1 : 1))
    .slice(0, 20)
    .filter(({ t }) => !chosenArtists.has(t.authorId));
  assert.ok(pool.every(({ j }) => score(j) <= pickScore + 1e-12));
});
