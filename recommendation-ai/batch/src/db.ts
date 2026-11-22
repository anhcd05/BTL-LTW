import type { PrismaClient } from '@infosound/database';
import { checkDemoGuard, connectedDatabaseOk, readDbUrl } from './guard';
import type { Snapshot } from './snapshot';

export class GuardError extends Error {}

/**
 * The only way this package opens a database connection. The guard runs BEFORE
 * `@infosound/database` is loaded (that module connects lazily but reads the secret on import).
 */
export async function connectDemoDb(argv: readonly string[]): Promise<PrismaClient> {
  const guard = checkDemoGuard(process.env, argv, readDbUrl(process.env));
  if (!guard.ok) throw new GuardError(`Refusing to run: ${guard.reason}`);
  const { db } = await import('@infosound/database');
  const rows = await db.$queryRaw<{ name: string }[]>`SELECT current_database() AS name`;
  if (!connectedDatabaseOk(rows[0]?.name ?? '', guard)) {
    await db.$disconnect();
    throw new GuardError(`Refusing to run: connected database "${rows[0]?.name}" failed the demo check`);
  }
  if (guard.override) process.stderr.write(`[reco] WARNING: demo guard overridden for database "${guard.database}"\n`);
  return db;
}

type TrackRow = { id: string; author_id: string; title: string; published_at: Date | null; play_count: number; genres: string[] | null };

/**
 * Training inputs from the demo DB. "Public" = the serving predicate (recommendation-ai/src/repository.ts
 * publicTrack): READY + PUBLISHED + not deleted + active author; all genre ids, like serving.
 */
export async function loadSnapshot(db: PrismaClient, now: Date, embeddingModel: string | null): Promise<Snapshot> {
  const tracks = await db.$queryRaw<TrackRow[]>`
    SELECT t.id::text, t.author_id::text, t.title, t.published_at, t.play_count,
      array_remove(array_agg(tg.genre_id ORDER BY tg.position), NULL) AS genres
    FROM tracks t
    JOIN users a ON a.id=t.author_id AND a.active=true
    LEFT JOIN track_genres tg ON tg.track_id=t.id
    WHERE t.publication_state='PUBLISHED' AND t.processing_state='READY' AND t.deleted_at IS NULL
    GROUP BY t.id
    ORDER BY t.id`;
  const publicIds = new Set(tracks.map((t) => t.id));
  const onPublic = <T extends { trackId: string }>(rows: T[]) => rows.filter((r) => publicIds.has(r.trackId));
  const likes = onPublic(
    await db.$queryRaw<{ userId: string; trackId: string; at: Date }[]>`
      SELECT user_id::text AS "userId", track_id::text AS "trackId", created_at AS at FROM track_likes`,
  );
  const listens = onPublic(
    await db.$queryRaw<{ userId: string; trackId: string; qualifiedPlays: number; lastListenedAt: Date }[]>`
      SELECT user_id::text AS "userId", track_id::text AS "trackId", qualified_plays AS "qualifiedPlays",
        last_listened_at AS "lastListenedAt" FROM track_listens`,
  );
  const engagement = onPublic(
    await db.$queryRaw<{ userId: string; trackId: string; starts: number; skips: number; completes: number; lastEventAt: Date }[]>`
      SELECT user_id::text AS "userId", track_id::text AS "trackId", starts, skips, completes,
        COALESCE(last_event_at, now()) AS "lastEventAt" FROM track_engagement`,
  );
  const playlistTracks = onPublic(
    await db.$queryRaw<{ userId: string; trackId: string; at: Date }[]>`
      SELECT p.owner_id::text AS "userId", pt.track_id::text AS "trackId", p.updated_at AS at
      FROM playlist_tracks pt JOIN playlists p ON p.id=pt.playlist_id`,
  );
  const follows = await db.$queryRaw<{ userId: string; authorId: string }[]>`
    SELECT user_id::text AS "userId", author_id::text AS "authorId" FROM artist_follows`;
  const preferences = await db.$queryRaw<{ userId: string; genreIds: string[]; artistIds: string[] }[]>`
    SELECT user_id::text AS "userId", genre_ids AS "genreIds", artist_ids::text[] AS "artistIds" FROM music_preferences`;
  const impressions = onPublic(
    await db.$queryRaw<{ userId: string; trackId: string; shownAt: Date; clicked: boolean }[]>`
      SELECT user_id::text AS "userId", track_id::text AS "trackId", shown_at AS "shownAt", clicked_at IS NOT NULL AS clicked
      FROM recommendation_impressions WHERE shown_at > now() - interval '30 days'`,
  );
  const embeddings = new Map<string, Float32Array>();
  if (embeddingModel) {
    const rows = await db.$queryRaw<{ trackId: string; vector: number[] }[]>`
      SELECT e.track_id::text AS "trackId", e.vector FROM track_embeddings e
      JOIN tracks t ON t.id=e.track_id AND t.source_version=e.source_version
      WHERE e.model=${embeddingModel}`;
    for (const r of rows) if (publicIds.has(r.trackId)) embeddings.set(r.trackId, Float32Array.from(r.vector));
  }
  const users = new Set<string>();
  for (const r of [...likes, ...listens, ...engagement, ...playlistTracks, ...impressions]) users.add(r.userId);
  for (const r of preferences) users.add(r.userId);
  return {
    now,
    tracks: tracks.map((t) => ({
      id: t.id,
      authorId: t.author_id,
      title: t.title,
      genres: t.genres ?? [],
      publishedAt: t.published_at ?? now,
      playCount: Number(t.play_count),
    })),
    users: [...users].sort(),
    likes,
    listens: listens.map((r) => ({ ...r, qualifiedPlays: Number(r.qualifiedPlays) })),
    engagement: engagement.map((r) => ({ ...r, starts: Number(r.starts), skips: Number(r.skips), completes: Number(r.completes) })),
    playlistTracks,
    follows,
    preferences,
    impressions,
    embeddings,
  };
}
