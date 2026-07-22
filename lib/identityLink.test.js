const test = require('node:test');
const assert = require('node:assert');
const { linkWithinHunt, proposeFromAliases } = require('./identityLink');

const REAL = '110983319176384512';
const REAL2 = '135203806676779008';

test('a call whose caller matches one linked equity row gets that discordId', () => {
  const hunt = {
    equity: [{ id: 'e1', name: 'SpinSage', discordId: REAL }],
    calls: [{ id: 'c1', slot: 'Mental', user: 'SpinSage' }],
  };
  const r = linkWithinHunt(hunt);
  assert.strictEqual(hunt.calls[0].callerId, REAL);
  assert.strictEqual(r.calls, 1);
});

test('matching is case- and whitespace-insensitive', () => {
  const hunt = {
    equity: [{ id: 'e1', name: 'Spin Sage', discordId: REAL }],
    calls: [{ id: 'c1', slot: 'A', user: '  spinsage ' }],
  };
  linkWithinHunt(hunt);
  assert.strictEqual(hunt.calls[0].callerId, REAL);
});

test('an ambiguous name links nothing', () => {
  const hunt = {
    equity: [
      { id: 'e1', name: 'Sage', discordId: REAL },
      { id: 'e2', name: 'Sage', discordId: REAL2 },
    ],
    calls: [{ id: 'c1', slot: 'A', user: 'Sage' }],
  };
  const r = linkWithinHunt(hunt);
  assert.strictEqual(hunt.calls[0].callerId, undefined);
  assert.strictEqual(r.calls, 0);
});

test('two equity rows with the same name AND the same id are not ambiguous', () => {
  const hunt = {
    equity: [
      { id: 'e1', name: 'Sage', discordId: REAL },
      { id: 'e2', name: 'Sage', discordId: REAL },
    ],
    calls: [{ id: 'c1', slot: 'A', user: 'Sage' }],
  };
  linkWithinHunt(hunt);
  assert.strictEqual(hunt.calls[0].callerId, REAL);
});

test('an existing callerId is never overwritten', () => {
  const hunt = {
    equity: [{ id: 'e1', name: 'SpinSage', discordId: REAL }],
    calls: [{ id: 'c1', slot: 'A', user: 'SpinSage', callerId: REAL2 }],
  };
  linkWithinHunt(hunt);
  assert.strictEqual(hunt.calls[0].callerId, REAL2);
});

test('a synthetic manual: id is never written as an identity', () => {
  const hunt = {
    equity: [{ id: 'e1', name: 'Ghost', discordId: 'manual:ghost' }],
    calls: [{ id: 'c1', slot: 'A', user: 'Ghost' }],
  };
  const r = linkWithinHunt(hunt);
  assert.strictEqual(hunt.calls[0].callerId, undefined);
  assert.strictEqual(r.calls, 0);
});

test('bonuses carrying a caller name are linked too', () => {
  const hunt = {
    equity: [{ id: 'e1', name: 'SpinSage', discordId: REAL }],
    calls: [],
    bonuses: [{ slot: 'Mental', caller: 'SpinSage', bet: 1, win: 2 }],
  };
  const r = linkWithinHunt(hunt);
  assert.strictEqual(hunt.bonuses[0].callerId, REAL);
  assert.strictEqual(r.bonuses, 1);
});

test('an unlinked equity row cannot be a source', () => {
  const hunt = {
    equity: [{ id: 'e1', name: 'SpinSage' }],
    calls: [{ id: 'c1', slot: 'A', user: 'SpinSage' }],
  };
  assert.strictEqual(linkWithinHunt(hunt).calls, 0);
});

test('an empty or missing name links nothing and does not throw', () => {
  const hunt = { equity: [{ id: 'e1', name: '', discordId: REAL }], calls: [{ id: 'c1', slot: 'A', user: '' }] };
  assert.strictEqual(linkWithinHunt(hunt).calls, 0);
  assert.doesNotThrow(() => linkWithinHunt({}));
  assert.doesNotThrow(() => linkWithinHunt(null));
});

test('links[] reports every applied link for the audit trail', () => {
  const hunt = {
    equity: [{ id: 'e1', name: 'SpinSage', discordId: REAL }],
    calls: [{ id: 'c1', slot: 'A', user: 'SpinSage' }],
    bonuses: [{ slot: 'B', caller: 'SpinSage', bet: 1, win: 5 }],
  };
  const r = linkWithinHunt(hunt);
  assert.strictEqual(r.links.length, 2);
  assert.deepStrictEqual(r.links.map(l => l.kind).sort(), ['bonus', 'call']);
  assert.ok(r.links.every(l => l.discordId === REAL));
});

test('proposeFromAliases proposes a unique owner and never mutates', () => {
  const hunt = { equity: [{ id: 'e1', name: 'SpinSage' }], calls: [] };
  const owners = new Map([['SpinSage', new Set([REAL])]]);
  const r = proposeFromAliases(hunt, owners);
  assert.strictEqual(r.proposals.length, 1);
  assert.strictEqual(r.proposals[0].discordId, REAL);
  assert.strictEqual(hunt.equity[0].discordId, undefined); // untouched
});

test('proposeFromAliases reports an ambiguous name instead of proposing it', () => {
  const hunt = { equity: [{ id: 'e1', name: 'Sage' }], calls: [] };
  const owners = new Map([['Sage', new Set([REAL, REAL2])]]);
  const r = proposeFromAliases(hunt, owners);
  assert.strictEqual(r.proposals.length, 0);
  assert.deepStrictEqual(r.ambiguous, [{ name: 'Sage', count: 2 }]);
});

test('proposeFromAliases skips rows that already carry an id', () => {
  const hunt = { equity: [{ id: 'e1', name: 'SpinSage', discordId: REAL2 }], calls: [] };
  const owners = new Map([['SpinSage', new Set([REAL])]]);
  assert.strictEqual(proposeFromAliases(hunt, owners).proposals.length, 0);
});

test('proposeFromAliases refuses a synthetic manual: owner', () => {
  const hunt = { equity: [{ id: 'e1', name: 'Ghost' }], calls: [] };
  const owners = new Map([['Ghost', new Set(['manual:ghost'])]]);
  assert.strictEqual(proposeFromAliases(hunt, owners).proposals.length, 0);
});

test('proposeFromAliases covers calls as well as equity, and tolerates no owners', () => {
  const hunt = { equity: [], calls: [{ id: 'c1', slot: 'A', user: 'SpinSage' }] };
  const owners = new Map([['SpinSage', new Set([REAL])]]);
  const r = proposeFromAliases(hunt, owners);
  assert.strictEqual(r.proposals.length, 1);
  assert.strictEqual(r.proposals[0].kind, 'call');
  assert.deepStrictEqual(proposeFromAliases(hunt, new Map()).proposals, []);
});
