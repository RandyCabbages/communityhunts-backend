// scripts/recompute-all-user-stats.js
// ONE-TIME (idempotent): regenerate every (tenant,user) rollup so stats fields added in code
// (huntKey, srcCurrency) appear without waiting for each user's next hunt. Safe to re-run.
//   node scripts/recompute-all-user-stats.js
require('dotenv/config');
const { Pool } = require('pg');
const makeFxRates = require('../lib/fxRates');
const makeStatsStore = require('../lib/statsStore');

(async () => {
  const pgPool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const fxRates = makeFxRates({ pgPool });
  const store = makeStatsStore({ pgPool, fxRates });
  await store.ensureTables();
  const r = await pgPool.query('SELECT DISTINCT tenant_id, user_id FROM hunt_participants');
  console.log(`[recompute] recomputing ${r.rows.length} (tenant,user) rollups…`);
  let n = 0;
  for (const row of r.rows) {
    await store.recomputeUser(row.tenant_id, row.user_id);
    if (++n % 25 === 0) console.log(`  …${n}/${r.rows.length}`);
  }
  console.log(`[recompute] done — ${n} rollups recomputed`);
  await pgPool.end();
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
