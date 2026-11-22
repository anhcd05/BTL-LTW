'use client';
import { useCallback, useEffect, useRef } from 'react';
import { api, type Track } from '@/lib/api';

/**
 * Recommendation impression/click logging (recommendation-ai/docs/DESIGN.md §4).
 * Authenticated surfaces only: callers pass enabled=false for visitors; a response without a
 * requestId or server-issued impressionToken (rule-based fallback, older API) disables logging.
 * Requests go through api(), which sends the same CSRF headers as POST /tracks/:id/listens.
 * They are fire-and-forget, abortable and never retried; keys live in memory only (no request
 * IDs, tokens or URLs in browser storage).
 */
const reported = new Set<string>();
function remember(key: string) {
  reported.add(key);
  if (reported.size > 1000) reported.delete(reported.values().next().value!);
}

type ImpressionItem = { trackId: string; position: number; reason: string };

export function useRecommendationTelemetry({
  requestId,
  impressionToken,
  surface,
  tracks,
  enabled,
  fallbackReason = 'FOR_YOU',
}: {
  requestId?: string | null;
  impressionToken?: string | null;
  surface: string;
  tracks: Track[];
  enabled: boolean;
  fallbackReason?: string;
}) {
  const container = useRef<HTMLDivElement>(null);
  const clicks = useRef(new Set<AbortController>());
  // Set by the impression effect: queues the given card if unreported, sends the queue now and
  // resolves once every impression POST of this mount has settled.
  const flushNow = useRef<((trackId: string) => Promise<void>) | null>(null);
  const active =
    enabled &&
    typeof requestId === 'string' &&
    !!requestId &&
    typeof impressionToken === 'string' &&
    !!impressionToken;
  const trackKey = tracks.map((track) => track.id).join(',');
  useEffect(() => {
    const root = container.current;
    if (!active || !requestId || !impressionToken || !root) return;
    if (typeof IntersectionObserver === 'undefined') return;
    const items = new Map(
      tracks.map((track, index) => [
        track.id,
        {
          trackId: track.id,
          position: index + 1,
          reason: track.recommendation?.reason ?? fallbackReason,
        } satisfies ImpressionItem,
      ]),
    );
    const queued: ImpressionItem[] = [];
    const inFlight = new Map<AbortController, Promise<void>>();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const flush = () => {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      const batch = queued.splice(0);
      if (!batch.length) return;
      const abort = new AbortController();
      const sent = api('/recommendations/impressions', {
        method: 'POST',
        body: { requestId, impressionToken, surface, items: batch },
        signal: abort.signal,
      })
        .then(() => undefined)
        .catch(() => {
          // Allow a later mount to report again; the API is idempotent per (requestId, trackId).
          for (const item of batch) reported.delete(requestId + ':' + item.trackId);
        })
        .finally(() => inFlight.delete(abort));
      inFlight.set(abort, sent);
    };
    flushNow.current = (trackId) => {
      const item = items.get(trackId);
      const key = requestId + ':' + trackId;
      if (item && !reported.has(key)) {
        remember(key);
        queued.push(item);
      }
      flush();
      return Promise.allSettled(inFlight.values()).then(() => undefined);
    };
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          observer.unobserve(entry.target);
          const item = items.get((entry.target as HTMLElement).dataset.trackId ?? '');
          const key = requestId + ':' + item?.trackId;
          if (!item || reported.has(key)) continue;
          remember(key);
          queued.push(item);
        }
        if (queued.length && timer === undefined) timer = setTimeout(flush, 400);
      },
      { threshold: 0.5 },
    );
    root.querySelectorAll<HTMLElement>('[data-track-id]').forEach((card) => {
      if (!reported.has(requestId + ':' + card.dataset.trackId)) observer.observe(card);
    });
    return () => {
      flushNow.current = null;
      observer.disconnect();
      if (timer !== undefined) clearTimeout(timer);
      // Cards that were queued but not sent may be reported by a later mount.
      for (const item of queued) reported.delete(requestId + ':' + item.trackId);
      for (const abort of inFlight.keys()) abort.abort();
    };
    // trackKey stands in for the track list identity; tracks itself changes on every render.
  }, [active, requestId, impressionToken, surface, trackKey, fallbackReason]);
  useEffect(() => {
    const pending = clicks.current;
    return () => {
      for (const abort of pending) abort.abort();
      pending.clear();
    };
  }, []);
  const onPlay = useCallback(
    (track: Track) => {
      if (!active || !requestId || !impressionToken) return;
      const key = 'click:' + requestId + ':' + track.id;
      if (reported.has(key)) return;
      remember(key);
      const abort = new AbortController();
      clicks.current.add(abort);
      // Send this card's impression first (even if the observer has not fired yet), then click.
      const impressions = flushNow.current?.(track.id) ?? Promise.resolve();
      void impressions
        .then(() => {
          if (abort.signal.aborted) throw new DOMException('Aborted', 'AbortError');
          return api('/recommendations/clicks', {
            method: 'POST',
            body: { requestId, impressionToken, trackId: track.id },
            signal: abort.signal,
          });
        })
        .catch(() => reported.delete(key))
        .finally(() => clicks.current.delete(abort));
    },
    [active, requestId, impressionToken],
  );
  return { container, onPlay };
}
