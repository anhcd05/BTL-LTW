// Loads compiled pure modules only (no @infosound/database import, so no DB secret is needed).
const path = require('node:path');

const dist = process.env.RECO_AI_DIST || path.join(__dirname, '..', '..', 'dist');
const load = (name) => require(path.join(dist, `${name}.js`));

module.exports = {
  math: load('math'),
  features: load('features'),
  scoring: load('scoring'),
  taste: load('taste'),
  reasons: load('reasons'),
  rerank: load('rerank'),
  vectors: load('vectors'),
  engagement: load('engagement-rules'),
  shelves: load('shelves'),
};
