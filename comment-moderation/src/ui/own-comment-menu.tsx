'use client';
import { useEffect, useId, useRef, useState } from 'react';
import { messages } from './messages';
import { useModerationAction } from './hooks';
import { expectedVersion, type ModerationApi, type CommentDeletionTarget } from './types';

/** Load only deletion metadata; track owners must not receive held comment text. */
export function OwnCommentMenu({
  id,
  api,
  locale,
  onChanged,
}: {
  id: string;
  api: ModerationApi;
  locale?: string;
  onChanged: (outcome: 'saved' | 'conflict') => void;
}) {
  const text = messages(locale),
    panelId = useId(),
    root = useRef<HTMLDivElement>(null),
    trigger = useRef<HTMLButtonElement>(null);
  const request = useRef<AbortController | null>(null),
    alive = useRef(true),
    action = useModerationAction();
  const [open, setOpen] = useState(false),
    [confirm, setConfirm] = useState(false),
    [loading, setLoading] = useState(false),
    [failed, setFailed] = useState(false),
    [target, setTarget] = useState<CommentDeletionTarget | null>(null);
  const [placement, setPlacement] = useState({ left: 0, width: 280 });
  const close = (focus = false) => {
    request.current?.abort();
    setOpen(false);
    setConfirm(false);
    setTarget(null);
    setLoading(false);
    if (focus) trigger.current?.focus();
  };
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      request.current?.abort();
    };
  }, []);
  useEffect(() => {
    if (!open) return;
    const dismiss = (event: Event) => {
      if (event.target instanceof Node && !root.current?.contains(event.target) && !action.pending)
        close();
    };
    const resize = () => {
      if (!action.pending) close();
    };
    document.addEventListener('pointerdown', dismiss);
    document.addEventListener('focusin', dismiss);
    window.addEventListener('resize', resize);
    return () => {
      document.removeEventListener('pointerdown', dismiss);
      document.removeEventListener('focusin', dismiss);
      window.removeEventListener('resize', resize);
    };
  }, [open, action.pending]);
  const load = async () => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    const rect = root.current?.getBoundingClientRect();
    if (rect) {
      const width = Math.min(320, window.innerWidth - 32);
      setPlacement({
        width,
        left:
          Math.max(16, Math.min(rect.right - width, window.innerWidth - width - 16)) - rect.left,
      });
    }
    setOpen(true);
    setConfirm(false);
    setTarget(null);
    setLoading(true);
    setFailed(false);
    try {
      const comment = await api<CommentDeletionTarget>(
        '/comments/' + encodeURIComponent(id) + '/deletion-target',
        { signal: controller.signal },
      );
      if (alive.current && !controller.signal.aborted) setTarget(comment);
    } catch {
      if (alive.current && !controller.signal.aborted) setFailed(true);
    } finally {
      if (alive.current && !controller.signal.aborted) setLoading(false);
    }
  };
  const remove = () => {
    if (!target || !target.canDelete || target.status === 'DELETED') return;
    void action.run(
      (signal) =>
        api('/comments/' + encodeURIComponent(id), {
          method: 'DELETE',
          signal,
          body: expectedVersion(target),
        }),
      (outcome) => {
        if (outcome === 'saved') close(true);
        else {
          setConfirm(false);
          setTarget(null);
          setFailed(true);
        }
        onChanged(outcome);
      },
    );
  };
  return (
    <div
      ref={root}
      className="moderation-comment-menu"
      onKeyDown={(event) => {
        if (event.key === 'Escape' && open && !action.pending) {
          event.preventDefault();
          event.stopPropagation();
          close(true);
        }
      }}
    >
      <button
        ref={trigger}
        type="button"
        className="moderation-comment-options icon-button"
        aria-label={text.commentOptions}
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        disabled={action.pending}
        onClick={() => {
          if (open) close();
          else void load();
        }}
      >
        <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <circle cx="5" cy="12" r="1.7" />
          <circle cx="12" cy="12" r="1.7" />
          <circle cx="19" cy="12" r="1.7" />
        </svg>
      </button>
      {open && (
        <div
          id={panelId}
          className="moderation-comment-menu-panel"
          style={{ right: 'auto', left: placement.left, width: placement.width }}
          role="group"
          aria-label={text.commentOptions}
          aria-busy={loading || action.pending}
        >
          {loading ? (
            <p role="status">{text.loading}</p>
          ) : failed ? (
            <>
              <p role="alert">{action.outcome === 'conflict' ? text.conflict : text.error}</p>
              <button type="button" className="text-action" onClick={() => void load()}>
                {text.reload}
              </button>
            </>
          ) : target?.status === 'DELETED' ? (
            <p role="status">{text.deleted}</p>
          ) : target && !target.canDelete ? (
            <p role="status">{text.deleteDenied}</p>
          ) : confirm ? (
            <>
              <p>{text.confirmRemove}</p>
              <div className="moderation-actions">
                <button
                  type="button"
                  className="button secondary"
                  autoFocus
                  disabled={action.pending}
                  onClick={() => close(true)}
                >
                  {text.cancel}
                </button>
                <button
                  type="button"
                  className="button danger"
                  disabled={action.pending}
                  onClick={remove}
                >
                  {action.pending ? text.working : text.remove}
                </button>
              </div>
              {action.outcome === 'error' && <p role="alert">{text.error}</p>}
            </>
          ) : (
            target && (
              <button
                type="button"
                className="moderation-delete-choice text-action"
                onClick={() => setConfirm(true)}
              >
                {text.deleteComment}
              </button>
            )
          )}
        </div>
      )}
    </div>
  );
}
