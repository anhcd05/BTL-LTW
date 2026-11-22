import {
  type Rng,
  createRng,
  hashUnit,
  perturb,
  pick,
  sampleWithoutReplacement,
  shuffle,
  uuidFrom,
  weightedIndex,
  zipfWeights,
} from './rng';
import { DAY_MS, type Snapshot } from './snapshot';
import { STUFFED_DESCRIPTION, trackCopy } from './text';

/**
 * Deterministic synthetic world. Behaviour is driven by LATENT variables that no recommender can
 * read (mood vectors, track quality, per-user mixing weights and taste drift); only the aggregated
 * interaction tables leave this module through toSnapshot()/the seeder.
 */

/** 15 existing selectable genre ids (migrations 202611020001_track_genres + 202611030004_bolero_genre). */
export const GENRES: { id: string; name: string; mood: number[] }[] = [
  { id: 'pop', name: 'Pop', mood: [0.5, 0.6, -0.3, -0.3] },
  { id: 'v-pop', name: 'V-pop', mood: [0.3, 0.3, -0.1, 0.0] },
  { id: 'ballad', name: 'Ballad', mood: [-0.5, -0.4, 0.4, 0.5] },
  { id: 'bolero', name: 'Bolero', mood: [-0.4, -0.5, 0.5, 0.9] },
  { id: 'r-and-b', name: 'R&B', mood: [0.1, 0.2, -0.2, -0.1] },
  { id: 'hip-hop', name: 'Hip-Hop', mood: [0.6, 0.1, -0.6, -0.4] },
  { id: 'rap', name: 'Rap', mood: [0.8, -0.1, -0.7, -0.5] },
  { id: 'rock', name: 'Rock', mood: [0.8, -0.2, -0.2, 0.1] },
  { id: 'indie', name: 'Indie', mood: [0.0, 0.0, 0.4, 0.2] },
  { id: 'edm', name: 'EDM', mood: [0.95, 0.6, -0.9, -0.6] },
  { id: 'lo-fi', name: 'Lo-fi', mood: [-0.7, 0.1, 0.5, 0.4] },
  { id: 'acoustic', name: 'Acoustic', mood: [-0.5, 0.3, 0.9, 0.3] },
  { id: 'jazz', name: 'Jazz', mood: [-0.3, 0.2, 0.6, 0.6] },
  { id: 'folk', name: 'Folk', mood: [-0.2, 0.1, 0.8, 0.7] },
  { id: 'k-pop', name: 'K-pop', mood: [0.8, 0.7, -0.6, -0.7] },
];
const GENRE_INDEX = new Map(GENRES.map((g, i) => [g.id, i]));

export type Persona = {
  key: string;
  label: string;
  genres: Record<string, number>;
  mood: number[];
  multiGenre: boolean;
  showcase?: { email: string; username: string; displayName: string };
};

/** Mixing weights of the utility: genre 40%, artist loyalty 25%, latent mood 20%, noise 15%. */
export const PERSONA_MIX = [0.4, 0.25, 0.2, 0.15] as const;

export const PERSONAS: Persona[] = [
  {
    key: 'chill',
    label: 'Chill / Lo-fi',
    genres: { 'lo-fi': 0.4, acoustic: 0.3, jazz: 0.2, indie: 0.1 },
    mood: [-0.7, 0.1, 0.8, 0.3],
    multiGenre: false,
    showcase: { email: 'chill@demo.infosound.local', username: 'rdemo_chill', displayName: 'Demo Chill' },
  },
  {
    key: 'vpop',
    label: 'V-pop / Ballad / Bolero',
    genres: { 'v-pop': 0.4, ballad: 0.35, bolero: 0.25 },
    mood: [-0.2, -0.5, 0.3, 0.8],
    multiGenre: false,
    showcase: { email: 'vpop@demo.infosound.local', username: 'rdemo_vpop', displayName: 'Demo V-pop' },
  },
  {
    key: 'rap',
    label: 'Rap / Hip-hop / R&B',
    genres: { rap: 0.4, 'hip-hop': 0.35, 'r-and-b': 0.25 },
    mood: [0.7, 0.0, -0.6, -0.6],
    multiGenre: false,
    showcase: { email: 'rap@demo.infosound.local', username: 'rdemo_rap', displayName: 'Demo Rap' },
  },
  {
    key: 'party',
    label: 'Party (EDM + K-pop + Pop)',
    genres: { edm: 0.35, 'k-pop': 0.35, pop: 0.3 },
    mood: [0.9, 0.7, -0.8, -0.5],
    multiGenre: true,
  },
  {
    key: 'rock',
    label: 'Rock / Indie / Folk',
    genres: { rock: 0.45, indie: 0.3, folk: 0.25 },
    mood: [0.5, -0.3, 0.0, 0.2],
    multiGenre: false,
  },
  {
    key: 'eclectic',
    label: 'Eclectic (multi-genre)',
    genres: { pop: 0.15, jazz: 0.15, rock: 0.15, rap: 0.15, bolero: 0.15, folk: 0.1, 'r-and-b': 0.15 },
    mood: [0.0, 0.2, 0.0, 0.0],
    multiGenre: true,
  },
];

export const DEMO_EMAIL_DOMAIN = 'demo.infosound.local';

export type WArtist = { id: string; idx: number; name: string; email: string; username: string; primary: number; secondary: number | null; style: number[] };
export type WTrack = {
  id: string;
  assetId: string;
  idx: number;
  artistIdx: number;
  authorId: string;
  genres: string[];
  mood: number[];
  quality: number;
  basePop: number;
  publishedAt: Date;
  title: string;
  description: string;
  lyrics: string[];
  pitchHz: number;
  stuffed: boolean;
  /** Released after the cold-start cutoff (only when config.coldShare > 0). */
  lateRelease: boolean;
};
export type WUser = {
  id: string;
  idx: number;
  persona: number;
  email: string;
  username: string;
  displayName: string;
  showcase: boolean;
  p0: number[];
  p1: number[];
  mix: number[];
  mood: number[];
  mood1: number[];
  favArtists: Set<number>;
  offTaste: number;
  plays: number;
};
export type WEvent = { userIdx: number; trackIdx: number; at: number; kind: 'skip' | 'listen' | 'complete'; offTaste: boolean };

export type WorldConfig = {
  seed: number;
  now: Date;
  tracks: number;
  artists: number;
  listeners: number;
  days: number;
  /** Item cold-start scenario: this share of tracks is (re)released in [coldFrom, coldFrom + 3 d). */
  coldShare?: number;
  coldFrom?: number;
};
export const DEFAULT_WORLD: Omit<WorldConfig, 'seed' | 'now' | 'coldShare' | 'coldFrom'> = { tracks: 200, artists: 40, listeners: 60, days: 60 };

export type World = {
  config: WorldConfig;
  artists: WArtist[];
  tracks: WTrack[];
  users: WUser[];
  events: WEvent[];
  likes: { userIdx: number; trackIdx: number; at: number }[];
  follows: { userIdx: number; artistIdx: number; at: number }[];
  playlists: { id: string; userIdx: number; title: string; isPublic: boolean; createdAt: number; trackIdx: number[] }[];
  preferences: { userIdx: number; genreIds: string[]; artistIdx: number[]; at: number }[];
  listens: { userIdx: number; trackIdx: number; qualifiedPlays: number; lastListenedAt: number }[];
  engagement: { userIdx: number; trackIdx: number; starts: number; skips: number; completes: number; lastEventAt: number }[];
  /** Latent utility (oracle); never available to the recommender. */
  utility(userIdx: number, trackIdx: number, atMs: number): number;
  /** Simulated click probability of a recommended item at `now` (for simulated CTR only). */
  clickProb(userIdx: number, trackIdx: number): number;
};

const ARTIST_FIRST = ['Sóng', 'Mây', 'Gió', 'Nắng', 'Phố', 'Sao', 'Lá', 'Biển'];
const ARTIST_SECOND = ['Nhỏ', 'Lang Thang', 'Chiều', 'Xanh', 'Đêm', 'Cũ', 'Muộn'];
const GIVEN = ['An', 'Bình', 'Chi', 'Dũng', 'Giang', 'Hà', 'Hải', 'Hương', 'Khánh', 'Lan', 'Linh', 'Long', 'Mai', 'Minh', 'Nam', 'Ngọc', 'Phương', 'Quang', 'Thảo', 'Trang', 'Tuấn', 'Vy'];
const FAMILY = ['Nguyễn', 'Trần', 'Lê', 'Phạm', 'Hoàng', 'Vũ', 'Đặng', 'Bùi'];

const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));
function cosine(a: readonly number[], b: readonly number[]): number {
  let d = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    d += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? d / Math.sqrt(na * nb) : 0;
}
const clip = (x: number) => Math.max(-1, Math.min(1, x));
const pad2 = (n: number) => String(n).padStart(2, '0');

function personaVector(p: Persona): number[] {
  const v = GENRES.map((g) => p.genres[g.id] ?? 0.005);
  const total = v.reduce((a, b) => a + b, 0);
  return v.map((x) => x / total);
}

export function generateWorld(input: Partial<WorldConfig> & { seed: number; now: Date }): World {
  const config: WorldConfig = { ...DEFAULT_WORLD, ...input };
  const root = createRng(config.seed);
  const now = config.now.getTime();
  const start = now - config.days * DAY_MS;
  const ids = root.fork('ids');

  // Artists: every genre gets >= 2 primary artists, the rest are spread at random.
  const artistRng = root.fork('artists');
  const primaries = shuffle(artistRng, [
    ...GENRES.map((_, i) => i),
    ...GENRES.map((_, i) => i),
    ...Array.from({ length: Math.max(0, config.artists - 2 * GENRES.length) }, () => artistRng.int(GENRES.length)),
  ]).slice(0, config.artists);
  const artistNames = shuffle(
    artistRng,
    ARTIST_FIRST.flatMap((a) => ARTIST_SECOND.map((b) => `${a} ${b}`)),
  );
  const artists: WArtist[] = primaries.map((primary, idx) => ({
    id: uuidFrom(ids),
    idx,
    name: artistNames[idx % artistNames.length] + (idx >= artistNames.length ? ` ${idx}` : ''),
    email: `artist${pad2(idx + 1)}@${DEMO_EMAIL_DOMAIN}`,
    username: `rdemo_artist${pad2(idx + 1)}`,
    primary,
    secondary: artistRng.next() < 0.35 ? artistRng.int(GENRES.length) : null,
    style: [0, 0, 0, 0].map(() => artistRng.normal() * 0.4),
  }));
  for (const a of artists) if (a.secondary === a.primary) a.secondary = null;

  // Tracks per artist: >= 2 each, remainder proportional to a skewed prolificness weight.
  const trackRng = root.fork('tracks');
  const counts = artists.map(() => 2);
  const prolific = artists.map(() => trackRng.next() ** 2 + 0.05);
  for (let n = counts.reduce((a, b) => a + b, 0); n < config.tracks; n += 1) counts[weightedIndex(trackRng, prolific)] += 1;
  const zipf = shuffle(trackRng, zipfWeights(config.tracks, 1.1)); // popularity independent of genre
  const tracks: WTrack[] = [];
  const titles = new Set<string>();
  for (const artist of artists) {
    for (let k = 0; k < counts[artist.idx]; k += 1) {
      const idx = tracks.length;
      const genreIdx = [artist.primary];
      if (trackRng.next() < 0.3) {
        const second = artist.secondary ?? trackRng.int(GENRES.length);
        if (second !== artist.primary) genreIdx.push(second);
      }
      const centroid = GENRES[artist.primary].mood;
      // Mood is only partly genre-determined: genre centroid + artist style + N(0, 0.5) per track.
      const mood = centroid.map((c, d) => clip(0.7 * c + artist.style[d] + trackRng.normal() * 0.5));
      let copy = trackCopy(trackRng, artist.primary, GENRES[artist.primary].id, mood);
      for (let attempt = 0; titles.has(copy.title) && attempt < 12; attempt += 1)
        copy = trackCopy(trackRng, artist.primary, GENRES[artist.primary].id, mood);
      if (titles.has(copy.title)) copy = { ...copy, title: `${copy.title} (${idx + 1})` };
      titles.add(copy.title);
      // Staggered releases: most older than the 60-day window, ~12% inside the last 14 days.
      const ageDays = trackRng.next() < 0.12 ? 1 + trackRng.next() * 13 : 14 + trackRng.next() * 136;
      tracks.push({
        id: uuidFrom(ids),
        assetId: uuidFrom(ids),
        idx,
        artistIdx: artist.idx,
        authorId: artist.id,
        genres: genreIdx.map((g) => GENRES[g].id),
        mood,
        quality: Math.min(1, Math.max(0, 0.5 + trackRng.normal() * 0.2)),
        basePop: zipf[idx],
        publishedAt: new Date(Math.floor((now - ageDays * DAY_MS) / 1000) * 1000),
        title: copy.title,
        description: copy.description,
        lyrics: copy.lyrics,
        pitchHz: Math.round(180 + (700 * idx) / Math.max(1, config.tracks - 1)),
        stuffed: false,
        lateRelease: false,
      });
    }
  }
  // SIDD minor demo: two low-popularity niche tracks whose descriptions are keyword-stuffed with
  // popular-genre words. Their latent genre/mood (and therefore behaviour) is unchanged.
  const niche = tracks
    .filter((t) => ['folk', 'jazz', 'acoustic'].includes(t.genres[0]))
    .sort((a, b) => a.basePop - b.basePop)
    .slice(0, 2);
  for (const t of niche) {
    t.stuffed = true;
    t.description = STUFFED_DESCRIPTION;
  }
  // Item cold start (evaluation scenario only): a random share of tracks is released after the cutoff.
  // Only the release date changes; their copy, mood vocabulary and latent variables are generated exactly
  // like every other track (same RNG stream as above), so nothing about them leaks.
  if (config.coldShare && config.coldFrom !== undefined) {
    const coldRng = root.fork('cold-items');
    const late = shuffle(coldRng, tracks).slice(0, Math.round(config.coldShare * tracks.length));
    for (const t of late) {
      t.lateRelease = true;
      t.publishedAt = new Date(Math.floor((config.coldFrom + coldRng.next() * 3 * DAY_MS) / 1000) * 1000);
    }
  }

  // Listeners: Dirichlet perturbations of 6 personas, with latent drift, mood and loyalty.
  const userRng = root.fork('users');
  const users: WUser[] = [];
  for (let idx = 0; idx < config.listeners; idx += 1) {
    const persona = idx % PERSONAS.length;
    const p = PERSONAS[persona];
    const rank = Math.floor(idx / PERSONAS.length);
    const showcase = rank === 0 && !!p.showcase;
    const p0 = perturb(userRng, personaVector(p), 25, 0.01);
    const p1 = perturb(userRng, p0, 15, 0.01); // taste drift target at the end of the window
    const mix = perturb(userRng, [...PERSONA_MIX], 40, 0.01);
    const mood = p.mood.map((m) => clip(m + userRng.normal() * 0.35));
    const mood1 = mood.map((m) => clip(m + userRng.normal() * 0.3)); // latent mood drift over the window
    const favWeights = artists.map((a) => p0[a.primary] ** 2 + 0.3 * (a.secondary !== null ? p0[a.secondary] ** 2 : 0));
    const favArtists = new Set(sampleWithoutReplacement(userRng, favWeights, 3));
    const plays = Math.round(Math.min(480, Math.max(25, Math.exp(Math.log(110) + userRng.normal() * 0.6))));
    const given = pick(userRng, GIVEN);
    users.push({
      id: uuidFrom(ids),
      idx,
      persona,
      email: showcase ? p.showcase!.email : `listener${pad2(idx + 1)}@${DEMO_EMAIL_DOMAIN}`,
      username: showcase ? p.showcase!.username : `rdemo_listener${pad2(idx + 1)}`,
      displayName: showcase ? p.showcase!.displayName : `${pick(userRng, FAMILY)} ${given} (demo)`,
      showcase,
      p0,
      p1,
      mix,
      mood,
      mood1,
      favArtists,
      offTaste: 0.1 + userRng.next() * 0.1,
      plays: showcase ? Math.max(plays, 140) : plays,
    });
  }

  const utility = (u: number, t: number, at: number): number => {
    const user = users[u];
    const track = tracks[t];
    const frac = Math.max(0, Math.min(1, (at - start) / (now - start)));
    let best = 0;
    let max = 0;
    for (let g = 0; g < GENRES.length; g += 1) max = Math.max(max, (1 - frac) * user.p0[g] + frac * user.p1[g]);
    for (const gid of track.genres) {
      const g = GENRE_INDEX.get(gid)!;
      best = Math.max(best, (1 - frac) * user.p0[g] + frac * user.p1[g]);
    }
    const genreAff = max ? best / max : 0;
    const artistAff = user.favArtists.has(track.artistIdx) ? 1 : 0;
    const userMood = user.mood.map((m, d) => (1 - frac) * m + frac * user.mood1[d]);
    const moodAff = (1 + cosine(userMood, track.mood)) / 2;
    const noise = hashUnit(`${config.seed}|${u}|${t}`);
    return (
      user.mix[0] * genreAff + user.mix[1] * artistAff + user.mix[2] * moodAff + user.mix[3] * noise + 0.2 * (track.quality - 0.5)
    );
  };

  // Behaviour simulation over the 60-day window.
  const simRng = root.fork('behaviour');
  const events: WEvent[] = [];
  const likedAt = new Map<string, number>();
  for (const user of users) {
    const times = Array.from({ length: user.plays }, () => start + simRng.next() * (now - start - 60_000)).sort((a, b) => a - b);
    for (const at of times) {
      const available = tracks.filter((t) => t.publishedAt.getTime() <= at);
      if (!available.length) continue;
      const offTaste = simRng.next() < user.offTaste;
      const weights = available.map((t) =>
        offTaste ? t.basePop ** 0.8 : Math.exp(utility(user.idx, t.idx, at) / 0.08) * t.basePop ** 0.35,
      );
      const track = available[weightedIndex(simRng, weights)];
      const u = utility(user.idx, track.idx, at);
      const randomSkip = simRng.next() < 0.07; // interruptions, wrong click, etc.
      const tasteSkip = simRng.next() < sigmoid((0.45 - u) / 0.07);
      if (randomSkip || tasteSkip) {
        events.push({ userIdx: user.idx, trackIdx: track.idx, at, kind: 'skip', offTaste });
        continue;
      }
      const complete = simRng.next() < sigmoid((u - 0.5) / 0.08);
      events.push({ userIdx: user.idx, trackIdx: track.idx, at, kind: complete ? 'complete' : 'listen', offTaste });
      const key = `${user.idx}|${track.idx}`;
      if (complete && !likedAt.has(key) && simRng.next() < 0.35 * sigmoid((u - 0.65) / 0.06))
        likedAt.set(key, Math.min(now - 1000, at + 120_000 + simRng.next() * 300_000));
    }
  }

  const { listens, engagement } = aggregateEvents(events, Infinity);
  const likes = [...likedAt.entries()].map(([key, at]) => {
    const [u, t] = key.split('|').map(Number);
    return { userIdx: u, trackIdx: t, at };
  });

  // Follows come only from LATENT favourites (each followed with p = 0.75, so some favourites stay
  // unfollowed) plus noise: one random artist for 75% of users (~25% of all follows). Never from
  // observed likes, so following cannot leak future behaviour. Timestamped for snapshot filtering.
  const socialRng = root.fork('social');
  const follows: World['follows'] = [];
  for (const user of users) {
    const chosen = new Set<number>();
    for (const a of [...user.favArtists].sort((x, y) => x - y)) if (socialRng.next() < 0.75) chosen.add(a);
    if (socialRng.next() < 0.75) {
      const others = artists.map((a) => a.idx).filter((a) => !user.favArtists.has(a));
      chosen.add(pick(socialRng, others));
    }
    for (const a of [...chosen].sort((x, y) => x - y))
      follows.push({ userIdx: user.idx, artistIdx: a, at: start - 30 * DAY_MS + socialRng.next() * (now - start + 30 * DAY_MS) });
  }

  // Playlists for ~40% of users (and all showcase users) from their own positives.
  const playlists: World['playlists'] = [];
  for (const user of users) {
    if (!user.showcase && socialRng.next() >= 0.4) continue;
    // Built only from what the user had played before the playlist was created (no future leakage).
    const createdAt = now - (1 + socialRng.next() * 40) * DAY_MS;
    const size = 5 + socialRng.int(5);
    const isPublic = socialRng.next() < 0.5;
    const own = aggregateEvents(events.filter((e) => e.userIdx === user.idx), createdAt)
      .listens.sort((a, b) => b.qualifiedPlays - a.qualifiedPlays || a.trackIdx - b.trackIdx)
      .slice(0, size)
      .map((l) => l.trackIdx);
    if (own.length < 3) continue;
    playlists.push({ id: uuidFrom(ids), userIdx: user.idx, title: `Tuyển tập của ${user.displayName}`, isPublic, createdAt, trackIdx: own });
  }

  // Survey answers (music_preferences) for about half the users, always for showcase users.
  const preferences: World['preferences'] = [];
  for (const user of users) {
    if (!user.showcase && socialRng.next() >= 0.5) continue;
    preferences.push({ userIdx: user.idx, ...noisySurvey(socialRng, user, artists.length), at: start });
  }

  return {
    config,
    artists,
    tracks,
    users,
    events,
    likes,
    follows,
    playlists,
    preferences,
    listens,
    engagement,
    utility,
    clickProb: (u, t) => sigmoid((utility(u, t, now) - 0.55) / 0.08),
  };
}

type ListenAgg = { userIdx: number; trackIdx: number; qualifiedPlays: number; lastListenedAt: number };
type EngagementAgg = { userIdx: number; trackIdx: number; starts: number; skips: number; completes: number; lastEventAt: number };

/** Aggregates play events with `at < before` exactly like the API's tables (track_listens / track_engagement). */
export function aggregateEvents(events: readonly WEvent[], before: number): { listens: ListenAgg[]; engagement: EngagementAgg[] } {
  const listenMap = new Map<string, ListenAgg>();
  const engagementMap = new Map<string, EngagementAgg>();
  for (const e of events) {
    if (e.at >= before) continue;
    const key = `${e.userIdx}|${e.trackIdx}`;
    let eng = engagementMap.get(key);
    if (!eng) engagementMap.set(key, (eng = { userIdx: e.userIdx, trackIdx: e.trackIdx, starts: 0, skips: 0, completes: 0, lastEventAt: e.at }));
    eng.starts += 1;
    eng.lastEventAt = Math.max(eng.lastEventAt, e.at);
    if (e.kind === 'skip') {
      eng.skips += 1;
      continue;
    }
    if (e.kind === 'complete') eng.completes += 1;
    let listen = listenMap.get(key);
    if (!listen) listenMap.set(key, (listen = { userIdx: e.userIdx, trackIdx: e.trackIdx, qualifiedPlays: 0, lastListenedAt: e.at }));
    listen.qualifiedPlays += 1;
    listen.lastListenedAt = Math.max(listen.lastListenedAt, e.at);
  }
  return { listens: [...listenMap.values()], engagement: [...engagementMap.values()] };
}

/**
 * The database as it would have looked at `before` (default: world now): only tracks published, play
 * events, likes, follows, playlists and survey answers strictly before that instant; play_count and
 * skip statistics are re-aggregated from those events. snapshot.now = before.
 */
export function worldSnapshot(
  world: World,
  embeddings: Map<string, Float32Array> = new Map(),
  opts: { before?: number; catalogueBefore?: number } = {},
): Snapshot {
  const { tracks, users } = world;
  const before = opts.before ?? world.config.now.getTime();
  const { listens, engagement } = aggregateEvents(world.events, before);
  const plays = new Map<number, number>();
  for (const l of listens) plays.set(l.trackIdx, (plays.get(l.trackIdx) ?? 0) + l.qualifiedPlays);
  // catalogueBefore > before models recommending at release time: tracks exist, but have no behaviour yet.
  const published = new Set(tracks.filter((t) => t.publishedAt.getTime() < (opts.catalogueBefore ?? before)).map((t) => t.idx));
  const onCatalogue = <T extends { trackIdx: number }>(rows: readonly T[]) => rows.filter((r) => published.has(r.trackIdx));
  return {
    now: new Date(before),
    tracks: tracks
      .filter((t) => published.has(t.idx))
      .map((t) => ({ id: t.id, authorId: t.authorId, title: t.title, genres: t.genres, publishedAt: t.publishedAt, playCount: plays.get(t.idx) ?? 0 })),
    users: users.map((u) => u.id),
    likes: onCatalogue(world.likes.filter((l) => l.at < before)).map((l) => ({ userId: users[l.userIdx].id, trackId: tracks[l.trackIdx].id, at: new Date(l.at) })),
    listens: onCatalogue(listens).map((l) => ({
      userId: users[l.userIdx].id,
      trackId: tracks[l.trackIdx].id,
      qualifiedPlays: l.qualifiedPlays,
      lastListenedAt: new Date(l.lastListenedAt),
    })),
    engagement: onCatalogue(engagement).map((e) => ({
      userId: users[e.userIdx].id,
      trackId: tracks[e.trackIdx].id,
      starts: e.starts,
      skips: e.skips,
      completes: e.completes,
      lastEventAt: new Date(e.lastEventAt),
    })),
    playlistTracks: world.playlists
      .filter((p) => p.createdAt < before)
      .flatMap((p) =>
        p.trackIdx.filter((t) => published.has(t)).map((t) => ({ userId: users[p.userIdx].id, trackId: tracks[t].id, at: new Date(p.createdAt) })),
      ),
    follows: world.follows.filter((f) => f.at < before).map((f) => ({ userId: users[f.userIdx].id, authorId: world.artists[f.artistIdx].id })),
    preferences: world.preferences
      .filter((p) => p.at < before)
      .map((p) => ({ userId: users[p.userIdx].id, genreIds: p.genreIds, artistIds: p.artistIdx.map((a) => world.artists[a].id) })),
    impressions: [],
    embeddings,
  };
}

/**
 * Discovery ground truth for [from, to): (user, track) pairs whose FIRST play event is at/after `from`,
 * that are positive within the window (like OR completes >= 1 OR qualified plays >= 2) and whose track
 * was already published at `from` (otherwise no recommender at `from` could have shown it).
 */
export function discoveryPositives(
  world: World,
  from: number,
  to: number,
  opts: { includeLaterReleases?: boolean; onlyTracks?: ReadonlySet<string>; onlyUsers?: ReadonlySet<string> } = {},
): Map<string, string[]> {
  const first = new Map<string, number>();
  for (const e of world.events) {
    const key = `${e.userIdx}|${e.trackIdx}`;
    first.set(key, Math.min(first.get(key) ?? Infinity, e.at));
  }
  const window = aggregateEvents(
    world.events.filter((e) => e.at >= from),
    to,
  );
  const liked = new Set(world.likes.filter((l) => l.at < to).map((l) => `${l.userIdx}|${l.trackIdx}`));
  const completes = new Map(window.engagement.map((e) => [`${e.userIdx}|${e.trackIdx}`, e.completes]));
  const out = new Map<string, string[]>();
  for (const l of window.listens) {
    const key = `${l.userIdx}|${l.trackIdx}`;
    if ((first.get(key) ?? -Infinity) < from) continue;
    if (!opts.includeLaterReleases && world.tracks[l.trackIdx].publishedAt.getTime() >= from) continue;
    if (opts.onlyTracks && !opts.onlyTracks.has(world.tracks[l.trackIdx].id)) continue;
    if (opts.onlyUsers && !opts.onlyUsers.has(world.users[l.userIdx].id)) continue;
    if (!(liked.has(key) || (completes.get(key) ?? 0) >= 1 || l.qualifiedPlays >= 2)) continue;
    const user = world.users[l.userIdx].id;
    const list = out.get(user) ?? [];
    list.push(world.tracks[l.trackIdx].id);
    out.set(user, list);
  }
  return out;
}

/**
 * Noisy, incomplete survey answers: sometimes only one genre, each answer wrong (random genre) with
 * p = 0.25, and the optional artist is a real favourite only 60% of the time.
 */
export function noisySurvey(rng: Rng, user: WUser, artistCount: number): { genreIds: string[]; artistIdx: number[] } {
  const answers = user.p0
    .map((w, g) => ({ w, g }))
    .sort((a, b) => b.w - a.w || a.g - b.g)
    .slice(0, rng.next() < 0.2 ? 1 : 2 + rng.int(2))
    .map((x) => (rng.next() < 0.25 ? rng.int(GENRES.length) : x.g));
  const genreIds = [...new Set(answers)].map((g) => GENRES[g].id);
  const artistIdx = rng.next() < 0.5 ? [rng.next() < 0.6 ? [...user.favArtists].sort((a, b) => a - b)[0] : rng.int(artistCount)] : [];
  return { genreIds, artistIdx };
}

/**
 * User cold-start scenario: for the given users, keep only the pre-cutoff events of their first 2–3
 * distinct tracks (likes only on those), drop their pre-cutoff follows and playlists, and make sure they
 * have a (noisy) survey. Post-cutoff behaviour is untouched. Returns a new World sharing the latent model.
 */
export function truncateHistory(world: World, userIdx: readonly number[], cutoff: number, rng: Rng): { world: World; kept: Map<number, number> } {
  const picked = new Set(userIdx);
  const keepTracks = new Map<number, Set<number>>();
  const kept = new Map<number, number>();
  for (const u of [...picked].sort((a, b) => a - b)) {
    const k = 2 + rng.int(2);
    const order: number[] = [];
    for (const e of world.events.filter((x) => x.userIdx === u && x.at < cutoff).sort((a, b) => a.at - b.at))
      if (!order.includes(e.trackIdx)) order.push(e.trackIdx);
    keepTracks.set(u, new Set(order.slice(0, k)));
    kept.set(u, Math.min(k, order.length));
  }
  const keep = (u: number, t: number, at: number) => !picked.has(u) || at >= cutoff || keepTracks.get(u)!.has(t);
  const events = world.events.filter((e) => keep(e.userIdx, e.trackIdx, e.at));
  const preferences = world.preferences.slice();
  for (const u of [...picked].sort((a, b) => a - b))
    if (!preferences.some((p) => p.userIdx === u))
      preferences.push({ userIdx: u, ...noisySurvey(rng, world.users[u], world.artists.length), at: cutoff - 30 * DAY_MS });
  const { listens, engagement } = aggregateEvents(events, Infinity);
  return {
    kept,
    world: {
      ...world,
      events,
      listens,
      engagement,
      likes: world.likes.filter((l) => keep(l.userIdx, l.trackIdx, l.at)),
      follows: world.follows.filter((f) => !picked.has(f.userIdx) || f.at >= cutoff),
      playlists: world.playlists.filter((p) => !picked.has(p.userIdx) || p.createdAt >= cutoff),
      preferences,
    },
  };
}

export function genreName(id: string): string {
  return GENRES.find((g) => g.id === id)?.name ?? id;
}

/** Exposed for tests: the persona → user perturbation step on its own. */
export function samplePersonaUser(rng: Rng, persona: Persona): { p0: number[]; mix: number[] } {
  return { p0: perturb(rng, personaVector(persona), 25, 0.01), mix: perturb(rng, [...PERSONA_MIX], 40, 0.01) };
}
export { personaVector };
