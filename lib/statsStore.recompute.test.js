// recordHunt held the per-user rollup recompute INSIDE its transaction:
//
//   for (const uid of affected) await recomputeUser(tenantId, uid, client);
//   await client.query('COMMIT');
//
// recomputeUser reads EVERY snapshot that user has ever participated in (full JSONB, ~16 kB each,
// max 50 kB measured), recomputes all-time stats in JS, and writes back a ~17 kB rollup. So the
// transaction's cost is O(participants × their lifetime hunts × snapshot size), serially, on one
// pooled connection. Worst case measured on the live database 2026-07-27: 711 snapshots ≈ 11 MB
// read for a single archive, with avg 2.7 participants/hunt and a max of 27.
//
// It scales as (hunts per tenant) × (regulars): a tenant at 2,000 hunts with 15 regulars averaging
// 400 hunts each is ~6,000 snapshot rows ≈ 96 MB per archive, holding a write transaction open the
// whole time — and idle_in_transaction_session_timeout was 0, so nothing reaped it.
//
// The rollups are DERIVED data. They do not belong in the transaction that makes the hunt durable.

const { test } = require('node:test');
const assert = require('node:assert');
const makeStatsStore = require('./statsStore');

function fakePool({ recomputeThrows = false, priorParticipants = [] } = {}) {
  const calls = [];
  const query = async (sql, params) => {
    calls.push({ sql: String(sql).replace(/\s+/g, ' ').trim(), params });
    if (/CREATE TABLE|CREATE INDEX|ALTER TABLE/i.test(sql)) return { rows: [] };
    if (/SELECT user_id FROM hunt_participants/i.test(sql)) {
      return { rows: priorParticipants.map(user_id => ({ user_id })) };
    }
    if (/SELECT .*snapshot.* FROM hunt_history/i.test(sql)) {
      if (recomputeThrows) throw new Error('recompute read failed');
      return { rows: [] };
    }
    return { rows: [] };
  };
  const pool = { calls, query };
  pool.connect = async () => ({ query, release() {} });
  return pool;
}

const HUNT = {
  huntId: 'H1', tenantId: 'bean', user: { id: 'u1' }, startedAt: 'T0',
  archivedAt: '2026-07-01T00:00:00Z', currency: 'USD',
  equity: [{ id: 'u1', amount: 100 }, { id: 'u2', amount: 50 }],
  bonuses: [{ slot: 'A', bet: 10, win: 40, mult: 4 }],
};
const fx = { ensureTable: async () => {}, getUsdRate: async () => 1 };
const idx = (calls, re) => calls.findIndex(c => re.test(c.sql));

test('the rollup recompute happens AFTER COMMIT, not inside the transaction', async () => {
  const pool = fakePool();
  await makeStatsStore({ pgPool: pool, fxRates: fx }).recordHunt(HUNT);

  const commit = idx(pool.calls, /^COMMIT$/i);
  const rollup = idx(pool.calls, /INSERT INTO user_hunt_stats/i);
  assert.ok(commit >= 0, 'the hunt write still commits');
  assert.ok(rollup >= 0, 'the rollup still happens');
  assert.ok(rollup > commit,
    'a derived rollup must not extend the transaction that makes the hunt durable');
});

test('nothing between BEGIN and COMMIT except the hunt writes', async () => {
  const pool = fakePool();
  await makeStatsStore({ pgPool: pool, fxRates: fx }).recordHunt(HUNT);

  const begin = idx(pool.calls, /^BEGIN$/i);
  const commit = idx(pool.calls, /^COMMIT$/i);
  const inTxn = pool.calls.slice(begin + 1, commit);
  assert.ok(!inTxn.some(c => /FROM hunt_history h/i.test(c.sql)),
    'the expensive all-snapshots read must be outside the transaction');
  assert.ok(!inTxn.some(c => /INSERT INTO user_hunt_stats/i.test(c.sql)));
  assert.ok(inTxn.some(c => /INSERT INTO hunt_history/i.test(c.sql)), 'the hunt itself still goes in it');
});

// The whole point: making the hunt durable must not depend on derived stats succeeding.
test('a failing recompute does NOT lose the hunt', async () => {
  const pool = fakePool({ recomputeThrows: true });
  const store = makeStatsStore({ pgPool: pool, fxRates: fx });

  await store.recordHunt(HUNT);   // must not throw

  assert.ok(pool.calls.some(c => /INSERT INTO hunt_history/i.test(c.sql)), 'hunt written');
  assert.ok(pool.calls.some(c => /^COMMIT$/i.test(c.sql)), 'and committed');
  assert.ok(!pool.calls.some(c => /^ROLLBACK$/i.test(c.sql)),
    'a derived-stats failure must never roll back the durable hunt row');
});

test('every affected user is still recomputed, including one dropped from equity', async () => {
  const pool = fakePool({ priorParticipants: ['u9'] });   // u9 was in the hunt before, not now
  await makeStatsStore({ pgPool: pool, fxRates: fx }).recordHunt(HUNT);

  const rollups = pool.calls.filter(c => /INSERT INTO user_hunt_stats/i.test(c.sql));
  const users = rollups.map(c => c.params[1]).sort();
  assert.deepStrictEqual(users, ['u1', 'u2', 'u9'],
    'the union of old and new participants must all be refreshed');
});

test('a hunt with no pgPool is still a no-op', async () => {
  const store = makeStatsStore({ pgPool: null, fxRates: null });
  await store.recordHunt(HUNT);   // must not throw
});
