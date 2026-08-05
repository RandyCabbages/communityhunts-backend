// scripts/recompute-all-user-stats.js
// ONE-TIME (idempotent): regenerate every (tenant,user) rollup so stats fields added in code
// (huntKey, srcCurrency) appear without waiting for each user's next hunt. Safe to re-run.
//   node scripts/recompute-all-user-stats.js
require('dotenv/config');
const { Pool } = require('pg');
const makeFxRates = require('../lib/fxRates');
const makeStatsStore = require('../lib/statsStore');
const settings = require('../lib/settings');
const huntsCore = require('../lib/hunts-core');

(async () => {
  const pgPool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

  // The stats rollup now stores member NAMES, so the anonymity predicate has to be live in any
  // process that writes it. hunts-core's default masks nothing — a script that skips this bakes
  // real names into the cache permanently, at the current version stamp, with no self-heal.
  // And it has to fail LOUDLY: the load swallows a pg error and falls back to a file this process
  // does not have, so a transient failure would arm nothing, log "0 anonymous user(s)" and exit 0.
  settings.initSettings({ pgPool });
  const anon = await settings.loadAnonymousUsers();
  if (!anon.ok) {
    console.error('[recompute] refusing to write rollups: the anonymity set could not be loaded, ' +
      'so anonymous members would be cached under their real names. Fix the database read and re-run.');
    process.exit(1);
  }
  huntsCore.initHuntsCore({
    hunts: {}, archive: [], viewers: {}, io: null,
    isAnonymousUser: settings.isAnonymousUser,
    shouldMaskIdentity: settings.shouldMaskIdentity,
  });

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
