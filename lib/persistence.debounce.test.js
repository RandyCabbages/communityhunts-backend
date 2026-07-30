// persistHunts() used to do ALL of this synchronously, on every one of its 52 call sites —
// one of which is emitHubUpdate, i.e. every hub broadcast:
//
//   1. an O(hunts × calls) regex dedupe over EVERY hunt, changed or not
//   2. JSON.stringify(hunts)                        → the Postgres write
//   3. JSON.stringify(hunts) a SECOND time          → the file write
//   4. fs.writeFileSync + fs.renameSync             → blocking disk I/O
//
// Steps 1, 3 and 4 all block the single event loop that serves every request and every socket
// packet for every tenant. Cost per call scales with the number of active hunts, and so does the
// call RATE — so total load grows with the SQUARE of concurrency. At 3-4 concurrent hunts it is
// invisible; the platform is heading for 20-30 across five communities, ~50x the serialization.
//
// So persistHunts() now SCHEDULES a coalesced flush and flushHunts() performs it. These tests pin
// the coalescing, the write-through of the final state, and the file-write skip.

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');

const MOD = require.resolve('./persistence');

// A private directory, NOT the repo root. `node --test` runs test files in parallel, and
// persistence.clobber.test.js also creates/removes hunts_data.json — sharing the path makes both
// suites intermittently fail depending on interleaving. initPersistence takes `dataDir` so each
// suite gets its own.
const ROOT = fs.mkdtempSync(path.join(require('os').tmpdir(), 'ch-persist-'));
const HUNTS_FILE = path.join(ROOT, 'hunts_data.json');

function freshModule() {
  delete require.cache[MOD];
  return require('./persistence');
}

// Records every non-SELECT statement it is asked to run.
function fakePool({ writeDelayMs = 0 } = {}) {
  const writes = [];
  return {
    writes,
    query: async (sql, params) => {
      if (/CREATE TABLE/i.test(sql)) return { rows: [] };
      if (/^SELECT/i.test(sql)) return { rows: [] };
      writes.push({ sql, params });
      if (writeDelayMs) await new Promise(r => setTimeout(r, writeDelayMs));
      return { rows: [] };
    },
  };
}

function cleanFiles() {
  for (const f of ['hunts_data.json', 'hunts_archive.json', 'share_tokens.json']) {
    const p = path.join(ROOT, f);
    if (fs.existsSync(p)) fs.rmSync(p);
  }
}

// hunts are written one row per hunt now: params[0] = user ids, params[1] = serialized hunts.
// Decode a batch write back into the { userId: hunt } shape these assertions are written against.
function rowsOf(write) {
  const out = {};
  const ids = write.params[0] || [];
  const blobs = write.params[1] || [];
  ids.forEach((id, i) => { out[id] = JSON.parse(blobs[i]); });
  return out;
}
const boot = async (P, pgPool, extra = {}) => {
  cleanFiles();
  await P.initPersistence({
    pgPool,
    dataDir: ROOT,
    normalizeSlot: (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(),
    huntsFlushMs: 15,
    ...extra,
  });
};

// ── Coalescing ────────────────────────────────────────────────────────────────

test('a burst of persistHunts() calls collapses into ONE Postgres write', async () => {
  const P = freshModule();
  const pool = fakePool();
  await boot(P, pool);

  P.hunts.a = { huntId: 'h1', bonuses: [], equity: [], calls: [] };
  // A call rush across three live communities: today this is 10 full serializations.
  for (let i = 0; i < 10; i++) P.persistHunts();

  await P.flushHunts();

  assert.strictEqual(pool.writes.length, 1, '10 scheduled persists must produce exactly one write');
  assert.match(pool.writes[0].sql, /INSERT INTO hunts_rows/);
});

test('the coalesced write carries the LAST state, not the first', async () => {
  const P = freshModule();
  const pool = fakePool();
  await boot(P, pool);

  P.hunts.a = { huntId: 'first', bonuses: [], equity: [], calls: [] };
  P.persistHunts();
  P.hunts.a.huntId = 'second';
  P.hunts.b = { huntId: 'third', bonuses: [], equity: [], calls: [] };
  P.persistHunts();

  await P.flushHunts();

  assert.strictEqual(pool.writes.length, 1);
  const written = rowsOf(pool.writes[0]);
  assert.strictEqual(written.a.huntId, 'second', 'must persist the newest value, not a stale snapshot');
  assert.strictEqual(written.b.huntId, 'third', 'a hunt added after the first schedule must still land');
});

test('the debounce timer fires on its own, with no explicit flush', async () => {
  const P = freshModule();
  const pool = fakePool();
  await boot(P, pool);

  P.hunts.a = { huntId: 'h1', bonuses: [], equity: [], calls: [] };
  P.persistHunts();
  assert.strictEqual(pool.writes.length, 0, 'the write must not be synchronous any more');

  await new Promise(r => setTimeout(r, 60));   // > huntsFlushMs

  assert.strictEqual(pool.writes.length, 1, 'the scheduled flush must land without anyone calling it');
});

test('a later persistHunts() after a flush schedules a NEW write', async () => {
  const P = freshModule();
  const pool = fakePool();
  await boot(P, pool);

  P.hunts.a = { huntId: 'h1', bonuses: [], equity: [], calls: [] };
  P.persistHunts();
  await P.flushHunts();

  P.hunts.a.huntId = 'h2';
  P.persistHunts();
  await P.flushHunts();

  assert.strictEqual(pool.writes.length, 2, 'the debounce must not latch off after the first flush');
  assert.strictEqual(rowsOf(pool.writes[1]).a.huntId, 'h2');
});

test('flushing with nothing pending writes nothing', async () => {
  const P = freshModule();
  const pool = fakePool();
  await boot(P, pool);

  await P.flushHunts();
  await P.flushHunts();

  assert.deepStrictEqual(pool.writes, [], 'a quiet server must not write the blob on a timer');
});

// ── Introspection (also surfaced on /api/health) ───────────────────────────────

test('pgHealth reports whether a flush is still pending', async () => {
  const P = freshModule();
  const pool = fakePool();
  await boot(P, pool);

  assert.strictEqual(P.pgHealth().huntsFlushPending, false, 'nothing scheduled yet');

  P.hunts.a = { huntId: 'h1', bonuses: [], equity: [], calls: [] };
  P.persistHunts();
  assert.strictEqual(P.pgHealth().huntsFlushPending, true, 'a scheduled write is unflushed state');

  await P.flushHunts();
  assert.strictEqual(P.pgHealth().huntsFlushPending, false, 'flushing clears it');
});

// ── The redundant file write ───────────────────────────────────────────────────

test('a healthy Postgres write skips the blocking file write', async () => {
  const P = freshModule();
  const pool = fakePool();
  await boot(P, pool);

  P.hunts.a = { huntId: 'h1', bonuses: [], equity: [], calls: [] };
  P.persistHunts();
  await P.flushHunts();

  assert.strictEqual(pool.writes.length, 1, 'Postgres still gets the write');
  assert.strictEqual(fs.existsSync(HUNTS_FILE), false,
    'the file is a fallback for when Postgres is not the store — writing it costs a blocking ' +
    'fs.writeFileSync on the hot path and, on Railway, lands on an ephemeral disk nobody reads');
});

test('with NO Postgres the file is still written every flush', async () => {
  const P = freshModule();
  await boot(P, null);

  P.hunts.a = { huntId: 'local-dev', bonuses: [], equity: [], calls: [] };
  P.persistHunts();
  await P.flushHunts();

  assert.ok(fs.existsSync(HUNTS_FILE), 'with no DATABASE_URL the file IS the durable store');
  assert.strictEqual(JSON.parse(fs.readFileSync(HUNTS_FILE, 'utf8')).a.huntId, 'local-dev');
  cleanFiles();
});

test('when Postgres writes are BLOCKED the file is still written', async () => {
  const P = freshModule();
  // SELECTs throw → clobber guard blocks PG writes → the file is the only record we can keep.
  const pool = {
    writes: [],
    query: async (sql, params) => {
      if (/CREATE TABLE/i.test(sql)) return { rows: [] };
      if (/^SELECT/i.test(sql)) throw new Error('connection terminated unexpectedly');
      pool.writes.push({ sql, params });
      return { rows: [] };
    },
  };
  await boot(P, pool);
  assert.strictEqual(P.pgHealth().pgWritesBlocked, true, 'precondition');

  P.hunts.a = { huntId: 'degraded', bonuses: [], equity: [], calls: [] };
  P.persistHunts();
  await P.flushHunts();

  assert.deepStrictEqual(pool.writes, [], 'the clobber guard still holds');
  assert.ok(fs.existsSync(HUNTS_FILE), 'a degraded boot must still leave a local record');
  cleanFiles();
});

// ── Behaviour that must NOT change ─────────────────────────────────────────────

test('call arrays are still deduped before the row is written', async () => {
  const P = freshModule();
  const pool = fakePool();
  await boot(P, pool);

  P.hunts.a = {
    huntId: 'h1', bonuses: [], equity: [],
    calls: [{ slot: 'Gates of Olympus' }, { slot: 'gates-of-olympus' }, { slot: 'Razor Shark' }],
  };
  P.persistHunts();
  await P.flushHunts();

  const written = rowsOf(pool.writes[0]);
  assert.strictEqual(written.a.calls.length, 2, 'the duplicate slot must still be dropped');
  assert.deepStrictEqual(written.a.calls.map(c => c.slot), ['Gates of Olympus', 'Razor Shark']);
  assert.strictEqual(P.hunts.a.calls.length, 2, 'and the in-memory hunt is deduped too');
});

test('dedupe replaces the calls array rather than mutating it in place', async () => {
  // archiveHunt takes a SHALLOW copy, so a live hunt and its archived snapshot share the same
  // `calls` array object. Reassigning (h.calls = filter(...)) detaches them; splicing in place
  // would silently rewrite history. Pinned so nobody "optimises" the filter into a splice.
  const P = freshModule();
  const pool = fakePool();
  await boot(P, pool);

  const shared = [{ slot: 'Gates of Olympus' }, { slot: 'gates of olympus' }];
  P.hunts.a = { huntId: 'h1', bonuses: [], equity: [], calls: shared };
  P.persistHunts();
  await P.flushHunts();

  assert.strictEqual(shared.length, 2, 'the original array object must be left untouched');
  assert.notStrictEqual(P.hunts.a.calls, shared, 'the hunt must point at a NEW array');
});

test('an untimestamped call is stamped with `ts` on the way to the row', async () => {
  // The public API exposes this as `calls[].at`, and it was null on EVERY row of every hunt: only
  // lib/huntCalls.js stamped a call, and that covers the public board and the Discord bot, not the
  // host's own calls — which are minted client-side and arrive as a whole array on the next PUT.
  // Stamped here rather than at the six route handlers that assign h.calls, so a seventh can't
  // silently miss it.
  const P = freshModule();
  const pool = fakePool();
  await boot(P, pool);

  const before = Date.now();
  P.hunts.a = { huntId: 'h1', bonuses: [], equity: [],
    calls: [{ id: 'c1', slot: 'Le Bandit' }, { id: 'c2', slot: 'Razor Shark', ts: 1234 }] };
  P.persistHunts();
  await P.flushHunts();

  const written = rowsOf(pool.writes[0]).a.calls;
  assert.ok(written[0].ts >= before, 'an untimestamped call gets one');
  assert.strictEqual(written[1].ts, 1234, 'an existing timestamp is never rewritten');
});

test('stamping does not re-fire on every flush once a call is timestamped', async () => {
  // A `ts` that moved on each flush would make the content diff see a change forever, so every
  // hunt would rewrite its row on every flush — exactly the write amplification the row split
  // exists to remove.
  const P = freshModule();
  const pool = fakePool();
  await boot(P, pool);

  P.hunts.a = { huntId: 'h1', bonuses: [], equity: [], calls: [{ id: 'c1', slot: 'Le Bandit' }] };
  P.persistHunts();
  await P.flushHunts();
  const stamped = P.hunts.a.calls[0].ts;

  P.persistHunts();
  await P.flushHunts();
  assert.strictEqual(P.hunts.a.calls[0].ts, stamped, 'the stamp must be written once and stay put');
  assert.strictEqual(pool.writes.length, 1, 'an unchanged hunt must not write again');
});

// ── Shutdown ───────────────────────────────────────────────────────────────────

test('flushAll() resolves only after the pending Postgres write settles', async () => {
  const P = freshModule();
  const pool = fakePool({ writeDelayMs: 30 });
  await boot(P, pool);

  P.hunts.a = { huntId: 'h1', bonuses: [], equity: [], calls: [] };
  P.persistHunts();

  let settled = false;
  const done = P.flushAll().then(() => { settled = true; });
  assert.strictEqual(settled, false, 'must not resolve before the write completes');

  await done;
  assert.strictEqual(settled, true);
  assert.strictEqual(pool.writes.length, 1, 'SIGTERM must not lose the debounced write');
});

test('flushAll() also waits for an in-flight archive write', async () => {
  // persistArchive is NOT debounced (a hunt ending is rare, unlike a hub broadcast), but its
  // Postgres write is still fire-and-forget — so shutdown has to wait for it too.
  const P = freshModule();
  const pool = fakePool({ writeDelayMs: 30 });
  await boot(P, pool);

  P.archive.push({ huntId: 'h1', user: { id: 'u1' }, bonuses: [{ slot: 's' }] });
  P.persistArchive();

  await P.flushAll();

  const archiveWrites = pool.writes.filter(w => /INSERT INTO archive_rows/.test(w.sql));
  assert.strictEqual(archiveWrites.length, 1, 'the archive write must have settled before shutdown');
});

test('flushAll() gives up after timeoutMs when Postgres never answers', async () => {
  // Adding a SIGTERM listener OVERRIDES Node's default exit. If the flush can hang, every deploy
  // stalls until Railway force-kills the container. Shutdown must be bounded.
  const P = freshModule();
  const pool = {
    query: async (sql) => {
      if (/CREATE TABLE/i.test(sql)) return { rows: [] };
      if (/^SELECT/i.test(sql)) return { rows: [] };
      await new Promise(() => {});           // a write that never settles
    },
  };
  await boot(P, pool);

  P.hunts.a = { huntId: 'h1', bonuses: [], equity: [], calls: [] };
  P.persistHunts();

  const started = Date.now();
  await P.flushAll({ timeoutMs: 40 });
  assert.ok(Date.now() - started < 1000, 'shutdown must not block on a dead database');
});

test('flushAll() survives a Postgres write that rejects', async () => {
  const P = freshModule();
  const pool = {
    query: async (sql) => {
      if (/CREATE TABLE/i.test(sql)) return { rows: [] };
      if (/^SELECT/i.test(sql)) return { rows: [] };
      throw new Error('Connection terminated unexpectedly');
    },
  };
  await boot(P, pool);

  P.hunts.a = { huntId: 'h1', bonuses: [], equity: [], calls: [] };
  P.persistHunts();

  await P.flushAll();   // must resolve, not reject — shutdown cannot hang on a dead database
  assert.strictEqual(P.pgHealth().pgLastWriteOk, false, 'and the failure is still reported');
  cleanFiles();
});
