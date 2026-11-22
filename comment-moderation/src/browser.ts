'use client';
export {
  OwnComments,
  ModerationNotice,
  ModerationStatusLabel,
  ModerationCommentText,
  moderationSubmissionMessage,
} from './ui/own-comments';
export { ModerationQueue } from './ui/moderation-queue';
export { OwnCommentMenu } from './ui/own-comment-menu';
export { CommentStatusObserver } from './ui/status-observer';
export {
  CommentViolationNotification,
  moderationNotificationFeedCopy,
} from './ui/violation-notification';
export type {
  ModerationApi,
  ModerationPermissions,
  OwnComment,
  ModerationStatus,
} from './ui/types';
export type { CommentViolationNotice } from './contracts/index';
