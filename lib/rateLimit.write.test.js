// Writes get their own, much tighter bucket: a limit sized for read polling is no limit at all
// on a mutating endpoint. The IP floor exists because rateLimit runs AFTER requireApiKey and
// keys off the tenant resolved from the key — so a request carrying a bad key is metered by
// nothing at all (2026-07-23 security review).
const { test } = require('node:test');
const assert = require('node:assert');
const { checkRate, checkIp, WRITE_LIMITS, LIMITS } = require('./rateLimit');

test('write limits are tighter than read limits on every plan', () => {
  for (const plan of ['pro', 'partner']) {
    assert.ok(WRITE_LIMITS[plan].perMin < LIMITS[plan].perMin, `${plan} perMin`);
    assert.ok(WRITE_LIMITS[plan].perHour < LIMITS[plan].perHour, `${plan} perHour`);
  }
});

test('the write bucket is independent of the read bucket', () => {
  const now = 1_000_000;
  for (let i = 0; i < 5; i++) checkRate('indep', 'pro', now, WRITE_LIMITS);
  // Read bucket for the same slug is untouched — otherwise write traffic could exhaust reads.
  const r = checkRate('indep', 'pro', now);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.remaining, LIMITS.pro.perMin - 1);
});

test('the write bucket refuses once the per-minute limit is spent', () => {
  const now = 2_000_000;
  const lim = WRITE_LIMITS.pro.perMin;
  for (let i = 0; i < lim; i++) {
    assert.strictEqual(checkRate('spend', 'pro', now, WRITE_LIMITS).ok, true, `call ${i}`);
  }
  const over = checkRate('spend', 'pro', now, WRITE_LIMITS);
  assert.strictEqual(over.ok, false);
  assert.ok(over.retryAfter >= 1);
});

test('the ip floor meters unauthenticated callers', () => {
  const now = 3_000_000;
  for (let i = 0; i < 60; i++) assert.strictEqual(checkIp('1.2.3.4', now).ok, true, `call ${i}`);
  assert.strictEqual(checkIp('1.2.3.4', now).ok, false);
  // A different address is unaffected.
  assert.strictEqual(checkIp('5.6.7.8', now).ok, true);
});

test('the ip floor window rolls over', () => {
  const now = 4_000_000;
  for (let i = 0; i < 60; i++) checkIp('9.9.9.9', now);
  assert.strictEqual(checkIp('9.9.9.9', now).ok, false);
  assert.strictEqual(checkIp('9.9.9.9', now + 60_001).ok, true);
});
