// Guards the "one PG hiccup at boot wipes every live hunt" data-loss path.
//
// Postgres is the durable store. The JSON files are a dev fallback and, on Railway, live on an
// ephemeral disk that is EMPTY after every redeploy. So when the boot-time SELECT failed, the old
// code fell back to a file that does not exist in production, started with hunts = {}, and the
// next persistHunts() upserted that empty object over the row holding every live hunt.
//
// Each test re-requires the module fresh because the guard state is module-level.

const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');

const MOD = require.resolve('./persistence');

function freshModule() {
  delete require.cache[MOD];
  return require('./persistence');
}

// A pgPool stub whose SELECTs either work or throw, recording every write it is asked to make.
function fakePool({ selectThrows = false, rows = {} } = {}) {
  const writes = [];
  return {
    writes,
    query: async (sql, params) => {
      if (/CREATE TABLE/i.test(sql)) return { rows: [] };
      if (/^SELECT/i.test(sql)) {
        if (selectThrows) throw new Error('connection terminated unexpectedly');
        const key = (sql.match(/key='(\w+)'/) || [])[1];
        return { rows: rows[key] ? [{ value: rows[key] }] : [] };
      }
      writes.push({ sql, params });
      return { rows: [] };
    },
  };
}

beforeEach(() => {
  // Keep the fallback files out of the picture; we only care about PG behaviour here.
  for (const f of ['hunts_data.json', 'hunts_archive.json', 'share_tokens.json']) {
    const p = path.join(__dirname, '..', f);
    if (fs.existsSync(p)) fs.rmSync(p);
  }
});

test('a failed boot read BLOCKS Postgres writes instead of clobbering the row', async () => {
  const P = freshModule();
  const pool = fakePool({ selectThrows: true });

  await P.initPersistence({ pgPool: pool, normalizeSlot: (s) => String(s || '').toLowerCase() });

  assert.strictEqual(P.pgHealth().pgReadOk, false);
  assert.strictEqual(P.pgHealth().pgWritesBlocked, true, 'writes must be blocked after a failed read');

  // Simulate the app doing what it always does after boot.
  P.hunts['someone'] = { huntId: 'h1', bonuses: [], equity: [], calls: [] };
  P.persistHunts();
  P.persistArchive();
  P.persistShareTokens();

  assert.deepStrictEqual(pool.writes, [], 'NOTHING may be written to PG while state is not authoritative');
});

test('a successful boot read on an EMPTY database still allows writes', async () => {
  const P = freshModule();
  const pool = fakePool({ rows: {} }); // valid first boot: no rows yet

  await P.initPersistence({ pgPool: pool, normalizeSlot: (s) => String(s || '').toLowerCase() });

  assert.strictEqual(P.pgHealth().pgReadOk, true);
  assert.strictEqual(P.pgHealth().pgWritesBlocked, false,
    'an empty table is a legitimate state — blocking here would break every fresh deploy');

  P.hunts['someone'] = { huntId: 'h1', bonuses: [], equity: [], calls: [] };
  P.persistHunts();

  assert.strictEqual(pool.writes.length, 1);
  assert.match(pool.writes[0].sql, /INSERT INTO hunts_kv/);
  assert.match(pool.writes[0].params[0], /"huntId":"h1"/);
});

test('a successful boot read WITH existing rows loads them and allows writes', async () => {
  const P = freshModule();
  const pool = fakePool({ rows: { hunts: { alice: { huntId: 'existing' } } } });

  await P.initPersistence({ pgPool: pool, normalizeSlot: (s) => String(s || '').toLowerCase() });

  assert.strictEqual(P.pgHealth().pgWritesBlocked, false);
  assert.strictEqual(P.hunts.alice.huntId, 'existing');
});

test('file writes are atomic: valid JSON on disk and no leftover temp files', async () => {
  const P = freshModule();
  await P.initPersistence({ pgPool: null, normalizeSlot: (s) => String(s || '').toLowerCase() });

  P.hunts['someone'] = { huntId: 'h-atomic', bonuses: [], equity: [], calls: [] };
  P.persistHunts();

  const root = path.join(__dirname, '..');
  const file = path.join(root, 'hunts_data.json');
  assert.ok(fs.existsSync(file), 'hunts file should exist');

  // Parses cleanly — a truncated write is exactly what breaks the next boot.
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.strictEqual(parsed.someone.huntId, 'h-atomic');

  const strays = fs.readdirSync(root).filter(f => f.startsWith('hunts_data.json.') && f.endsWith('.tmp'));
  assert.deepStrictEqual(strays, [], 'temp file must be renamed away, not left behind');

  fs.rmSync(file);
});

// ── Runtime liveness (separate from the boot-read clobber guard) ────────────────
// The guard answers "was state authoritative at startup". It said "ok" forever after Postgres
// died mid-flight, because nothing re-examined the connection — the durable store was gone and
// health reported fine. These pin the write-outcome liveness signal.

test('a healthy write reports pgLastWriteOk true', async () => {
  const P = freshModule();
  const pool = fakePool();
  await P.initPersistence({ pgPool: pool, normalizeSlot: (s) => String(s || '').toLowerCase() });

  P.hunts['x'] = { huntId: 'h', bonuses: [], equity: [], calls: [] };
  P.persistHunts();
  await new Promise(r => setImmediate(r));         // let the write promise settle

  assert.strictEqual(P.pgHealth().pgLastWriteOk, true);
});

test('a write that fails AFTER a good boot flips liveness to false', async () => {
  const P = freshModule();
  // Reads succeed (so the clobber guard stays open), then writes start failing — exactly what
  // happens when Postgres goes away while the process keeps running.
  const pool = {
    query: async (sql) => {
      if (/CREATE TABLE/i.test(sql)) return { rows: [] };
      if (/^SELECT/i.test(sql)) return { rows: [] };
      throw new Error('Connection terminated unexpectedly');
    },
  };
  await P.initPersistence({ pgPool: pool, normalizeSlot: (s) => String(s || '').toLowerCase() });

  assert.strictEqual(P.pgHealth().pgWritesBlocked, false, 'boot read was fine, so writes stay allowed');
  assert.strictEqual(P.pgHealth().pgLastWriteOk, null, 'nothing written yet');

  P.hunts['x'] = { huntId: 'h', bonuses: [], equity: [], calls: [] };
  P.persistHunts();
  await new Promise(r => setImmediate(r));

  const h = P.pgHealth();
  assert.strictEqual(h.pgLastWriteOk, false, 'the failed write must be visible');
  assert.match(h.pgLastErrorMsg, /Connection terminated/);
  assert.ok(h.pgLastErrorAt > 0);
});

test('no write yet is null, NOT a failure', async () => {
  const P = freshModule();
  await P.initPersistence({ pgPool: fakePool(), normalizeSlot: (s) => String(s || '').toLowerCase() });
  assert.strictEqual(P.pgHealth().pgLastWriteOk, null,
    'a quiet server that has not written must not look unhealthy');
});
