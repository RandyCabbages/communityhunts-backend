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
