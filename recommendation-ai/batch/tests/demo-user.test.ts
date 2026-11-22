import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { CORE_GENRES, SIDE_GENRE, planDemoUser, type CatalogArtist, type CatalogTrack } from '../src/demo-user';
import { GENRES } from '../src/world';

const NOW = new Date('2026-11-22T12:00:00Z');
const USER = '254e0000-0000-4000-8000-000000000001';

// 40 artists, 200 tracks: artist i plays mostly GENRES[i % 15] with a varying secondary genre.
function catalogue(): { tracks: CatalogTrack[]; artists: CatalogArtist[] } {
  const artists = Array.from({ length: 40 }, (_, i) => ({ id: `a${String(i).padStart(2, '0')}`, name: `Artist ${i}` }));
  const tracks: CatalogTrack[] = [];
  for (let i = 0; i < 200; i++) {
    const a = i % 40;
    const g = GENRES[a % GENRES.length]!.id;
    const second = GENRES[(i * 7) % GENRES.length]!.id;
    tracks.push({ id: `t${String(i).padStart(3, '0')}`, authorId: artists[a]!.id, genres: second === g ? [g] : [g, second], sourceVersion: 1 });
  }
  return { tracks, artists };
}
const tasteGenres: readonly string[] = [...CORE_GENRES, SIDE_GENRE];
const taste = (t: CatalogTrack) => t.genres.some((g) => tasteGenres.includes(g));

test('plan is deterministic and has the requested shape', () => {
  const { tracks, artists } = catalogue();
  const plan = planDemoUser(USER, tracks, artists, NOW);
  assert.deepEqual(plan, planDemoUser(USER, tracks, artists, NOW));
  assert.ok(plan.follows.length >= 3 && plan.follows.length <= 4, `follows ${plan.follows.length}`);
  assert.ok(plan.listens.length >= 20 && plan.listens.length <= 25, `listens ${plan.listens.length}`);
  assert.equal(plan.likes.length, 10);
  assert.ok(plan.skips.length >= 3);
  assert.ok(plan.listens.some((l) => l.skips > 0), 'a few skips on listened tracks');
  assert.ok(plan.playlist.trackIds.length >= 5);
  assert.deepEqual(plan.preferences.genreIds, [...CORE_GENRES]);
  assert.deepEqual(plan.preferences.artistIds, [plan.follows[0]!.authorId]);
});

test('listens are on taste tracks within the last 30 days; skips are off-taste', () => {
  const { tracks, artists } = catalogue();
  const byId = new Map(tracks.map((t) => [t.id, t]));
  const plan = planDemoUser(USER, tracks, artists, NOW);
  for (const l of plan.listens) {
    assert.ok(taste(byId.get(l.trackId)!), l.trackId);
    assert.ok(l.qualifiedPlays >= 1);
    const age = NOW.getTime() - l.at.getTime();
    assert.ok(age > 0 && age <= 30 * 86_400_000);
  }
  for (const s of plan.skips) assert.ok(!taste(byId.get(s.trackId)!));
  assert.ok(plan.listens.some((l) => byId.get(l.trackId)!.genres.includes(SIDE_GENRE)), 'a bit of lo-fi');
  const heard = new Set(plan.listens.map((l) => l.trackId));
  for (const l of plan.likes) assert.ok(heard.has(l.trackId));
  for (const id of plan.playlist.trackIds) assert.ok(heard.has(id));
  assert.ok(plan.playlist.trackIds.every((id) => plan.listens.find((l) => l.trackId === id)!.at < plan.playlist.at));
});

test('leaves same-taste tracks unheard, including tracks of followed artists', () => {
  const { tracks, artists } = catalogue();
  const plan = planDemoUser(USER, tracks, artists, NOW);
  const tasteTracks = tracks.filter(taste);
  assert.ok(plan.unheardTaste.length >= tasteTracks.length * 0.4, `${plan.unheardTaste.length}/${tasteTracks.length}`);
  const heard = new Set(plan.listens.map((l) => l.trackId));
  for (const f of plan.follows) {
    const own = tracks.filter((t) => t.authorId === f.authorId);
    assert.ok(own.some((t) => !heard.has(t.id)), `followed ${f.authorId} has unheard tracks`);
  }
});
