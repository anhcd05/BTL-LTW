/** JSON-only public contracts. No ORM, provider, environment or Node runtime imports. */
export type ModerationStatus = 'PENDING' | 'VISIBLE' | 'HELD' | 'HIDDEN' | 'DELETED';
export type ModerationLabel =
  | 'harassment'
  | 'hate'
  | 'threat'
  | 'sexual'
  | 'spam'
  | 'scam'
  | 'privacy'
  | 'profanity';
export type ExpectedCommentVersion = {
  expected_content_version: number;
  expected_moderation_revision: number;
};
export type ModerationDecisionInput = ExpectedCommentVersion & {
  action: 'APPROVE' | 'HIDE';
  reason: string;
};
export type ModerationPermissions = { read: boolean; review: boolean; retry: boolean };
export type CommentDeletionTarget = {
  id: string;
  status: ModerationStatus;
  contentVersion: number;
  moderationRevision: number;
  canDelete: boolean;
  deleteIncludesReplies: true;
};
export type CommentViolationNotice = {
  id: string;
  kind: 'COMMENT_VIOLATION';
  message: string;
  commentId: string;
  commentBody: string;
  contentVersion: number;
  createdAt: string;
  readAt?: string | null;
  trackId?: string;
};
export type OwnComment = {
  id: string;
  trackId: string;
  body: string;
  status: ModerationStatus;
  contentVersion: number;
  moderationRevision: number;
  sourceVersion: number;
  reviewRequested: boolean;
  createdAt?: string;
};
export type CommentCollection = {
  items: OwnComment[];
  total: number;
  page: number;
  pageSize: number;
};
export type ModerationAssessment = {
  labels: string[];
  severity: string;
  reason_vi: string;
  reason_codes: string[];
  recommendation: string;
  uncertain?: boolean;
  evidence_quotes?: string[];
};
export type ModerationAuditEntry = {
  action: string;
  actorId: string | null;
  fromStatus: string | null;
  toStatus: string;
  reason: string;
  createdAt: string;
  contentVersion: number;
  moderationRevision: number;
};
export type ModerationDetail = OwnComment & {
  result: ModerationAssessment | null;
  errorCode: string | null;
  retryEligible: boolean;
  context?: { title: string; parent: string | null };
  evaluation?: {
    model: string;
    policyVersion: string;
    promptVersion: string;
    schemaVersion: string;
    attempts: number;
    latencyMs: number | null;
  } | null;
  audit: ModerationAuditEntry[];
};
