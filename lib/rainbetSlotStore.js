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
    tableReady = pgPool.query(`
      CREATE TABLE IF NOT EXISTS rainbet_slots (
        rainbet_slug TEXT PRIMARY KEY,
        name         TEXT NOT NULL,
        thumb        TEXT,
        updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `).catch(e => {
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
    'SELECT rainbet_slug, name, thumb FROM rainbet_slots ORDER BY rainbet_slug');
  return r.rows.map(row => ({ rainbetSlug: row.rainbet_slug, name: row.name, thumb: row.thumb }));
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

  const client = await pgPool.connect();
  let deleted = 0;
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO rainbet_slots (rainbet_slug, name, thumb)
       SELECT * FROM UNNEST($1::text[], $2::text[], $3::text[])
       ON CONFLICT (rainbet_slug) DO UPDATE
         SET name = EXCLUDED.name, thumb = EXCLUDED.thumb, updated_at = now()`,
      [slugs, names, thumbs]);
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

module.exports = { initRainbetSlotStore, ensureTable, loadAll, saveAll, seedIfEmpty, count, SHRINK_FLOOR };
