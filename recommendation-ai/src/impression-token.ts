// Signed record of what the server actually served (no I/O). Impressions and clicks are accepted only
// for the user, request id and track ids inside a valid token, so clients cannot forge exposure data.
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { RecoReason } from './reasons';

export const IMPRESSION_TOKEN_TTL_MS = 24 * 60 * 60_000;
const DOMAIN = 'infosound-reco-impression.v1.';
const REASONS: ReadonlySet<string> = new Set(['LISTENED', 'SIMILAR', 'FOLLOW', 'TRENDING', 'EXPLORE']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type ServedItem = { trackId: string; reason: RecoReason };
export type ImpressionClaims = {
  userId: string;
  requestId: string;
  modelVersion: string;
  expiresAtMs: number;
  /** Served tracks in order (union over shelves, first occurrence wins). */
  items: ServedItem[];
};
type Payload = { v: 1; u: string; r: string; m: string; x: number; t: [string, string][] };

const mac = (secret: string, body: string) => createHmac('sha256', secret).update(DOMAIN + body).digest();

export function signImpressionToken(
  secret: string,
  input: { userId: string; requestId: string; modelVersion: string; items: readonly ServedItem[]; nowMs?: number },
): string {
  const seen = new Set<string>();
  const items: [string, string][] = [];
  for (const item of input.items) {
    const id = item.trackId.toLowerCase();
    if (seen.has(id)) continue;
    seen.add(id);
    items.push([id, item.reason]);
  }
  const payload: Payload = {
    v: 1,
    u: input.userId.toLowerCase(),
    r: input.requestId.toLowerCase(),
    m: input.modelVersion,
    x: (input.nowMs ?? Date.now()) + IMPRESSION_TOKEN_TTL_MS,
    t: items,
  };
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${body}.${mac(secret, body).toString('base64url')}`;
}

/** Returns the claims for this user and request, or null for any forged, foreign or expired token. */
export function verifyImpressionToken(
  secret: string,
  token: string,
  expected: { userId: string; requestId: string; nowMs?: number },
): ImpressionClaims | null {
  if (typeof token !== 'string' || token.length > 16_384) return null;
  const [body, signature, extra] = token.split('.');
  if (!body || !signature || extra !== undefined) return null;
  const actual = Buffer.from(signature, 'base64url');
  const wanted = mac(secret, body);
  if (actual.length !== wanted.length || !timingSafeEqual(actual, wanted)) return null;
  let payload: Payload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Payload;
  } catch {
    return null;
  }
  if (
    payload?.v !== 1 ||
    payload.u !== expected.userId.toLowerCase() ||
    payload.r !== expected.requestId.toLowerCase() ||
    typeof payload.m !== 'string' ||
    !Number.isSafeInteger(payload.x) ||
    payload.x < (expected.nowMs ?? Date.now()) ||
    !Array.isArray(payload.t) ||
    !payload.t.every((e) => Array.isArray(e) && UUID.test(String(e[0])) && REASONS.has(String(e[1])))
  )
    return null;
  return {
    userId: payload.u,
    requestId: payload.r,
    modelVersion: payload.m,
    expiresAtMs: payload.x,
    items: payload.t.map(([trackId, reason]) => ({ trackId, reason: reason as RecoReason })),
  };
}
