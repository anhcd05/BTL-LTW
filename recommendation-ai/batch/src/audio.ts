import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

/**
 * 45 s so skip (< min(30, D/2) = 22.5 s) and complete (>= 0.6·D = 27 s) can be demonstrated by hand.
 * 22.05 kHz mono 16-bit: a pure tone compresses very well in FLAC; seed refuses if the total exceeds
 * RECO_AUDIO_MAX_MB (default 200).
 */
export const DEMO_AUDIO = { seconds: 45, sampleRate: 22050, channels: 1, bitDepth: 16 } as const;
export const PLAYBACK_BUCKET = 'audio-playback';
/** Matches PIPELINE_VERSION in @infosound/contracts and the default tracks.pipeline_version. */
export const PIPELINE_VERSION = 1;
export const SOURCE_VERSION = 1;

/** Key layout written by apps/audio-worker: `${trackId}/v${source}/p${pipeline}/${runToken}.flac`. */
export function playbackKey(trackId: string, runToken: string): string {
  return `${trackId}/v${SOURCE_VERSION}/p${PIPELINE_VERSION}/${runToken}.flac`;
}

export async function ffmpegAvailable(bin = process.env.FFMPEG_PATH || 'ffmpeg'): Promise<boolean> {
  try {
    await run(bin, ['-version'], { timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

/** FLAC tone: a pure sine at `pitchHz` with fade in/out (16-bit mono, DEMO_AUDIO.seconds long). */
export async function renderTone(pitchHz: number, bin = process.env.FFMPEG_PATH || 'ffmpeg'): Promise<Buffer> {
  const dir = await mkdtemp(join(tmpdir(), 'reco-tone-'));
  try {
    const file = join(dir, 'tone.flac');
    const s = DEMO_AUDIO.seconds;
    await run(
      bin,
      [
        '-hide_banner', '-loglevel', 'error', '-nostdin',
        '-f', 'lavfi', '-i', `sine=frequency=${pitchHz}:sample_rate=${DEMO_AUDIO.sampleRate}:duration=${s}`,
        '-af', `volume=0.5,afade=t=in:d=0.3,afade=t=out:st=${s - 0.8}:d=0.8`,
        '-ac', '1', '-ar', String(DEMO_AUDIO.sampleRate), '-sample_fmt', 's16', '-c:a', 'flac', '-compression_level', '8', '-y', file,
      ],
      { timeout: 120_000 },
    );
    return await readFile(file);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export type UploadedAudio = { key: string; versionId: string | null; checksum: string; size: number; runToken: string };

/** Envelope of the rendered tone (fade in 0.3 s, fade out 0.8 s), as 512 peaks normalised to max 1. */
export function tonePeaks(points = 512): number[] {
  const s = DEMO_AUDIO.seconds;
  return Array.from({ length: points }, (_, i) => {
    const t = ((i + 0.5) / points) * s;
    const env = Math.min(1, t / 0.3, (s - t) / 0.8);
    return Math.round(Math.max(0, env) * 10000) / 10000;
  });
}

/** Lazily loaded so `--skip-audio` and offline commands never need S3 credentials. */
export async function uploader(): Promise<(trackId: string, body: Buffer) => Promise<UploadedAudio>> {
  const storage = await import('@infosound/storage');
  const identity = (process.env.RECO_S3_IDENTITY || 'WORKER') as Parameters<typeof storage.storageClient>[0];
  const s3 = storage.storageClient(identity);
  return async (trackId, body) => {
    const runToken = randomUUID();
    const key = playbackKey(trackId, runToken);
    const checksum = createHash('sha256').update(body).digest('hex');
    const put = await s3.send(
      new storage.PutObjectCommand({
        Bucket: PLAYBACK_BUCKET,
        Key: key,
        Body: body,
        ContentLength: body.length,
        ContentType: 'audio/flac',
        Metadata: { sha256: checksum, 'reco-demo': '1' },
      }),
    );
    const head = await s3.send(
      new storage.HeadObjectCommand({ Bucket: PLAYBACK_BUCKET, Key: key, ...(put.VersionId ? { VersionId: put.VersionId } : {}) }),
    );
    if (Number(head.ContentLength) !== body.length) throw new Error(`Uploaded object size mismatch for ${key}`);
    return { key, versionId: put.VersionId || null, checksum, size: body.length, runToken };
  };
}

export async function deleteObjects(objects: { bucket: string; key: string; versionId: string | null }[]): Promise<number> {
  if (!objects.length) return 0;
  const storage = await import('@infosound/storage');
  type Identity = Parameters<typeof storage.storageClient>[0];
  // Default identities with write access: WORKER for audio-playback, API for artwork; RECO_S3_IDENTITY overrides.
  const clients = new Map<Identity, ReturnType<typeof storage.storageClient>>();
  const clientFor = (bucket: string) => {
    const identity = (process.env.RECO_S3_IDENTITY || (bucket === 'artwork' ? 'API' : 'WORKER')) as Identity;
    if (!clients.has(identity)) clients.set(identity, storage.storageClient(identity));
    return clients.get(identity)!;
  };
  let deleted = 0;
  for (const o of objects) {
    try {
      const s3 = clientFor(o.bucket);
      await s3.send(new storage.DeleteObjectCommand({ Bucket: o.bucket, Key: o.key, ...(o.versionId ? { VersionId: o.versionId } : {}) }));
      deleted += 1;
    } catch {
      // best effort: orphaned demo objects are harmless and are listed in the summary count
    }
  }
  return deleted;
}
