'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ModerationApi } from './types';

/** User/route scoped requests are aborted on disposal. Polling is bounded to two minutes. */
export function useModerationResource<T>(
  api: ModerationApi,
  path: string,
  refresh: number | string = 0,
  shouldPoll?: (value: T) => boolean,
) {
  const [data, setData] = useState<T>();
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(true);
  const [paused, setPaused] = useState(false);
  const [nonce, setNonce] = useState(0);
  const poll = useRef(shouldPoll);
  poll.current = shouldPoll;
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let attempts = 0;
    const started = Date.now();
    setData(undefined);
    setLoading(true);
    setError(false);
    setPaused(false);
    const read = async () => {
      try {
        const next = await api<T>(path, { signal: controller.signal });
        if (controller.signal.aborted) return;
        setData(next);
        setError(false);
        setLoading(false);
        if (poll.current?.(next)) {
          if (++attempts < 24 && Date.now() - started < 120_000)
            timer = setTimeout(() => void read(), 5000);
          else setPaused(true);
        }
      } catch {
        if (!controller.signal.aborted) {
          setError(true);
          setLoading(false);
        }
      }
    };
    void read();
    return () => {
      controller.abort();
      if (timer) clearTimeout(timer);
    };
  }, [api, path, refresh, nonce]);
  const reload = useCallback(() => setNonce((value) => value + 1), []);
  return { data, error, loading, paused, reload };
}

export function useModerationAction() {
  const busy = useRef(false),
    current = useRef<AbortController | null>(null),
    alive = useRef(true);
  const [pending, setPending] = useState(false);
  const [outcome, setOutcome] = useState<
    'saved' | 'conflict' | 'error' | 'aiRequired' | 'policyDenied' | null
  >(null);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      current.current?.abort();
    };
  }, []);
  const run = async (
    operation: (signal: AbortSignal) => Promise<unknown>,
    after: (outcome: 'saved' | 'conflict') => void,
  ) => {
    if (busy.current) return;
    const controller = new AbortController();
    current.current = controller;
    busy.current = true;
    setPending(true);
    setOutcome(null);
    try {
      await operation(controller.signal);
      if (!controller.signal.aborted) {
        setOutcome('saved');
        after('saved');
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        const code = (error as { code?: string }).code;
        const conflict =
          (error as { status?: number }).status === 409 &&
          !['AI_REVIEW_REQUIRED', 'STRICT_POLICY_VIOLATION'].includes(code ?? '');
        setOutcome(
          code === 'AI_REVIEW_REQUIRED'
            ? 'aiRequired'
            : code === 'STRICT_POLICY_VIOLATION'
              ? 'policyDenied'
              : conflict
                ? 'conflict'
                : 'error',
        );
        if (conflict) after('conflict');
      }
    } finally {
      busy.current = false;
      if (alive.current && current.current === controller) setPending(false);
    }
  };
  return { pending, outcome, run };
}
