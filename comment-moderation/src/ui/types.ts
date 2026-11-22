import type { OwnComment } from '../contracts/index';
export type {
  ModerationStatus,
  OwnComment,
  CommentCollection,
  ModerationPermissions,
  ModerationDetail,
  CommentDeletionTarget,
} from '../contracts/index';
export type ModerationApi = <T>(
  path: string,
  options?: { method?: string; body?: unknown; signal?: AbortSignal },
) => Promise<T>;
export const expectedVersion = (
  comment: Pick<OwnComment, 'contentVersion' | 'moderationRevision'>,
) => ({
  expected_content_version: comment.contentVersion,
  expected_moderation_revision: comment.moderationRevision,
});
