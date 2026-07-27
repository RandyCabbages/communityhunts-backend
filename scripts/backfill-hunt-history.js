// scripts/backfill-hunt-history.js
// Seed hunt_history / hunt_participants / user_hunt_stats from the current archive + live hunts.
//
// DRY RUN BY DEFAULT — pass --apply to write. Its siblings (dedupe_rainbet_slots.js,
// reconcile_rainbet.js) both have a dry run; this one did not, and it was the most destructive of
// the three.
//
// Two hazards this version removes:
//
//  1. It stamped EVERY hunt with `_approxRate: true` and re-recorded it. recordHunt re-fetches the
//     LATEST fx rate for an approx row, so a second run silently downgraded hunts that had been
//     recorded live with an exact same-day rate, and overwrote their usd_rate. Measured
//     2026-07-27: 93 of 374 hunts already carried approx; a re-run pushed that toward 100% and
//     moved the public usdWon figure. It now fills GAPS only (lib/backfillPlan.js) — anything
//     already in hunt_history is left exactly as it is.
//
//  2. It called persistence.initPersistence(), whose loadPersistedState can itself call
//     persistArchive() — so a nominally read-side backfill could WRITE hunts_kv from its own
//     snapshot while the live server was running, clobbering hunt edits made in between. It now
//     reads hunts_kv directly and never loads the persistence module.

require('dotenv/config');
const { Pool } = require('pg');
const makeFxRates = require('../lib/fxRates');
const makeStatsStore = require('../lib/statsStore');
const { planBackfill } = require('../lib/backfillPlan');
const { makePoolConfig } = require('../lib/pgConfig');

const APPLY = process.argv.includes('--apply');

(async () => {
  if (!process.env.DATABASE_URL) { console.error('[backfill] DATABASE_URL is not set'); process.exit(1); }
  const pgPool = new Pool(makePoolConfig(process.env.DATABASE_URL));
  const fxRates = makeFxRates({ pgPool });
  const statsStore = makeStatsStore({ pgPool, fxRates });
  await statsStore.ensureTables();

  // Read hunt state directly — see hazard 2 above.
  const readKv = async (key) => {
    const r = await pgPool.query('SELECT value FROM hunts_kv WHERE key=$1', [key]);
    return r.rows[0] ? r.rows[0].value : null;
  };
  const liveHunts = (await readKv('hunts')) || {};
  const archived = (await readKv('archive')) || [];
  const all = [...Object.values(liveHunts), ...archived];

  const existing = await pgPool.query('SELECT hunt_key FROM hunt_history');
  const existingKeys = new Set(existing.rows.map(r => r.hunt_key));

  const { toRecord, skipped } = planBackfill({ hunts: all, existingKeys });
  console.log(`[backfill] ${all.length} hunt(s) in state · ${existingKeys.size} already in hunt_history`);
  console.log(`[backfill] ${toRecord.length} to record · ${skipped.length} left untouched (their exact fx rate is preserved)`);

  const UUID = `'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'`;
  const junk = `user_id ~* ${UUID} OR user_id IN ('creator_auto','bean_auto')`;

  if (!APPLY) {
    const c1 = await pgPool.query(`SELECT count(*)::int AS n FROM hunt_participants WHERE ${junk}`);
    const c2 = await pgPool.query(`SELECT count(*)::int AS n FROM user_hunt_stats WHERE ${junk} OR hunts = 0`);
    console.log(`[backfill] would clean ${c1.rows[0].n} placeholder participant row(s), ${c2.rows[0].n} spurious rollup(s)`);
    for (const h of toRecord.slice(0, 20)) console.log(`  + ${h.huntId || h.user?.id}`);
    if (toRecord.length > 20) console.log(`  … and ${toRecord.length - 20} more`);
    console.log('[backfill] DRY RUN — nothing written. Re-run with --apply to commit.');
    await pgPool.end();
    process.exit(0);
  }

  let done = 0;
  for (const h of toRecord) {
    try { await statsStore.recordHunt(h); done++; }
    catch (e) { console.error('[backfill] failed for', h.huntId || h.user?.id, e.message); }
  }
  console.log(`[backfill] recorded ${done}/${toRecord.length} hunts`);

  // Tidy up rows that aren't real users: per-row equity UUIDs and the creator_auto/bean_auto
  // placeholders (created by the pre-fix attribution), plus any now-empty rollups.
  const p1 = await pgPool.query(`DELETE FROM hunt_participants WHERE ${junk}`);
  const p2 = await pgPool.query(`DELETE FROM user_hunt_stats WHERE ${junk} OR hunts = 0`);
  console.log(`[backfill] cleaned ${p1.rowCount} placeholder participant row(s), ${p2.rowCount} spurious rollup(s)`);

  await pgPool.end();
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
