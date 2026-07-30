// `calls[].at` in the public API is `ts` on the stored row. It was null on almost every call:
// only lib/huntCalls.js stamped it (the public call board + the Discord bot), while every call the
// HOST adds in the tracker arrives client-side with no timestamp inside a whole-array hunt update.
// An integrator reported it null on every row they had ever observed.

const { test } = require('node:test');
const assert = require('node:assert');
const { stampNewCalls } = require('./hunts-core');

const NOW = 1_800_000_000_000;

test('a call appearing for the first time gets the server clock', () => {
  const next = stampNewCalls([], [{ id: 'c1', slot: 'Le Bandit', status: 'pending' }], NOW);
  assert.strictEqual(next[0].ts, NOW);
});

test('a row that already carries a ts is never re-stamped', () => {
  // Re-stamping on every save would turn `at` into "time of the last edit to this hunt", which is
  // a different and useless fact — and the hunt is saved on every keystroke-ish change.
  const prev = [{ id: 'c1', ts: 1 }];
  const next = stampNewCalls(prev, [{ id: 'c1', ts: 1 }, { id: 'c2' }], NOW);
  assert.strictEqual(next[0].ts, 1);
  assert.strictEqual(next[1].ts, NOW);
});

test('an OLD unstamped row keeps no timestamp — we do not invent history', () => {
  // The row predates the stamp entirely. Putting today's date on a call made months ago is worse
  // than admitting we don't know when it happened.
  const prev = [{ id: 'old', slot: 'Gates' }];
  const next = stampNewCalls(prev, [{ id: 'old', slot: 'Gates' }, { id: 'new' }], NOW);
  assert.strictEqual('ts' in next[0], false);
  assert.strictEqual(next[1].ts, NOW);
});

test('a client-supplied ts is honoured only when it is a number', () => {
  const next = stampNewCalls([], [{ id: 'a', ts: 'yesterday' }, { id: 'b', ts: null }], NOW);
  assert.strictEqual(next[0].ts, NOW, 'a junk ts must be replaced, not published');
  assert.strictEqual(next[1].ts, NOW);
});

test('a row with no id at all is treated as new', () => {
  const next = stampNewCalls([{ id: 'c1' }], [{ slot: 'No Id' }], NOW);
  assert.strictEqual(next[0].ts, NOW);
});

test('rows are copied, never mutated in place', () => {
  // archiveHunt takes a SHALLOW copy, so a live hunt and its archived snapshot can share this
  // array — mutating a row in place would rewrite history.
  const incoming = [{ id: 'c1' }];
  stampNewCalls([], incoming, NOW);
  assert.strictEqual('ts' in incoming[0], false);
});

test('order is preserved — the call queue IS the order', () => {
  const next = stampNewCalls([], [{ id: 'a' }, { id: 'b' }, { id: 'c' }], NOW);
  assert.deepStrictEqual(next.map(r => r.id), ['a', 'b', 'c']);
});

test('a non-array is passed straight through rather than throwing', () => {
  assert.strictEqual(stampNewCalls([], undefined, NOW), undefined);
  assert.strictEqual(stampNewCalls(null, null, NOW), null);
});

test('a null entry survives without becoming an object', () => {
  const next = stampNewCalls([], [null, { id: 'a' }], NOW);
  assert.strictEqual(next[0], null);
  assert.strictEqual(next[1].ts, NOW);
});
