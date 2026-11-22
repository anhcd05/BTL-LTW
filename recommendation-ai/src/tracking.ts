// Feedback writes: aggregated per-(user, track) engagement counters and impression/click logging.
// Callers authenticate the user and verify the listen token; these functions only persist.
import type { PrismaClient } from '@infosound/database';
import { Prisma } from '@infosound/database';
import { engagementTimingValid, terminalTokenId, type EngagementEvent } from './engagement-rules';
import { uuidArray, textArray, type Db } from './repository';

export { engagementTimingValid, terminalTokenId, SKIP_MAX_SECONDS, COMPLETE_FRACTION } from './engagement-rules';
export type { EngagementEvent } from './engagement-rules';

export type EngagementStatus = 'RECORDED' | 'DUPLICATE' | 'INVALID_TIMING' | 'UNAVAILABLE';

export type EngagementInput = {
  userId: string;
  trackId: string;
  tokenId: string;
  sourceVersion: number;
  startedAtMs: number;
  event: EngagementEvent;
  now?: Date;
};

export async function recordEngagement(db: PrismaClient | Db, input: EngagementInput): Promise<EngagementStatus> {
  const now = input.now ?? new Date();
  const rows = await db.$queryRaw<{ duration: number | null; sourceVersion: number }[]>`
    SELECT t.duration,t.source_version AS "sourceVersion" FROM tracks t
    WHERE t.id=${input.trackId}::uuid AND t.publication_state='PUBLISHED' AND t.processing_state='READY'
      AND t.deleted_at IS NULL
      AND EXISTS (SELECT 1 FROM users a WHERE a.id=t.author_id AND a.active=true)`;
  const track = rows[0];
  if (!track || track.sourceVersion !== input.sourceVersion || track.duration === null) return 'UNAVAILABLE';
  if (!engagementTimingValid(input.event, now.getTime() - input.startedAtMs, Number(track.duration)))
    return 'INVALID_TIMING';
  const terminal = terminalTokenId(input.tokenId);
  let changed: number;
  if (input.event === 'start') {
    // Replay guard: only a token newer than the last accepted start may start again.
    changed = await db.$executeRaw`
      INSERT INTO track_engagement AS e
        (user_id,track_id,source_version,starts,skips,completes,last_event_at,last_token_id,last_started_at_ms)
      VALUES (${input.userId}::uuid,${input.trackId}::uuid,${input.sourceVersion},1,0,0,${now},${input.tokenId}::uuid,
        ${input.startedAtMs}::bigint)
      ON CONFLICT (user_id,track_id) DO UPDATE SET
        starts=e.starts+1,source_version=EXCLUDED.source_version,last_event_at=EXCLUDED.last_event_at,
        last_token_id=EXCLUDED.last_token_id,last_started_at_ms=EXCLUDED.last_started_at_ms
      WHERE e.last_started_at_ms<EXCLUDED.last_started_at_ms`;
  } else {
    // Terminal events only for the token currently on record; the marker makes the second one a no-op.
    const skip = input.event === 'skip' ? 1 : 0;
    changed = await db.$executeRaw`
      UPDATE track_engagement SET skips=skips+${skip},completes=completes+${1 - skip},
        last_event_at=${now},last_token_id=${terminal}::uuid
      WHERE user_id=${input.userId}::uuid AND track_id=${input.trackId}::uuid
        AND last_token_id=${input.tokenId}::uuid`;
  }
  return changed > 0 ? 'RECORDED' : 'DUPLICATE';
}

export type ImpressionInput = {
  userId: string;
  requestId: string;
  /** Model version of the served request (from the signed impression token). */
  modelVersion: string;
  surface: string;
  /** Track ids must already be restricted to the signed token; reason is the server's reason. */
  items: readonly { trackId: string; position: number; reason: string }[];
};

const publicTrackJoin = Prisma.sql`JOIN tracks t ON t.id=i.track_id AND t.publication_state='PUBLISHED'
  AND t.processing_state='READY' AND t.deleted_at IS NULL`;

/**
 * Idempotent per (request_id, track_id); non-public tracks are ignored. A placeholder row created by an
 * early click (surface CLICK) is completed with the real surface/position once the impression arrives.
 */
export async function recordImpressions(db: PrismaClient | Db, input: ImpressionInput): Promise<number> {
  if (!input.items.length) return 0;
  const ids = input.items.map((item) => item.trackId);
  const positions = input.items.map((item) => item.position);
  const reasons = input.items.map((item) => item.reason);
  return db.$executeRaw`
    INSERT INTO recommendation_impressions AS r (request_id,user_id,track_id,surface,position,reason,model_version)
    SELECT ${input.requestId}::uuid,${input.userId}::uuid,i.track_id,${input.surface},i.position,i.reason,
      ${input.modelVersion}
    FROM unnest(${uuidArray(ids)},${intArray(positions)},${textArray(reasons)}) AS i(track_id,position,reason)
    ${publicTrackJoin}
    ON CONFLICT (request_id,track_id) DO UPDATE SET surface=EXCLUDED.surface,position=EXCLUDED.position
    WHERE r.surface='CLICK' AND r.user_id=EXCLUDED.user_id`;
}

function intArray(values: readonly number[]): Prisma.Sql {
  return values.length ? Prisma.sql`ARRAY[${Prisma.join(values)}]::int[]` : Prisma.sql`ARRAY[]::int[]`;
}

export type ClickInput = {
  userId: string;
  requestId: string;
  modelVersion: string;
  trackId: string;
  /** Served position/reason from the signed token, used only if the impression has not arrived yet. */
  position: number;
  reason: string;
  now?: Date;
};

/** Upsert: marks the first click on the user's own served item, even if it precedes the impression. */
export async function recordClick(db: PrismaClient | Db, input: ClickInput): Promise<boolean> {
  const now = input.now ?? new Date();
  const changed = await db.$executeRaw`
    INSERT INTO recommendation_impressions AS r
      (request_id,user_id,track_id,surface,position,reason,model_version,shown_at,clicked_at)
    SELECT ${input.requestId}::uuid,${input.userId}::uuid,i.track_id,'CLICK',${input.position},${input.reason},
      ${input.modelVersion},${now},${now}
    FROM (SELECT ${input.trackId}::uuid AS track_id) i
    ${publicTrackJoin}
    ON CONFLICT (request_id,track_id) DO UPDATE SET clicked_at=EXCLUDED.clicked_at
    WHERE r.user_id=EXCLUDED.user_id AND r.clicked_at IS NULL`;
  return changed > 0;
}
