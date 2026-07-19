const { test } = require('node:test');
const assert = require('node:assert');
const { sanitizePayouts } = require('./payouts');

test('keeps valid paid and notpaid records', () => {
  const out = sanitizePayouts({
    m1: { status: 'paid', amount: 340.5, at: 1721400000000, by: '123', note: 'rainbet tip' },
    m2: { status: 'notpaid', amount: 0, at: 1721400000001, by: '123', note: 'no handle' },
  });
  assert.deepStrictEqual(out.m1, { status: 'paid', amount: 340.5, at: 1721400000000, by: '123', note: 'rainbet tip' });
  assert.strictEqual(out.m2.status, 'notpaid');
});

test('drops entries with an unknown or missing status', () => {
  const out = sanitizePayouts({
    good: { status: 'paid', amount: 1, at: 1, by: 'a', note: '' },
    bad1: { status: 'refunded', amount: 1, at: 1, by: 'a', note: '' },
    bad2: { amount: 1, at: 1, by: 'a', note: '' },
  });
  assert.deepStrictEqual(Object.keys(out), ['good']);
});

test('coerces junk numbers to 0 and non-string by/note to empty', () => {
  const out = sanitizePayouts({ m1: { status: 'paid', amount: 'abc', at: null, by: 7, note: {} } });
  assert.strictEqual(out.m1.amount, 0);
  assert.strictEqual(out.m1.at, 0);
  assert.strictEqual(out.m1.by, '');
  assert.strictEqual(out.m1.note, '');
});

test('clamps note length and strips unknown keys', () => {
  const out = sanitizePayouts({ m1: { status: 'paid', amount: 1, at: 1, by: 'a', note: 'x'.repeat(500), evil: 'nope' } });
  assert.strictEqual(out.m1.note.length, 280);
  assert.strictEqual(out.m1.evil, undefined);
});

test('returns {} for non-object input', () => {
  assert.deepStrictEqual(sanitizePayouts(null), {});
  assert.deepStrictEqual(sanitizePayouts([1, 2]), {});
  assert.deepStrictEqual(sanitizePayouts('nope'), {});
});
