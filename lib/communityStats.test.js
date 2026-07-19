// lib/communityStats.js — pure aggregation, no DB, no env. Fixtures mirror hunt_history
// rows: { currency, usd_rate, snapshot }, where snapshot is the archived hunt object.
// `currency` is present for realism only — the aggregator reads usd_rate + snapshot.
const { test } = require('node:test');
const assert = require('node:assert');

const { aggregateCommunityStats } = require('./communityStats');

const row = (currency, usd_rate, snapshot) => ({ currency, usd_rate, snapshot });

test('mixed currencies convert per-hunt and never cross-sum', () => {
  const s = aggregateCommunityStats([
    row('USD', 1,     { bonuses: [{ win: 100 }, { win: 50 }] }),
    row('ARS', 0.001, { bonuses: [{ win: 1000000 }] }),
  ]);
  assert.strictEqual(s.hunts, 2);
  assert.strictEqual(s.bonuses, 3);
  assert.strictEqual(s.usdWon, 1150);   // 150 USD + (1_000_000 ARS x 0.001) = 1000
});

test('a row with no usable rate is skipped, never counted at 1.0', () => {
  const s = aggregateCommunityStats([
    row('USD', 1,    { bonuses: [{ win: 100 }] }),
    row('ARS', null, { bonuses: [{ win: 5000000 }] }),
    row('ARS', 0,    { bonuses: [{ win: 5000000 }] }),
  ]);
  assert.strictEqual(s.hunts, 3);      // still a hunt that happened
  assert.strictEqual(s.usdWon, 100);   // but it contributes no money
});

test('vault counts toward won, matching userStats', () => {
  const s = aggregateCommunityStats([
    row('USD', 1, { bonuses: [{ win: 100 }], vault: [{ amount: 25 }, { amount: 75 }] }),
  ]);
  assert.strictEqual(s.usdWon, 200);
});

test('approx counts snapshots whose rate was backfilled', () => {
  const s = aggregateCommunityStats([
    row('USD', 1,     { bonuses: [], approx: true }),
    row('ARS', 0.001, { bonuses: [], approx: false }),
    row('CAD', 0.73,  { bonuses: [] }),
  ]);
  assert.strictEqual(s.approx, 1);
});

test('empty and missing input produce zeros, not NaN', () => {
  for (const input of [[], null, undefined]) {
    assert.deepStrictEqual(aggregateCommunityStats(input),
      { hunts: 0, bonuses: 0, usdWon: 0, approx: 0 });
  }
});
