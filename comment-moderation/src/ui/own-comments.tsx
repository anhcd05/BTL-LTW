'use client';
import { useId, useState } from 'react';
import { messages } from './messages';
import { useModerationAction, useModerationResource } from './hooks';
import { OwnCommentMenu } from './own-comment-menu';
import { useCommentStatusInvalidation } from './status-observer';
import {
  expectedVersion,
  type CommentCollection,
  type ModerationApi,
  type ModerationStatus,
  type OwnComment,
} from './types';

export function ModerationNotice({ locale }: { locale?: string }) {
  return <p className="moderation-notice">{messages(locale).notice}</p>;
}
export function moderationSubmissionMessage(status: ModerationStatus, locale?: string) {
  const text = messages(locale);
  return status === 'VISIBLE'
    ? text.visible
    : status === 'HIDDEN'
      ? text.violation
      : status === 'HELD'
        ? text.held
        : status === 'DELETED'
          ? text.deleted
          : text.pending;
}
/** All comment text remains text, including markup and links. */
export function ModerationCommentText({ body }: { body: string }) {
  return (
    <p className="moderation-content" dir="auto">
      {body}
    </p>
  );
}
export function ModerationStatusLabel({
  status,
  locale,
}: {
  status: ModerationStatus;
  locale?: string;
}) {
  const text = messages(locale);
  const statuses = {
    PENDING: text.pending,
    VISIBLE: text.visible,
    HELD: text.held,
    HIDDEN: text.hidden,
    DELETED: text.deleted,
  };
  return (
    <span className={'moderation-status moderation-status-' + status.toLowerCase()}>
      {statuses[status]}
    </span>
  );
}
export function OwnComments({
  api,
  trackId,
  locale,
  refresh = 0,
  onChanged,
}: {
  api: ModerationApi;
  trackId: string;
  locale?: string;
  refresh?: number;
  onChanged: () => void;
}) {
  const text = messages(locale);
  const [page, setPage] = useState(1),
    [feedback, setFeedback] = useState<'saved' | 'conflict' | null>(null);
  const result = useModerationResource<CommentCollection>(
    api,
    '/tracks/' + encodeURIComponent(trackId) + '/comments/mine?page=' + page + '&pageSize=20',
    refresh,
    (value) =>
      value.items.some(
        (comment) =>
          comment.status === 'PENDING' || comment.status === 'HELD' || comment.reviewRequested,
      ),
  );
  useCommentStatusInvalidation(result.data, onChanged);
  const changed = (outcome: 'saved' | 'conflict') => {
    setFeedback(outcome);
    result.reload();
    onChanged();
  };
  return (
    <section className="moderation-panel moderation-own" aria-label={text.own}>
      <div className="moderation-heading">
        <h3>{text.own}</h3>
        <button
          className="text-action"
          type="button"
          onClick={result.reload}
          disabled={result.loading}
        >
          {text.reload}
        </button>
      </div>
      {feedback && <p role={feedback === 'conflict' ? 'alert' : 'status'}>{text[feedback]}</p>}
      {result.loading ? (
        <p role="status">{text.loading}</p>
      ) : result.error ? (
        <p role="alert">{text.error}</p>
      ) : result.data?.items.length ? (
        <>
          <div className="moderation-own-list">
            {result.data.items.map((comment) => (
              <OwnCommentRow
                key={comment.id + ':' + comment.contentVersion + ':' + comment.moderationRevision}
                comment={comment}
                api={api}
                locale={locale}
                changed={changed}
              />
            ))}
          </div>
          <ModerationPager
            page={page}
            total={result.data.total}
            pageSize={result.data.pageSize}
            setPage={setPage}
            locale={locale}
          />
        </>
      ) : (
        <p className="muted">{text.emptyOwn}</p>
      )}
      {result.paused && <p role="status">{text.paused}</p>}
    </section>
  );
}
function OwnCommentRow({
  comment,
  api,
  locale,
  changed,
}: {
  comment: OwnComment;
  api: ModerationApi;
  locale?: string;
  changed: (outcome: 'saved' | 'conflict') => void;
}) {
  const text = messages(locale),
    id = useId();
  const [editing, setEditing] = useState(false),
    [body, setBody] = useState(comment.body);
  const action = useModerationAction();
  const count = [...body].length;
  const invoke = (method: string, path: string, fields: object = {}) =>
    void action.run(
      (signal) => api(path, { method, signal, body: { ...expectedVersion(comment), ...fields } }),
      changed,
    );
  return (
    <article className="moderation-own-comment" aria-busy={action.pending}>
      <ModerationStatusLabel status={comment.status} locale={locale} />
      <ModerationCommentText body={comment.body} />
      {action.outcome && (
        <p role={action.outcome === 'saved' ? 'status' : 'alert'}>{text[action.outcome]}</p>
      )}
      {editing ? (
        <form
          className="form-stack"
          onSubmit={(event) => {
            event.preventDefault();
            invoke('PATCH', '/comments/' + comment.id, { body });
          }}
        >
          <label htmlFor={id}>{text.body}</label>
          <textarea
            id={id}
            rows={3}
            value={body}
            disabled={action.pending}
            required
            onChange={(event) => setBody(event.target.value)}
            aria-describedby={id + '-count'}
          />
          <small id={id + '-count'}>
            {count}/2000 {text.characters}
          </small>
          <div className="moderation-actions">
            <button
              type="submit"
              className="button"
              disabled={action.pending || !body.trim() || count > 2000}
            >
              {action.pending ? text.working : text.save}
            </button>
            <button
              type="button"
              className="button secondary"
              disabled={action.pending}
              onClick={() => setEditing(false)}
            >
              {text.cancel}
            </button>
          </div>
        </form>
      ) : (
        comment.status !== 'DELETED' && (
          <div className="moderation-actions">
            <button
              type="button"
              className="text-action"
              disabled={action.pending}
              onClick={() => setEditing(true)}
            >
              {text.edit}
            </button>
            <OwnCommentMenu id={comment.id} api={api} locale={locale} onChanged={changed} />
            {(comment.status === 'HELD' || comment.status === 'HIDDEN') && (
              <button
                type="button"
                className="text-action"
                disabled={action.pending || comment.reviewRequested}
                onClick={() => invoke('POST', '/comments/' + comment.id + '/review-request')}
              >
                {comment.reviewRequested ? text.requested : text.review}
              </button>
            )}
          </div>
        )
      )}
    </article>
  );
}
export function ModerationPager({
  page,
  total,
  pageSize,
  setPage,
  locale,
}: {
  page: number;
  total: number;
  pageSize: number;
  setPage: (page: number) => void;
  locale?: string;
}) {
  const text = messages(locale),
    pages = Math.max(1, Math.ceil(total / Math.max(1, pageSize)));
  if (pages <= 1) return null;
  return (
    <nav className="moderation-pager" aria-label={text.page}>
      <button
        type="button"
        className="text-action"
        disabled={page <= 1}
        onClick={() => setPage(page - 1)}
      >
        {text.previous}
      </button>
      <span>
        {text.page} {page}/{pages}
      </span>
      <button
        type="button"
        className="text-action"
        disabled={page >= pages}
        onClick={() => setPage(page + 1)}
      >
        {text.next}
      </button>
    </nav>
  );
}
