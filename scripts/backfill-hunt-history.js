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

  // Tidy up rows that aren't real users: per-row equity UUIDs and the creator_auto/bean_auto
  // placeholders (created by the pre-fix attribution), plus any now-empty rollups.
  const UUID = `'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'`;
  const junk = `user_id ~* ${UUID} OR user_id IN ('creator_auto','bean_auto')`;
  const p1 = await pgPool.query(`DELETE FROM hunt_participants WHERE ${junk}`);
  const p2 = await pgPool.query(`DELETE FROM user_hunt_stats WHERE ${junk} OR hunts = 0`);
  console.log(`[backfill] cleaned ${p1.rowCount} placeholder participant row(s), ${p2.rowCount} spurious rollup(s)`);

  await pgPool.end();
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
