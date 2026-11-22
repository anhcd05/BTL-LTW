// `@infosound/recommendation-ai/features` must load without DB secrets and without pulling in
// @infosound/database / Prisma or any I/O module. Runs in a fresh child process (clean module cache).
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const dist = process.env.RECO_AI_DIST || path.join(__dirname, '..', '..', 'dist');
const entry = path.join(dist, 'features.js');

const EXPECTED = [
  'FEATURE_ORDER', 'buildFeatures', 'tasteVector', 'cosine', 'sigmoid', 'scoreFeatures',
  'parseModel', 'rerank', 'pickReason', 'seededRandom', 'engagementTimingValid',
  'maxTerminalAgeMs', 'signImpressionToken', 'verifyImpressionToken',
];

test('features entry loads with no DB env and never imports DB / I/O modules', () => {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !/^(DATABASE_URL|JWT_SECRET)/.test(key)),
  );
  const script = `
    const m = require(${JSON.stringify(entry)});
    const loaded = Object.keys(require.cache);
    process.stdout.write(JSON.stringify({ exports: Object.keys(m), loaded }));
  `;
  const run = spawnSync(process.execPath, ['-e', script], { env, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  const { exports, loaded } = JSON.parse(run.stdout);
  for (const name of EXPECTED) assert.ok(exports.includes(name), `exports ${name}`);
  const forbidden = loaded.filter((file) =>
    /[\\/](repository|engine|tracking|embeddings|server)\.js$|@infosound[\\/]database|@prisma|[\\/]generated[\\/]client/.test(file),
  );
  assert.deepEqual(forbidden, []);
});
