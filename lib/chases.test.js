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
