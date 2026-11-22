// Tier 1 data access. Every value is a bound parameter (Prisma tagged templates / Prisma.join);
// Prisma.raw is only used for fixed, in-code table aliases.
import { Prisma, type PrismaClient } from '@infosound/database';
import type { ModelRow } from './scoring';
import type { TrackInteraction } from './taste';
import type { EmbeddingRow } from './vectors';

export type Db = Pick<PrismaClient, '$queryRaw' | '$executeRaw'>;

const DAY_MS = 86_400_000;
export const RECENT_DAYS = 14;
export const TRENDING_DAYS = 7;
export const EXPOSURE_DAYS = 30;
export const SKIP_DAYS = 14;
export const CF_SEEDS = 50;
export const LIMITS = { cf: 50, content: 50, follow: 25, trending: 25, explore: 20, interactions: 500, survey: 200 } as const;

export const daysBefore = (now: Date, days: number) => new Date(now.getTime() - days * DAY_MS);
/** 00:00 UTC of the given instant's day. */
export const utcDayStart = (now: Date) => new Date(Math.floor(now.getTime() / DAY_MS) * DAY_MS);

/** Public = same predicate as publicTrackWhere, plus an active author (as playback requires). */
function publicTrack(alias: 't' | 'c'): Prisma.Sql {
  const a = Prisma.raw(alias);
  return Prisma.sql`${a}.publication_state='PUBLISHED' AND ${a}.processing_state='READY' AND ${a}.deleted_at IS NULL
    AND EXISTS (SELECT 1 FROM users author WHERE author.id=${a}.author_id AND author.active=true)`;
}
export function uuidArray(ids: readonly string[]): Prisma.Sql {
  return ids.length ? Prisma.sql`ARRAY[${Prisma.join(ids)}]::uuid[]` : Prisma.sql`ARRAY[]::uuid[]`;
}
export function textArray(values: readonly string[]): Prisma.Sql {
  return values.length ? Prisma.sql`ARRAY[${Prisma.join(values)}]::text[]` : Prisma.sql`ARRAY[]::text[]`;
}

export async function loadActiveModel(db: Db): Promise<ModelRow | null> {
  const rows = await db.$queryRaw<ModelRow[]>`
    SELECT version,feature_names AS "featureNames",weights,bias
    FROM recommendation_models WHERE active=true
    ORDER BY created_at DESC LIMIT 1`;
  return rows[0] ?? null;
}

export async function loadPublicEmbeddings(db: Db): Promise<EmbeddingRow[]> {
  return db.$queryRaw<EmbeddingRow[]>`
    SELECT e.track_id::text AS "trackId",e.model,e.dims,e.vector::float8[] AS vector
    FROM track_embeddings e JOIN tracks t ON t.id=e.track_id AND e.source_version=t.source_version
    WHERE ${publicTrack('t')}`;
}

export type InteractionRow = TrackInteraction & { title: string; genres: string[] };
/** The user's own interactions with currently public tracks, newest first. */
export async function loadInteractions(db: Db, userId: string): Promise<InteractionRow[]> {
  return db.$queryRaw<InteractionRow[]>`
    WITH ids AS (
      SELECT track_id FROM track_likes WHERE user_id=${userId}::uuid
      UNION SELECT track_id FROM track_listens WHERE user_id=${userId}::uuid
      UNION SELECT track_id FROM track_engagement WHERE user_id=${userId}::uuid
      UNION SELECT pt.track_id FROM playlist_tracks pt JOIN playlists p ON p.id=pt.playlist_id
        WHERE p.owner_id=${userId}::uuid
    )
    SELECT t.id::text AS "trackId",t.title,
      l.created_at AS "likedAt",
      COALESCE(h.qualified_plays,0)::int AS plays,h.last_listened_at AS "listenedAt",
      COALESCE(e.completes,0)::int AS completes,COALESCE(e.skips,0)::int AS skips,e.last_event_at AS "engagedAt",
      EXISTS (SELECT 1 FROM playlist_tracks pt JOIN playlists p ON p.id=pt.playlist_id
        WHERE p.owner_id=${userId}::uuid AND pt.track_id=t.id) AS "inPlaylist",
      COALESCE((SELECT array_agg(tg.genre_id ORDER BY tg.position) FROM track_genres tg WHERE tg.track_id=t.id),
        ARRAY[]::text[]) AS genres
    FROM ids JOIN tracks t ON t.id=ids.track_id
    LEFT JOIN track_likes l ON l.user_id=${userId}::uuid AND l.track_id=t.id
    LEFT JOIN track_listens h ON h.user_id=${userId}::uuid AND h.track_id=t.id
    LEFT JOIN track_engagement e ON e.user_id=${userId}::uuid AND e.track_id=t.id
    WHERE ${publicTrack('t')}
    ORDER BY GREATEST(l.created_at,h.last_listened_at,e.last_event_at) DESC NULLS LAST,t.id
    LIMIT ${LIMITS.interactions}`;
}

export type Survey = { genreIds: string[]; artistIds: string[] };
export async function loadSurvey(db: Db, userId: string): Promise<Survey> {
  const rows = await db.$queryRaw<Survey[]>`
    SELECT genre_ids AS "genreIds",artist_ids::text[] AS "artistIds"
    FROM music_preferences WHERE user_id=${userId}::uuid`;
  return rows[0] ?? { genreIds: [], artistIds: [] };
}

/** Every liked track id (unbounded, unlike the 500-row interaction profile). */
export async function loadLikedIds(db: Db, userId: string): Promise<string[]> {
  const rows = await db.$queryRaw<{ trackId: string }[]>`
    SELECT track_id::text AS "trackId" FROM track_likes WHERE user_id=${userId}::uuid`;
  return rows.map((row) => row.trackId);
}

/** Tracks this user skipped more often than completed within the last 14 days. */
export async function loadSkippedIds(db: Db, userId: string, now: Date): Promise<string[]> {
  const rows = await db.$queryRaw<{ trackId: string }[]>`
    SELECT track_id::text AS "trackId" FROM track_engagement
    WHERE user_id=${userId}::uuid AND skips>completes AND last_event_at>=${daysBefore(now, SKIP_DAYS)}`;
  return rows.map((row) => row.trackId);
}

export async function loadFollowedArtists(db: Db, userId: string): Promise<string[]> {
  const rows = await db.$queryRaw<{ authorId: string }[]>`
    SELECT author_id::text AS "authorId" FROM artist_follows WHERE user_id=${userId}::uuid`;
  return rows.map((row) => row.authorId);
}

/** Excludes what the re-rank would drop anyway (liked, listened in 14 days, recently skipped, own). */
function unseenBy(userId: string, now: Date, alias: 'c'): Prisma.Sql {
  const a = Prisma.raw(alias);
  return Prisma.sql`${a}.author_id<>${userId}::uuid
    AND NOT EXISTS (SELECT 1 FROM track_likes ul WHERE ul.user_id=${userId}::uuid AND ul.track_id=${a}.id)
    AND NOT EXISTS (SELECT 1 FROM track_listens uh WHERE uh.user_id=${userId}::uuid AND uh.track_id=${a}.id
      AND uh.last_listened_at>=${daysBefore(now, RECENT_DAYS)})
    AND NOT EXISTS (SELECT 1 FROM track_engagement us WHERE us.user_id=${userId}::uuid AND us.track_id=${a}.id
      AND us.skips>us.completes AND us.last_event_at>=${daysBefore(now, SKIP_DAYS)})`;
}

export type CfRow = { trackId: string; score: number; seedId: string };
/**
 * Item-item co-occurrence over positive sets (likes ∪ listens ∪ completes ∪ playlist tracks):
 * score(j) = Σ_{i∈seeds(u)} cooc(i,j)/sqrt(n_i·n_j); seedId is the seed with the largest term.
 * Seeds are bounded to the user's 50 most recent public positives.
 */
export async function cfCandidates(db: Db, userId: string, now: Date): Promise<CfRow[]> {
  return db.$queryRaw<CfRow[]>`
    WITH pos AS MATERIALIZED (
      SELECT user_id,track_id FROM track_likes
      UNION SELECT user_id,track_id FROM track_listens
      UNION SELECT user_id,track_id FROM track_engagement WHERE completes>0
      UNION SELECT p.owner_id,pt.track_id FROM playlist_tracks pt JOIN playlists p ON p.id=pt.playlist_id
    ), visible AS MATERIALIZED (
      SELECT pos.user_id,pos.track_id FROM pos JOIN tracks t ON t.id=pos.track_id WHERE ${publicTrack('t')}
    ), seeds AS MATERIALIZED (
      SELECT recent.track_id FROM (
        SELECT track_id,created_at AS at FROM track_likes WHERE user_id=${userId}::uuid
        UNION ALL SELECT track_id,last_listened_at FROM track_listens WHERE user_id=${userId}::uuid
        UNION ALL SELECT track_id,last_event_at FROM track_engagement WHERE user_id=${userId}::uuid AND completes>0
        UNION ALL SELECT pt.track_id,p.updated_at FROM playlist_tracks pt JOIN playlists p ON p.id=pt.playlist_id
          WHERE p.owner_id=${userId}::uuid
      ) recent JOIN tracks t ON t.id=recent.track_id
      WHERE ${publicTrack('t')}
      GROUP BY recent.track_id
      ORDER BY max(recent.at) DESC,recent.track_id LIMIT ${CF_SEEDS}
    ), counts AS MATERIALIZED (
      SELECT track_id,count(*)::float8 AS n FROM visible GROUP BY track_id
    ), pairs AS (
      SELECT s.track_id AS seed_id,other.track_id AS candidate_id,count(*)::float8 AS together
      FROM seeds s
      JOIN visible peer ON peer.track_id=s.track_id AND peer.user_id<>${userId}::uuid
      JOIN visible other ON other.user_id=peer.user_id AND other.track_id<>s.track_id
      GROUP BY s.track_id,other.track_id
    ), scored AS (
      SELECT p.candidate_id,p.seed_id,p.together/sqrt(ns.n*nc.n) AS sim
      FROM pairs p
      JOIN counts ns ON ns.track_id=p.seed_id
      JOIN counts nc ON nc.track_id=p.candidate_id
      JOIN tracks c ON c.id=p.candidate_id
      WHERE ${unseenBy(userId, now, 'c')}
    )
    SELECT candidate_id::text AS "trackId",sum(sim)::float8 AS score,
      ((array_agg(seed_id ORDER BY sim DESC,seed_id))[1])::text AS "seedId"
    FROM scored GROUP BY candidate_id
    ORDER BY score DESC,candidate_id LIMIT ${LIMITS.cf}`;
}

/** Public tracks of followed artists: newest and most played. */
export async function followCandidates(db: Db, userId: string): Promise<string[]> {
  const rows = await db.$queryRaw<{ trackId: string }[]>`
    SELECT ranked.id::text AS "trackId" FROM (
      SELECT t.id,
        row_number() OVER (ORDER BY t.published_at DESC NULLS LAST,t.id) AS newest,
        row_number() OVER (ORDER BY t.play_count DESC,t.id) AS played
      FROM artist_follows f JOIN tracks t ON t.author_id=f.author_id
      WHERE f.user_id=${userId}::uuid AND ${publicTrack('t')}
    ) ranked
    WHERE ranked.newest<=${Math.ceil(LIMITS.follow / 2)} OR ranked.played<=${Math.floor(LIMITS.follow / 2)}
    ORDER BY ranked.newest`;
  return rows.map((row) => row.trackId);
}

/** Distinct listeners whose last listen is within 7 days (approximation; play_count is lifetime). */
export async function trendingCandidates(db: Db, now: Date): Promise<string[]> {
  const rows = await db.$queryRaw<{ trackId: string }[]>`
    SELECT l.track_id::text AS "trackId"
    FROM track_listens l JOIN tracks t ON t.id=l.track_id
    WHERE l.last_listened_at>=${daysBefore(now, TRENDING_DAYS)} AND ${publicTrack('t')}
    GROUP BY l.track_id
    ORDER BY count(DISTINCT l.user_id) DESC,l.track_id LIMIT ${LIMITS.trending}`;
  return rows.map((row) => row.trackId);
}

/**
 * Exploration pool: public tracks unseen by the user, ordered by distinct users who were shown them in
 * the 30 days before today 00:00 UTC (so the pool is stable within a UTC day), then newest first.
 */
export async function explorePool(db: Db, userId: string, now: Date): Promise<string[]> {
  const dayStart = utcDayStart(now);
  const rows = await db.$queryRaw<{ trackId: string }[]>`
    SELECT c.id::text AS "trackId" FROM tracks c
    WHERE ${publicTrack('c')} AND ${unseenBy(userId, now, 'c')}
      AND NOT EXISTS (SELECT 1 FROM track_listens seen WHERE seen.user_id=${userId}::uuid AND seen.track_id=c.id)
    ORDER BY (SELECT count(DISTINCT i.user_id) FROM recommendation_impressions i
        WHERE i.track_id=c.id AND i.shown_at>=${daysBefore(dayStart, EXPOSURE_DAYS)} AND i.shown_at<${dayStart}) ASC,
      c.published_at DESC NULLS LAST,c.id
    LIMIT ${LIMITS.explore}`;
  return rows.map((row) => row.trackId);
}

export async function surveyTrackIds(db: Db, survey: Survey): Promise<string[]> {
  if (!survey.genreIds.length && !survey.artistIds.length) return [];
  const rows = await db.$queryRaw<{ trackId: string }[]>`
    SELECT t.id::text AS "trackId" FROM tracks t
    WHERE ${publicTrack('t')} AND (t.author_id=ANY(${uuidArray(survey.artistIds)})
      OR EXISTS (SELECT 1 FROM track_genres tg WHERE tg.track_id=t.id AND tg.genre_id=ANY(${textArray(survey.genreIds)})))
    ORDER BY t.play_count DESC,t.id LIMIT ${LIMITS.survey}`;
  return rows.map((row) => row.trackId);
}

export type TrackMeta = {
  trackId: string;
  title: string;
  artistId: string;
  artistName: string;
  playCount: number;
  publishedAt: Date | null;
  genres: string[];
  skips: number;
  starts: number;
};
export async function trackMetadata(db: Db, ids: readonly string[]): Promise<TrackMeta[]> {
  if (!ids.length) return [];
  return db.$queryRaw<TrackMeta[]>`
    SELECT t.id::text AS "trackId",t.title,t.author_id::text AS "artistId",a.display_name AS "artistName",
      t.play_count AS "playCount",t.published_at AS "publishedAt",
      COALESCE((SELECT array_agg(tg.genre_id ORDER BY tg.position) FROM track_genres tg WHERE tg.track_id=t.id),
        ARRAY[]::text[]) AS genres,
      COALESCE(e.skips,0)::float8 AS skips,COALESCE(e.starts,0)::float8 AS starts -- distinct users
    FROM tracks t JOIN users a ON a.id=t.author_id
    LEFT JOIN LATERAL (
      -- One user contributes at most 1 to each count, so a single account cannot poison skip_rate.
      SELECT sum(LEAST(g.skips,1)) AS skips,sum(LEAST(g.starts,1)) AS starts FROM track_engagement g WHERE g.track_id=t.id
    ) e ON true
    WHERE t.id=ANY(${uuidArray(ids)}) AND ${publicTrack('t')}`;
}

export async function maxPublicPlayCount(db: Db): Promise<number> {
  const rows = await db.$queryRaw<{ max: number }[]>`
    SELECT COALESCE(max(t.play_count),0)::int AS max FROM tracks t WHERE ${publicTrack('t')}`;
  return rows[0]?.max ?? 0;
}
