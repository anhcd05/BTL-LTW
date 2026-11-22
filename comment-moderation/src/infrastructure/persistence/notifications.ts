import { Prisma, type PrismaClient } from '@infosound/database';

export const COMMENT_VIOLATION_MESSAGE_VI = 'Bình luận của bạn đã vi phạm tiêu chuẩn cộng đồng';
type Tx = Prisma.TransactionClient;
const confirmedViolation = Prisma.sql`(c.decision_source='MANUAL'
  OR (c.decision_source='SYSTEM' AND EXISTS(SELECT 1 FROM comment_moderation_audit a WHERE a.comment_id=c.id AND a.content_version=c.content_version AND a.action='POLICY_REJECTED' AND a.to_status='HIDDEN'))
  OR (c.decision_source='AI' AND EXISTS(SELECT 1 FROM comment_moderation_jobs j JOIN comment_moderation_audit a ON a.job_id=j.id WHERE j.comment_id=c.id AND j.content_version=c.content_version AND j.status='DONE' AND j.error_code IS NULL AND j.result->>'recommendation'='review' AND j.result->>'uncertain'='false' AND jsonb_array_length(j.result->'labels')>0 AND jsonb_array_length(j.result->'evidence_quotes')>0 AND a.action='AI_DECISION' AND a.to_status='HIDDEN'))) `;
export type NotificationInboxEntry = {
  id: string;
  kind: 'RELEASE' | 'COMMENT_VIOLATION';
  createdAt: Date;
  readAt: Date | null;
  commentId: string | null;
  contentVersion: number | null;
  trackId: string | null;
  commentBody: string | null;
};

/** Called after a confirmed manual, explicit policy, or validated AI rejection.
 * Duplicate hides reuse one record; a resolved warning can become unread again
 * after a new confirmed hide without creating a second inbox entry.
 */
export async function notifyCommentViolation(
  tx: Tx,
  commentId: string,
  contentVersion: number,
): Promise<void> {
  await tx.$executeRaw`INSERT INTO comment_moderation_notifications(recipient_id,comment_id,content_version)
    SELECT c.user_id,c.id,c.content_version FROM track_comments c
    WHERE c.id=${commentId}::uuid AND c.content_version=${contentVersion}
      AND c.moderation_status='HIDDEN' AND ${confirmedViolation} AND c.deleted_at IS NULL
    ON CONFLICT(comment_id,content_version) DO UPDATE SET resolved_at=NULL,
      read_at=CASE WHEN comment_moderation_notifications.resolved_at IS NOT NULL THEN NULL ELSE comment_moderation_notifications.read_at END,
      created_at=CASE WHEN comment_moderation_notifications.resolved_at IS NOT NULL THEN now() ELSE comment_moderation_notifications.created_at END`;
}
export async function resolveCommentNotifications(tx: Tx, commentId: string): Promise<void> {
  await tx.$executeRaw`UPDATE comment_moderation_notifications SET resolved_at=coalesce(resolved_at,now()) WHERE comment_id=${commentId}::uuid AND resolved_at IS NULL`;
}

/** Recipient-only current-version text. Never persists a body snapshot or AI reasons.
 * Comment links are omitted when the containing recording is not public/current.
 */
export async function listModerationNotificationPage(
  db: PrismaClient,
  userId: string,
  page: number,
  pageSize: number,
) {
  if (
    !Number.isSafeInteger(page) ||
    page < 1 ||
    page > 10000 ||
    !Number.isSafeInteger(pageSize) ||
    pageSize < 1 ||
    pageSize > 100
  )
    throw new Error('INVALID_NOTIFICATION_PAGE');
  const feed = Prisma.sql`
    SELECT n.id,'RELEASE'::text AS kind,n.created_at AS "createdAt",n.read_at AS "readAt",
      NULL::uuid AS "commentId",NULL::integer AS "contentVersion",NULL::uuid AS "trackId",NULL::text AS "commentBody"
    FROM notifications n WHERE n.recipient_id=${userId}::uuid
    UNION ALL
    SELECT n.id,'COMMENT_VIOLATION'::text AS kind,n.created_at AS "createdAt",n.read_at AS "readAt",
      c.id AS "commentId",n.content_version AS "contentVersion",
      CASE WHEN t.deleted_at IS NULL AND t.publication_state='PUBLISHED' AND t.processing_state='READY'
        AND c.source_version=t.source_version AND a.active=true AND a.role='AUTHOR' THEN t.id ELSE NULL END AS "trackId",c.body AS "commentBody"
    FROM comment_moderation_notifications n JOIN track_comments c ON c.id=n.comment_id
      JOIN tracks t ON t.id=c.track_id JOIN users a ON a.id=t.author_id
    WHERE n.recipient_id=${userId}::uuid AND n.resolved_at IS NULL AND c.user_id=n.recipient_id
      AND c.content_version=n.content_version AND c.moderation_status='HIDDEN' AND ${confirmedViolation} AND c.deleted_at IS NULL`;
  return db.$transaction(
    async (tx) => {
      const items = await tx.$queryRaw<NotificationInboxEntry[]>(
        Prisma.sql`WITH feed AS (${feed}) SELECT * FROM feed ORDER BY "createdAt" DESC,id ASC LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`,
      );
      const [counts] = await tx.$queryRaw<{ total: bigint; unreadCount: bigint }[]>(
        Prisma.sql`WITH feed AS (${feed}) SELECT count(*) AS total,count(*) FILTER(WHERE "readAt" IS NULL) AS "unreadCount" FROM feed`,
      );
      return {
        items,
        total: Number(counts.total),
        unreadCount: Number(counts.unreadCount),
        page,
        pageSize,
      };
    },
    { isolationLevel: 'RepeatableRead' },
  );
}
export function projectCommentNotification(entry: NotificationInboxEntry) {
  if (
    entry.kind !== 'COMMENT_VIOLATION' ||
    !entry.commentId ||
    !entry.contentVersion ||
    typeof entry.commentBody !== 'string'
  )
    throw new Error('INVALID_NOTIFICATION_ENTRY');
  return {
    id: entry.id,
    kind: 'COMMENT_VIOLATION' as const,
    message: COMMENT_VIOLATION_MESSAGE_VI,
    createdAt: entry.createdAt,
    readAt: entry.readAt,
    commentId: entry.commentId,
    contentVersion: entry.contentVersion,
    commentBody: entry.commentBody,
    ...(entry.trackId ? { trackId: entry.trackId } : {}),
  };
}
export async function readModerationNotification(
  db: PrismaClient,
  userId: string,
  id: string,
): Promise<boolean> {
  const changed =
    await db.$executeRaw`UPDATE comment_moderation_notifications n SET read_at=coalesce(n.read_at,now())
    FROM track_comments c WHERE n.id=${id}::uuid AND n.recipient_id=${userId}::uuid AND n.resolved_at IS NULL
      AND c.id=n.comment_id AND c.user_id=n.recipient_id AND c.content_version=n.content_version
      AND c.moderation_status='HIDDEN' AND ${confirmedViolation} AND c.deleted_at IS NULL`;
  return changed > 0;
}
