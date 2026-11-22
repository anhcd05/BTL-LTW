import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { checkDemoGuard, checkOfflineGuard, connectedDatabaseOk, OVERRIDE_FLAG, parseDbUrl } from '../src/guard';

const demoEnv = { RECO_DEMO: '1' } as NodeJS.ProcessEnv;

test('refuses without RECO_DEMO=1 even for a demo URL', () => {
  assert.equal(checkDemoGuard({} as NodeJS.ProcessEnv, [], 'postgresql://u:p@postgres-demo:5432/infosound_demo').ok, false);
  assert.equal(checkDemoGuard({ RECO_DEMO: 'true' } as NodeJS.ProcessEnv, [], 'postgresql://u:p@db/demo').ok, false);
  assert.equal(checkOfflineGuard({} as NodeJS.ProcessEnv).ok, false);
  assert.equal(checkOfflineGuard(demoEnv).ok, true);
});

test('refuses a non-demo URL unless the explicit flag is passed', () => {
  const real = 'postgresql://infosound_owner:x@postgres:5432/infosound';
  assert.equal(checkDemoGuard(demoEnv, [], real).ok, false);
  const forced = checkDemoGuard(demoEnv, [OVERRIDE_FLAG], real);
  assert.equal(forced.ok, true);
  assert.equal(forced.ok && forced.override, true);
  assert.equal(checkDemoGuard(demoEnv, ['--i-know-this-is-demo-not'], real).ok, false);
});

test('accepts demo in database name or host; rejects garbage URLs', () => {
  assert.equal(checkDemoGuard(demoEnv, [], 'postgresql://u:p@postgres:5432/infosound_demo').ok, true);
  assert.equal(checkDemoGuard(demoEnv, [], 'postgres://u:p@infosound-demo-postgres-1/infosound').ok, true);
  assert.equal(checkDemoGuard(demoEnv, [], 'mysql://u:p@demo/demo').ok, false);
  assert.equal(checkDemoGuard(demoEnv, [], 'not a url').ok, false);
  assert.equal(checkDemoGuard(demoEnv, [], null).ok, false);
  assert.equal(parseDbUrl('postgresql://u:p@h:1/'), null);
});

test('post-connect check requires the same database and a demo name/host', () => {
  const g = checkDemoGuard(demoEnv, [], 'postgresql://u:p@postgres:5432/infosound_demo');
  assert.ok(g.ok);
  if (!g.ok) return;
  assert.equal(connectedDatabaseOk('infosound_demo', g), true);
  assert.equal(connectedDatabaseOk('infosound', g), false);
});
