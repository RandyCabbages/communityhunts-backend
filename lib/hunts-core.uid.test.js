// uid() mints THREE things that matter, and it was `Math.random().toString(36).slice(2, 8)` —
// six characters from a non-cryptographic PRNG.
//
// 1. hunt.huntId, which statsStore.huntKey() returns verbatim (lib/statsStore.js:8-11) as the
//    hunt_history TEXT PRIMARY KEY — and that key is GLOBAL, not scoped per tenant. 36^6 is
//    2,176,782,336, so by the birthday bound a collision is ~0.09% at 2k hunts, 2.3% at 10k and
//    44% at 50k. On collision, recordHunt's ON CONFLICT DO UPDATE overwrites a DIFFERENT hunt's
//    snapshot and deletes its participants — potentially another tenant's.
//
// 2. Share tokens (routes/share.routes.js:20). GET /api/share/:token is PUBLIC — "no auth, anyone
//    with the link can view". Six characters is brute-forceable.
//
// 3. Equity-row and call ids, which are returned in ordinary API responses.
//
// (2) and (3) together are the sharper problem. V8's Math.random is xorshift128+, whose internal
// state can be recovered from a small number of outputs — so an attacker who collects ids from
// public responses can PREDICT subsequent share tokens rather than guessing them.

const { test } = require('node:test');
const assert = require('node:assert');
const core = require('./hunts-core');

test('uid() does not derive from Math.random', () => {
  const real = Math.random;
  try {
    Math.random = () => 0.5;          // fully determined PRNG
    const a = core.uid(), b = core.uid(), c = core.uid();
    assert.notStrictEqual(a, b, 'ids must not be reproducible by pinning Math.random');
    assert.notStrictEqual(b, c);
  } finally {
    Math.random = real;
  }
});

test('uid() carries enough entropy that a global PK collision is not a real risk', () => {
  const id = core.uid();
  assert.ok(id.length >= 20, `expected >= 20 chars of id, got ${id.length} (${id})`);
});

test('uid() is unique across a large sample', () => {
  const seen = new Set();
  for (let i = 0; i < 200000; i++) seen.add(core.uid());
  assert.strictEqual(seen.size, 200000, 'no collisions in 200k draws');
});

// These ids travel in URLs (share links) and JSON. Keep them boring so nothing downstream has to
// escape them — every existing consumer compares with === , so only the charset matters.
test('uid() stays URL-safe and alphanumeric', () => {
  for (let i = 0; i < 500; i++) {
    assert.match(core.uid(), /^[a-z0-9]+$/, 'lowercase alphanumeric only');
  }
});
