const { test } = require('node:test');
const assert = require('node:assert');
const { computeUserHuntStats } = require('./userStats');

const hunts = [
  { user: { id: 'u1' }, huntType: 'community', currency: 'USD', archivedAt: '2026-07-01T00:00:00Z',
    equity: [{ id: 'u1', amount: 100 }],
    bonuses: [{ bet: 10, win: 40, mult: 4 }, { bet: 10, win: 0, mult: 0 }] },
  { user: { id: 'other' }, huntType: 'vip', currency: 'USD', archivedAt: '2026-07-02T00:00:00Z',
    equity: [{ id: 'other', amount: 50 }, { id: 'u1', amount: 50 }],
    bonuses: [{ bet: 20, win: 200, mult: 10 }] },
];

test('tiles: attribution counts owner + equity member', () => {
  const s = computeUserHuntStats(hunts, 'u1');
  assert.strictEqual(s.tiles.hunts, 2);           // owns #1, equity in #2
});

test('tiles: wagered/won/winRate/avgMult from owned hunt', () => {
  const s = computeUserHuntStats(hunts, 'u1');
  // Hunt #1 (owner): wagered 20, won 40 → net +20 (win). Hunt #2 (50% of net 180 = +90).
  assert.ok(s.tiles.won >= 40);
  assert.ok(s.tiles.winRate > 0 && s.tiles.winRate <= 1);
  assert.ok(s.tiles.avgMult > 0);
});

test('multHistogram buckets multipliers', () => {
  const s = computeUserHuntStats(hunts, 'u1');
  const total = s.multHistogram.reduce((a, b) => a + b.count, 0);
  assert.ok(total >= 2);
});

test('non-participant gets zeroes', () => {
  const s = computeUserHuntStats(hunts, 'nobody');
  assert.strictEqual(s.tiles.hunts, 0);
  assert.deepStrictEqual(s.pastHunts, []);
});
