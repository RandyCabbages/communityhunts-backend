const test = require('node:test');
const assert = require('node:assert');
const { defaultHuntTitle, sanitizeTitle } = require('./huntTitle');

const NOON = Date.parse('2026-07-24T12:00:00Z');

test('defaultHuntTitle: dated default per kind, deterministic (UTC)', () => {
  assert.strictEqual(defaultHuntTitle('Bean', 'mod', NOON), "Bean's Hunt — Jul 24");
  assert.strictEqual(defaultHuntTitle('Bean', 'affiliate', NOON), 'Bean Affiliate Hunt — Jul 24');
  assert.strictEqual(defaultHuntTitle('', 'mod', NOON), "Host's Hunt — Jul 24"); // blank host → 'Host'
});

test('sanitizeTitle: trims, caps at 80, strips control chars, non-string → ""', () => {
  assert.strictEqual(sanitizeTitle('  Friday $10k  '), 'Friday $10k');
  assert.strictEqual(sanitizeTitle('ab'), 'ab');
  assert.strictEqual(sanitizeTitle('x'.repeat(200)).length, 80);
  assert.strictEqual(sanitizeTitle('a\tb\nc'), 'abc'); // control chars stripped
  assert.strictEqual(sanitizeTitle(123), '');
  assert.strictEqual(sanitizeTitle(null), '');
});
