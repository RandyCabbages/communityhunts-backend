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
  assert.ok(typeof out[0].id === 'string' && out[0].id.length > 0); // id backfilled
});

test('negative deposit and endBalance clamp to 0', () => {
  const out = sanitizeChases([{ id: 'r', endBalance: -10, participants: [{ id: 'a', deposit: -5 }] }]);
  assert.strictEqual(out[0].endBalance, 0);
  assert.strictEqual(out[0].participants[0].deposit, 0);
});
