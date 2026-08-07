const { test } = require('node:test');
const assert = require('node:assert');
const { badgedIds } = require('./callPriority');

test('badgedIds flattens all four badge sources to strings', () => {
  const s = badgedIds({ owners: [1], king: 2, mods: [3], supporters: [4] });
  assert.deepStrictEqual([...s].sort(), ['1', '2', '3', '4']);
});

test('badgedIds ignores an absent king and empty lists', () => {
  assert.strictEqual(badgedIds({}).size, 0);
  assert.strictEqual(badgedIds({ king: null, owners: [], mods: [], supporters: [] }).size, 0);
  assert.strictEqual(badgedIds({ king: '' }).size, 0);
});

test('badgedIds drops the stringified junk values an absent id turns into', () => {
  assert.strictEqual(badgedIds({ owners: [null, undefined, ''] }).size, 0);
});
