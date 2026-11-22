'use client';
import { messages } from './messages';

export function moderationNotificationFeedCopy(locale?: string) {
  const text = messages(locale);
  return {
    eyebrow: text.notificationsEyebrow,
    title: text.notificationsTitle,
    description: text.notificationsDescription,
  };
}

/** The recipient's comment is escaped text; no HTML, AI explanation or fake cover. */
export function CommentViolationNotification({
  titleId,
  locale,
  commentBody,
  createdAt,
  unread,
  formatDateTime,
  readPending,
  onMarkRead,
}: {
  titleId: string;
  locale?: string;
  commentBody: string;
  createdAt: string;
  unread: boolean;
  formatDateTime: (value: string) => string;
  readPending: boolean;
  onMarkRead: () => void;
}) {
  const text = messages(locale);
  return (
    <article
      className="notification-feed-item moderation-violation-notification"
      data-unread={unread ? 'true' : 'false'}
      aria-labelledby={titleId}
    >
      <div className="moderation-violation-symbol" aria-hidden="true">
        <svg
          width="28"
          height="28"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M12 3 3 7v5c0 5 9 9 9 9s9-4 9-9V7L12 3Z" />
          <path d="M12 8v5m0 3h.01" />
        </svg>
      </div>
      <div className="notification-feed-content">
        <div className="notification-feed-meta">
          <span>{text.moderationNotification}</span>
          <time dateTime={createdAt}>{formatDateTime(createdAt)}</time>
        </div>
        <h2 id={titleId}>{text.violation}</h2>
        <p>{text.violationDescription.replace('{comment}', () => commentBody)}</p>
        {unread && (
          <div className="notification-feed-actions">
            <button
              type="button"
              className="notification-feed-mark"
              disabled={readPending}
              aria-busy={readPending}
              onClick={onMarkRead}
            >
              {text.markRead}
            </button>
          </div>
        )}
      </div>
      {unread && <span className="notification-feed-unread" aria-hidden="true" />}
    </article>
  );
}
