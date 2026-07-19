const { test } = require('node:test');
const assert = require('node:assert');
const core = require('./hunts-core');

test('binds when exactly one unlinked name matches', () => {
  const hunt = { equity: [{ id: 'm1', name: 'Big Bird', amount: 10 }, { id: 'm2', name: 'Elmo', amount: 5 }] };
  const r = core.bindEquityIdentityByName(hunt, { userId: '111', name: 'big bird' });
  assert.deepEqual(r, { bound: true, memberId: 'm1' });
  assert.equal(hunt.equity[0].discordId, '111');
});

test('no-op on zero matches', () => {
  const hunt = { equity: [{ id: 'm1', name: 'Elmo' }] };
  assert.deepEqual(core.bindEquityIdentityByName(hunt, { userId: '1', name: 'Grover' }), { bound: false, memberId: null });
  assert.equal(hunt.equity[0].discordId, undefined);
});

test('no-op on ambiguous 2+ matches', () => {
  const hunt = { equity: [{ id: 'm1', name: 'Bird' }, { id: 'm2', name: 'bird' }] };
  assert.deepEqual(core.bindEquityIdentityByName(hunt, { userId: '1', name: 'BIRD' }), { bound: false, memberId: null });
});

test('never overwrites an already-linked row', () => {
  const hunt = { equity: [{ id: 'm1', name: 'Bird', discordId: 'existing' }] };
  const r = core.bindEquityIdentityByName(hunt, { userId: 'new', name: 'Bird' });
  assert.deepEqual(r, { bound: false, memberId: null }); // the only match is already linked
  assert.equal(hunt.equity[0].discordId, 'existing');
});
