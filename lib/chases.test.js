const test = require('node:test');
const assert = require('node:assert');
const { sanitizeChases } = require('./chases');

test('keeps well-formed rounds and coerces numbers', () => {
  const out = sanitizeChases([
    { id: 'r1', createdAt: 1, endBalance: '700', participants: [{ id: 'a', deposit: '50' }, { id: 'b', deposit: 0 }] },
  ]);
  assert.deepStrictEqual(out, [
    { id: 'r1', createdAt: 1, endBalance: 700, participants: [{ id: 'a', deposit: 50 }, { id: 'b', deposit: 0 }] },
  ]);
});

test('drops non-array input, bad rounds, and participants without ids', () => {
  assert.deepStrictEqual(sanitizeChases(null), []);
  assert.deepStrictEqual(sanitizeChases('x'), []);
  const out = sanitizeChases([
    { id: 'r1', endBalance: 100, participants: [{ id: 'a', deposit: 5 }, { deposit: 9 }, { id: '', deposit: 1 }] },
    { endBalance: 50, participants: [{ id: 'a' }] }, // no id → dropped
  ]);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].participants.length, 1);
  assert.strictEqual(out[0].participants[0].deposit, 5);
  assert.ok(typeof out[0].id === 'string' && out[0].id.length > 0); // id-less round dropped; r1 survives
});

test('preserves recorded rounds verbatim even when a participant is later marked paid', () => {
  // A chase round is settled history: once recorded, marking a chaser paid out must NOT
  // rewrite the round's participant list (doing so silently re-splits the end balance and
  // changes everyone's payout). Excluding paid members is a round-CREATION rule enforced by
  // the frontend round builder — never a retroactive edit to already-recorded rounds.
  const payouts = { a: { status: 'paid' }, b: { status: 'notpaid' }, c: {} };
  const out = sanitizeChases([
    { id: 'r1', endBalance: 300, participants: [{ id: 'a', deposit: 10 }, { id: 'b', deposit: 20 }, { id: 'c', deposit: 0 }] },
    { id: 'r2', endBalance: 100, participants: [{ id: 'a', deposit: 5 }] },
  ], payouts);
  assert.strictEqual(out.length, 2);
  assert.deepStrictEqual(out[0].participants.map(p => p.id), ['a', 'b', 'c']); // 'a' (paid) kept
  assert.deepStrictEqual(out[1].participants.map(p => p.id), ['a']);
});

test('negative deposit and endBalance clamp to 0', () => {
  const out = sanitizeChases([{ id: 'r', endBalance: -10, participants: [{ id: 'a', deposit: -5 }] }]);
  assert.strictEqual(out[0].endBalance, 0);
  assert.strictEqual(out[0].participants[0].deposit, 0);
});

test('preserves split:"equal" through the sanitizer (it used to be silently dropped)', () => {
  const out = sanitizeChases([
    { id: 'r1', createdAt: 1, endBalance: 700, split: 'equal', participants: [{ id: 'a', deposit: 0 }] },
  ]);
  assert.strictEqual(out[0].split, 'equal');
});

test('drops any split value that is not the exact "equal" literal', () => {
  for (const bad of ['stake', 'EQUAL', 1, true, null, {}]) {
    const out = sanitizeChases([{ id: 'r1', endBalance: 10, split: bad, participants: [{ id: 'a' }] }]);
    assert.ok(!('split' in out[0]), `split should be absent for ${JSON.stringify(bad)}`);
  }
});

test('keeps recipients deduped, drops non-string entries, omits the key when empty', () => {
  const out = sanitizeChases([
    { id: 'r1', endBalance: 700, participants: [{ id: 'a' }], recipients: ['a', 'b', 'a', '', 7, 'c'] },
    { id: 'r2', endBalance: 700, participants: [{ id: 'a' }], recipients: [] },
    { id: 'r3', endBalance: 700, participants: [{ id: 'a' }] },
  ]);
  assert.deepStrictEqual(out[0].recipients, ['a', 'b', 'c']);
  assert.ok(!('recipients' in out[1]), 'empty recipients must not be emitted');
  assert.ok(!('recipients' in out[2]), 'absent recipients must stay absent');
});

test('caps a runaway recipients list at 200 ids', () => {
  const many = Array.from({ length: 500 }, (_, i) => `m${i}`);
  const out = sanitizeChases([{ id: 'r1', endBalance: 1, participants: [{ id: 'a' }], recipients: many }]);
  assert.strictEqual(out[0].recipients.length, 200);
});

test('rejects prototype-chain ids anywhere an id is accepted', () => {
  const out = sanitizeChases([
    { id: 'r1', endBalance: 700, participants: [{ id: 'a' }, { id: '__proto__' }],
      recipients: ['a', '__proto__', 'constructor', 'prototype', 'b'] },
    { id: '__proto__', endBalance: 700, participants: [{ id: 'a' }] },
  ]);
  assert.strictEqual(out.length, 1, 'a round whose own id is unsafe is dropped');
  assert.deepStrictEqual(out[0].participants.map(p => p.id), ['a']);
  assert.deepStrictEqual(out[0].recipients, ['a', 'b']);
});
