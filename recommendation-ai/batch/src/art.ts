// `art` command (DEMO ONLY): procedural cover art + avatars for seeder-created rows, stored exactly like the API's
// processed images (apps/api/src/features/tracks/tracks.controller.ts completeArtwork, avatar.controller.ts complete):
// bucket `artwork`, keys cover/<trackId>/<uuid>.webp and avatar/<userId>/<uuid>.webp, image/webp,
// CacheControl `private, max-age=300`, sha256 checksum + size, verified ARTWORK track_assets row
// (source/pipeline version of the track) and users.avatar_* columns with avatar_revision + 1.
import { createHash } from 'node:crypto';
import type { PrismaClient } from '@infosound/database';
import {
  AVATAR_SIZE,
  COVER_SIZE,
  avatarKey,
  avatarPixels,
  coverKey,
  coverPixels,
  encodeWebp,
  initials,
} from './art-render';
import { PIPELINE_VERSION, ffmpegAvailable } from './audio';
import { DEMO_EMAIL_DOMAIN } from './world';

export const ARTWORK_BUCKET = 'artwork';
const DEMO_EMAIL_LIKE = `%@${DEMO_EMAIL_DOMAIN}`;

export type ArtOptions = { force: boolean; covers: boolean; avatars: boolean; log: (line: string) => void };

type TrackRow = { id: string; source_version: number; artwork_asset_id: string | null; genres: string[] | null };
type UserRow = { id: string; display_name: string; role: string; avatar_key: string | null; genres: string[] | null };
type Stored = { key: string; versionId: string | null; checksum: string; size: number };

/** S3 identity: the API's identity (Write:artwork/*) by default; RECO_S3_IDENTITY overrides (e.g. BOOTSTRAP). */
async function artworkWriter(): Promise<{ put: (key: string, body: Buffer) => Promise<Stored>; close: () => void }> {
  const storage = await import('@infosound/storage');
  const identity = (process.env.RECO_S3_IDENTITY || 'API') as Parameters<typeof storage.storageClient>[0];
  const s3 = storage.storageClient(identity);
  return {
    put: async (key, body) => {
      const put = await s3.send(
        new storage.PutObjectCommand({
          Bucket: ARTWORK_BUCKET,
          Key: key,
          Body: body,
          ContentLength: body.length,
          ContentType: 'image/webp',
          CacheControl: 'private, max-age=300',
        }),
      );
      const head = await s3.send(
        new storage.HeadObjectCommand({ Bucket: ARTWORK_BUCKET, Key: key, ...(put.VersionId ? { VersionId: put.VersionId } : {}) }),
      );
      if (Number(head.ContentLength) !== body.length || head.ContentType !== 'image/webp')
        throw new Error(`Uploaded image mismatch for ${key}`);
      return { key, versionId: put.VersionId || null, checksum: createHash('sha256').update(body).digest('hex'), size: body.length };
    },
    close: () => s3.destroy(),
  };
}

function deleteEvent(key: string, versionId: string | null) {
  return { type: 'OBJECT_DELETE', payload: { bucket: ARTWORK_BUCKET, key, versionId } };
}

export async function generateArt(db: PrismaClient, opts: ArtOptions): Promise<void> {
  if (!(await ffmpegAvailable())) throw new Error('ffmpeg not found (set FFMPEG_PATH); it encodes the WebP images');
  // Seeder-created rows only: tracks authored by @demo.infosound.local users, and those users.
  const tracks = opts.covers
    ? await db.$queryRaw<TrackRow[]>`
        SELECT t.id::text, t.source_version, t.artwork_asset_id::text,
          array_remove(array_agg(tg.genre_id ORDER BY tg.position), NULL) AS genres
        FROM tracks t JOIN users a ON a.id=t.author_id AND a.email LIKE ${DEMO_EMAIL_LIKE}
        LEFT JOIN track_genres tg ON tg.track_id=t.id
        WHERE t.deleted_at IS NULL
        GROUP BY t.id ORDER BY t.id`
    : [];
  // Avatar colour: the user's most frequent genre (own tracks for artists, liked tracks for listeners).
  const users = opts.avatars
    ? await db.$queryRaw<UserRow[]>`
        SELECT u.id::text, u.display_name, u.role::text, u.avatar_key,
          (SELECT array_agg(g.genre_id ORDER BY g.n DESC, g.genre_id) FROM (
             SELECT tg.genre_id, count(*) AS n FROM track_genres tg
             WHERE tg.track_id IN (SELECT id FROM tracks WHERE author_id=u.id
                                   UNION SELECT track_id FROM track_likes WHERE user_id=u.id)
             GROUP BY tg.genre_id) g) AS genres
        FROM users u WHERE u.email LIKE ${DEMO_EMAIL_LIKE} ORDER BY u.id`
    : [];
  const todoTracks = tracks.filter((t) => opts.force || !t.artwork_asset_id);
  const todoUsers = users.filter((u) => opts.force || !u.avatar_key);
  opts.log(`art: ${todoTracks.length}/${tracks.length} demo covers and ${todoUsers.length}/${users.length} demo avatars to generate`);
  if (!todoTracks.length && !todoUsers.length) return;

  const writer = await artworkWriter();
  let bytes = 0;
  try {
    for (const [i, t] of todoTracks.entries()) {
      const webp = await encodeWebp(coverPixels(t.id, t.genres ?? []), COVER_SIZE);
      const stored = await writer.put(coverKey(t.id), webp);
      bytes += stored.size;
      await db.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM tracks WHERE id=${t.id}::uuid FOR UPDATE`;
        const track = await tx.track.findFirst({
          where: { id: t.id, deletedAt: null, author: { email: { endsWith: `@${DEMO_EMAIL_DOMAIN}` } } },
          select: { id: true, sourceVersion: true, artworkAssetId: true },
        });
        if (!track) return;
        const previous = track.artworkAssetId ? await tx.trackAsset.findUnique({ where: { id: track.artworkAssetId } }) : null;
        const fields = { bucket: ARTWORK_BUCKET, key: stored.key, versionId: stored.versionId, size: BigInt(stored.size), contentType: 'image/webp', checksum: stored.checksum, verified: true };
        const asset = await tx.trackAsset.upsert({
          where: {
            trackId_sourceVersion_pipelineVersion_kind: { trackId: track.id, sourceVersion: track.sourceVersion, pipelineVersion: PIPELINE_VERSION, kind: 'ARTWORK' },
          },
          create: { trackId: track.id, sourceVersion: track.sourceVersion, pipelineVersion: PIPELINE_VERSION, kind: 'ARTWORK', ...fields },
          update: fields,
        });
        await tx.track.update({ where: { id: track.id }, data: { artworkAssetId: asset.id } });
        if (previous && previous.key !== stored.key) await tx.outboxEvent.create({ data: deleteEvent(previous.key, previous.versionId) });
      });
      if ((i + 1) % 50 === 0) opts.log(`art: ${i + 1}/${todoTracks.length} covers`);
    }
    for (const u of todoUsers) {
      const style = u.role === 'AUTHOR' ? 'initials' : 'face';
      const webp = await encodeWebp(avatarPixels(u.id, style, u.genres ?? []), AVATAR_SIZE, style === 'initials' ? initials(u.display_name) : undefined);
      const stored = await writer.put(avatarKey(u.id), webp);
      bytes += stored.size;
      await db.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM users WHERE id=${u.id}::uuid FOR UPDATE`;
        const user = await tx.user.findFirst({
          where: { id: u.id, email: { endsWith: `@${DEMO_EMAIL_DOMAIN}` } },
          select: { avatarKey: true, avatarVersionId: true },
        });
        if (!user) return;
        await tx.user.update({
          where: { id: u.id },
          data: {
            avatarKey: stored.key,
            avatarVersionId: stored.versionId,
            avatarChecksum: stored.checksum,
            avatarSize: BigInt(stored.size),
            avatarRevision: { increment: 1 },
          },
        });
        if (user.avatarKey && user.avatarKey !== stored.key) await tx.outboxEvent.create({ data: deleteEvent(user.avatarKey, user.avatarVersionId) });
      });
    }
  } finally {
    writer.close();
  }
  opts.log(`art: stored ${todoTracks.length} covers + ${todoUsers.length} avatars, ${(bytes / 1048576).toFixed(1)} MB in bucket ${ARTWORK_BUCKET}`);
}
