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
  assert.strictEqual(s.tiles.hosted, 1);          // hosted #1
  assert.strictEqual(s.tiles.joined, 1);          // joined #2
});

test('pastHunts carry host/member role', () => {
  const s = computeUserHuntStats(hunts, 'u1');
  const roles = s.pastHunts.map(h => h.role).sort();
  assert.deepStrictEqual(roles, ['host', 'member']);
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

// --- PAST HUNTS stat overhaul (2026-07-07) ---------------------------------

const HOST = '135203806676779008';

// Hunt: start balance 520 (pot), 3 opened bonuses, total won 218 -> a LOSS of 302.
const lossHunt = {
  user: { id: HOST }, huntId: 'h1', huntType: 'community', currency: 'USD',
  archivedAt: '2026-07-03T00:00:00.000Z',
  equity: [{ id: HOST, amount: 520 }],
  bonuses: [
    { bet: 20, win: 12,  mult: 0.6,  caller: 'Kyle' },    // 0.6x
    { bet: 20, win: 6,   mult: 0.3,  caller: 'Kyle' },    // Kyle avg = 18/40 = 0.45x
    { bet: 20, win: 200, mult: 10,   caller: 'Goofer' },  // Goofer = 200/20 = 10x
  ],
};

test('tiles: avgStart is the mean of hunt start balances (pots)', () => {
  // lossHunt pot = 520 (only hunt) -> avgStart = 520.
  const t = computeUserHuntStats([lossHunt], HOST).tiles;
  assert.strictEqual(t.avgStart, 520);
  // Two hunts, pots 520 and 100 -> avgStart = 310.
  const other = { user: { id: HOST }, huntId: 'hx', huntType: 'solo', currency: 'USD',
    archivedAt: '2026-07-04T00:00:00.000Z', equity: [{ id: HOST, amount: 100 }],
    bonuses: [{ bet: 10, win: 10, mult: 1, caller: 'Z' }] };
  const t2 = computeUserHuntStats([lossHunt, other], HOST).tiles;
  assert.strictEqual(t2.avgStart, 310);
});

test('pastHunts: profit baseline is won - pot (a $520->$218 hunt is a loss)', () => {
  const row = computeUserHuntStats([lossHunt], HOST).pastHunts[0];
  assert.strictEqual(row.startBalance, 520, 'startBalance = pot');
  assert.strictEqual(row.endBalance, 218, 'endBalance = total won');
  assert.strictEqual(row.result, 218 - 520, 'result = won - pot (a loss)');
  assert.ok(row.result < 0, 'result must be negative for this hunt');
  assert.strictEqual(row.slots, 3);
  assert.strictEqual(row.currency, 'USD');
  assert.strictEqual(row.role, 'host');
});

test('pastHunts: reqX and avgX share the same opened-bet denominator', () => {
  const row = computeUserHuntStats([lossHunt], HOST).pastHunts[0];
  assert.ok(Math.abs(row.reqX - 520 / 60) < 1e-9, 'reqX = pot / Σbet');
  assert.ok(Math.abs(row.avgX - 218 / 60) < 1e-9, 'avgX = won / Σbet');
  assert.ok(row.avgX < row.reqX, 'invariant: avgX < reqX <=> loss');
});

test('pastHunts: best/worst caller are money-weighted, need >=2 named callers', () => {
  const row = computeUserHuntStats([lossHunt], HOST).pastHunts[0];
  assert.strictEqual(row.bestCaller.name, 'Goofer');
  assert.ok(Math.abs(row.bestCaller.x - 10) < 1e-9);
  assert.strictEqual(row.worstCaller.name, 'Kyle');
  assert.ok(Math.abs(row.worstCaller.x - 0.45) < 1e-9);
});

test('pastHunts: pot 0 -> null multipliers; single caller -> no best/worst', () => {
  const soloNoPot = {
    user: { id: HOST }, huntId: 'h2', huntType: 'solo', currency: 'GBP',
    updatedAt: '2026-07-01T00:00:00.000Z',
    equity: [],                       // pot = 0
    bonuses: [{ bet: 10, win: 5, mult: 0.5, caller: 'Bean' }],
  };
  const row = computeUserHuntStats([soloNoPot], HOST).pastHunts[0];
  assert.strictEqual(row.startBalance, 0);
  assert.strictEqual(row.reqX, null, 'pot 0 -> reqX null');
  assert.strictEqual(row.bestCaller, null, '<2 callers -> null');
  assert.strictEqual(row.worstCaller, null);
});

test('pastHunts: equity participant result is scaled by their share', () => {
  const shared = {
    user: { id: 'someoneElse' }, huntId: 'h3', huntType: 'vip', currency: 'USD',
    archivedAt: '2026-06-29T00:00:00.000Z',
    equity: [{ id: 'someoneElse', amount: 300 }, { id: HOST, amount: 100 }], // share 100/400 = .25
    bonuses: [{ bet: 40, win: 80, mult: 2, caller: 'A' }],                    // won 80, pot 400 -> -320
  };
  const row = computeUserHuntStats([shared], HOST).pastHunts[0];
  assert.strictEqual(row.role, 'member');
  assert.ok(Math.abs(row.result - (80 - 400) * 0.25) < 1e-9, 'result scaled by equity share');
});

// --- PER-CURRENCY + USD AGGREGATION (Task 2) --------------------------------

test('byCurrency splits mixed-currency hunts, never cross-summing', () => {
  const mixed = [
    { user: { id: 'u' }, currency: 'USD', usdRate: 1, archivedAt: '2026-07-01T00:00:00Z',
      equity: [{ id: 'u', amount: 100 }], bonuses: [{ bet: 10, win: 150, mult: 15 }] },
    { user: { id: 'u' }, currency: 'ARS', usdRate: 0.001, archivedAt: '2026-07-02T00:00:00Z',
      equity: [{ id: 'u', amount: 100000 }], bonuses: [{ bet: 1000, win: 50000, mult: 50 }] },
  ];
  const s = computeUserHuntStats(mixed, 'u');
  assert.strictEqual(s.byCurrency.USD.hunts, 1);
  assert.strictEqual(s.byCurrency.ARS.hunts, 1);
  assert.strictEqual(s.byCurrency.USD.net, 50);       // 150 - 100
  assert.strictEqual(s.byCurrency.ARS.net, -50000);   // 50000 - 100000
});

test('usd block normalizes via usdRate and counts unconverted', () => {
  const mixed = [
    { user: { id: 'u' }, currency: 'USD', usdRate: 1, archivedAt: '2026-07-01T00:00:00Z',
      equity: [{ id: 'u', amount: 100 }], bonuses: [{ bet: 10, win: 150, mult: 15 }] },
    { user: { id: 'u' }, currency: 'ARS', usdRate: 0.001, archivedAt: '2026-07-02T00:00:00Z',
      equity: [{ id: 'u', amount: 100000 }], bonuses: [{ bet: 1000, win: 50000, mult: 50 }] },
    { user: { id: 'u' }, currency: 'GBP', archivedAt: '2026-07-03T00:00:00Z', // no usdRate
      equity: [{ id: 'u', amount: 80 }], bonuses: [{ bet: 8, win: 8, mult: 1 }] },
  ];
  const s = computeUserHuntStats(mixed, 'u');
  // USD net 50 + ARS (-50000 * 0.001 = -50) => 0 ; GBP skipped
  assert.strictEqual(s.usd.net, 0);
  assert.strictEqual(s.usd.unconvertedCount, 1);
});

// --- RECORDS & STREAKS (Task 3) ------------------------------------------------

test('records: biggest win, highest mult, best/worst hunt net', () => {
  const hs = [
    { user: { id: 'u' }, currency: 'USD', usdRate: 1, archivedAt: '2026-07-01T00:00:00Z',
      equity: [{ id: 'u', amount: 100 }], bonuses: [{ bet: 10, win: 500, mult: 50 }] },      // net +400
    { user: { id: 'u' }, currency: 'USD', usdRate: 1, archivedAt: '2026-07-02T00:00:00Z',
      equity: [{ id: 'u', amount: 100 }], bonuses: [{ bet: 10, win: 20, mult: 2 }] },         // net -80
  ];
  const s = computeUserHuntStats(hs, 'u');
  assert.strictEqual(s.records.biggestWin, 500);
  assert.strictEqual(s.records.highestMult, 50);
  assert.strictEqual(s.records.bestHuntNet, 400);
  assert.strictEqual(s.records.worstHuntNet, -80);
});

test('records: win/loss streaks over chronological order', () => {
  const mk = (d, amt, win) => ({ user: { id: 'u' }, currency: 'USD', usdRate: 1,
    archivedAt: d, equity: [{ id: 'u', amount: amt }], bonuses: [{ bet: 10, win, mult: win / 10 }] });
  const hs = [ mk('2026-07-01T00:00:00Z', 100, 200),  // win
               mk('2026-07-02T00:00:00Z', 100, 300),  // win
               mk('2026-07-03T00:00:00Z', 100, 10),   // loss
               mk('2026-07-04T00:00:00Z', 100, 5) ];  // loss
  const s = computeUserHuntStats(hs, 'u');
  assert.strictEqual(s.records.longestWinStreak, 2);
  assert.strictEqual(s.records.longestLossStreak, 2);
});
