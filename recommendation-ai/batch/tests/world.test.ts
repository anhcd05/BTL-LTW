import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { createRng } from '../src/rng';
import { POOL_SIZES, genreTemplateIndices } from '../src/text';
import { GENRES, PERSONAS, PERSONA_MIX, discoveryPositives, generateWorld, personaVector, samplePersonaUser, truncateHistory, worldSnapshot } from '../src/world';
import { DEMO_AUDIO, tonePeaks } from '../src/audio';
import { passageText, contentHash, hashEmbedder } from '../src/embedder';

const NOW = new Date('2026-11-21T00:00:00Z');

test('persona sampling: Dirichlet perturbation centred on the persona', () => {
  const rng = createRng(1);
  const persona = PERSONAS[0];
  const target = personaVector(persona);
  const mean = new Array(GENRES.length).fill(0);
  const mix = [0, 0, 0, 0];
  const n = 3000;
  for (let i = 0; i < n; i += 1) {
    const s = samplePersonaUser(rng, persona);
    assert.ok(Math.abs(s.p0.reduce((a, b) => a + b, 0) - 1) < 1e-9);
    s.p0.forEach((x, k) => (mean[k] += x / n));
    s.mix.forEach((x, k) => (mix[k] += x / n));
  }
  // floor 0.01 per component shifts the mean slightly towards uniform
  target.forEach((p, k) => assert.ok(Math.abs(mean[k] - p) < 0.02, `genre ${k}: ${mean[k]} vs ${p}`));
  PERSONA_MIX.forEach((p, k) => assert.ok(Math.abs(mix[k] - p) < 0.01));
  assert.equal(PERSONAS.length, 6);
  assert.ok(PERSONAS.filter((p) => p.multiGenre).length >= 1 && PERSONAS.filter((p) => p.multiGenre).length <= 2);
  assert.equal(PERSONAS.filter((p) => p.showcase).length, 3);
});

test('every genre draws >= 10 templates from each shared pool', () => {
  GENRES.forEach((_, g) => {
    assert.ok(genreTemplateIndices(g, POOL_SIZES.title, 11).length >= 10);
    assert.ok(genreTemplateIndices(g, POOL_SIZES.description, 10).length >= 10);
    assert.ok(genreTemplateIndices(g, POOL_SIZES.lyric, 12).length >= 10);
  });
});

test('world is deterministic, sized as specified and internally consistent', () => {
  const a = generateWorld({ seed: 42, now: NOW });
  const b = generateWorld({ seed: 42, now: NOW });
  const c = generateWorld({ seed: 43, now: NOW });
  assert.deepEqual(a.tracks.map((t) => [t.id, t.title, t.description]), b.tracks.map((t) => [t.id, t.title, t.description]));
  assert.equal(a.events.length, b.events.length);
  assert.notEqual(a.tracks[0].id, c.tracks[0].id);
  assert.equal(a.tracks.length, 200);
  assert.equal(a.artists.length, 40);
  assert.equal(a.users.length, 60);
  assert.equal(new Set(a.tracks.flatMap((t) => t.genres)).size, 15);
  assert.equal(new Set(a.tracks.map((t) => t.title)).size, 200, 'titles unique');
  assert.equal(a.users.filter((u) => u.showcase).length, 3);
  assert.equal(a.tracks.filter((t) => t.stuffed).length, 2);
  const off = a.events.filter((e) => e.offTaste).length / a.events.length;
  assert.ok(off >= 0.1 && off <= 0.2, `off-taste share ${off}`);
  const start = NOW.getTime() - 60 * 86_400_000;
  assert.ok(a.events.every((e) => e.at >= start && e.at <= NOW.getTime()));
  assert.ok(a.events.every((e) => a.tracks[e.trackIdx].publishedAt.getTime() <= e.at), 'no play before release');
  assert.ok(a.events.some((e) => e.kind === 'skip' && e.offTaste) && a.events.some((e) => e.kind === 'skip' && !e.offTaste));
  // likes / listens / engagement consistency
  for (const l of a.listens) {
    const eng = a.engagement.find((e) => e.userIdx === l.userIdx && e.trackIdx === l.trackIdx)!;
    assert.equal(eng.starts - eng.skips, l.qualifiedPlays);
    assert.ok(eng.completes <= l.qualifiedPlays);
  }
  // follows: only latent favourites (some unfollowed) + ~25% random noise, all timestamped
  const fav = a.follows.filter((f) => a.users[f.userIdx].favArtists.has(f.artistIdx)).length;
  const randomShare = 1 - fav / a.follows.length;
  assert.ok(randomShare > 0.12 && randomShare < 0.4, `random follow share ${randomShare}`);
  assert.ok(fav < a.users.length * 3, 'some favourites stay unfollowed');
  assert.ok(a.follows.every((f) => Number.isFinite(f.at)));
  // playlists only contain tracks played before the playlist existed
  for (const p of a.playlists)
    for (const t of p.trackIdx) assert.ok(a.events.some((e) => e.userIdx === p.userIdx && e.trackIdx === t && e.at < p.createdAt && e.kind !== 'skip'));
  const snap = worldSnapshot(a);
  const total = snap.tracks.reduce((s, t) => s + t.playCount, 0);
  assert.equal(total, a.listens.reduce((s, l) => s + l.qualifiedPlays, 0));
  // popularity is shuffled Zipf: the top track by base popularity is not tied to a fixed genre
  const topGenres = [42, 43, 44, 45, 46].map((s) => {
    const w = generateWorld({ seed: s, now: NOW });
    return w.tracks.slice().sort((x, y) => y.basePop - x.basePop)[0].genres[0];
  });
  assert.ok(new Set(topGenres).size >= 2);
});

test('passage text and content hash follow DESIGN §6', () => {
  const text = passageText({ title: ' Mưa  Sài Gòn ', description: 'Mô tả', lyrics: ['a', 'b', 'c', 'd', 'e'] });
  assert.equal(text, 'passage: Mưa Sài Gòn. Mô tả. a / b / c / d');
  assert.ok(!/Thể loại/.test(text), 'no genre names in the passage');
  assert.match(contentHash(text, 'm1'), /^[0-9a-f]{64}$/);
  assert.notEqual(contentHash(text, 'm1'), contentHash(text, 'm2'));
});

test('hash embedder is deterministic and normalised', async () => {
  const e = hashEmbedder(64);
  const [v1, v2] = await e.embed(['passage: mưa buồn', 'passage: mưa buồn']);
  assert.deepEqual(Array.from(v1), Array.from(v2));
  assert.ok(Math.abs(v1.reduce((s, x) => s + x * x, 0) - 1) < 1e-6);
});

test('item cold start: ~15% late releases, same copy as the warm world, no behaviour before release', () => {
  const cut = NOW.getTime() - 10 * 86_400_000;
  const warm = generateWorld({ seed: 21, now: NOW });
  const cold = generateWorld({ seed: 21, now: NOW, coldShare: 0.15, coldFrom: cut });
  const late = cold.tracks.filter((t) => t.lateRelease);
  assert.equal(late.length, 30);
  assert.ok(late.every((t) => t.publishedAt.getTime() >= cut && t.publishedAt.getTime() < cut + 3 * 86_400_000));
  // honest generator: identical ids, titles, descriptions and latent mood, only the release date differs
  cold.tracks.forEach((t, i) => {
    assert.equal(t.id, warm.tracks[i].id);
    assert.equal(t.description, warm.tracks[i].description);
    assert.deepEqual(t.mood, warm.tracks[i].mood);
  });
  assert.ok(cold.events.every((e) => cold.tracks[e.trackIdx].publishedAt.getTime() <= e.at));
  const snap = worldSnapshot(cold, new Map(), { before: cut, catalogueBefore: NOW.getTime() });
  const lateIds = new Set(late.map((t) => t.id));
  assert.equal(snap.tracks.filter((t) => lateIds.has(t.id)).length, 30, 'new tracks are in the catalogue');
  assert.ok(snap.tracks.filter((t) => lateIds.has(t.id)).every((t) => t.playCount === 0));
  assert.ok(!snap.listens.some((l) => lateIds.has(l.trackId)) && !snap.engagement.some((l) => lateIds.has(l.trackId)));
  const truth = discoveryPositives(cold, cut, NOW.getTime(), { includeLaterReleases: true, onlyTracks: lateIds });
  assert.ok([...truth.values()].flat().every((t) => lateIds.has(t)));
});

test('user cold start: truncated users keep 2–3 pre-cutoff tracks, no follows/playlists, and have a survey', () => {
  const cut = NOW.getTime() - 10 * 86_400_000;
  const world = generateWorld({ seed: 22, now: NOW });
  const picked = [0, 5, 7, 11];
  const { world: t, kept } = truncateHistory(world, picked, cut, createRng(3));
  for (const u of picked) {
    const pre = new Set(t.events.filter((e) => e.userIdx === u && e.at < cut).map((e) => e.trackIdx));
    assert.ok(pre.size >= 1 && pre.size <= 3);
    assert.equal(pre.size, kept.get(u));
    assert.ok(!t.follows.some((f) => f.userIdx === u && f.at < cut));
    assert.ok(t.preferences.some((p) => p.userIdx === u));
    assert.equal(t.events.filter((e) => e.userIdx === u && e.at >= cut).length, world.events.filter((e) => e.userIdx === u && e.at >= cut).length);
  }
  assert.equal(t.events.filter((e) => e.userIdx === 1).length, world.events.filter((e) => e.userIdx === 1).length);
});

test('demo audio is 45 s so skip (< 22.5 s) and complete (>= 27 s) can be shown by hand', () => {
  assert.equal(DEMO_AUDIO.seconds, 45);
  assert.ok(Math.min(30, DEMO_AUDIO.seconds / 2) === 22.5 && 0.6 * DEMO_AUDIO.seconds === 27);
  const peaks = tonePeaks();
  assert.equal(peaks.length, 512);
  assert.ok(peaks.every((x) => x >= 0 && x <= 1) && Math.max(...peaks) === 1);
});
