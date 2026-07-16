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

// priorParticipants: opt-in seed for the stored `SELECT user_id FROM hunt_participants`
// read (defaults to [] so existing tests keep seeing {rows:[]}).
function fakePool(priorParticipants = [], knownUsers = []) {
  const calls = [];
  const historyRows = [];
  const pool = {
    calls, historyRows,
    query: async (sql, params = []) => {
      calls.push({ sql, params });
      if (/FROM known_users/i.test(sql)) {
        // Name index source — default [] means no name resolution (existing tests unchanged).
        return { rows: knownUsers };
      }
      if (/INSERT INTO hunt_history/i.test(sql)) {
        historyRows.push({ hunt_key: params[0], tenant_id: params[1], snapshot: params[7] });
        return { rows: [] };
      }
      if (/SELECT user_id FROM hunt_participants/i.test(sql)) {
        // The union read done inside recordHunt/removeHunt — return the seeded prior set.
        return { rows: priorParticipants.map(user_id => ({ user_id })) };
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

test('recordHunt uses an explicit usdRate override and marks the snapshot approx', async () => {
  const pool = fakePool();
  const fxRates = { ensureTable: async () => {}, getUsdRate: async () => 999 }; // would be used if no override
  const store = makeStatsStore({ pgPool: pool, fxRates });
  await store.recordHunt({
    huntId: 'H1', tenantId: 'bean', user: { id: 'u1' }, startedAt: 'T0',
    archivedAt: '2026-07-01T00:00:00Z', currency: 'ARS',
    equity: [{ id: 'u1', amount: 100 }], bonuses: [{ slot: 'A', bet: 10, win: 40, mult: 4 }],
  }, { usdRate: 0.001 });
  const snap = pool.historyRows[0].snapshot;
  assert.strictEqual(snap.usdRate, 0.001); // override used, NOT the fx 999
  assert.strictEqual(snap.approx, true);   // admin-supplied rate flagged approximate
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

test('recordHunt unions stored prior participants so a dropped member is recomputed', async () => {
  // Prior stored participant 'old_member' is NOT in the new hunt's participants.
  const pool = fakePool(['old_member']);
  const fxRates = { ensureTable: async () => {}, getUsdRate: async () => 1 };
  const store = makeStatsStore({ pgPool: pool, fxRates });
  await store.recordHunt({
    huntId: 'H1', tenantId: 'bean', user: { id: 'u1' }, startedAt: 'T0',
    archivedAt: '2026-07-01T00:00:00Z', currency: 'USD',
    equity: [{ id: 'u1', amount: 100 }],   // only u1 now; old_member was dropped
    bonuses: [{ slot: 'A', bet: 10, win: 40, mult: 4 }],
  });
  // recomputeUser ran for the dropped member => its recompute SELECT appears in calls.
  const recomputedOld = pool.calls.some(c =>
    /SELECT .*snapshot.* FROM hunt_history/i.test(c.sql) && c.params[1] === 'old_member');
  assert.ok(recomputedOld, 'dropped old_member should be recomputed via the union');
  // And the surviving member u1 is recomputed too.
  assert.ok(pool.calls.some(c =>
    /SELECT .*snapshot.* FROM hunt_history/i.test(c.sql) && c.params[1] === 'u1'),
    'surviving u1 should also be recomputed');
});

test('correctHuntCurrency relabels currency, re-stamps override rate, marks approx', async () => {
  const pool = fakePool();
  const fxRates = { ensureTable: async () => {}, getUsdRate: async () => 1 };
  const store = makeStatsStore({ pgPool: pool, fxRates });
  await store.recordHunt({
    huntId: 'H1', tenantId: 'bean', user: { id: 'u1' }, startedAt: 'T0',
    archivedAt: '2026-07-01T00:00:00Z', currency: 'USD',
    equity: [{ id: 'u1', amount: 100 }], bonuses: [{ slot: 'A', bet: 10, win: 40, mult: 4 }],
  });
  const res = await store.correctHuntCurrency('bean', 'H1', { currency: 'ARS', usdRate: 0.001 });
  assert.deepStrictEqual(res, { ok: true });
  const inserts = pool.calls.filter(c => /INSERT INTO hunt_history/i.test(c.sql));
  const last = inserts[inserts.length - 1];
  assert.strictEqual(last.params[3], 'ARS');         // currency relabeled
  assert.strictEqual(last.params[4], 0.001);         // override rate persisted to the row
  assert.strictEqual(last.params[7].usdRate, 0.001); // ...and into the snapshot
  assert.strictEqual(last.params[7].approx, true);   // flagged approximate
});

test('correctHuntCurrency without an override auto-fetches the rate for the new currency', async () => {
  const pool = fakePool();
  let askedFor = null;
  const fxRates = { ensureTable: async () => {}, getUsdRate: async (cur) => { askedFor = cur; return 0.0011; } };
  const store = makeStatsStore({ pgPool: pool, fxRates });
  await store.recordHunt({
    huntId: 'H1', tenantId: 'bean', user: { id: 'u1' }, startedAt: 'T0',
    archivedAt: '2026-07-01T00:00:00Z', currency: 'USD',
    equity: [{ id: 'u1', amount: 100 }], bonuses: [{ slot: 'A', bet: 10, win: 40, mult: 4 }],
  });
  askedFor = null; // ignore the fetch done during the seed record
  await store.correctHuntCurrency('bean', 'H1', { currency: 'ARS' });
  assert.strictEqual(askedFor, 'ARS');
  const inserts = pool.calls.filter(c => /INSERT INTO hunt_history/i.test(c.sql));
  assert.strictEqual(inserts[inserts.length - 1].params[4], 0.0011);
});

test('correctHuntCurrency returns notFound when the key is absent', async () => {
  const pool = fakePool(); // no history seeded
  const store = makeStatsStore({ pgPool: pool, fxRates: { ensureTable: async () => {}, getUsdRate: async () => 1 } });
  const res = await store.correctHuntCurrency('bean', 'NOPE', { currency: 'ARS' });
  assert.deepStrictEqual(res, { notFound: true });
});

test('removeHunt deletes history + participants and recomputes affected in a transaction', async () => {
  const pool = fakePool(['u1']);   // hunt currently has u1 stored as a participant
  const store = makeStatsStore({ pgPool: pool, fxRates: null });
  await store.removeHunt({
    huntId: 'H1', tenantId: 'bean', user: { id: 'u1' },
    equity: [{ id: 'u1', amount: 100 }],
  });
  const beginIdx = pool.calls.findIndex(c => /^\s*BEGIN\s*$/i.test(c.sql));
  const commitIdx = pool.calls.findIndex(c => /^\s*COMMIT\s*$/i.test(c.sql));
  assert.ok(beginIdx >= 0, 'BEGIN issued');
  assert.ok(commitIdx > beginIdx, 'COMMIT issued after BEGIN');
  const delHistory = pool.calls.find(c => /DELETE FROM hunt_history WHERE hunt_key=\$1/i.test(c.sql));
  const delParts = pool.calls.find(c => /DELETE FROM hunt_participants WHERE hunt_key=\$1/i.test(c.sql));
  assert.ok(delHistory && delHistory.params[0] === 'H1', 'hunt_history deleted for the key');
  assert.ok(delParts && delParts.params[0] === 'H1', 'hunt_participants deleted for the key');
  // Affected participant (u1, from the union) recomputed.
  assert.ok(pool.calls.some(c =>
    /SELECT .*snapshot.* FROM hunt_history/i.test(c.sql) && c.params[1] === 'u1'),
    'affected u1 recomputed on removal');
});

test('deleteHuntByKey removes the hunt and recomputes stored participants', async () => {
  const pool = fakePool(['u1']); // u1 stored as a participant of the key
  const store = makeStatsStore({ pgPool: pool, fxRates: null });
  const res = await store.deleteHuntByKey('bean', 'H1');
  assert.deepStrictEqual(res, { ok: true });
  assert.ok(pool.calls.some(c => /DELETE FROM hunt_history WHERE hunt_key=\$1/i.test(c.sql) && c.params[0] === 'H1'));
  assert.ok(pool.calls.some(c => /DELETE FROM hunt_participants WHERE hunt_key=\$1/i.test(c.sql) && c.params[0] === 'H1'));
  assert.ok(pool.calls.some(c => /SELECT .*snapshot.* FROM hunt_history/i.test(c.sql) && c.params[1] === 'u1'));
  const beginIdx = pool.calls.findIndex(c => /^\s*BEGIN\s*$/i.test(c.sql));
  const commitIdx = pool.calls.findIndex(c => /^\s*COMMIT\s*$/i.test(c.sql));
  assert.ok(beginIdx >= 0 && commitIdx > beginIdx, 'wrapped in a transaction');
});

test('recordHunt stamps equity discordId by name and adds the joined member as a participant', async () => {
  // known_users maps display name "Joiner" -> a real Discord snowflake. The id MUST be snowflake-
  // shaped: getNameIndex skips anything isRealDiscordId() rejects, so a toy id like "u2" would be
  // dropped from the index here and the name would never resolve.
  const JOINER_ID = '222222222222222222';
  const pool = fakePool([], [{ user_id: JOINER_ID, display_name: 'Joiner', username: null }]);
  const fxRates = { ensureTable: async () => {}, getUsdRate: async () => 1 };
  const store = makeStatsStore({ pgPool: pool, fxRates });
  await store.recordHunt({
    huntId: 'H9', tenantId: 'bean', user: { id: 'host1' }, startedAt: 'T0',
    archivedAt: '2026-07-01T00:00:00Z', currency: 'USD',
    // equity row for the joiner carries only a per-row UUID + name (no discordId) — the pre-fix
    // data shape that made "joined" attribution silently fail.
    equity: [
      { id: '11111111-1111-4111-8111-111111111111', name: 'Host', amount: 100 },
      { id: '22222222-2222-4222-8222-222222222222', name: 'Joiner', amount: 100 },
    ],
    bonuses: [{ slot: 'A', bet: 10, win: 300, mult: 30 }],
  });
  // The joiner (resolved by name) is inserted as a member participant...
  const partJoiner = pool.calls.find(c =>
    /INSERT INTO hunt_participants/i.test(c.sql) && c.params[2] === JOINER_ID && c.params[3] === 'member');
  assert.ok(partJoiner, 'name-matched joiner added as a member participant');
  // ...the raw UUID row id is NOT used as a participant...
  assert.ok(!pool.calls.some(c =>
    /INSERT INTO hunt_participants/i.test(c.sql) && /^2{8}-/.test(String(c.params[2]))),
    'the per-row UUID is never treated as a user id');
  // ...and the stored snapshot has discordId stamped onto the joiner's equity row.
  const joiner = pool.historyRows[0].snapshot.equity.find(e => e.name === 'Joiner');
  assert.strictEqual(joiner.discordId, JOINER_ID);
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
