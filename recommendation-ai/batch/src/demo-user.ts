// `demo-user` command (DEMO ONLY): attaches a coherent Ballad / V-pop / Acoustic (+ a little Lo-fi) taste profile to
// an EXISTING, normally registered account, using only seeder-created (demo) tracks and artists. The user row itself
// (password, role, sessions, avatar) is never read for writing or modified. The email is passed at run time only.
import type { Prisma, PrismaClient } from '@infosound/database';
import { createHash } from 'node:crypto';
import { DAY_MS } from './snapshot';
import { DEMO_EMAIL_DOMAIN } from './world';

const DEMO_EMAIL_LIKE = `%@${DEMO_EMAIL_DOMAIN}`;
/** Marker used to find (and on reset remove) the playlist this command created. */
export const DEMO_USER_PLAYLIST_DESCRIPTION = 'Playlist demo (dữ liệu tổng hợp, reco demo-user)';
export const DEMO_USER_PLAYLIST_TITLE = 'Ballad & Acoustic chill';
export const CORE_GENRES = ['ballad', 'v-pop', 'acoustic'] as const;
export const SIDE_GENRE = 'lo-fi';
export const TARGET_LISTENS = 25;
export const TARGET_LIKES = 10;

export type CatalogTrack = { id: string; authorId: string; genres: string[]; sourceVersion: number };
export type CatalogArtist = { id: string; name: string };
export type ListenPlan = { trackId: string; sourceVersion: number; qualifiedPlays: number; at: Date; skips: number };
export type SkipPlan = { trackId: string; sourceVersion: number; at: Date };
export type DemoUserPlan = {
  follows: { authorId: string; at: Date }[];
  listens: ListenPlan[];
  skips: SkipPlan[];
  likes: { trackId: string; at: Date }[];
  playlist: { id: string; trackIds: string[]; at: Date };
  preferences: { genreIds: string[]; artistIds: string[]; at: Date };
  unheardTaste: string[];
};

const unit = (key: string) => createHash('sha256').update(key).digest().readUInt32BE(0) / 0x1_0000_0000;
function uuidFrom(key: string): string {
  const h = createHash('sha256').update(key).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
const isCore = (t: CatalogTrack) => t.genres.some((g) => (CORE_GENRES as readonly string[]).includes(g));
const isSide = (t: CatalogTrack) => !isCore(t) && t.genres.includes(SIDE_GENRE);

/**
 * Pure, deterministic plan for (userId, catalogue, now):
 * - follows: for each core genre the artist with the most tracks primarily in that genre, + the next best core/lo-fi
 *   artist (4 in total when available);
 * - ~25 listened tracks over the last 30 days: about half of each followed artist's taste tracks (the other half
 *   stays unheard for the FOLLOW shelf), other core tracks, 3 lo-fi tracks; ≥ 40 % of the taste tracks stay unheard;
 * - completes for every listen, a few skips on the listened tracks and 4 skipped off-taste tracks (no listen row);
 * - ~10 likes on the most played listens, one private playlist of 8 listened tracks, survey = core genres + 1 artist.
 */
export function planDemoUser(userId: string, tracks: readonly CatalogTrack[], artists: readonly CatalogArtist[], now: Date): DemoUserPlan {
  const h = (key: string) => unit(`${userId}:${key}`);
  const order = (list: readonly CatalogTrack[], salt: string) => [...list].sort((a, b) => h(salt + a.id) - h(salt + b.id) || (a.id < b.id ? -1 : 1));
  const byArtist = new Map<string, CatalogTrack[]>();
  for (const t of tracks) byArtist.set(t.authorId, [...(byArtist.get(t.authorId) ?? []), t]);
  const primary = (artistId: string) => {
    const counts = new Map<string, number>();
    for (const t of byArtist.get(artistId) ?? []) if (t.genres[0]) counts.set(t.genres[0], (counts.get(t.genres[0]) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0]?.[0] ?? null;
  };
  const tasteCount = (artistId: string) => (byArtist.get(artistId) ?? []).filter((t) => isCore(t) || isSide(t)).length;
  const known = artists.filter((a) => byArtist.has(a.id)).sort((a, b) => tasteCount(b.id) - tasteCount(a.id) || (a.id < b.id ? -1 : 1));
  const followed: string[] = [];
  for (const genre of CORE_GENRES) {
    const best = known.find((a) => !followed.includes(a.id) && primary(a.id) === genre && tasteCount(a.id) >= 4);
    if (best) followed.push(best.id);
  }
  const extra = known.find((a) => !followed.includes(a.id) && [...CORE_GENRES, SIDE_GENRE].includes(primary(a.id) as never) && tasteCount(a.id) >= 4);
  if (extra) followed.push(extra.id);

  const core = tracks.filter(isCore);
  const side = tracks.filter(isSide);
  const listened: CatalogTrack[] = [];
  const take = (t: CatalogTrack) => {
    if (listened.length < TARGET_LISTENS && !listened.includes(t)) listened.push(t);
  };
  for (const artistId of followed) {
    const own = order((byArtist.get(artistId) ?? []).filter((t) => isCore(t) || isSide(t)), 'follow');
    own.slice(0, Math.floor(own.length / 2)).forEach(take);
  }
  const sideTarget = Math.min(3, side.length);
  const maxCore = Math.floor((core.length + side.length) * 0.6) - sideTarget;
  for (const t of order(core.filter((t) => !followed.includes(t.authorId)), 'core')) {
    if (listened.length >= Math.min(TARGET_LISTENS - sideTarget, maxCore)) break;
    take(t);
  }
  order(side.filter((t) => !listened.includes(t)), 'side').slice(0, sideTarget).forEach(take);

  const at = (key: string, minDays: number, maxDays: number) =>
    new Date(Math.floor((now.getTime() - (minDays + h(key) * (maxDays - minDays)) * DAY_MS) / 1000) * 1000);
  const listens: ListenPlan[] = listened.map((t, i) => {
    const favourite = followed.includes(t.authorId);
    return {
      trackId: t.id,
      sourceVersion: t.sourceVersion,
      qualifiedPlays: 1 + Math.floor(h(`plays${t.id}`) * (favourite ? 4 : 3)),
      at: at(`at${t.id}`, 0.1, 29.5),
      skips: i % 6 === 5 ? 1 : 0,
    };
  });
  const offTaste = order(tracks.filter((t) => !isCore(t) && !isSide(t)), 'skip').slice(0, 4);
  const skips: SkipPlan[] = offTaste.map((t) => ({ trackId: t.id, sourceVersion: t.sourceVersion, at: at(`skip${t.id}`, 0.5, 13) }));
  const likes = [...listens]
    .filter((l) => !l.skips)
    .sort((a, b) => b.qualifiedPlays - a.qualifiedPlays || (a.trackId < b.trackId ? -1 : 1))
    .slice(0, TARGET_LIKES)
    .map((l) => ({ trackId: l.trackId, at: new Date(l.at.getTime() + 60_000) }));
  // Playlist built before "now" from tracks heard before its creation time.
  const playlistAt = at('playlist', 1, 3);
  const playlistTracks = listens.filter((l) => l.at < playlistAt && !l.skips).slice(0, 8).map((l) => l.trackId);
  const heard = new Set(listened.map((t) => t.id));
  return {
    follows: followed.map((authorId) => ({ authorId, at: at(`follow${authorId}`, 20, 29) })),
    listens,
    skips,
    likes,
    playlist: { id: uuidFrom(`${userId}:demo-user-playlist`), trackIds: playlistTracks, at: playlistAt },
    preferences: { genreIds: [...CORE_GENRES], artistIds: followed.slice(0, 1), at: at('survey', 29, 30) },
    unheardTaste: [...core, ...side].filter((t) => !heard.has(t.id)).map((t) => t.id),
  };
}

type Tx = Prisma.TransactionClient;

async function demoCatalog(db: Tx | PrismaClient) {
  const artists = await db.$queryRaw<{ id: string; name: string }[]>`
    SELECT id::text, display_name AS name FROM users WHERE email LIKE ${DEMO_EMAIL_LIKE} AND role='AUTHOR' AND active=true ORDER BY id`;
  // Public demo tracks only (the serving predicate).
  const tracks = await db.$queryRaw<{ id: string; author_id: string; source_version: number; genres: string[] | null }[]>`
    SELECT t.id::text, t.author_id::text, t.source_version,
      array_remove(array_agg(tg.genre_id ORDER BY tg.position), NULL) AS genres
    FROM tracks t JOIN users a ON a.id=t.author_id AND a.active=true AND a.email LIKE ${DEMO_EMAIL_LIKE}
    LEFT JOIN track_genres tg ON tg.track_id=t.id
    WHERE t.publication_state='PUBLISHED' AND t.processing_state='READY' AND t.deleted_at IS NULL
    GROUP BY t.id ORDER BY t.id`;
  return {
    artists,
    tracks: tracks.map((t) => ({ id: t.id, authorId: t.author_id, sourceVersion: Number(t.source_version), genres: t.genres ?? [] })),
  };
}

async function findAccount(db: PrismaClient, email: string) {
  const user = await db.user.findUnique({ where: { email }, select: { id: true, username: true, role: true, active: true } });
  if (!user) throw new Error('No account with that email (register it through the app first)');
  if (!user.active) throw new Error('That account is not active');
  if (user.role !== 'USER') throw new Error(`demo-user only attaches to USER accounts (found ${user.role})`);
  return user;
}

/**
 * Removes this command's data from real (non-demo) accounts: the marker playlist, the survey answer it wrote (only
 * when unchanged), and — when `userId` is given — the user's likes / listens / engagement on demo tracks and follows
 * of demo artists (play_count decremented by the removed qualified plays, mirroring the increment). Returns the
 * number of accounts touched. The user rows are never modified.
 */
export async function detachDemoUserData(
  tx: Tx,
  scope: { demoUserIds: string[]; demoTrackIds: string[]; userId?: string },
): Promise<number> {
  const owners = scope.userId
    ? [scope.userId]
    : (
        await tx.$queryRaw<{ owner_id: string }[]>`
          SELECT DISTINCT owner_id::text FROM playlists
          WHERE description=${DEMO_USER_PLAYLIST_DESCRIPTION} AND NOT (owner_id = ANY(${scope.demoUserIds}::uuid[]))`
      ).map((r) => r.owner_id);
  for (const owner of owners) {
    if (scope.demoUserIds.includes(owner)) continue;
    await tx.$executeRaw`DELETE FROM playlists WHERE owner_id=${owner}::uuid AND description=${DEMO_USER_PLAYLIST_DESCRIPTION}`;
    await tx.$executeRaw`
      DELETE FROM music_preferences WHERE user_id=${owner}::uuid
        AND genre_ids = ${[...CORE_GENRES]}::text[]
        AND cardinality(artist_ids) <= 1 AND artist_ids <@ ${scope.demoUserIds}::uuid[]`;
    if (scope.userId) {
      const removed = await tx.$queryRaw<{ track_id: string; qualified_plays: number }[]>`
        DELETE FROM track_listens WHERE user_id=${owner}::uuid AND track_id = ANY(${scope.demoTrackIds}::uuid[])
        RETURNING track_id::text, qualified_plays`;
      for (const r of removed)
        await tx.$executeRaw`UPDATE tracks SET play_count = GREATEST(0, play_count - ${Number(r.qualified_plays)}) WHERE id=${r.track_id}::uuid`;
      await tx.$executeRaw`DELETE FROM track_engagement WHERE user_id=${owner}::uuid AND track_id = ANY(${scope.demoTrackIds}::uuid[])`;
      await tx.$executeRaw`DELETE FROM track_likes WHERE user_id=${owner}::uuid AND track_id = ANY(${scope.demoTrackIds}::uuid[])`;
      await tx.$executeRaw`DELETE FROM playlist_tracks WHERE track_id = ANY(${scope.demoTrackIds}::uuid[])
        AND playlist_id IN (SELECT id FROM playlists WHERE owner_id=${owner}::uuid)`;
      await tx.$executeRaw`DELETE FROM artist_follows WHERE user_id=${owner}::uuid AND author_id = ANY(${scope.demoUserIds}::uuid[])`;
    }
  }
  return owners.filter((o) => !scope.demoUserIds.includes(o)).length;
}

export type DemoUserOptions = { email: string; now: Date; reset: boolean; log: (line: string) => void };

export async function demoUser(db: PrismaClient, opts: DemoUserOptions): Promise<void> {
  const account = await findAccount(db, opts.email);
  if (opts.reset) {
    await db.$transaction(
      async (tx) => {
        const demoUserIds = (await tx.$queryRaw<{ id: string }[]>`SELECT id::text FROM users WHERE email LIKE ${DEMO_EMAIL_LIKE}`).map((r) => r.id);
        const demoTrackIds = (await tx.$queryRaw<{ id: string }[]>`SELECT id::text FROM tracks WHERE author_id = ANY(${demoUserIds}::uuid[])`).map((r) => r.id);
        await detachDemoUserData(tx, { demoUserIds, demoTrackIds, userId: account.id });
      },
      { timeout: 60_000 },
    );
    opts.log(`demo-user: removed demo interactions from account "${account.username}" (account kept)`);
    return;
  }
  const catalog = await demoCatalog(db);
  if (catalog.tracks.length < 50) throw new Error('Demo catalogue missing: run `seed` first');
  const plan = planDemoUser(account.id, catalog.tracks, catalog.artists, opts.now);
  const counts = await db.$transaction(
    async (tx) => {
      const userId = account.id;
      // Every write is insert-if-absent, so re-runs change nothing (and never overwrite the user's own activity).
      const follows = await tx.artistFollow.createMany({
        data: plan.follows.map((f) => ({ userId, authorId: f.authorId, createdAt: f.at })),
        skipDuplicates: true,
      });
      let listens = 0;
      for (const l of plan.listens) {
        const inserted = await tx.$executeRaw`
          INSERT INTO track_listens (user_id, track_id, source_version, qualified_plays, last_listened_at, last_counted_at)
          VALUES (${userId}::uuid, ${l.trackId}::uuid, ${l.sourceVersion}, ${l.qualifiedPlays}, ${l.at}, ${l.at})
          ON CONFLICT (user_id, track_id) DO NOTHING`;
        // Same rule as seed: tracks.play_count = Σ qualified plays; only newly inserted rows add to it.
        if (inserted) {
          listens += 1;
          await tx.$executeRaw`UPDATE tracks SET play_count = play_count + ${l.qualifiedPlays} WHERE id=${l.trackId}::uuid`;
        }
      }
      const engagementRows = [
        ...plan.listens.map((l) => ({ ...l, starts: l.qualifiedPlays + l.skips, completes: l.qualifiedPlays })),
        ...plan.skips.map((s) => ({ ...s, starts: 1, skips: 1, completes: 0 })),
      ];
      let engagement = 0;
      for (const e of engagementRows)
        engagement += await tx.$executeRaw`
          INSERT INTO track_engagement (user_id, track_id, source_version, starts, skips, completes, last_event_at)
          VALUES (${userId}::uuid, ${e.trackId}::uuid, ${e.sourceVersion}, ${e.starts}, ${e.skips}, ${e.completes}, ${e.at})
          ON CONFLICT (user_id, track_id) DO NOTHING`;
      const likes = await tx.trackLike.createMany({
        data: plan.likes.map((l) => ({ userId, trackId: l.trackId, createdAt: l.at })),
        skipDuplicates: true,
      });
      let playlist = 0;
      const existing = await tx.playlist.findFirst({ where: { ownerId: userId, description: DEMO_USER_PLAYLIST_DESCRIPTION }, select: { id: true } });
      if (!existing && plan.playlist.trackIds.length) {
        await tx.playlist.create({
          data: {
            id: plan.playlist.id,
            ownerId: userId,
            title: DEMO_USER_PLAYLIST_TITLE,
            description: DEMO_USER_PLAYLIST_DESCRIPTION,
            isPublic: false,
            createdAt: plan.playlist.at,
            updatedAt: plan.playlist.at,
          },
        });
        await tx.playlistTrack.createMany({ data: plan.playlist.trackIds.map((trackId, position) => ({ playlistId: plan.playlist.id, trackId, position })) });
        playlist = 1;
      }
      const survey = await tx.musicPreference.findUnique({ where: { userId } });
      let preferences = 0;
      if (!survey) {
        const { genreIds, artistIds, at } = plan.preferences;
        await tx.musicPreference.create({ data: { userId, genreIds, artistIds, updatedAt: at } });
        preferences = 1;
      }
      return { follows: follows.count, listens, engagement, likes: likes.count, playlist, preferences, keptSurvey: !!survey };
    },
    { timeout: 120_000, maxWait: 30_000 },
  );
  opts.log(
    `demo-user "${account.username}": +${counts.follows}/${plan.follows.length} follows, +${counts.listens}/${plan.listens.length} listens, ` +
      `+${counts.engagement}/${plan.listens.length + plan.skips.length} engagement rows (${plan.skips.length} off-taste skips), ` +
      `+${counts.likes}/${plan.likes.length} likes, +${counts.playlist} playlist, +${counts.preferences} survey` +
      (counts.keptSurvey ? ' (existing survey kept)' : ''),
  );
  opts.log(`demo-user: ${plan.unheardTaste.length} same-taste demo tracks left unheard for recommendations`);
}
