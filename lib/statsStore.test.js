// lib/statsStore.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const makeStatsStore = require('./statsStore');

const store = makeStatsStore({ pgPool: null, fxRates: null });

test('huntKey prefers huntId, falls back to user|startedAt', () => {
  assert.strictEqual(store.huntKey({ huntId: 'H1' }), 'H1');
  assert.strictEqual(store.huntKey({ user: { id: 'u' }, startedAt: 'T0' }), 'u|T0');
});

test('participantsOf returns host + equity members, deduped, host wins', () => {
  const p = store.participantsOf({
    user: { id: 'u1' },
    equity: [{ id: 'u1', amount: 50 }, { id: 'u2', amount: 50 }, { id: '', amount: 0 }],
  });
  const map = Object.fromEntries(p.map(x => [x.userId, x.role]));
  assert.strictEqual(map.u1, 'host');   // host role wins over its equity row
  assert.strictEqual(map.u2, 'member');
  assert.strictEqual(p.length, 2);      // empty id dropped
});

function fakePool() {
  const calls = [];
  const historyRows = [];
  const pool = {
    calls, historyRows,
    query: async (sql, params = []) => {
      calls.push({ sql, params });
      if (/INSERT INTO hunt_history/i.test(sql)) {
        historyRows.push({ hunt_key: params[0], tenant_id: params[1], snapshot: params[7] });
        return { rows: [] };
      }
      if (/SELECT .*snapshot.* FROM hunt_history/i.test(sql)) {
        // params: [tenantId, userId] — return snapshots for that user
        return { rows: historyRows.map(r => ({ snapshot: r.snapshot })) };
      }
      return { rows: [] };
    },
  };
  // Transaction client shares the same query handler so BEGIN/COMMIT and all writes
  // land in pool.calls (keeps every existing assertion working).
  pool.connect = async () => ({ query: pool.query, release() {} });
  return pool;
}

test('recordHunt upserts history keyed by huntKey and recomputes participants', async () => {
  const pool = fakePool();
  const fxRates = { ensureTable: async () => {}, getUsdRate: async () => 1 };
  const store = makeStatsStore({ pgPool: pool, fxRates });
  await store.recordHunt({
    huntId: 'H1', tenantId: 'bean', user: { id: 'u1' }, startedAt: 'T0',
    archivedAt: '2026-07-01T00:00:00Z', currency: 'USD',
    equity: [{ id: 'u1', amount: 100 }],
    bonuses: [{ slot: 'A', bet: 10, win: 40, mult: 4 }],
  });
  const ins = pool.calls.find(c => /INSERT INTO hunt_history/i.test(c.sql));
  assert.strictEqual(ins.params[0], 'H1');                                  // hunt_key
  assert.ok(pool.calls.some(c => /ON CONFLICT \(hunt_key\)/i.test(c.sql))); // idempotent upsert
  const roll = pool.calls.find(c => /INSERT INTO user_hunt_stats/i.test(c.sql));
  assert.ok(roll, 'rollup upserted');
  assert.strictEqual(roll.params[2], 1);        // hunts
  assert.strictEqual(roll.params[3], 1);        // hosted
  assert.strictEqual(roll.params[4], 0);        // joined
  assert.strictEqual(roll.params[5], 10);       // wagered_usd
  assert.strictEqual(roll.params[6], 40);       // won_usd
  assert.strictEqual(roll.params[7], -60);      // net_usd
  assert.strictEqual(roll.params[10], 4);       // avg_x
  assert.strictEqual(roll.params[11], 40);      // biggest_win
  assert.strictEqual(roll.params[16], 1);       // longest_loss_streak
  assert.strictEqual(pool.historyRows[0].snapshot.usdRate, 1);             // rate carried into snapshot
});

test('recordHunt with null FX rate still records (unconverted)', async () => {
  const pool = fakePool();
  const fxRates = { ensureTable: async () => {}, getUsdRate: async () => null };
  const store = makeStatsStore({ pgPool: pool, fxRates });
  await store.recordHunt({
    huntId: 'H2', tenantId: 'bean', user: { id: 'u1' }, startedAt: 'T0',
    archivedAt: '2026-07-01T00:00:00Z', currency: 'GBP',
    equity: [{ id: 'u1', amount: 100 }], bonuses: [{ slot: 'A', bet: 10, win: 40, mult: 4 }],
  });
  assert.strictEqual(pool.historyRows[0].snapshot.usdRate, null);
});

test('getUserStats returns rollup row when present', async () => {
  const pool = {
    calls: [],
    query: async (sql, params = []) => {
      pool.calls.push({ sql, params });
      if (/SELECT stats FROM user_hunt_stats/i.test(sql)) return { rows: [{ stats: { tiles: { hunts: 3 } } }] };
      return { rows: [] };
    },
  };
  const store = makeStatsStore({ pgPool: pool, fxRates: null });
  const s = await store.getUserStats('bean', 'u1');
  assert.strictEqual(s.tiles.hunts, 3);
});

test('getUserStats falls back to recompute when row missing', async () => {
  let selectCount = 0;
  const pool = {
    query: async (sql) => {
      if (/SELECT stats FROM user_hunt_stats/i.test(sql)) {
        selectCount++;
        return selectCount === 1 ? { rows: [] } : { rows: [{ stats: { tiles: { hunts: 0 } } }] };
      }
      if (/FROM hunt_history/i.test(sql)) return { rows: [] };     // recomputeUser reads no hunts
      return { rows: [] };
    },
  };
  const store = makeStatsStore({ pgPool: pool, fxRates: null });
  const s = await store.getUserStats('bean', 'ghost');
  assert.ok(s);                        // recomputed then re-read
  assert.strictEqual(selectCount, 2);  // missed, then hit
});
