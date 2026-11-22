// Pure engagement rules (no I/O) shared by the API endpoint and unit tests.
import { createHash } from 'node:crypto';

export type EngagementEvent = 'start' | 'skip' | 'complete';
export const SKIP_MAX_SECONDS = 30;
export const COMPLETE_FRACTION = 0.6;

/** Listen-token lifetime; terminal events may arrive after it (token verified ignoring expiry). */
export const LISTEN_TOKEN_TTL_MS = 15 * 60_000;

/** Oldest acceptable terminal event: max(15 min, 2·D) after the token's startedAtMs. */
export function maxTerminalAgeMs(durationSeconds: number): number {
  return Math.max(LISTEN_TOKEN_TTL_MS, 2 * durationSeconds * 1000);
}

/**
 * skip ⇒ elapsed < min(30, D/2); complete ⇒ 0.6·D ≤ elapsed; both ⇒ elapsed ≤ max(15 min, 2·D);
 * start ⇒ any non-negative elapsed (its token is verified with normal expiry).
 */
export function engagementTimingValid(event: EngagementEvent, elapsedMs: number, durationSeconds: number): boolean {
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0) return false;
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return false;
  if (event === 'start') return true;
  if (elapsedMs > maxTerminalAgeMs(durationSeconds)) return false;
  if (event === 'skip') return elapsedMs < Math.min(SKIP_MAX_SECONDS, durationSeconds / 2) * 1000;
  return elapsedMs >= COMPLETE_FRACTION * durationSeconds * 1000;
}

/**
 * Marker stored in last_token_id after a token's terminal event. It differs from the token id, so a
 * later start or a second terminal event for the same token is rejected without an event log.
 */
export function terminalTokenId(tokenId: string): string {
  const hex = createHash('sha256').update(`reco-terminal:${tokenId.toLowerCase()}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
