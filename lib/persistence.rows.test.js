// One row per hunt (hunts_rows), replacing the single hunts_kv blob.
//
// The debounce capped the write RATE, but every flush still rewrote EVERY hunt as one JSONB value.
// Change 50 bytes on one hunt, rewrite all of them — paid three times over: the write, the WAL it
// generates (now also the PITR archive), and the serialization blocking the event loop that serves
// every tenant.
//
// These pin the two things that make the new scheme safe rather than just faster:
//   1. only CHANGED rows are written  — the point of the exercise
//   2. a REMOVED hunt is DELETEd      — the blob got this for free; rows do not, and a missed
//                                       delete means the hunt comes back from the dead on reboot

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

const MOD = require.resolve('./persistence');
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-rows-'));

function freshModule() {
  delete require.cache[MOD];
  return require('./persistence');
}

// Records upserts and deletes separately, and can serve either store on the boot read.
function fakePool({ rows = null, kv = null, failWrites = false } = {}) {
  const upserts = [];
  const deletes = [];
  const archiveOps = [];
  return {
    upserts, deletes, archiveOps,
    get writes() { return [...upserts, ...deletes, ...archiveOps]; },
    query: async (sql, params) => {
      if (/CREATE TABLE/i.test(sql)) return { rows: [] };
      if (/^SELECT .* FROM hunts_rows/i.test(sql)) {
        return { rows: rows ? Object.entries(rows).map(([user_id, data]) => ({ user_id, data })) : [] };
      }
      if (/^SELECT/i.test(sql)) {
        const key = (sql.match(/key='(\w+)'/) || [])[1];
        return { rows: kv && kv[key] ? [{ value: kv[key] }] : [] };
      }
      if (failWrites) throw new Error('connection terminated unexpectedly');
      if (/^INSERT INTO hunts_rows/i.test(sql)) upserts.push({ ids: params[0], blobs: params[1] });
      else if (/^DELETE FROM hunts_rows/i.test(sql)) deletes.push({ ids: params[0] });
      else if (/^INSERT INTO archive_rows/i.test(sql) || /^DELETE FROM archive_rows/i.test(sql)) archiveOps.push({ sql, params });
      return { rows: [] };
    },
  };
}

// Clear the JSON fallback files first. persistArchive/flushHunts write them on every call, and the
// loader falls back to them whenever Postgres returns nothing — so without this, one test's archive
// is loaded as the NEXT test's starting state. (Cost an hour: two tests failed with more rows than
// they created, which reads exactly like a duplicate-write bug in the code under test.)
const boot = (P, pool) => {
  for (const n of ['hunts_data.json', 'hunts_archive.json', 'share_tokens.json']) {
    const p = path.join(ROOT, n);
    if (fs.existsSync(p)) fs.rmSync(p);
  }
  return P.initPersistence({
    pgPool: pool, dataDir: ROOT, huntsFlushMs: 5,
    normalizeSlot: (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(),
  });
};

const hunt = (id, over = {}) => ({ huntId: id, bonuses: [], equity: [], calls: [], ...over });

// ── Only what changed ─────────────────────────────────────────────────────────

test('writes only the hunts whose content actually changed', async () => {
  const P = freshModule();
  const pool = fakePool();
  await boot(P, pool);

  P.hunts.a = hunt('a'); P.hunts.b = hunt('b'); P.hunts.c = hunt('c');
  P.persistHunts(); await P.flushHunts();
  assert.deepStrictEqual(pool.upserts[0].ids.sort(), ['a', 'b', 'c'], 'first flush writes all three');

  // Touch ONE hunt. The old blob write rewrote all three every time.
  P.hunts.b.bonuses.push({ id: 'x', win: 500 });
  P.persistHunts(); await P.flushHunts();

  assert.strictEqual(pool.upserts.length, 2);
  assert.deepStrictEqual(pool.upserts[1].ids, ['b'], 'only the edited hunt may be written');
});

test('a flush with nothing changed writes nothing at all', async () => {
  const P = freshModule();
  const pool = fakePool();
  await boot(P, pool);

  P.hunts.a = hunt('a');
  P.persistHunts(); await P.flushHunts();
  const after = pool.writes.length;

  P.persistHunts(); await P.flushHunts();   // no mutation in between
  assert.strictEqual(pool.writes.length, after, 'an unchanged flush must not touch Postgres');
});

// ── Deletion: the failure mode the blob never had ─────────────────────────────

test('a removed hunt is DELETEd, not merely absent from the next write', async () => {
  const P = freshModule();
  const pool = fakePool();
  await boot(P, pool);

  P.hunts.a = hunt('a'); P.hunts.b = hunt('b');
  P.persistHunts(); await P.flushHunts();

  delete P.hunts.a;
  P.persistHunts(); await P.flushHunts();

  assert.deepStrictEqual(pool.deletes.map(d => d.ids), [['a']],
    'without an explicit DELETE the hunt resurrects on the next boot');
});

test('deleting the last hunt still issues the DELETE', async () => {
  const P = freshModule();
  const pool = fakePool();
  await boot(P, pool);

  P.hunts.only = hunt('only');
  P.persistHunts(); await P.flushHunts();
  delete P.hunts.only;
  P.persistHunts(); await P.flushHunts();

  assert.deepStrictEqual(pool.deletes[0].ids, ['only']);
  assert.strictEqual(P.pgHealth().huntRowsWritten, 0);
});

// ── Failure handling ──────────────────────────────────────────────────────────

// The old whole-blob write simply lost a failed write until something else changed. Comparing
// content gives the retry for free: a failure leaves the baseline untouched, so the row is still
// "changed" next time.
test('a failed write is retried on the next flush', async () => {
  const P = freshModule();
  const pool = fakePool();
  await boot(P, pool);

  P.hunts.a = hunt('a');
  const broken = fakePool({ failWrites: true });
  // Swap in a failing pool by re-booting with it would reset state; instead drive the failure
  // through the same module by making the next query throw.
  const realQuery = pool.query;
  pool.query = async (sql, params) => {
    if (/^INSERT INTO hunts_rows/i.test(sql)) throw new Error('connection terminated unexpectedly');
    return realQuery(sql, params);
  };
  P.persistHunts(); await P.flushHunts();
  assert.strictEqual(P.pgHealth().pgLastWriteOk, false, 'the failure must be recorded');
  assert.strictEqual(P.pgHealth().huntRowsWritten, 0, 'a failed write must not advance the baseline');

  pool.query = realQuery;                    // connection comes back
  P.persistHunts(); await P.flushHunts();
  assert.deepStrictEqual(pool.upserts[0].ids, ['a'], 'the unwritten row must be retried');
  void broken;
});

// ── Boot: load, migration, precedence ─────────────────────────────────────────

// A hunt as it comes back from a store that has already been through load normalization once.
const stored = (id) => hunt(id, { createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' });

test('loads from hunts_rows and does NOT rewrite unchanged ones on the first flush', async () => {
  const P = freshModule();
  const pool = fakePool({ rows: { alice: stored('existing') } });
  await boot(P, pool);

  assert.strictEqual(P.hunts.alice.huntId, 'existing');
  P.persistHunts(); await P.flushHunts();
  assert.deepStrictEqual(pool.writes, [],
    'the baseline must be seeded from what was loaded, or every boot rewrites the whole table');
});

// The counterpart: load DOES normalize (backfilling createdAt/updatedAt, coercing missing arrays,
// deduping calls), and that is a genuine change to the stored value — so it must reach the durable
// store rather than living only in memory. Self-limiting: once written, the next boot is a no-op.
test('a hunt the loader had to normalize IS written back', async () => {
  const P = freshModule();
  const pool = fakePool({ rows: { alice: { huntId: 'raw' } } }); // no createdAt, no arrays
  await boot(P, pool);

  P.persistHunts(); await P.flushHunts();
  assert.deepStrictEqual(pool.upserts[0].ids, ['alice']);
  assert.ok(JSON.parse(pool.upserts[0].blobs[0]).createdAt, 'the backfilled field must be persisted');
});

test('migrates the hunts_kv blob into rows when hunts_rows is empty', async () => {
  const P = freshModule();
  const pool = fakePool({ kv: { hunts: { alice: hunt('a'), bob: hunt('b') } } });
  await boot(P, pool);

  assert.strictEqual(Object.keys(P.hunts).length, 2, 'the blob is still readable');
  await P.flushHunts();   // initPersistence scheduled it
  assert.deepStrictEqual(pool.upserts[0].ids.sort(), ['alice', 'bob']);
});

test('hunts_rows wins when both stores have data', async () => {
  const P = freshModule();
  const pool = fakePool({
    rows: { alice: hunt('from-rows') },
    kv:   { hunts: { alice: hunt('from-blob'), stale: hunt('stale') } },
  });
  await boot(P, pool);

  assert.strictEqual(P.hunts.alice.huntId, 'from-rows');
  assert.strictEqual(P.hunts.stale, undefined, 'the frozen blob must not resurrect deleted hunts');
});

// The clobber guard is what stands between a failed boot read and an empty `hunts` map. With rows,
// an unguarded flush would issue DELETEs rather than an empty upsert — worse, not better.
test('a failed boot read blocks deletes as well as writes', async () => {
  const P = freshModule();
  const pool = fakePool({ rows: { alice: hunt('a') } });
  pool.query = async (sql) => {
    if (/CREATE TABLE/i.test(sql)) return { rows: [] };
    if (/^SELECT/i.test(sql)) throw new Error('connection terminated unexpectedly');
    throw new Error('no write should ever be attempted');
  };
  await boot(P, pool);

  assert.strictEqual(P.pgHealth().pgWritesBlocked, true);
  P.persistHunts();
  await P.flushHunts();   // must not throw — nothing may be attempted
});

// ── Archive rows ──────────────────────────────────────────────────────────────
// Same treatment as hunts, applied to a store that was in worse shape: one blob rewritten in full
// on every hunt end, growing without bound, and never debounced.

const archived = (over = {}) => ({
  huntId: 'h1', user: { id: 'u1' }, startedAt: '2026-01-01T00:00:00.000Z',
  archivedAt: '2026-01-02T00:00:00.000Z', bonuses: [{ slot: 's', win: 1 }], ...over,
});

const archiveUpserts = (pool) => pool.archiveOps.filter(w => /INSERT INTO archive_rows/.test(w.sql));
const archiveDeletes = (pool) => pool.archiveOps.filter(w => /DELETE FROM archive_rows/.test(w.sql));

test('archive: only changed snapshots are written', async () => {
  const P = freshModule();
  const pool = fakePool();
  await boot(P, pool);

  P.archive.push(archived({ huntId: 'a' }), archived({ huntId: 'b' }));
  P.persistArchive();
  await P.flushAll();
  assert.strictEqual(archiveUpserts(pool)[0].params[0].length, 2, 'both land on the first write');

  P.archive[1].statsPending = true;   // what retryPendingStats toggles
  P.persistArchive();
  await P.flushAll();
  assert.strictEqual(archiveUpserts(pool)[1].params[0].length, 1, 'only the edited snapshot');
});

test('archive: an unchanged persistArchive writes nothing', async () => {
  const P = freshModule();
  const pool = fakePool();
  await boot(P, pool);

  P.archive.push(archived());
  P.persistArchive(); await P.flushAll();
  const n = pool.writes.length;

  P.persistArchive(); await P.flushAll();
  assert.strictEqual(pool.writes.length, n, 'no mutation means no write');
});

// trimArchive evicts past the cap, unarchiveHunt removes a reopened hunt, and both the admin
// delete and the janitor splice entries out. All four used to disappear for free by simply not
// being in the next blob; with rows a missed DELETE resurrects them on the next boot.
test('archive: a spliced-out snapshot is DELETEd', async () => {
  const P = freshModule();
  const pool = fakePool();
  await boot(P, pool);

  P.archive.push(archived({ huntId: 'keep' }), archived({ huntId: 'drop' }));
  P.persistArchive(); await P.flushAll();
  const droppedId = P.archive[1].archiveId;

  P.archive.splice(1, 1);
  P.persistArchive(); await P.flushAll();

  assert.deepStrictEqual(archiveDeletes(pool)[0].params[0], [droppedId]);
});

// archiveHunt REPLACES the snapshot with a fresh object when the same hunt is re-ended. If the id
// were regenerated, the old row would be orphaned in Postgres — a duplicate reappearing on the
// next boot, which is exactly what that upsert exists to prevent.
test('archive: re-ending a hunt reuses its row rather than orphaning one', async () => {
  const P = freshModule();
  const pool = fakePool();
  await boot(P, pool);

  P.archiveHunt({ huntId: 'h9', user: { id: 'u9' }, startedAt: 's', bonuses: [{ slot: 'x', win: 5 }] });
  await P.flushAll();
  const firstId = P.archive[0].archiveId;

  P.archiveHunt({ huntId: 'h9', user: { id: 'u9' }, startedAt: 's', bonuses: [{ slot: 'x', win: 99 }] });
  await P.flushAll();

  assert.strictEqual(P.archive.length, 1, 'still one entry in memory');
  assert.strictEqual(P.archive[0].archiveId, firstId, 'the row id must carry across the replacement');
  assert.deepStrictEqual(archiveDeletes(pool), [], 'nothing was orphaned, so nothing to delete');
});

test('archive: every snapshot gets a stable id, even without huntId or user', async () => {
  const P = freshModule();
  const pool = fakePool();
  await boot(P, pool);

  P.archive.push({ bonuses: [] }, { bonuses: [] });   // no huntId, no user, no archivedAt
  P.persistArchive(); await P.flushAll();

  const ids = archiveUpserts(pool)[0].params[0];
  assert.strictEqual(ids.length, 2);
  assert.notStrictEqual(ids[0], ids[1], 'ids must not collide, or two hunts merge into one row');
  assert.ok(ids.every(Boolean), 'a null PK would fail the insert');
});