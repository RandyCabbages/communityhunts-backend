// scripts/fix-mistagged-currency.js
//
// ONE-SHOT: retag hunts recorded in the wrong currency, and recompute everyone they touched.
//
//   node scripts/fix-mistagged-currency.js            # dry run — prints the change, writes nothing
//   node scripts/fix-mistagged-currency.js --apply    # perform it
//
// WHY THESE ROWS EXIST
// A hunt created from a `/hunt?type=…` URL was born USD whatever the host picked: the Start Hunt
// box dropped the currency on its logged-out exit, and MyHunt started the hunt without it, so
// `hunts.routes.js` applied `currency || 'USD'`. Fixed frontend-side (hunt/startParams.js); these
// are the rows that reached production first.
//
// WHY IT MATTERS OUT OF PROPORTION TO FIVE ROWS
// /api/community-stats normalises each hunt through its own stored rate. USD's rate is 1 and ARS's
// is ~0.00067, so a peso hunt wearing a USD label counts ~1500x over. These five turned a true
// ~$461K of tracked winnings into a published $2,026,109 on the homepage — and one hunt alone was
// 69% of the platform's entire advertised total.
//
// SCOPE — this fixes hunt_history, which is the stats source of truth behind the homepage band and
// every user rollup. It deliberately does NOT touch the live `hunts` / `archive` singletons: those
// are owned in memory by the running server (lib/persistence.js) and a direct write here would be
// overwritten by its next flush. Retag those through the running server instead:
//   POST /api/admin/hunts/retag-currency  { currency, userId, archivedAt }
// That only changes which symbol the archived copy renders; the money figures come from here.
require('dotenv/config');
const { Pool } = require('pg');
const makeFxRates = require('../lib/fxRates');
const makeStatsStore = require('../lib/statsStore');
const huntsCore = require('../lib/hunts-core');
const settings = require('../lib/settings');
const { sumVault } = huntsCore;

const APPLY = process.argv.includes('--apply');
const TENANT = 'bean';

// Explicit targets rather than re-running the detector at apply time: a heuristic that decides
// what to rewrite in production is a heuristic that can decide something new on a day nobody is
// watching. Each was confirmed by hand — same host, same stakes, same games as that host's peso
// hunts, in one case four hours apart on the same evening.
const TARGETS = [
  { key: '268197202b5e5a9d256d', to: 'ARS', host: 'zDec x' },
  { key: 'bb276e318bdf277f2d36', to: 'ARS', host: 'lukeyDx' },
  { key: '76dbdaa7fe3de862be21', to: 'ARS', host: 'MsMoonlight' },
  { key: '30udir',               to: 'ARS', host: 'Corthhhh' },
  { key: '5v2hd8',               to: 'ARS', host: 'Waterbuffalo21' },
];

// A hunt is only retagged if its stakes still contradict its label. If someone has already fixed
// one, or the row has changed since it was identified, this refuses rather than rewriting blind.
const GUARD_MIN_MEDIAN_BET = 10;   // platform USD median is 0.6; ARS is 44.

const median = (xs) => {
  const a = xs.filter(Number.isFinite).filter(x => x > 0).sort((x, y) => x - y);
  return a.length ? a[Math.floor(a.length / 2)] : null;
};
const wonOf = (s) =>
  (s?.bonuses || []).reduce((a, b) => a + (Number(b.win) || 0), 0) + sumVault(s);

(async () => {
  const connectionString = process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL;
  const pgPool = new Pool({ connectionString, ssl: { rejectUnauthorized: false } });

  // The stats rollup now stores member NAMES, so the anonymity predicate has to be live in any
  // process that writes it. hunts-core's default masks nothing — a script that skips this bakes
  // real names into the cache permanently, at the current version stamp, with no self-heal.
  // correctHuntCurrency recomputes every participant of a retagged hunt, so it writes rollups.
  settings.initSettings({ pgPool });
  await settings.loadAnonymousUsers();
  huntsCore.initHuntsCore({
    hunts: {}, archive: [], viewers: {}, io: null,
    isAnonymousUser: settings.isAnonymousUser,
    shouldMaskIdentity: settings.shouldMaskIdentity,
  });

  const fxRates = makeFxRates({ pgPool });
  const store = makeStatsStore({ pgPool, fxRates });

  const totalOf = async () => {
    const { rows } = await pgPool.query(
      'SELECT usd_rate, snapshot FROM hunt_history WHERE tenant_id=$1', [TENANT]);
    return rows.reduce((a, r) => {
      const rate = Number(r.usd_rate);
      return a + (isFinite(rate) && rate > 0 ? wonOf(r.snapshot) * rate : 0);
    }, 0);
  };

  const before = await totalOf();
  console.log(`${APPLY ? 'APPLY' : 'DRY RUN'} — tenant ${TENANT}`);
  console.log(`platform usdWon before: $${before.toFixed(2)}\n`);

  let planned = 0, skipped = 0;

  for (const t of TARGETS) {
    const { rows } = await pgPool.query(
      'SELECT currency, usd_rate, ended_at, snapshot FROM hunt_history WHERE hunt_key=$1 AND tenant_id=$2',
      [t.key, TENANT]);
    const row = rows[0];
    if (!row) { console.log(`SKIP ${t.key} — not in hunt_history`); skipped++; continue; }

    // correctHuntCurrency writes through recordHunt, which RE-DERIVES the primary key from the
    // snapshot (`huntId`, else `user.id|startedAt`). If that does not reproduce the row's own key
    // the upsert inserts a SECOND row instead of correcting this one — which would double the
    // hunt rather than fix it, in the exact table the homepage totals. Refuse if it disagrees.
    const derivedKey = row.snapshot?.huntId
      ? String(row.snapshot.huntId)
      : `${row.snapshot?.user?.id}|${row.snapshot?.startedAt}`;
    if (derivedKey !== t.key) {
      console.log(`SKIP ${t.key} — snapshot derives key "${derivedKey}"; correcting it would insert a duplicate`);
      skipped++; continue;
    }

    const medBet = median((row.snapshot?.bonuses || []).map(b => Number(b.bet)));
    if (row.currency === t.to) { console.log(`SKIP ${t.key} — already ${t.to}`); skipped++; continue; }
    if (!(medBet >= GUARD_MIN_MEDIAN_BET)) {
      console.log(`SKIP ${t.key} — median bet ${medBet} no longer looks like ${t.to}; not touching it`);
      skipped++; continue;
    }

    // The rate that applied THEN, taken from the platform's own record of hunts in the target
    // currency ended the same day. fxRates is latest-only, so letting it fetch would stamp
    // today's rate onto a July hunt — meaningful for a currency that moves like ARS.
    const day = row.ended_at.toISOString().slice(0, 10);
    const { rows: peers } = await pgPool.query(
      `SELECT usd_rate FROM hunt_history
        WHERE tenant_id=$1 AND currency=$2 AND usd_rate IS NOT NULL
          AND ended_at::date = $3::date`, [TENANT, t.to, day]);
    let rate = median(peers.map(p => Number(p.usd_rate)));
    let rateSrc = `${peers.length} ${t.to} hunt(s) ended ${day}`;

    if (!rate) {
      // No same-day peer: take the nearest dated one either side rather than today's rate.
      const { rows: near } = await pgPool.query(
        `SELECT usd_rate, ended_at FROM hunt_history
          WHERE tenant_id=$1 AND currency=$2 AND usd_rate IS NOT NULL
          ORDER BY abs(extract(epoch FROM (ended_at - $3::timestamptz))) ASC LIMIT 1`,
        [TENANT, t.to, row.ended_at]);
      if (!near[0]) { console.log(`SKIP ${t.key} — no ${t.to} rate anywhere to reference`); skipped++; continue; }
      rate = Number(near[0].usd_rate);
      rateSrc = `nearest ${t.to} hunt (${near[0].ended_at.toISOString().slice(0, 10)})`;
    }

    const won = wonOf(row.snapshot);
    const nowUsd = won * Number(row.usd_rate);
    const newUsd = won * rate;

    console.log(`${t.key}  ${day}  ${t.host}`);
    console.log(`   ${row.currency} @ ${row.usd_rate}  ->  ${t.to} @ ${rate}   (${rateSrc})`);
    console.log(`   median bet ${medBet} · raw won ${won.toFixed(2)}`);
    console.log(`   usdWon $${nowUsd.toFixed(2)}  ->  $${newUsd.toFixed(2)}`);

    if (APPLY) {
      const r = await store.correctHuntCurrency(TENANT, t.key, { currency: t.to, usdRate: rate });
      if (r && r.notFound) { console.log('   !! not found on write'); skipped++; continue; }
      console.log('   corrected, participant rollups recomputed');
    }
    console.log('');
    planned++;
  }

  const after = await totalOf();
  console.log(`hunts ${APPLY ? 'corrected' : 'to correct'}: ${planned}   skipped: ${skipped}`);
  console.log(`platform usdWon ${APPLY ? 'after' : 'still'}: $${after.toFixed(2)}`);
  if (!APPLY) console.log('\nnothing was written — re-run with --apply');

  await pgPool.end();
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
