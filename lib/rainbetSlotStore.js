// Durable home for the Rainbet slot catalogue.
//
// It used to live ONLY in rainbet_slots.json — a file the Railway image resets on every deploy —
// with a GitHub Contents API commit as the sole thing keeping it alive. That made the catalogue
// hostage to deploy timing, because the scrape takes 5-7 minutes and restarts from zero whenever
// the container is replaced:
//
//   - Measured 2026-08-01/02, the two heaviest merge days on record (PRs #160-#167): containers
//     lived 2, 5, 9 and 13 minutes and the catalogue got ZERO commits across both days, while
//     quiet days either side produced 1-2. Every merge killed the scrape mid-run.
//   - Even a scrape that DID finish lost its work if a deploy landed in the window between
//     finishing and the commit going through.
//
// Postgres removes both failure modes. The file stays on as the repo-readable snapshot and the
// first-boot / local-dev seed; it is no longer what keeps the catalogue alive.
//
// Shape is deliberately the file's shape ({ rainbetSlug, name, thumb }) so every existing reader
// and the scrape's merge logic keep working unchanged — this is a change of storage, not of format.

let pgPool = null;
let tableReady = null;

// Refuse to shrink the catalogue by more than this in one write. The scrape's own removal path is
// already guarded (it only trusts a full-catalogue run), so anything that gets past that and still
// halves the catalogue is a broken run, not 3,000 delistings. Same shape of guard as
// rainbetReconcile's catalogFloorOk — a bad crawl must write nothing rather than empty the picker.
const SHRINK_FLOOR = 0.5;

function initRainbetSlotStore({ pgPool: pool } = {}) {
  pgPool = pool || null;
  tableReady = null;
  return pgPool ? ensureTable() : Promise.resolve();
}

function ensureTable() {
  if (!pgPool) return Promise.resolve();
  if (!tableReady) {
    // missing_since is the reconcile job's mark-then-sweep stamp (lib/rainbetReconcile.js): an
    // entry absent from Rainbet's live set is stamped, and only swept once the stamp is 3 days
    // old. It HAS to live with the catalogue. While the catalogue was a file this was just another
    // key on the row; once it moved here, a column that dropped it would have the 10-minute sync
    // erase every mark on its next write — the grace period could never elapse and nothing would
    // ever be swept, silently.
    tableReady = pgPool.query(`
      CREATE TABLE IF NOT EXISTS rainbet_slots (
        rainbet_slug  TEXT PRIMARY KEY,
        name          TEXT NOT NULL,
        thumb         TEXT,
        missing_since TEXT,
        updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `).then(() =>
      // Separate ALTER so a table created by an earlier deploy gains the column too.
      pgPool.query('ALTER TABLE rainbet_slots ADD COLUMN IF NOT EXISTS missing_since TEXT')
    ).catch(e => {
      // Reset so a later call can retry rather than latching onto a rejected promise forever.
      tableReady = null;
      throw e;
    });
  }
  return tableReady;
}

async function count() {
  if (!pgPool) return 0;
  await ensureTable();
  const r = await pgPool.query('SELECT COUNT(*)::int AS n FROM rainbet_slots');
  return r.rows[0] ? r.rows[0].n : 0;
}

// The whole catalogue, in the file's shape. Order is by slug so the snapshot the sync commits back
// to the repo is stable — an unordered dump would produce a churny 7,000-line diff every time.
async function loadAll() {
  if (!pgPool) return null;
  await ensureTable();
  const r = await pgPool.query(
    'SELECT rainbet_slug, name, thumb, missing_since FROM rainbet_slots ORDER BY rainbet_slug');
  return r.rows.map(row => {
    const e = { rainbetSlug: row.rainbet_slug, name: row.name, thumb: row.thumb };
    // Present only when stamped, matching the file exactly: rainbetReconcile clears a mark by
    // dropping the key, and an always-present `missingSince: null` would also add a null to all
    // ~7,600 rows of the committed snapshot on every write.
    if (row.missing_since) e.missingSince = row.missing_since;
    return e;
  });
}

// Replace the catalogue with `entries`. Upserts everything given and deletes anything missing,
// because the scrape hands back the full kept list rather than a delta.
//
// Returns { skipped } rather than throwing when the shrink guard trips: the caller has a live
// in-memory catalogue either way, and failing the whole sync over a suspicious write would also
// discard the additions in the same batch.
async function saveAll(entries) {
  if (!pgPool) return { saved: 0, deleted: 0, skipped: 'no-db' };
  if (!Array.isArray(entries)) return { saved: 0, deleted: 0, skipped: 'not-an-array' };
  await ensureTable();

  const rows = entries.filter(e => e && e.rainbetSlug && e.name);
  if (rows.length === 0) return { saved: 0, deleted: 0, skipped: 'empty' };

  const before = await count();
  if (before > 0 && rows.length < before * SHRINK_FLOOR) {
    return { saved: 0, deleted: 0, skipped: 'shrink-guard', before, offered: rows.length };
  }

  const slugs = rows.map(e => String(e.rainbetSlug));
  const names = rows.map(e => String(e.name));
  const thumbs = rows.map(e => (e.thumb == null ? null : String(e.thumb)));
  // An entry with no mark writes NULL, which is how the reconcile job's "this game came back"
  // clears a stamp — it drops the key, so absent must mean cleared rather than unchanged.
  const marks = rows.map(e => (e.missingSince == null ? null : String(e.missingSince)));

  const client = await pgPool.connect();
  let deleted = 0;
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO rainbet_slots (rainbet_slug, name, thumb, missing_since)
       SELECT * FROM UNNEST($1::text[], $2::text[], $3::text[], $4::text[])
       ON CONFLICT (rainbet_slug) DO UPDATE
         SET name = EXCLUDED.name, thumb = EXCLUDED.thumb,
             missing_since = EXCLUDED.missing_since, updated_at = now()`,
      [slugs, names, thumbs, marks]);
    // Delisted games. Guarded by the shrink floor above, so this can only ever trim a plausible
    // number of rows.
    const del = await client.query(
      'DELETE FROM rainbet_slots WHERE rainbet_slug <> ALL($1::text[])', [slugs]);
    deleted = del.rowCount || 0;
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
  return { saved: rows.length, deleted };
}

// Apply a reconciliation as TARGETED changes rather than a whole-catalogue replace.
//
// The reconcile job runs off Railway and takes ~20 minutes, while the in-process 10-minute sync
// keeps adding newly released slots. A replace-everything write built from a 20-minute-old read
// would delete every slot added in the meantime. That race exists against the file too, but there
// it surfaces as a git rebase conflict that FAILS the job — moving to Postgres without this would
// have quietly turned a loud failure into a silent one.
//
// Removals are capped as a last backstop. A sweep is a handful of delisted games that already sat
// marked through a 3-day grace, so anything bigger is a broken crawl that the job's own
// provider/live-set gates failed to catch.
//
// The floor matters: a pure fraction blocks removing even ONE entry from a small catalogue, which
// is wrong for a dev/test database and does nothing for the case this guard exists for — the real
// catalogue is ~7,600 rows, where the fraction is what binds.
const MAX_SWEEP_FRACTION = 0.1;
const MIN_SWEEP = 10;

async function applyReconcile({ removed = [], marked = [], cleared = [] } = {}) {
  if (!pgPool) return { skipped: 'no-db' };
  await ensureTable();

  const rm = [...new Set(removed.map(String).filter(Boolean))];
  const total = await count();
  const allowed = Math.max(MIN_SWEEP, total * MAX_SWEEP_FRACTION);
  if (total > 0 && rm.length > allowed) {
    return { skipped: 'sweep-cap', total, offered: rm.length, allowed };
  }

  const markSlugs = [], markStamps = [];
  for (const m of marked) {
    if (!m || !m.rainbetSlug || !m.missingSince) continue;
    markSlugs.push(String(m.rainbetSlug));
    markStamps.push(String(m.missingSince));
  }
  const clr = [...new Set(cleared.map(String).filter(Boolean))];

  const client = await pgPool.connect();
  try {
    await client.query('BEGIN');
    let deletedRows = 0;
    if (rm.length) {
      const d = await client.query(
        'DELETE FROM rainbet_slots WHERE rainbet_slug = ANY($1::text[])', [rm]);
      deletedRows = d.rowCount || 0;
    }
    if (markSlugs.length) {
      await client.query(
        `UPDATE rainbet_slots SET missing_since = m.stamp, updated_at = now()
           FROM UNNEST($1::text[], $2::text[]) AS m(slug, stamp)
          WHERE rainbet_slots.rainbet_slug = m.slug`,
        [markSlugs, markStamps]);
    }
    if (clr.length) {
      await client.query(
        'UPDATE rainbet_slots SET missing_since = NULL, updated_at = now() WHERE rainbet_slug = ANY($1::text[])',
        [clr]);
    }
    await client.query('COMMIT');
    return { removed: deletedRows, marked: markSlugs.length, cleared: clr.length };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

// The three targeted change sets a reconciliation implies, derived by comparing the entries it was
// given with the entries it produced. Pure, so the script does not have to thread slug lists back
// out of lib/rainbetReconcile.js (which reports NAMES, not slugs).
function diffReconcile(before, after) {
  const beforeBySlug = new Map((before || []).filter(e => e && e.rainbetSlug).map(e => [String(e.rainbetSlug), e]));
  const afterBySlug = new Map((after || []).filter(e => e && e.rainbetSlug).map(e => [String(e.rainbetSlug), e]));
  const removed = [], marked = [], cleared = [];
  for (const [slug, was] of beforeBySlug) {
    const now = afterBySlug.get(slug);
    if (!now) { removed.push(slug); continue; }
    if (now.missingSince && now.missingSince !== was.missingSince) {
      marked.push({ rainbetSlug: slug, missingSince: now.missingSince });
    } else if (!now.missingSince && was.missingSince) {
      cleared.push(slug);
    }
  }
  return { removed, marked, cleared };
}

// First boot against a fresh database: copy the committed file in so the catalogue is never empty
// while the first scrape (5-7 minutes) is still running. Mirrors the hunts_rows migration — the
// seed is read ONLY when the table is empty, so it can never overwrite a live catalogue with a
// stale repo snapshot.
async function seedIfEmpty(entries) {
  if (!pgPool) return { seeded: 0 };
  if (await count() > 0) return { seeded: 0 };
  const r = await saveAll(entries);
  if (r.saved) console.log(`[slot-store] seeded ${r.saved} slots into Postgres from the committed file`);
  return { seeded: r.saved || 0 };
}

module.exports = {
  initRainbetSlotStore, ensureTable, loadAll, saveAll, seedIfEmpty, count,
  applyReconcile, diffReconcile,
  SHRINK_FLOOR, MAX_SWEEP_FRACTION, MIN_SWEEP,
};
