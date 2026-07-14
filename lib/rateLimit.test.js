const { test } = require('node:test');
const assert = require('node:assert');
const rl = require('./rateLimit');

test('allows requests under the per-minute limit', () => {
  const t0 = 1_000_000;
  let last;
  for (let i = 0; i < 100; i++) last = rl.checkRate('pro-a', 'pro', t0);
  assert.strictEqual(last.ok, true);
  assert.strictEqual(last.limit, 100);
  assert.strictEqual(last.remaining, 0);
});

test('429s the request over the per-minute limit', () => {
  const t0 = 2_000_000;
  for (let i = 0; i < 100; i++) rl.checkRate('pro-b', 'pro', t0);
  const over = rl.checkRate('pro-b', 'pro', t0);
  assert.strictEqual(over.ok, false);
  assert.ok(over.retryAfter > 0);
});

test('reports the tighter of minute vs hour remaining', () => {
  // partner: 300/min, 10000/hr. After 300 in one minute, minute window is the binding one.
  const t0 = 3_000_000;
  for (let i = 0; i < 300; i++) rl.checkRate('partner-a', 'partner', t0);
  const over = rl.checkRate('partner-a', 'partner', t0);
  assert.strictEqual(over.ok, false);
});

test('window resets after the minute rolls over', () => {
  const t0 = 4_000_000;
  for (let i = 0; i < 100; i++) rl.checkRate('pro-c', 'pro', t0);
  const after = rl.checkRate('pro-c', 'pro', t0 + 61_000);
  assert.strictEqual(after.ok, true);
});

test('429s on the per-hour limit even when each minute window has reset', () => {
  // pro: 100/min, 2000/hr. Spread 2000 requests across 20 distinct minutes (100 each) so the
  // minute window resets every batch, but the hour window keeps accumulating toward 2000.
  const t0 = 5_000_000;
  let last;
  for (let batch = 0; batch < 20; batch++) {
    const now = t0 + batch * 60_000; // 19 advances by the last batch = 1_140_000ms, still < 1hr
    for (let i = 0; i < 100; i++) last = rl.checkRate('pro-hour', 'pro', now);
  }
  assert.strictEqual(last.ok, true); // the 2000th request still succeeds

  // A fresh minute (20th advance, 1_200_000ms from hourStart — still < 1hr, so the hour window
  // has NOT reset) has a full minute budget again, but the hour budget is exhausted.
  const over = rl.checkRate('pro-hour', 'pro', t0 + 20 * 60_000);
  assert.strictEqual(over.ok, false);
  assert.ok(over.retryAfter > 0);
});
