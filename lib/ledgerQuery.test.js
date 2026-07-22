const { test } = require('node:test');
const assert = require('node:assert');
const { projectSlice, canResolveHunt, MOD_HUNT_KEYS } = require('./ledgerQuery');

const row = () => ({
  hunt_key: 'h1',
  ended_at: '2026-07-18T00:00:00.000Z',
  currency: 'USD',
  host_user_id: '135203806676779008',
  snapshot: {
    user: { id: '135203806676779008', displayName: 'Cabbage' },
    equity: [{ id: 'e1', name: 'Goofer', amount: 10, discordId: '168055630916091904' }],
    gifts: [{ type: 'equity', amount: 5, funderId: 'e1' }],
    bonuses: [{ win: 10 }, { win: 2 }, { win: null }],
    vault: [{ amount: 3 }],
    payouts: { e1: { status: 'paid', amount: 6, at: 1, by: 'x', note: '' } },
    editors: ['someone'],
    calls: [{ slot: 'Swoll' }],
  },
});

test('projectSlice keeps only the fields the ledger fold needs', () => {
  const s = projectSlice(row());
  assert.deepStrictEqual(Object.keys(s).sort(), [
    'bonuses', 'currency', 'endedAt', 'equity', 'gifts', 'host', 'huntKey', 'payouts', 'vault',
  ]);
  assert.strictEqual(s.huntKey, 'h1');
  assert.strictEqual(s.currency, 'USD');
  assert.deepStrictEqual(s.host, { id: '135203806676779008', name: 'Cabbage' });
});

test('projectSlice drops fields the client must not receive', () => {
  const s = projectSlice(row());
  assert.strictEqual(s.editors, undefined);
  assert.strictEqual(s.calls, undefined);
});

test('projectSlice keeps bonuses and vault in native shape for totalWonOf', () => {
  const s = projectSlice(row());
  assert.deepStrictEqual(s.bonuses, [{ win: 10 }, { win: 2 }, { win: null }]);
  assert.deepStrictEqual(s.vault, [{ amount: 3 }]);
});

test('projectSlice tolerates a legacy snapshot missing gifts/vault/payouts', () => {
  const r = row();
  delete r.snapshot.gifts; delete r.snapshot.vault; delete r.snapshot.payouts;
  const s = projectSlice(r);
  assert.deepStrictEqual(s.gifts, []);
  assert.deepStrictEqual(s.vault, []);
  assert.deepStrictEqual(s.payouts, {});
});

test('canResolveHunt allows the real host', () => {
  assert.strictEqual(canResolveHunt({
    hostUserId: '135203806676779008', callerId: '135203806676779008', isMod: false,
  }), true);
});

test('canResolveHunt rejects a non-host', () => {
  assert.strictEqual(canResolveHunt({
    hostUserId: '135203806676779008', callerId: '999', isMod: false,
  }), false);
});

test('canResolveHunt allows a mod on the fixed-key shared hunts', () => {
  for (const key of MOD_HUNT_KEYS) {
    assert.strictEqual(canResolveHunt({ hostUserId: key, callerId: '999', isMod: true }), true,
      `mod should resolve ${key}`);
  }
});

test('canResolveHunt rejects a non-mod on the fixed-key shared hunts', () => {
  for (const key of MOD_HUNT_KEYS) {
    assert.strictEqual(canResolveHunt({ hostUserId: key, callerId: '999', isMod: false }), false);
  }
});
