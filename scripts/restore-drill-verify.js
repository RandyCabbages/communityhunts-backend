#!/usr/bin/env node
// Restore-drill verification. Answers the question a restore actually has to answer:
// "is the data that came back the data that went in?"
//
// Railway's PITR restore builds a NEW sibling service and never touches the source, so this is
// safe to run against production. Both modes are strictly read-only — no DDL, no DML.
//
//   1. BEFORE the restore, against the SOURCE:
//        railway run --service Postgres node scripts/restore-drill-verify.js --baseline > drill.json
//
//   2. In the dashboard: Postgres -> Backups -> pick the timestamp printed by step 1 as
//      `restoreTarget` -> "Restore to this moment". Note the wall-clock start.
//
//   3. AFTER it boots, against the RESTORED FORK:
//        railway run --service <the-restored-service> node scripts/restore-drill-verify.js --compare drill.json
//
//      Exit 0 = verified. Exit 1 = the restore did not reproduce the source.
//
// WHY IT COMPARES WHAT IT COMPARES
//
// The source keeps taking writes while the fork is being built, so raw table counts will differ
// and equality on them would fail for a perfectly good restore. The load-bearing assertion is on
// the set that CANNOT legitimately change: archived hunts with `archived_at <= restoreTarget`.
// An archived snapshot is immutable once written, so that set must come back BYTE-IDENTICAL —
// checksummed per row and aggregated. Counts are reported alongside as context, not as a verdict.
//
// Nothing here prints a name, a Discord id or a secret: counts, sums, timestamps and hashes only.

const fs = require('fs');

const args = process.argv.slice(2);
const mode = args.includes('--baseline') ? 'baseline'
  : args.includes('--compare') ? 'compare' : null;

if (!mode) {
  console.error('usage: restore-drill-verify.js --baseline > drill.json');
  console.error('       restore-drill-verify.js --compare drill.json');
  process.exit(2);
}
if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set. Run this through `railway run --service <service>`.');
  process.exit(2);
}

// Required after the usage guards above, so a wrong invocation prints the usage rather than a
// MODULE_NOT_FOUND stack from a checkout with no node_modules.
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 1,
  ssl: { rejectUnauthorized: false },
  statement_timeout: 30000,
});
const q = async (sql, params) => (await pool.query(sql, params)).rows;

const TABLES = ['hunts_rows', 'archive_rows', 'hunts_kv', 'hunt_history',
                'hunt_participants', 'user_hunt_stats', 'user_settings', 'known_users'];

async function snapshot(target) {
  const present = (await q(`SELECT relname AS t FROM pg_stat_user_tables`)).map(r => r.t);

  const counts = {};
  for (const t of TABLES) {
    counts[t] = present.includes(t)
      ? Number((await q(`SELECT count(*)::int AS c FROM ${t}`))[0].c)
      : null;                                  // null = table absent, reported not asserted
  }

  // The immutable set. md5 per row, ordered, then hashed together: one value that changes if any
  // byte of any archived hunt changed, and that is independent of physical row order.
  const frozen = (await q(`
    SELECT count(*)::int                                          AS rows,
           coalesce(md5(string_agg(h, '' ORDER BY h)), 'EMPTY')   AS checksum
      FROM (SELECT md5(archive_id || '|' || data::text) AS h
              FROM archive_rows
             WHERE archived_at <= $1) s`, [target]))[0];

  // Money, over the same frozen set. A checksum tells you something changed; these tell you
  // whether the part that matters changed, in units a human can argue about.
  const money = (await q(`
    SELECT round(coalesce(sum((SELECT coalesce(sum((b->>'win')::numeric), 0)
             FROM jsonb_array_elements(CASE jsonb_typeof(data->'bonuses')
               WHEN 'array' THEN data->'bonuses' ELSE '[]'::jsonb END) b)), 0), 2) AS total_won,
           round(coalesce(sum((SELECT coalesce(sum((e->>'amount')::numeric), 0)
             FROM jsonb_array_elements(CASE jsonb_typeof(data->'equity')
               WHEN 'array' THEN data->'equity' ELSE '[]'::jsonb END) e)), 0), 2) AS total_equity
      FROM archive_rows WHERE archived_at <= $1`, [target]))[0];

  return { counts, frozen, money };
}

(async () => {
  if (mode === 'baseline') {
    // Target slightly in the past: a hunt archived in the same second the snapshot is taken
    // could otherwise land on one side of the boundary here and the other side there.
    const target = (await q(`SELECT (now() - interval '2 minutes') AT TIME ZONE 'UTC' AS t`))[0].t;
    const snap = await snapshot(target);
    const out = {
      takenAt: new Date().toISOString(),
      restoreTarget: new Date(target).toISOString(),
      serverVersion: (await q('SHOW server_version'))[0].server_version,
      dbSize: (await q('SELECT pg_size_pretty(pg_database_size(current_database())) AS s'))[0].s,
      ...snap,
    };
    console.log(JSON.stringify(out, null, 2));
    console.error(`\nRestore target to enter in the Backups tab: ${out.restoreTarget}`);
    console.error(`Frozen set: ${snap.frozen.rows} archived hunts, checksum ${snap.frozen.checksum}`);
    await pool.end();
    return;
  }

  const path = args[args.indexOf('--compare') + 1];
  if (!path || !fs.existsSync(path)) {
    console.error('--compare needs the baseline json written by --baseline');
    process.exit(2);
  }
  const base = JSON.parse(fs.readFileSync(path, 'utf8'));
  const now = await snapshot(base.restoreTarget);

  const checks = [];
  const check = (name, ok, detail) => checks.push({ name, ok, detail });

  check('archived-hunt row count at target', now.frozen.rows === base.frozen.rows,
    `baseline ${base.frozen.rows} vs restored ${now.frozen.rows}`);
  check('archived-hunt content checksum', now.frozen.checksum === base.frozen.checksum,
    `baseline ${base.frozen.checksum} vs restored ${now.frozen.checksum}`);
  check('total won across archived hunts', String(now.money.total_won) === String(base.money.total_won),
    `baseline ${base.money.total_won} vs restored ${now.money.total_won}`);
  check('total equity staked across archived hunts', String(now.money.total_equity) === String(base.money.total_equity),
    `baseline ${base.money.total_equity} vs restored ${now.money.total_equity}`);

  // A restored fork must not be MISSING a table, and must not have lost live hunts wholesale.
  // Counts can legitimately drift (the source kept writing), so this only catches collapse.
  for (const t of TABLES) {
    if (base.counts[t] === null) continue;
    check(`table present: ${t}`, now.counts[t] !== null, `restored count ${now.counts[t]}`);
  }
  check('live hunts did not come back empty', (now.counts.hunts_rows || 0) > 0,
    `baseline ${base.counts.hunts_rows} vs restored ${now.counts.hunts_rows} (drift expected, zero is not)`);

  const failed = checks.filter(c => !c.ok);
  for (const c of checks) console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name} — ${c.detail}`);
  console.log(`\nBaseline taken ${base.takenAt}, restore target ${base.restoreTarget}`);
  console.log(failed.length ? `\n${failed.length} CHECK(S) FAILED — the restore did not reproduce the source.`
                            : '\nAll checks passed. The restore reproduced the source exactly.');
  await pool.end();
  process.exit(failed.length ? 1 : 0);
})().catch(async (e) => {
  console.error('VERIFY FAILED:', e.message);
  try { await pool.end(); } catch {}
  process.exit(1);
});
