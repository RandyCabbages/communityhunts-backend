const { test } = require('node:test');
const assert = require('node:assert');
const { badgedIds, withCallPriority } = require('./callPriority');

const roster = { owners: ['1'], king: '2', mods: ['3'], supporters: ['4'] };

test('badgedIds flattens all four badge sources to strings', () => {
  const s = badgedIds({ owners: [1], king: 2, mods: [3], supporters: [4] });
  assert.deepStrictEqual([...s].sort(), ['1', '2', '3', '4']);
});

test('badgedIds ignores an absent king and empty lists', () => {
  assert.strictEqual(badgedIds({}).size, 0);
  assert.strictEqual(badgedIds({ king: null, owners: [], mods: [], supporters: [] }).size, 0);
  assert.strictEqual(badgedIds({ king: '' }).size, 0);
});

// The whole point: the flag is resolved from the RAW hunt, because the public row no longer has
// the callerId it would need.
test('withCallPriority flags the badged caller on the masked rows', () => {
  const raw = [{ id: 'c1', callerId: '4', user: 'Sup' }, { id: 'c2', callerId: '9', user: 'Reg' }];
  const pub = raw.map(({ callerId, ...rest }) => rest); // what publicHuntView produces
  const out = withCallPriority(pub, raw, roster);
  assert.strictEqual(out[0].priority, true);
  assert.strictEqual(out[1].priority, undefined); // only `true` is ever written
});

test('withCallPriority never re-attaches the callerId it read', () => {
  const raw = [{ id: 'c1', callerId: '4', user: 'Sup' }];
  const pub = raw.map(({ callerId, ...rest }) => rest);
  const out = withCallPriority(pub, raw, roster);
  assert.strictEqual('callerId' in out[0], false);
  assert.ok(!JSON.stringify(out).includes('"4"'), 'a badged callerId leaked to the public payload');
});

test('an unbadged hunt is returned untouched (byte-identical payload)', () => {
  const raw = [{ id: 'c1', callerId: '9', user: 'Reg' }];
  const pub = raw.map(({ callerId, ...rest }) => rest);
  assert.deepStrictEqual(withCallPriority(pub, raw, roster), pub);
  assert.deepStrictEqual(withCallPriority(pub, raw, {}), pub); // empty roster short-circuits
});

// Index-zip is only valid while publicHuntView maps calls 1:1. If that ever changes, flagging the
// wrong caller is worse than flagging nobody.
test('a length mismatch bails out rather than mislabelling callers', () => {
  const raw = [{ id: 'c1', callerId: '4' }, { id: 'c2', callerId: '9' }];
  const pub = [{ id: 'c2' }];
  assert.deepStrictEqual(withCallPriority(pub, raw, roster), pub);
});

test('tolerates a missing or non-array call list', () => {
  assert.strictEqual(withCallPriority(undefined, [], roster), undefined);
  assert.deepStrictEqual(withCallPriority([], undefined, roster), []);
});

test('a call with no callerId is never prioritized', () => {
  const pub = [{ id: 'c1', user: 'Typed name only' }];
  const out = withCallPriority(pub, [{ id: 'c1' }], roster);
  assert.strictEqual(out[0].priority, undefined);
});
