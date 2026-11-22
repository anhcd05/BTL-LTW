'use client';
import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { messages } from './messages';
import { useModerationAction, useModerationResource } from './hooks';
import { ModerationCommentText, ModerationPager, ModerationStatusLabel } from './own-comments';
import {
  expectedVersion,
  type CommentCollection,
  type ModerationApi,
  type ModerationDetail,
  type ModerationPermissions,
  type ModerationStatus,
} from './types';

const labels = ['harassment', 'hate', 'threat', 'sexual', 'spam', 'scam', 'privacy', 'profanity'];
const technicalErrors = [
  'CONFIG_MISSING',
  'AUTH_FAILED',
  'MODEL_UNAVAILABLE',
  'RATE_LIMITED',
  'NETWORK_ERROR',
  'PROVIDER_TIMEOUT',
  'PROVIDER_REFUSAL',
  'INVALID_OUTPUT',
  'INTERNAL_BUDGET_EXCEEDED',
];
export function ModerationQueue({
  api,
  locale,
  permissions,
  formatDateTime,
}: {
  api: ModerationApi;
  locale?: string;
  permissions: ModerationPermissions;
  formatDateTime: (value: string) => string;
}) {
  const text = messages(locale);
  const [page, setPage] = useState(1),
    [filters, setFilters] = useState('status=HELD'),
    [selected, setSelected] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const opener = useRef<HTMLButtonElement | null>(null);
  const [feedback, setFeedback] = useState<'saved' | 'conflict' | null>(null);
  const result = useModerationResource<CommentCollection>(
    api,
    '/admin/moderation/comments?' + filters + '&page=' + page + '&pageSize=20',
    revision,
  );
  const changed = (outcome: 'saved' | 'conflict') => {
    setFeedback(outcome);
    setRevision((value) => value + 1);
    if (outcome === 'saved') setSelected(null);
  };
  const apply = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget),
      params = new URLSearchParams();
    for (const [key, value] of data) if (typeof value === 'string' && value) params.set(key, value);
    setFilters(params.toString());
    setPage(1);
    setSelected(null);
  };
  return (
    <section className="moderation-console">
      <header>
        <h1>{text.queue}</h1>
        <p className="muted">{text.queueDescription}</p>
      </header>
      <form className="moderation-filters" onSubmit={apply}>
        <label>
          {text.status}
          <select name="status" defaultValue="HELD">
            <option value="">{text.all}</option>
            {(['PENDING', 'HELD', 'HIDDEN', 'VISIBLE'] as ModerationStatus[]).map((status) => (
              <option key={status} value={status}>
                {
                  text[
                    (
                      {
                        PENDING: 'pending',
                        VISIBLE: 'visible',
                        HELD: 'held',
                        HIDDEN: 'hidden',
                        DELETED: 'deleted',
                      } as const
                    )[status]
                  ]
                }
              </option>
            ))}
          </select>
        </label>
        <label>
          {text.label}
          <select name="label">
            <option value="">{text.all}</option>
            {labels.map((label) => (
              <option key={label} value={label}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label>
          {text.technical}
          <select name="errorCode">
            <option value="">{text.all}</option>
            {technicalErrors.map((code) => (
              <option key={code} value={code}>
                {code}
              </option>
            ))}
          </select>
        </label>
        <label>
          {text.from}
          <input name="from" type="date" />
        </label>
        <label>
          {text.to}
          <input name="to" type="date" />
        </label>
        <button className="button" type="submit">
          {text.filter}
        </button>
      </form>
      <div className="moderation-heading">
        <h2>{text.queue}</h2>
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
          <ul className="moderation-queue-list">
            {result.data.items.map((comment) => (
              <li key={comment.id}>
                <div>
                  <ModerationStatusLabel status={comment.status} locale={locale} />
                  <p className="moderation-content" dir="auto">
                    {comment.body}
                  </p>
                  <small>
                    {text.version} {comment.contentVersion} · {text.revision}{' '}
                    {comment.moderationRevision}
                  </small>
                  {comment.createdAt && (
                    <time dateTime={comment.createdAt}>{formatDateTime(comment.createdAt)}</time>
                  )}
                </div>
                <button
                  className="button secondary"
                  type="button"
                  onClick={(event) => {
                    opener.current = event.currentTarget;
                    setSelected(comment.id);
                  }}
                  aria-expanded={selected === comment.id}
                >
                  {text.view}
                </button>
              </li>
            ))}
          </ul>
          <ModerationPager
            page={page}
            total={result.data.total}
            pageSize={result.data.pageSize}
            setPage={(value) => {
              setPage(value);
              setSelected(null);
            }}
            locale={locale}
          />
        </>
      ) : (
        <p className="moderation-empty">{text.empty}</p>
      )}
      {selected && (
        <ReviewComment
          key={selected}
          id={selected}
          api={api}
          locale={locale}
          permissions={permissions}
          formatDateTime={formatDateTime}
          changed={changed}
          close={() => {
            setSelected(null);
            opener.current?.focus();
          }}
        />
      )}
    </section>
  );
}
function ReviewComment({
  id,
  api,
  locale,
  permissions,
  formatDateTime,
  changed,
  close,
}: {
  id: string;
  api: ModerationApi;
  locale?: string;
  permissions: ModerationPermissions;
  formatDateTime: (value: string) => string;
  changed: (outcome: 'saved' | 'conflict') => void;
  close: () => void;
}) {
  const text = messages(locale),
    fieldId = useId();
  const [reason, setReason] = useState('');
  const result = useModerationResource<ModerationDetail>(
    api,
    '/admin/moderation/comments/' + encodeURIComponent(id),
  );
  const action = useModerationAction();
  const comment = result.data;
  const heading = useRef<HTMLHeadingElement | null>(null);
  useEffect(() => {
    heading.current?.focus();
  }, []);
  const updated = (outcome: 'saved' | 'conflict') => {
    result.reload();
    if (outcome === 'conflict') setReason('');
    changed(outcome);
  };
  const decide = (choice: 'APPROVE' | 'HIDE') => {
    if (!comment || !reason.trim() || reason.length > 300) return;
    void action.run(
      (signal) =>
        api('/admin/moderation/comments/' + id + '/decision', {
          method: 'POST',
          signal,
          body: { ...expectedVersion(comment), action: choice, reason: reason.trim() },
        }),
      updated,
    );
  };
  return (
    <section className="moderation-panel moderation-review" aria-labelledby={fieldId + '-title'}>
      <div className="moderation-heading">
        <h2 ref={heading} tabIndex={-1} id={fieldId + '-title'}>
          {text.detail}
        </h2>
        <button type="button" className="text-action" onClick={close} disabled={action.pending}>
          {text.close}
        </button>
      </div>
      {result.loading ? (
        <p role="status">{text.loading}</p>
      ) : result.error ? (
        <p role="alert">
          {text.error}{' '}
          <button type="button" className="text-action" onClick={result.reload}>
            {text.reload}
          </button>
        </p>
      ) : (
        comment && (
          <>
            <ModerationStatusLabel status={comment.status} locale={locale} />
            <ModerationCommentText body={comment.body} />
            <p>
              {text.version} {comment.contentVersion} · {text.revision} {comment.moderationRevision}
            </p>
            {comment.context && (
              <div className="moderation-context">
                <h3>{text.context}</h3>
                <p>
                  {text.title}: <span dir="auto">{comment.context.title}</span>
                </p>
                {comment.context.parent && (
                  <p>
                    {text.parent}: <span dir="auto">{comment.context.parent}</span>
                  </p>
                )}
              </div>
            )}
            <div className="moderation-assessment">
              <h3>{text.ai}</h3>
              {comment.errorCode && (
                <p>
                  {text.technicalExplanation} <code>{comment.errorCode}</code>
                </p>
              )}
              {comment.result ? (
                <>
                  <p>
                    {comment.result.recommendation === 'allow'
                      ? text.approvedDecision
                      : text.heldDecision}{' '}
                    · {comment.result.severity}
                  </p>
                  <p dir="auto">{comment.result.reason_vi}</p>
                  <p>{comment.result.labels.join(', ') || '—'}</p>
                  <small>{comment.result.reason_codes.join(', ')}</small>
                </>
              ) : (
                <p>{text.noAi}</p>
              )}
            </div>
            {action.outcome && (
              <p role={action.outcome === 'saved' ? 'status' : 'alert'}>{text[action.outcome]}</p>
            )}
            {permissions.review && comment.status !== 'DELETED' && (
              <form
                className="form-stack"
                onSubmit={(event) => {
                  event.preventDefault();
                  decide('APPROVE');
                }}
                aria-busy={action.pending}
              >
                <p className="moderation-notice">{text.hideConsequence}</p>
                <label htmlFor={fieldId}>{text.reason}</label>
                <textarea
                  id={fieldId}
                  value={reason}
                  required
                  rows={3}
                  maxLength={300}
                  disabled={action.pending}
                  onChange={(event) => setReason(event.target.value)}
                  aria-describedby={fieldId + '-count'}
                />
                <small id={fieldId + '-count'}>
                  {reason.length}/300 {text.characters}
                </small>
                <div className="moderation-actions">
                  <button
                    className="button"
                    type="submit"
                    disabled={action.pending || !reason.trim() || reason.length > 300}
                  >
                    {action.pending ? text.working : text.approve}
                  </button>
                  <button
                    className="button danger"
                    type="button"
                    disabled={action.pending || !reason.trim() || reason.length > 300}
                    onClick={() => decide('HIDE')}
                  >
                    {text.hide}
                  </button>
                </div>
              </form>
            )}
            {permissions.retry && comment.retryEligible && (
              <button
                className="button secondary"
                type="button"
                disabled={action.pending}
                onClick={() =>
                  void action.run(
                    (signal) =>
                      api('/admin/moderation/comments/' + id + '/retry', {
                        method: 'POST',
                        signal,
                        body: expectedVersion(comment),
                      }),
                    updated,
                  )
                }
              >
                {text.retry}
              </button>
            )}
            {comment.evaluation && (
              <p className="muted">
                <code>
                  {comment.evaluation.model} · {comment.evaluation.policyVersion} ·{' '}
                  {comment.evaluation.promptVersion} · schema {comment.evaluation.schemaVersion}
                </code>
              </p>
            )}
            <h3>{text.audit}</h3>
            {comment.audit.length ? (
              <ol className="moderation-audit">
                {comment.audit.map((entry, index) => (
                  <li key={entry.createdAt + ':' + index}>
                    <strong>{entry.action}</strong> · {entry.fromStatus || '—'} → {entry.toStatus}
                    <p dir="auto">{entry.reason}</p>
                    <small>
                      {text.version} {entry.contentVersion} · {text.revision}{' '}
                      {entry.moderationRevision} · {entry.actorId ?? 'SYSTEM'}
                    </small>
                    <time dateTime={entry.createdAt}>{formatDateTime(entry.createdAt)}</time>
                  </li>
                ))}
              </ol>
            ) : (
              <p>{text.noAudit}</p>
            )}
          </>
        )
      )}
    </section>
  );
}
