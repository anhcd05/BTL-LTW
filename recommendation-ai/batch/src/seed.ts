import type { PrismaClient } from '@infosound/database';
import { SOURCE_VERSION, PIPELINE_VERSION, PLAYBACK_BUCKET, DEMO_AUDIO, deleteObjects, ffmpegAvailable, renderTone, tonePeaks, uploader, type UploadedAudio, playbackKey } from './audio';
import { DEMO_EMAIL_DOMAIN, GENRES, type World, generateWorld, genreName } from './world';
import { DAY_MS } from './snapshot';
import { ARTWORK_BUCKET } from './art';
import { detachDemoUserData } from './demo-user';

/** Demo-only password for the 3 showcase accounts (documented in README; never use elsewhere). */
export const DEMO_PASSWORD = 'RecoDemo#2026';
const DEMO_EMAIL_LIKE = `%@${DEMO_EMAIL_DOMAIN}`;

export type SeedOptions = { seed: number; now: Date; reset: boolean; resetOnly: boolean; skipAudio: boolean; log: (line: string) => void };

async function demoUserCount(db: PrismaClient): Promise<number> {
  return db.user.count({ where: { email: { endsWith: `@${DEMO_EMAIL_DOMAIN}` } } });
}

/** Deletes ONLY rows created by the seeder: users @demo.infosound.local and tracks authored by them. */
export async function resetDemo(db: PrismaClient, log: (line: string) => void): Promise<void> {
  const objects = await db.$transaction(
    async (tx) => {
      const users = (await tx.$queryRaw<{ id: string }[]>`SELECT id::text FROM users WHERE email LIKE ${DEMO_EMAIL_LIKE}`).map((r) => r.id);
      if (!users.length) return [];
      const tracks = (await tx.$queryRaw<{ id: string }[]>`SELECT id::text FROM tracks WHERE author_id = ANY(${users}::uuid[])`).map((r) => r.id);
      // PLAYBACK (audio-playback) and ARTWORK (artwork, from `art`) objects, plus `art` avatars.
      const assets = await tx.trackAsset.findMany({ where: { trackId: { in: tracks } }, select: { bucket: true, key: true, versionId: true } });
      const avatars = await tx.user.findMany({ where: { id: { in: users }, avatarKey: { not: null } }, select: { avatarKey: true, avatarVersionId: true } });
      for (const a of avatars) assets.push({ bucket: ARTWORK_BUCKET, key: a.avatarKey!, versionId: a.avatarVersionId });
      // `demo-user` data attached to real accounts: marker playlist + its survey answer. All its other rows point at
      // demo tracks/artists and go with them below (likes/playlist_tracks explicitly, listens/engagement/follows by
      // cascade). The real account itself is never modified.
      const attached = await detachDemoUserData(tx, { demoUserIds: users, demoTrackIds: tracks });
      if (attached) log(`reset: removed demo-user data from ${attached} real account(s) (accounts kept)`);
      await tx.$executeRaw`DELETE FROM track_likes WHERE track_id = ANY(${tracks}::uuid[]) OR user_id = ANY(${users}::uuid[])`;
      await tx.$executeRaw`DELETE FROM playlist_tracks WHERE track_id = ANY(${tracks}::uuid[])
        OR playlist_id IN (SELECT id FROM playlists WHERE owner_id = ANY(${users}::uuid[]))`;
      await tx.$executeRaw`DELETE FROM notifications WHERE release_event_id IN (SELECT id FROM release_events WHERE track_id = ANY(${tracks}::uuid[]))`;
      await tx.$executeRaw`DELETE FROM release_events WHERE track_id = ANY(${tracks}::uuid[])`;
      await tx.$executeRaw`DELETE FROM upload_sessions WHERE track_id = ANY(${tracks}::uuid[]) OR user_id = ANY(${users}::uuid[])`;
      await tx.$executeRaw`DELETE FROM processing_tasks WHERE track_id = ANY(${tracks}::uuid[])`;
      await tx.$executeRaw`DELETE FROM track_assets WHERE track_id = ANY(${tracks}::uuid[])`;
      // ON DELETE CASCADE: genres, lyrics, listens, comments, waveforms, engagement, embeddings, impressions.
      const deletedTracks = await tx.$executeRaw`DELETE FROM tracks WHERE id = ANY(${tracks}::uuid[])`;
      const deletedUsers = await tx.$executeRaw`DELETE FROM users WHERE id = ANY(${users}::uuid[]) AND email LIKE ${DEMO_EMAIL_LIKE}`;
      log(`reset: deleted ${deletedTracks} demo tracks and ${deletedUsers} demo users (cascading rows included)`);
      return assets;
    },
    { timeout: 120_000, maxWait: 30_000 },
  );
  if (objects.length) {
    const removed = await deleteObjects(objects);
    log(`reset: removed ${removed}/${objects.length} demo audio/image objects (best effort)`);
  }
}

export async function seed(db: PrismaClient, opts: SeedOptions): Promise<void> {
  const existing = await demoUserCount(db);
  if (existing && !opts.reset && !opts.resetOnly)
    throw new Error(`Demo data already present (${existing} users @${DEMO_EMAIL_DOMAIN}); pass --reset to delete and re-seed`);
  if (existing) await resetDemo(db, opts.log);
  if (opts.resetOnly) return;

  const genreRows = await db.genre.findMany({ where: { id: { in: GENRES.map((g) => g.id) }, isSelectable: true }, select: { id: true } });
  const missing = GENRES.map((g) => g.id).filter((id) => !genreRows.some((r) => r.id === id));
  if (missing.length) throw new Error(`Selectable genres missing in DB (migrations not applied?): ${missing.join(', ')}`);

  const world = generateWorld({ seed: opts.seed, now: opts.now });
  opts.log(`world: ${world.tracks.length} tracks, ${world.artists.length} artists, ${world.users.length} listeners, ${world.events.length} play events`);

  const audio = new Map<string, UploadedAudio>();
  if (!opts.skipAudio) {
    if (!(await ffmpegAvailable())) throw new Error('ffmpeg not found (set FFMPEG_PATH) — or pass --skip-audio (tracks will not be playable)');
    // Render everything first so the size budget is checked before anything is uploaded.
    const rendered = new Map<string, Buffer>();
    for (const t of world.tracks) rendered.set(t.id, await renderTone(t.pitchHz));
    const totalBytes = [...rendered.values()].reduce((s, b) => s + b.length, 0);
    const maxMb = Number(process.env.RECO_AUDIO_MAX_MB || 200);
    opts.log(`audio: rendered ${rendered.size} × ${DEMO_AUDIO.seconds} s FLAC, total ${(totalBytes / 1048576).toFixed(1)} MB (limit ${maxMb} MB)`);
    if (totalBytes > maxMb * 1048576) throw new Error(`Demo audio would be ${(totalBytes / 1048576).toFixed(1)} MB > RECO_AUDIO_MAX_MB=${maxMb}`);
    const upload = await uploader();
    for (const t of world.tracks) {
      audio.set(t.id, await upload(t.id, rendered.get(t.id)!));
      if (audio.size % 25 === 0) opts.log(`audio: ${audio.size}/${world.tracks.length} uploaded`);
    }
  }
  const { hashDemoPassword } = await import('./password');
  const passwordHash = await hashDemoPassword(DEMO_PASSWORD);
  await writeWorld(db, world, audio, passwordHash, opts);
  opts.log(
    `seeded: ${world.likes.length} likes, ${world.listens.length} listens, ${world.engagement.length} engagement rows, ` +
      `${world.follows.length} follows, ${world.playlists.length} playlists, ${world.preferences.length} survey answers`,
  );
  for (const u of world.users.filter((x) => x.showcase)) opts.log(`demo login: ${u.email} / ${DEMO_PASSWORD}`);
  if (opts.skipAudio) opts.log('NOTE: --skip-audio — playback assets are unverified placeholders; tracks are listed but not playable');
}

async function writeWorld(db: PrismaClient, world: World, audio: Map<string, UploadedAudio>, passwordHash: string, opts: SeedOptions) {
  const { tracks, artists, users } = world;
  const now = opts.now.getTime();
  const created = new Date(now - (world.config.days + 30) * DAY_MS);
  const plays = new Map<number, number>();
  for (const l of world.listens) plays.set(l.trackIdx, (plays.get(l.trackIdx) ?? 0) + l.qualifiedPlays);

  await db.$transaction(
    async (tx) => {
      await tx.user.createMany({
        data: [
          ...artists.map((a) => ({
            id: a.id,
            email: a.email,
            username: a.username,
            displayName: a.name,
            bio: `Nghệ sĩ demo (dữ liệu tổng hợp) — ${genreName(GENRES[a.primary].id)}`,
            role: 'AUTHOR' as const,
            createdAt: created,
          })),
          ...users.map((u) => ({
            id: u.id,
            email: u.email,
            username: u.username,
            displayName: u.displayName,
            passwordHash: u.showcase ? passwordHash : null,
            bio: 'Tài khoản demo (dữ liệu tổng hợp)',
            role: 'USER' as const,
            createdAt: created,
          })),
        ],
      });
      // tracks.playback_asset_id → track_assets is DEFERRABLE INITIALLY DEFERRED; the READY trigger runs at commit.
      await tx.track.createMany({
        data: tracks.map((t) => ({
          id: t.id,
          authorId: t.authorId,
          title: t.title,
          description: t.description,
          genre: t.genres.map(genreName).join(', '),
          processingState: 'READY' as const,
          publicationState: 'PUBLISHED' as const,
          sourceVersion: SOURCE_VERSION,
          pipelineVersion: PIPELINE_VERSION,
          duration: DEMO_AUDIO.seconds,
          playCount: plays.get(t.idx) ?? 0,
          sampleRate: DEMO_AUDIO.sampleRate,
          bitDepth: DEMO_AUDIO.bitDepth,
          channels: DEMO_AUDIO.channels,
          sourceCodec: 'flac',
          outputCodec: 'flac',
          lossyTranscode: false,
          provenance: 'SYNTHETIC_DEMO',
          playbackAssetId: t.assetId,
          publishedAt: t.publishedAt,
          createdAt: new Date(t.publishedAt.getTime() - 3_600_000),
        })),
      });
      await tx.trackAsset.createMany({
        data: tracks.map((t) => {
          const a = audio.get(t.id);
          return {
            id: t.assetId,
            trackId: t.id,
            sourceVersion: SOURCE_VERSION,
            pipelineVersion: PIPELINE_VERSION,
            kind: 'PLAYBACK' as const,
            bucket: PLAYBACK_BUCKET,
            key: a?.key ?? playbackKey(t.id, '00000000-0000-4000-8000-000000000000'),
            versionId: a?.versionId ?? null,
            checksum: a?.checksum ?? null,
            size: BigInt(a?.size ?? 1),
            contentType: 'audio/flac',
            runToken: a?.runToken ?? null,
            verified: !!a, // never claim a verified object that was not uploaded
          };
        }),
      });
      await tx.trackGenre.createMany({ data: tracks.flatMap((t) => t.genres.map((genreId, position) => ({ trackId: t.id, genreId, position }))) });
      await tx.trackLyrics.createMany({
        data: tracks.map((t) => ({
          trackId: t.id,
          sourceVersion: SOURCE_VERSION,
          // 8 lines spread over the 45 s tone
          lines: t.lyrics.map((text, i) => ({ startMs: i * Math.floor((DEMO_AUDIO.seconds * 1000) / (t.lyrics.length + 1)), text })),
        })),
      });
      if (audio.size)
        await tx.trackWaveform.createMany({
          data: tracks.map((t) => ({
            trackId: t.id,
            sourceVersion: SOURCE_VERSION,
            pipelineVersion: PIPELINE_VERSION,
            playbackAssetId: t.assetId,
            status: 'SUCCEEDED' as const,
            duration: DEMO_AUDIO.seconds,
            peaks: tonePeaks(),
          })),
        });
      await tx.trackLike.createMany({
        data: world.likes.map((l) => ({ userId: users[l.userIdx].id, trackId: tracks[l.trackIdx].id, createdAt: new Date(l.at) })),
      });
      await tx.trackListen.createMany({
        data: world.listens.map((l) => ({
          userId: users[l.userIdx].id,
          trackId: tracks[l.trackIdx].id,
          sourceVersion: SOURCE_VERSION,
          qualifiedPlays: l.qualifiedPlays,
          lastListenedAt: new Date(l.lastListenedAt),
          lastCountedAt: new Date(l.lastListenedAt),
        })),
      });
      const e = world.engagement;
      await tx.$executeRaw`
        INSERT INTO track_engagement (user_id, track_id, source_version, starts, skips, completes, last_event_at)
        SELECT * FROM unnest(
          ${e.map((r) => users[r.userIdx].id)}::uuid[],
          ${e.map((r) => tracks[r.trackIdx].id)}::uuid[],
          ${e.map(() => SOURCE_VERSION)}::int[],
          ${e.map((r) => r.starts)}::int[],
          ${e.map((r) => r.skips)}::int[],
          ${e.map((r) => r.completes)}::int[],
          ${e.map((r) => new Date(r.lastEventAt).toISOString())}::timestamptz[])`;
      await tx.artistFollow.createMany({
        data: world.follows.map((f) => ({ userId: users[f.userIdx].id, authorId: artists[f.artistIdx].id, createdAt: new Date(f.at) })),
      });
      await tx.playlist.createMany({
        data: world.playlists.map((p) => ({
          id: p.id,
          ownerId: users[p.userIdx].id,
          title: p.title,
          description: 'Playlist demo (dữ liệu tổng hợp)',
          isPublic: p.isPublic,
          createdAt: new Date(p.createdAt),
          updatedAt: new Date(p.createdAt),
        })),
      });
      await tx.playlistTrack.createMany({
        data: world.playlists.flatMap((p) => p.trackIdx.map((t, position) => ({ playlistId: p.id, trackId: tracks[t].id, position }))),
      });
      await tx.musicPreference.createMany({
        data: world.preferences.map((p) => ({
          userId: users[p.userIdx].id,
          genreIds: p.genreIds,
          artistIds: p.artistIdx.map((a) => artists[a].id),
          updatedAt: new Date(p.at),
        })),
      });
    },
    { timeout: 600_000, maxWait: 30_000 },
  );
}
