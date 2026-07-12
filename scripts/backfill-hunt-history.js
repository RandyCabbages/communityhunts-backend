// scripts/backfill-hunt-history.js
// One-shot, idempotent: seed hunt_history/participants/user_hunt_stats from the current
// archive + live hunts. FX is latest-only, so backfilled rows are flagged approx.
require('dotenv/config');
const { Pool } = require('pg');
const makeFxRates = require('../lib/fxRates');
const makeStatsStore = require('../lib/statsStore');
const persistence = require('../lib/persistence');

(async () => {
  const pgPool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const fxRates = makeFxRates({ pgPool });
  const statsStore = makeStatsStore({ pgPool, fxRates });
  await statsStore.ensureTables();
  await persistence.initPersistence({ pgPool, statsStore });

  const { hunts, archive } = persistence;
  const all = [...Object.values(hunts), ...archive].filter(h => h && h.user && Array.isArray(h.bonuses) && h.bonuses.length);
  let done = 0;
  for (const h of all) {
    try { await statsStore.recordHunt({ ...h, _approxRate: true }); done++; }
    catch (e) { console.error('[backfill] failed for', h.huntId || h.user?.id, e.message); }
  }
  console.log(`[backfill] recorded ${done}/${all.length} hunts`);
  await pgPool.end();
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
