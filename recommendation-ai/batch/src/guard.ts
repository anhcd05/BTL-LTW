import { readFileSync } from 'node:fs';

/**
 * Demo-only guard. Every command refuses to run unless
 *   RECO_DEMO=1  AND  (database name or host of the DB URL contains "demo"  OR  --i-know-this-is-demo).
 * The URL is read the same way @infosound/database reads it (DATABASE_URL_FILE, then DATABASE_URL).
 * After connecting, the server-side current_database() is checked again (see assertConnectedDemo).
 */
export const OVERRIDE_FLAG = '--i-know-this-is-demo';

export type GuardResult = { ok: true; database: string; host: string; override: boolean } | { ok: false; reason: string };

export function parseDbUrl(url: string): { database: string; host: string } | null {
  try {
    const parsed = new URL(url);
    if (!/^postgres(ql)?:$/.test(parsed.protocol)) return null;
    const database = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
    const host = parsed.hostname;
    if (!database || !host) return null;
    return { database, host };
  } catch {
    return null;
  }
}

export function readDbUrl(env: NodeJS.ProcessEnv): string | null {
  const file = env.DATABASE_URL_FILE;
  if (file) {
    try {
      return readFileSync(file, 'utf8').trim() || null;
    } catch {
      return null;
    }
  }
  return env.DATABASE_URL?.trim() || null;
}

export function checkDemoGuard(env: NodeJS.ProcessEnv, argv: readonly string[], url: string | null): GuardResult {
  if (env.RECO_DEMO !== '1') return { ok: false, reason: 'RECO_DEMO=1 is not set' };
  if (!url) return { ok: false, reason: 'no DATABASE_URL_FILE / DATABASE_URL' };
  const parsed = parseDbUrl(url);
  if (!parsed) return { ok: false, reason: 'DB URL is not a parseable postgres:// URL' };
  const override = argv.includes(OVERRIDE_FLAG);
  const named = /demo/i.test(parsed.database) || /demo/i.test(parsed.host);
  if (!named && !override)
    return {
      ok: false,
      reason: `database "${parsed.database}" on host "${parsed.host}" does not contain "demo" (pass ${OVERRIDE_FLAG} only if you are sure)`,
    };
  return { ok: true, database: parsed.database, host: parsed.host, override: override && !named };
}

/** Environment-only guard for commands that never open a DB connection (offline evaluate). */
export function checkOfflineGuard(env: NodeJS.ProcessEnv): GuardResult {
  if (env.RECO_DEMO !== '1') return { ok: false, reason: 'RECO_DEMO=1 is not set' };
  return { ok: true, database: '(none)', host: '(none)', override: false };
}

/**
 * Second line of defence once connected: the server must report the database named in the URL,
 * and that name (or the URL host) must contain "demo" unless the explicit override was given.
 */
export function connectedDatabaseOk(currentDatabase: string, guard: Extract<GuardResult, { ok: true }>): boolean {
  if (currentDatabase !== guard.database) return false;
  return guard.override || /demo/i.test(currentDatabase) || /demo/i.test(guard.host);
}
