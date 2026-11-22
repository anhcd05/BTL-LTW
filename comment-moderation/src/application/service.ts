import { createHash, randomUUID } from 'node:crypto';
import { Prisma, type PrismaClient } from '@infosound/database';
import type { ModerationConfig } from '../config';
import {
  checkStrictViolation,
  containsPrivateData,
  evaluatePolicy,
  validateResult,
  POLICY_VERSION,
  PROMPT_VERSION,
  SCHEMA_VERSION,
  type ModerationProvider,
  type ModerationResult,
} from '../domain/index';
import { PostgresBudget } from '../infrastructure/persistence/budget';
import {
  notifyCommentViolation,
  resolveCommentNotifications,
} from '../infrastructure/persistence/notifications';

type Tx = Prisma.TransactionClient;
type Status = 'PENDING' | 'VISIBLE' | 'HELD' | 'HIDDEN' | 'DELETED';
export type ExpectedVersion = {
  expected_content_version: number;
  expected_moderation_revision: number;
};
export class ModerationAccessError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}
type CommentRow = {
  id: string;
  trackId: string;
  userId: string;
  body: string;
  status: Status;
  contentVersion: number;
  moderationRevision: number;
  sourceVersion: number;
  parentId: string | null;
  createdAt: Date;
  decisionSource: string;
  deletedAt: Date | null;
  reviewRequested: boolean;
};
type Job = {
  id: string;
  comment_id: string;
  content_version: number;
  moderation_revision: number;
  policy_version: string;
  prompt_version: string;
  schema_version: string;
  model: string;
  content_hash: string;
  repeated: boolean;
  attempts: number;
  deadline: Date;
  run_token: string;
};
const fields = Prisma.sql`c.id,c.track_id AS "trackId",c.user_id AS "userId",c.body,c.moderation_status AS status,
  c.content_version AS "contentVersion",c.moderation_revision AS "moderationRevision",c.source_version AS "sourceVersion",
  c.parent_id AS "parentId",c.created_at AS "createdAt",c.decision_source AS "decisionSource",c.deleted_at AS "deletedAt",
  EXISTS(SELECT 1 FROM comment_moderation_reviews r WHERE r.comment_id=c.id AND r.content_version=c.content_version AND r.closed_at IS NULL) AS "reviewRequested"`;
const hash = (body: string) => createHash('sha256').update(body).digest('hex');
const technicalRetry = new Set([
  'NETWORK_ERROR',
  'PROVIDER_TIMEOUT',
  'RATE_LIMITED',
  'MODEL_UNAVAILABLE',
  'CONFIG_MISSING',
  'INTERNAL_BUDGET_EXCEEDED',
]);
const failureCode = (error: unknown) => {
  const code = (error as { code?: unknown })?.code;
  return typeof code === 'string' &&
    new Set([
      'CONFIG_MISSING',
      'AUTH_FAILED',
      'MODEL_UNAVAILABLE',
      'RATE_LIMITED',
      'NETWORK_ERROR',
      'PROVIDER_TIMEOUT',
      'PROVIDER_REFUSAL',
      'INVALID_OUTPUT',
      'INTERNAL_BUDGET_EXCEEDED',
    ]).has(code)
    ? code
    : 'NETWORK_ERROR';
};
// This protects outbound data, not a substitute profanity classifier. Keep likely
// personal identifiers/secrets internal and omit context from external requests.
export const requiresPrivateReview = containsPrivateData;

export class ModerationService {
  readonly budget: PostgresBudget;
  constructor(
    readonly db: PrismaClient,
    readonly config: ModerationConfig,
    private readonly provider?: ModerationProvider,
  ) {
    this.budget = new PostgresBudget(db, config);
  }
  async permissions(userId: string) {
    const rows = await this.db.$queryRaw<
      { permission: string }[]
    >`SELECT p.permission FROM comment_moderation_permissions p JOIN users u ON u.id=p.user_id WHERE p.user_id=${userId}::uuid AND u.active=true`;
    const has = (name: string) => rows.some((row) => row.permission === name);
    return {
      read: has('moderation.read'),
      review: has('moderation.review'),
      retry: has('moderation.retry'),
    };
  }
  async requirePermission(userId: string, permission: 'read' | 'review' | 'retry') {
    if (!(await this.permissions(userId))[permission])
      throw new ModerationAccessError(403, 'MODERATION_FORBIDDEN');
  }
  /** One transaction-scoped lock serializes comment-tree mutations on a song. */
  async lockTrack(tx: Tx, trackId: string) {
    await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtextextended('comment-moderation:'||${trackId}::text,0))`;
  }
  private async lockCommentTrack(tx: Tx, id: string) {
    const [row] = await tx.$queryRaw<
      { track_id: string }[]
    >`SELECT track_id FROM track_comments WHERE id=${id}::uuid`;
    if (!row) throw new ModerationAccessError(404, 'COMMENT_NOT_FOUND');
    await this.lockTrack(tx, row.track_id);
  }
  async rateLimit(tx: Tx, userId: string) {
    await tx.$executeRaw`INSERT INTO comment_moderation_rate(user_id) VALUES(${userId}::uuid) ON CONFLICT DO NOTHING`;
    const rows = await tx.$queryRaw<{ user_id: string }[]>`UPDATE comment_moderation_rate SET
      minute_count=CASE WHEN minute_at<date_trunc('minute',now()) THEN 1 ELSE minute_count+1 END,
      hour_count=CASE WHEN hour_at<date_trunc('hour',now()) THEN 1 ELSE hour_count+1 END,
      minute_at=date_trunc('minute',now()),hour_at=date_trunc('hour',now())
      WHERE user_id=${userId}::uuid AND (minute_at<date_trunc('minute',now()) OR minute_count<5)
        AND (hour_at<date_trunc('hour',now()) OR hour_count<60) RETURNING user_id`;
    if (!rows.length) throw new ModerationAccessError(429, 'COMMENT_RATE_LIMITED');
  }
  private async audit(
    tx: Tx,
    c: Pick<CommentRow, 'id' | 'contentVersion' | 'moderationRevision'>,
    action: string,
    from: Status | null,
    to: Status,
    reason: string,
    actor: string | null = null,
    jobId: string | null = null,
  ) {
    await tx.$executeRaw`INSERT INTO comment_moderation_audit(comment_id,content_version,moderation_revision,actor_id,action,from_status,to_status,reason,job_id)
      VALUES(${c.id}::uuid,${c.contentVersion},${c.moderationRevision},${actor}::uuid,${action},${from},${to},${reason},${jobId}::uuid) ON CONFLICT(job_id,action) DO NOTHING`;
  }
  async enqueue(tx: Tx, commentId: string) {
    const [c] = await tx.$queryRaw<
      CommentRow[]
    >`SELECT ${fields} FROM track_comments c WHERE c.id=${commentId}::uuid`;
    if (!c || c.status !== 'PENDING') return;
    if (checkStrictViolation(c.body)) {
      await this.rejectStrict(tx, c);
      return;
    }
    const [repeat] = await tx.$queryRaw<
      { count: bigint }[]
    >`SELECT count(*) FROM track_comments WHERE user_id=${c.userId}::uuid AND id<>${c.id}::uuid AND body=${c.body} AND created_at>now()-interval '1 hour'`;
    const repeated = Number(repeat.count) > 0;
    const code =
      !this.config.enabled || !this.config.keyPresent || this.config.errors.length
        ? 'CONFIG_MISSING'
        : requiresPrivateReview(c.body)
          ? 'PRIVATE_DATA_REVIEW'
          : null;
    const inserted =
      await tx.$executeRaw`INSERT INTO comment_moderation_jobs(comment_id,content_version,moderation_revision,policy_version,prompt_version,schema_version,model,content_hash,repeated,deadline,status,error_code,completed_at)
      VALUES(${c.id}::uuid,${c.contentVersion},${c.moderationRevision},${POLICY_VERSION},${PROMPT_VERSION},${SCHEMA_VERSION},${this.config.model},${hash(c.body)},${repeated},now()+(${this.config.pendingMaxAgeSeconds}*interval '1 second'),${code ? 'DONE' : 'QUEUED'},${code},CASE WHEN ${code}::text IS NULL THEN NULL ELSE now() END)
      ON CONFLICT(comment_id,content_version,moderation_revision,policy_version,prompt_version) DO NOTHING`;
    if (!inserted) return;
    if (code) {
      await tx.$executeRaw`UPDATE track_comments SET moderation_status='HELD',decision_source='SYSTEM',moderation_updated_at=now(),decision_at=now() WHERE id=${c.id}::uuid AND moderation_status='PENDING'`;
      await this.audit(tx, c, 'MANUAL_FALLBACK', 'PENDING', 'HELD', code);
    } else await this.audit(tx, c, 'ENQUEUED', null, 'PENDING', 'Đang kiểm duyệt', c.userId);
  }
  private async read(tx: Tx, id: string, lock = false) {
    const [c] = await tx.$queryRaw<
      CommentRow[]
    >`SELECT ${fields} FROM track_comments c JOIN tracks t ON t.id=c.track_id JOIN users u ON u.id=c.user_id JOIN users a ON a.id=t.author_id
      WHERE c.id=${id}::uuid AND t.deleted_at IS NULL AND t.processing_state='READY' AND t.publication_state='PUBLISHED' AND c.source_version=t.source_version AND a.active=true AND a.role='AUTHOR' AND u.active=true ${lock ? Prisma.sql`FOR UPDATE OF c` : Prisma.empty}`;
    if (!c) throw new ModerationAccessError(404, 'COMMENT_NOT_FOUND');
    return c;
  }
  async status(id: string, userId: string) {
    const c = await this.read(this.db, id);
    if (c.userId !== userId) await this.requirePermission(userId, 'read');
    return this.ownerView(c);
  }
  private async record(tx: Tx, id: string, lock = false) {
    const [c] = await tx.$queryRaw<
      CommentRow[]
    >`SELECT ${fields} FROM track_comments c JOIN tracks t ON t.id=c.track_id WHERE c.id=${id}::uuid AND t.deleted_at IS NULL ${lock ? Prisma.sql`FOR UPDATE OF c` : Prisma.empty}`;
    if (!c) throw new ModerationAccessError(404, 'COMMENT_NOT_FOUND');
    return c;
  }
  private async canDelete(tx: Tx, c: CommentRow, userId: string) {
    const [row] = await tx.$queryRaw<
      { allowed: boolean }[]
    >`SELECT (c.user_id=${userId}::uuid OR (t.author_id=${userId}::uuid AND actor.role='AUTHOR')) AS allowed FROM track_comments c JOIN tracks t ON t.id=c.track_id JOIN users actor ON actor.id=${userId}::uuid AND actor.active=true WHERE c.id=${c.id}::uuid AND t.deleted_at IS NULL`;
    return row?.allowed === true;
  }
  private async parentVisible(tx: Tx, id: string) {
    const [row] = await tx.$queryRaw<
      { id: string }[]
    >`SELECT id FROM track_comments WHERE id=${id}::uuid AND moderation_status='VISIBLE' AND deleted_at IS NULL`;
    return !!row;
  }
  async deletionTarget(id: string, userId: string) {
    const c = await this.record(this.db, id);
    if (!(await this.canDelete(this.db, c, userId)))
      throw new ModerationAccessError(404, 'COMMENT_NOT_FOUND');
    return {
      id: c.id,
      status: c.status,
      contentVersion: c.contentVersion,
      moderationRevision: c.moderationRevision,
      canDelete: true,
      deleteIncludesReplies: true,
    };
  }
  private ownerView(c: CommentRow) {
    return {
      id: c.id,
      trackId: c.trackId,
      body: c.body,
      status: c.status,
      contentVersion: c.contentVersion,
      moderationRevision: c.moderationRevision,
      sourceVersion: c.sourceVersion,
      parentId: c.parentId,
      createdAt: c.createdAt,
      reviewRequested: c.reviewRequested,
    };
  }
  async mine(trackId: string, userId: string, page = 1, pageSize = 20) {
    const where = Prisma.sql`c.track_id=${trackId}::uuid AND c.user_id=${userId}::uuid AND c.deleted_at IS NULL AND t.deleted_at IS NULL AND t.processing_state='READY' AND t.publication_state='PUBLISHED' AND c.source_version=t.source_version AND EXISTS(SELECT 1 FROM users a WHERE a.id=t.author_id AND a.active=true AND a.role='AUTHOR')`;
    const [items, [total]] = await Promise.all([
      this.db.$queryRaw<
        CommentRow[]
      >`SELECT ${fields} FROM track_comments c JOIN tracks t ON t.id=c.track_id WHERE ${where} ORDER BY c.created_at DESC,c.id LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`,
      this.db.$queryRaw<
        { count: bigint }[]
      >`SELECT count(*) FROM track_comments c JOIN tracks t ON t.id=c.track_id WHERE ${where}`,
    ]);
    return {
      items: items.map((c) => this.ownerView(c)),
      total: Number(total.count),
      page,
      pageSize,
    };
  }
  async edit(id: string, userId: string, input: ExpectedVersion & { body: string }) {
    if (
      !input.body.trim() ||
      [...input.body].length > this.config.maxCommentChars ||
      /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(input.body)
    )
      throw new ModerationAccessError(400, 'COMMENT_BODY_INVALID');
    return this.db.$transaction(async (tx) => {
      await this.lockCommentTrack(tx, id);
      const old = await this.read(tx, id, true);
      if (old.userId !== userId || old.deletedAt)
        throw new ModerationAccessError(404, 'COMMENT_NOT_FOUND');
      await this.rateLimit(tx, userId);
      const changed =
        await tx.$executeRaw`UPDATE track_comments SET body=${input.body},content_version=content_version+1,moderation_revision=moderation_revision+1,moderation_status='PENDING',decision_source='SYSTEM',decision_at=NULL,moderation_updated_at=now()
        WHERE id=${id}::uuid AND user_id=${userId}::uuid AND deleted_at IS NULL AND content_version=${input.expected_content_version} AND moderation_revision=${input.expected_moderation_revision}`;
      if (!changed) throw new ModerationAccessError(409, 'MODERATION_CONFLICT');
      const c = await this.read(tx, id);
      await this.audit(tx, c, 'EDIT', old.status, 'PENDING', 'Nội dung đã được sửa', userId);
      await resolveCommentNotifications(tx, id);
      await this.enqueue(tx, id);
      return this.ownerView(await this.read(tx, id));
    });
  }
  private async removeTree(
    tx: Tx,
    id: string,
    actor: string | null,
    includeRoot = true,
    reason = 'Người có quyền xóa bình luận và toàn bộ trả lời',
  ) {
    const rows = await tx.$queryRaw<
      CommentRow[]
    >`WITH RECURSIVE tree AS (SELECT id FROM track_comments WHERE id=${id}::uuid UNION SELECT c.id FROM track_comments c JOIN tree p ON c.parent_id=p.id) SELECT ${fields} FROM track_comments c JOIN tree t ON t.id=c.id WHERE c.deleted_at IS NULL AND (${includeRoot} OR c.id<>${id}::uuid) ORDER BY c.id FOR UPDATE OF c`;
    for (const old of rows) {
      await tx.$executeRaw`UPDATE track_comments SET moderation_status='DELETED',deleted_at=now(),decision_source=${actor ? 'AUTHOR' : 'SYSTEM'},decision_at=now(),moderation_revision=moderation_revision+1,moderation_updated_at=now() WHERE id=${old.id}::uuid AND deleted_at IS NULL`;
      const c = {
        ...old,
        status: 'DELETED' as const,
        moderationRevision: old.moderationRevision + 1,
      };
      await this.audit(
        tx,
        c,
        old.id === id ? 'DELETE' : 'CASCADE_DELETE',
        old.status,
        'DELETED',
        reason,
        actor,
      );
      await resolveCommentNotifications(tx, old.id);
      await tx.$executeRaw`UPDATE comment_moderation_reviews SET closed_at=coalesce(closed_at,now()) WHERE comment_id=${old.id}::uuid`;
      await tx.$executeRaw`UPDATE comment_moderation_jobs SET result=NULL,status=CASE WHEN status IN ('RUNNING','QUEUED') THEN 'STALE' ELSE status END,run_token=NULL,lease_expires_at=NULL WHERE comment_id=${old.id}::uuid`;
    }
    return rows.length;
  }
  async remove(id: string, userId: string, input: ExpectedVersion) {
    return this.db.$transaction(async (tx) => {
      await this.lockCommentTrack(tx, id);
      const old = await this.record(tx, id, true);
      if (!(await this.canDelete(tx, old, userId)))
        throw new ModerationAccessError(404, 'COMMENT_NOT_FOUND');
      if (
        old.deletedAt ||
        old.contentVersion !== input.expected_content_version ||
        old.moderationRevision !== input.expected_moderation_revision
      )
        throw new ModerationAccessError(409, 'MODERATION_CONFLICT');
      const deletedCount = await this.removeTree(tx, id, userId);
      return {
        id,
        status: 'DELETED' as const,
        contentVersion: old.contentVersion,
        moderationRevision: old.moderationRevision + 1,
        deletedCount,
      };
    });
  }
  private async rejectStrict(tx: Tx, c: CommentRow) {
    const changed =
      await tx.$executeRaw`UPDATE track_comments SET moderation_status='HIDDEN',decision_source='SYSTEM',decision_at=now(),moderation_revision=moderation_revision+1,moderation_updated_at=now() WHERE id=${c.id}::uuid AND content_version=${c.contentVersion} AND moderation_revision=${c.moderationRevision} AND deleted_at IS NULL`;
    if (!changed) throw new ModerationAccessError(409, 'MODERATION_CONFLICT');
    const next = { ...c, status: 'HIDDEN' as const, moderationRevision: c.moderationRevision + 1 };
    await this.audit(tx, next, 'POLICY_REJECTED', c.status, 'HIDDEN', 'PROFANITY_PROHIBITED');
    await tx.$executeRaw`UPDATE comment_moderation_jobs SET status='STALE',error_code=NULL,result=NULL,run_token=NULL,lease_expires_at=NULL,completed_at=now() WHERE comment_id=${c.id}::uuid AND status IN ('QUEUED','RUNNING')`;
    await this.removeTree(
      tx,
      c.id,
      null,
      false,
      'Bình luận cha bị loại theo chính sách ngôn từ nghiêm ngặt',
    );
    await notifyCommentViolation(tx, c.id, c.contentVersion);
    return next;
  }
  /** Backend-only operational cleanup; no HTTP route and no outbound AI call. */
  async enforceStrictPolicy(id: string, input: ExpectedVersion) {
    return this.db.$transaction(async (tx) => {
      await this.lockCommentTrack(tx, id);
      const c = await this.record(tx, id, true);
      if (c.deletedAt) return { id, status: c.status, changed: false };
      if (
        c.contentVersion !== input.expected_content_version ||
        c.moderationRevision !== input.expected_moderation_revision
      )
        throw new ModerationAccessError(409, 'MODERATION_CONFLICT');
      if (!checkStrictViolation(c.body) || (c.status === 'HIDDEN' && c.decisionSource === 'SYSTEM'))
        return { id, status: c.status, changed: false };
      const changed = await this.rejectStrict(tx, c);
      return { id, status: changed.status, changed: true };
    });
  }
  async reviewRequest(id: string, userId: string, input: ExpectedVersion) {
    return this.db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM track_comments WHERE id=${id}::uuid FOR UPDATE`;
      const c = await this.read(tx, id);
      if (c.userId !== userId) throw new ModerationAccessError(404, 'COMMENT_NOT_FOUND');
      if (
        c.contentVersion !== input.expected_content_version ||
        c.moderationRevision !== input.expected_moderation_revision
      )
        throw new ModerationAccessError(409, 'MODERATION_CONFLICT');
      if (!['HELD', 'HIDDEN'].includes(c.status))
        throw new ModerationAccessError(409, 'REVIEW_NOT_ELIGIBLE');
      const inserted =
        await tx.$executeRaw`INSERT INTO comment_moderation_reviews(comment_id,content_version) VALUES(${id}::uuid,${c.contentVersion})
      ON CONFLICT(comment_id,content_version) DO UPDATE SET requested_at=now(),closed_at=NULL WHERE comment_moderation_reviews.closed_at IS NOT NULL`;
      if (inserted)
        await this.audit(
          tx,
          c,
          'REVIEW_REQUEST',
          c.status,
          c.status,
          'Yêu cầu xem xét lại',
          userId,
        );
      return this.ownerView({ ...c, reviewRequested: true });
    });
  }
  async list(
    userId: string,
    filter: {
      page: number;
      pageSize: number;
      status?: Status;
      label?: string;
      errorCode?: string;
      from?: Date;
      to?: Date;
    },
  ) {
    await this.requirePermission(userId, 'read');
    const where = Prisma.sql`c.deleted_at IS NULL AND t.deleted_at IS NULL
      ${filter.status ? Prisma.sql`AND c.moderation_status=${filter.status}` : Prisma.empty}
      ${filter.label ? Prisma.sql`AND EXISTS(SELECT 1 FROM comment_moderation_jobs j WHERE j.comment_id=c.id AND j.content_version=c.content_version AND j.result->'labels' ? ${filter.label})` : Prisma.empty}
      ${filter.errorCode ? Prisma.sql`AND EXISTS(SELECT 1 FROM comment_moderation_jobs j WHERE j.comment_id=c.id AND j.content_version=c.content_version AND j.error_code=${filter.errorCode})` : Prisma.empty}
      ${filter.from ? Prisma.sql`AND c.created_at>=${filter.from}` : Prisma.empty}${filter.to ? Prisma.sql`AND c.created_at<=${filter.to}` : Prisma.empty}`;
    const [items, [count]] = await Promise.all([
      this.db.$queryRaw<
        CommentRow[]
      >`SELECT ${fields} FROM track_comments c JOIN tracks t ON t.id=c.track_id WHERE ${where}
        ORDER BY EXISTS(SELECT 1 FROM comment_moderation_jobs j WHERE j.comment_id=c.id AND j.content_version=c.content_version AND j.result->>'severity'='high') DESC,c.created_at,c.id LIMIT ${filter.pageSize} OFFSET ${(filter.page - 1) * filter.pageSize}`,
      this.db.$queryRaw<
        { count: bigint }[]
      >`SELECT count(*) FROM track_comments c JOIN tracks t ON t.id=c.track_id WHERE ${where}`,
    ]);
    return {
      items: items.map((c) => this.ownerView(c)),
      total: Number(count.count),
      page: filter.page,
      pageSize: filter.pageSize,
    };
  }
  async detail(id: string, userId: string) {
    await this.requirePermission(userId, 'read');
    const c = await this.read(this.db, id);
    const [jobs, audit, context] = await Promise.all([
      this.db.$queryRaw<
        {
          result: ModerationResult | null;
          error_code: string | null;
          attempts: number;
          manual_retries: number;
          latency_ms: number | null;
          model: string;
          policy_version: string;
          prompt_version: string;
          schema_version: string;
        }[]
      >`SELECT result,error_code,attempts,manual_retries,latency_ms,model,policy_version,prompt_version,schema_version FROM comment_moderation_jobs WHERE comment_id=${id}::uuid AND content_version=${c.contentVersion} ORDER BY created_at DESC LIMIT 1`,
      this.db
        .$queryRaw`SELECT action,actor_id AS "actorId",from_status AS "fromStatus",to_status AS "toStatus",reason,created_at AS "createdAt",content_version AS "contentVersion",moderation_revision AS "moderationRevision" FROM comment_moderation_audit WHERE comment_id=${id}::uuid ORDER BY created_at DESC,id DESC LIMIT 100`,
      this.db.$queryRaw<
        { title: string; parent: string | null }[]
      >`SELECT left(t.title,200) AS title,left(p.body,500) AS parent FROM track_comments c JOIN tracks t ON t.id=c.track_id LEFT JOIN track_comments p ON p.id=c.parent_id WHERE c.id=${id}::uuid`,
    ]);
    const job = jobs[0];
    return {
      ...this.ownerView(c),
      result: job?.result ?? null,
      errorCode: job?.error_code ?? null,
      audit,
      context: context[0],
      evaluation: job
        ? {
            model: job.model,
            policyVersion: job.policy_version,
            promptVersion: job.prompt_version,
            schemaVersion: job.schema_version,
            attempts: job.attempts,
            latencyMs: job.latency_ms,
          }
        : null,
      retryEligible:
        c.status === 'HELD' &&
        c.decisionSource !== 'MANUAL' &&
        !!job?.error_code &&
        technicalRetry.has(job.error_code) &&
        job.attempts <= this.config.maxRetries &&
        job.manual_retries < 2,
    };
  }
  async decision(
    id: string,
    userId: string,
    input: ExpectedVersion & { action: 'APPROVE' | 'HIDE'; reason: string },
  ) {
    await this.requirePermission(userId, 'review');
    return this.db.$transaction(async (tx) => {
      await this.lockCommentTrack(tx, id);
      const old = await this.read(tx, id, true);
      const status = input.action === 'APPROVE' ? 'VISIBLE' : 'HIDDEN';
      if (
        old.deletedAt ||
        old.contentVersion !== input.expected_content_version ||
        old.moderationRevision !== input.expected_moderation_revision
      )
        throw new ModerationAccessError(409, 'MODERATION_CONFLICT');
      if (input.action === 'APPROVE') {
        if (checkStrictViolation(old.body))
          throw new ModerationAccessError(409, 'STRICT_POLICY_VIOLATION');
        const [evaluation] = await tx.$queryRaw<
          { result: unknown }[]
        >`SELECT result FROM comment_moderation_jobs WHERE comment_id=${id}::uuid AND content_version=${old.contentVersion} AND content_hash=${hash(old.body)} AND policy_version=${POLICY_VERSION} AND prompt_version=${PROMPT_VERSION} AND schema_version=${SCHEMA_VERSION} AND status='DONE' AND error_code IS NULL AND result IS NOT NULL ORDER BY created_at DESC LIMIT 1`;
        if (!evaluation) throw new ModerationAccessError(409, 'AI_REVIEW_REQUIRED');
        try {
          validateResult(evaluation.result, old.body);
        } catch {
          throw new ModerationAccessError(409, 'AI_REVIEW_REQUIRED');
        }
        if (old.parentId && !(await this.parentVisible(tx, old.parentId)))
          throw new ModerationAccessError(409, 'PARENT_UNAVAILABLE');
      }
      const changed =
        await tx.$executeRaw`UPDATE track_comments SET moderation_status=${status},moderation_revision=moderation_revision+1,decision_source='MANUAL',decision_at=now(),moderation_updated_at=now()
        WHERE id=${id}::uuid AND deleted_at IS NULL AND moderation_status<>'DELETED' AND content_version=${input.expected_content_version} AND moderation_revision=${input.expected_moderation_revision}`;
      if (!changed) throw new ModerationAccessError(409, 'MODERATION_CONFLICT');
      const c = await this.read(tx, id);
      await this.audit(tx, c, input.action, old.status, status, input.reason, userId);
      if (input.action === 'HIDE') await notifyCommentViolation(tx, id, c.contentVersion);
      else await resolveCommentNotifications(tx, id);
      if (input.action === 'HIDE')
        await this.removeTree(tx, id, userId, false, 'Bình luận cha bị ẩn vì vi phạm');
      await tx.$executeRaw`UPDATE comment_moderation_reviews SET closed_at=now() WHERE comment_id=${id}::uuid AND content_version=${c.contentVersion} AND closed_at IS NULL`;
      return this.ownerView(c);
    });
  }
  async retry(id: string, userId: string, input: ExpectedVersion) {
    await this.requirePermission(userId, 'retry');
    return this.db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM track_comments WHERE id=${id}::uuid FOR UPDATE`;
      const c = await this.read(tx, id);
      const [job] = await tx.$queryRaw<
        { attempts: number; manual_retries: number; error_code: string | null; id: string }[]
      >`SELECT attempts,manual_retries,error_code,id FROM comment_moderation_jobs WHERE comment_id=${id}::uuid AND content_version=${c.contentVersion} ORDER BY created_at DESC LIMIT 1 FOR UPDATE`;
      if (
        c.contentVersion !== input.expected_content_version ||
        c.moderationRevision !== input.expected_moderation_revision
      )
        throw new ModerationAccessError(409, 'MODERATION_CONFLICT');
      if (
        c.status !== 'HELD' ||
        c.decisionSource === 'MANUAL' ||
        !job?.error_code ||
        !technicalRetry.has(job.error_code) ||
        job.attempts > this.config.maxRetries ||
        job.manual_retries >= 2
      )
        throw new ModerationAccessError(409, 'RETRY_NOT_ELIGIBLE');
      if (!this.config.enabled || !this.config.keyPresent || this.config.errors.length)
        throw new ModerationAccessError(409, 'CONFIG_MISSING');
      // Reuse this evaluation's attempt counter: repeated operator clicks cannot
      // reset the three-call cap or override a manual HIDDEN decision.
      await tx.$executeRaw`UPDATE track_comments SET moderation_status='PENDING',decision_source='SYSTEM',decision_at=NULL,moderation_updated_at=now() WHERE id=${id}::uuid`;
      await tx.$executeRaw`UPDATE comment_moderation_jobs SET status='QUEUED',manual_retries=manual_retries+1,error_code=NULL,next_attempt_at=now(),deadline=now()+(${this.config.pendingMaxAgeSeconds}*interval '1 second'),run_token=NULL,lease_expires_at=NULL WHERE id=${job.id}::uuid`;
      await this.audit(tx, c, 'RETRY', 'HELD', 'PENDING', 'Thử lại lỗi kỹ thuật', userId);
      return this.ownerView({ ...c, status: 'PENDING' });
    });
  }
  private async finish(
    job: Job,
    result: ModerationResult | null,
    code: string | null,
    latency: number,
  ) {
    return this.db.$transaction(async (tx) => {
      await this.lockCommentTrack(tx, job.comment_id);
      const [comment] = await tx.$queryRaw<
        CommentRow[]
      >`SELECT ${fields} FROM track_comments c WHERE c.id=${job.comment_id}::uuid FOR UPDATE OF c`;
      if (!comment) return false;
      const lock = await tx.$queryRaw<
        { id: string }[]
      >`SELECT id FROM comment_moderation_jobs WHERE id=${job.id}::uuid AND status='RUNNING' AND run_token=${job.run_token}::uuid AND lease_expires_at>now() FOR UPDATE`;
      if (!lock.length) return false;
      let status: Status = result
        ? evaluatePolicy(result, { autoApprove: this.config.autoApprove, repeated: job.repeated })
        : 'HELD';
      if (
        status === 'VISIBLE' &&
        comment.parentId &&
        !(await this.parentVisible(tx, comment.parentId))
      ) {
        status = 'HELD';
        code = 'PARENT_UNAVAILABLE';
      }
      const changed =
        await tx.$executeRaw`UPDATE track_comments SET moderation_status=${status},decision_source=${result ? 'AI' : 'SYSTEM'},decision_at=now(),moderation_updated_at=now()
      WHERE id=${job.comment_id}::uuid AND content_version=${job.content_version} AND moderation_revision=${job.moderation_revision} AND moderation_status='PENDING' AND deleted_at IS NULL AND decision_source<>'MANUAL'
        AND EXISTS(SELECT 1 FROM comment_moderation_jobs WHERE id=${job.id}::uuid AND deadline>now())`;
      await tx.$executeRaw`UPDATE comment_moderation_jobs SET status=${changed ? 'DONE' : 'STALE'},result=${result ? JSON.stringify(result) : null}::jsonb,error_code=${code},latency_ms=${latency},completed_at=now(),lease_expires_at=NULL,run_token=NULL WHERE id=${job.id}::uuid AND run_token=${job.run_token}::uuid`;
      if (changed)
        await this.audit(
          tx,
          {
            id: job.comment_id,
            contentVersion: job.content_version,
            moderationRevision: job.moderation_revision,
          },
          result ? 'AI_DECISION' : 'MANUAL_FALLBACK',
          'PENDING',
          status,
          code ?? 'AI đề xuất; policy backend đã áp dụng',
          null,
          job.id,
        );
      if (changed && status === 'HIDDEN') {
        await this.removeTree(
          tx,
          job.comment_id,
          null,
          false,
          'Bình luận cha bị AI xác nhận vi phạm',
        );
        await notifyCommentViolation(tx, job.comment_id, job.content_version);
      }
      return !!changed;
    });
  }
  async tick(): Promise<void> {
    // Reconcile deadline independently of provider/Redis. Never leave old pending
    // data public and fence any result returning after the deadline transition.
    await this.db.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<
        CommentRow[]
      >`SELECT ${fields} FROM track_comments c WHERE c.moderation_status='PENDING' AND c.deleted_at IS NULL
        AND c.moderation_updated_at<now()-(${this.config.pendingMaxAgeSeconds}*interval '1 second') ORDER BY c.moderation_updated_at LIMIT 20 FOR UPDATE OF c SKIP LOCKED`;
      for (const c of rows) {
        await tx.$executeRaw`UPDATE track_comments SET moderation_status='HELD',decision_source='SYSTEM',decision_at=now(),moderation_updated_at=now() WHERE id=${c.id}::uuid AND moderation_status='PENDING'`;
        await tx.$executeRaw`UPDATE comment_moderation_jobs SET status='DONE',error_code='PENDING_EXPIRED',completed_at=now(),run_token=NULL,lease_expires_at=NULL WHERE comment_id=${c.id}::uuid AND content_version=${c.contentVersion} AND moderation_revision=${c.moderationRevision} AND status IN ('QUEUED','RUNNING')`;
        await this.audit(tx, c, 'MANUAL_FALLBACK', 'PENDING', 'HELD', 'PENDING_EXPIRED');
      }
      await tx.$executeRaw`UPDATE comment_moderation_jobs SET result=NULL WHERE id IN (SELECT id FROM comment_moderation_jobs WHERE result IS NOT NULL AND created_at<now()-(${this.config.auditRetentionDays ?? 30}*interval '1 day') LIMIT 100)`;
      await tx.$executeRaw`UPDATE comment_moderation_audit SET reason='REDACTED_RETENTION' WHERE id IN (SELECT id FROM comment_moderation_audit WHERE reason<>'REDACTED_RETENTION' AND created_at<now()-(${this.config.auditRetentionDays ?? 30}*interval '1 day') LIMIT 100)`;
      await tx.$executeRaw`UPDATE comment_moderation_jobs SET status='STALE',run_token=NULL,lease_expires_at=NULL,completed_at=now() WHERE id IN (
        SELECT j.id FROM comment_moderation_jobs j JOIN track_comments c ON c.id=j.comment_id WHERE j.status IN ('QUEUED','RUNNING')
          AND (c.content_version<>j.content_version OR c.moderation_revision<>j.moderation_revision OR c.deleted_at IS NOT NULL OR c.moderation_status<>'PENDING') LIMIT 100)`;
    });
    const token = randomUUID();
    const [job] = await this.db.$queryRaw<
      Job[]
    >`UPDATE comment_moderation_jobs j SET status='RUNNING',run_token=${token}::uuid,lease_expires_at=now()+(${this.config.timeoutMs + 10000}*interval '1 millisecond')
      WHERE j.id=(SELECT q.id FROM comment_moderation_jobs q JOIN track_comments c ON c.id=q.comment_id
        WHERE (q.status='QUEUED' OR (q.status='RUNNING' AND q.lease_expires_at<now())) AND q.next_attempt_at<=now() AND q.deadline>now()
          AND c.moderation_status='PENDING' AND c.deleted_at IS NULL AND c.content_version=q.content_version AND c.moderation_revision=q.moderation_revision
        ORDER BY q.created_at,q.id LIMIT 1 FOR UPDATE OF q SKIP LOCKED) RETURNING j.*`;
    if (!job) return;
    if (
      job.policy_version !== POLICY_VERSION ||
      job.prompt_version !== PROMPT_VERSION ||
      job.schema_version !== SCHEMA_VERSION ||
      job.model !== this.config.model
    ) {
      await this.finish(job, null, 'VERSION_UNAVAILABLE', 0);
      return;
    }
    if (
      !this.provider ||
      !this.config.enabled ||
      !this.config.keyPresent ||
      this.config.errors.length
    ) {
      await this.finish(job, null, 'CONFIG_MISSING', 0);
      return;
    }
    if (job.attempts > this.config.maxRetries) {
      await this.finish(job, null, 'ATTEMPTS_EXHAUSTED', 0);
      return;
    }
    const [content] = await this.db.$queryRaw<
      { body: string }[]
    >`SELECT c.body FROM track_comments c JOIN tracks t ON t.id=c.track_id JOIN users u ON u.id=c.user_id JOIN users a ON a.id=t.author_id
      WHERE c.id=${job.comment_id}::uuid AND c.content_version=${job.content_version} AND c.moderation_revision=${job.moderation_revision} AND c.moderation_status='PENDING' AND c.deleted_at IS NULL AND c.decision_source<>'MANUAL'
        AND t.deleted_at IS NULL AND t.processing_state='READY' AND t.publication_state='PUBLISHED' AND c.source_version=t.source_version AND u.active=true AND a.active=true AND a.role='AUTHOR'
        AND EXISTS(SELECT 1 FROM comment_moderation_jobs WHERE id=${job.id}::uuid AND run_token=${token}::uuid AND lease_expires_at>now())`;
    if (!content || hash(content.body) !== job.content_hash) {
      await this.finish(job, null, 'CONTENT_UNAVAILABLE', 0);
      return;
    }
    if (requiresPrivateReview(content.body)) {
      await this.finish(job, null, 'PRIVATE_DATA_REVIEW', 0);
      return;
    }
    const start = Date.now();
    let reserved = false;
    try {
      await this.budget.reserve();
      reserved = true;
      const ready = await this.db
        .$executeRaw`UPDATE comment_moderation_jobs j SET attempts=attempts+1 WHERE j.id=${job.id}::uuid AND j.run_token=${token}::uuid AND j.status='RUNNING' AND j.lease_expires_at>now() AND j.attempts<${this.config.maxRetries + 1}
        AND EXISTS(SELECT 1 FROM track_comments c WHERE c.id=j.comment_id AND c.content_version=j.content_version AND c.moderation_revision=j.moderation_revision AND c.moderation_status='PENDING' AND c.deleted_at IS NULL AND c.decision_source<>'MANUAL')`;
      if (!ready) {
        await this.budget.release(true);
        return;
      }
      const result = validateResult(
        await this.provider.classify({
          comment: content.body,
          signals: { repeated: job.repeated },
        }),
        content.body,
      );
      await this.budget.release(true);
      reserved = false;
      await this.finish(job, result, null, Date.now() - start);
    } catch (error) {
      if (reserved) {
        await this.budget.release(false).catch(() => undefined);
        reserved = false;
      }
      const code = failureCode(error),
        meta = error as { retryable?: boolean; retryAfterSeconds?: number };
      const calls = job.attempts + (code === 'INTERNAL_BUDGET_EXCEEDED' ? 0 : 1);
      const seconds = Math.max(
        meta.retryAfterSeconds ?? 0,
        Math.min(30, 2 ** calls) + Math.random(),
      );
      if (
        meta.retryable &&
        calls <= this.config.maxRetries &&
        Date.now() + seconds * 1000 < job.deadline.getTime()
      ) {
        await this.db
          .$executeRaw`UPDATE comment_moderation_jobs SET status='QUEUED',run_token=NULL,lease_expires_at=NULL,error_code=${code},next_attempt_at=now()+(${seconds}*interval '1 second') WHERE id=${job.id}::uuid AND run_token=${token}::uuid AND status='RUNNING' AND lease_expires_at>now()`;
      } else await this.finish(job, null, code, Date.now() - start);
    }
  }
  async metrics(userId: string) {
    await this.requirePermission(userId, 'read');
    const [states, jobs, manual, budget] = await Promise.all([
      this.db
        .$queryRaw`SELECT moderation_status AS status,count(*)::int AS count,max(extract(epoch FROM now()-moderation_updated_at))::float8 AS "oldestSeconds" FROM track_comments WHERE deleted_at IS NULL GROUP BY moderation_status`,
      this.db
        .$queryRaw`SELECT error_code AS "errorCode",count(*)::int AS count,avg(latency_ms)::float8 AS "averageLatencyMs" FROM comment_moderation_jobs WHERE created_at>now()-interval '1 day' GROUP BY error_code`,
      this.db
        .$queryRaw`SELECT count(*)::int AS decisions,count(*) FILTER(WHERE from_status<>to_status)::int AS "visibilityChanges" FROM comment_moderation_audit WHERE actor_id IS NOT NULL AND action IN ('APPROVE','HIDE') AND created_at>now()-interval '1 day'`,
      this.budget.diagnostics(),
    ]);
    return {
      states,
      jobs,
      manual,
      budget,
      provider: {
        model: this.config.model,
        key_present: this.config.keyPresent,
        configured: this.config.enabled && !this.config.errors.length,
        connection: 'unverified',
      },
    };
  }
}
export function createModerationService(options: {
  db: PrismaClient;
  config: ModerationConfig;
  provider?: ModerationProvider;
}) {
  return new ModerationService(options.db, options.config, options.provider);
}
