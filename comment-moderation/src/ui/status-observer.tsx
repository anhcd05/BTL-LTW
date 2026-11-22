'use client';
import { useEffect, useRef } from 'react';
import { useModerationResource } from './hooks';
import type { CommentCollection, ModerationApi } from './types';

/** Refresh permissions after the first private success, then only on status changes. */
export function useCommentStatusInvalidation(
  data: CommentCollection | undefined,
  onChanged: () => void,
) {
  const lastStatus = useRef<string | null>(null);
  useEffect(() => {
    if (!data) return;
    const current = data.items
      .map((comment) => comment.id + ':' + comment.status + ':' + comment.contentVersion)
      .join('|');
    if (current !== lastStatus.current) {
      lastStatus.current = current;
      onChanged();
    }
  }, [data, onChanged]);
}

/** No visible panel. Requests abort on disposal; the existing poller is bounded. */
export function CommentStatusObserver({
  api,
  trackId,
  refresh = 0,
  onChanged,
}: {
  api: ModerationApi;
  trackId: string;
  refresh?: number;
  onChanged: () => void;
}) {
  const result = useModerationResource<CommentCollection>(
    api,
    '/tracks/' + encodeURIComponent(trackId) + '/comments/mine?page=1&pageSize=20',
    refresh,
    (value) =>
      value.items.some(
        (comment) =>
          comment.status === 'PENDING' || comment.status === 'HELD' || comment.reviewRequested,
      ),
  );
  useCommentStatusInvalidation(result.data, onChanged);
  return null;
}
