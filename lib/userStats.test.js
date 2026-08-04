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

test('attribution: equity member matched by discordId, never the per-row uuid id', () => {
  const hs = [
    { user: { id: 'host1' }, currency: 'USD', usdRate: 1, archivedAt: '2026-07-01T00:00:00Z',
      equity: [
        { id: 'uuid-aaa', name: 'Host', amount: 100 },
        { id: 'uuid-bbb', name: 'Joiner', discordId: 'u2', amount: 100 },  // real user via discordId
      ],
      bonuses: [{ bet: 10, win: 300, mult: 30 }] },   // won 300, pot 200
  ];
  const s = computeUserHuntStats(hs, 'u2');
  assert.strictEqual(s.tiles.hunts, 1);     // attributed via discordId, not the uuid `id`
  assert.strictEqual(s.tiles.joined, 1);
  assert.strictEqual(s.tiles.hosted, 0);
  // net = (won 300 − pot 200) × share(100/200) = 100 × 0.5 = 50
  assert.strictEqual(s.byCurrency.USD.net, 50);
});

test('usd: invested / returned / roi are share-adjusted for a joined member', () => {
  const hs = [
    { user: { id: 'host' }, currency: 'USD', usdRate: 1, archivedAt: '2026-07-01T00:00:00Z',
      equity: [
        { id: 'uuid-h', name: 'Host', discordId: 'host', amount: 300 },
        { id: 'uuid-m', name: 'Me', discordId: 'u2', amount: 100 },   // 100 of a 400 pot = 25%
      ],
      bonuses: [{ bet: 10, win: 800, mult: 80 }] },   // pot 400, end balance 800
  ];
  const s = computeUserHuntStats(hs, 'u2');
  assert.strictEqual(s.usd.invested, 100);   // their own equity in
  assert.strictEqual(s.usd.returned, 200);   // 800 × 25% share
  assert.strictEqual(s.usd.net, 100);        // 200 − 100
  assert.strictEqual(s.usd.roi, 1);          // net 100 ÷ invested 100 = 1.0 (=100%)
});

test('usd: roi is null when nothing was invested', () => {
  const s = computeUserHuntStats([], 'nobody');
  assert.strictEqual(s.usd.roi, null);
  assert.strictEqual(s.usd.invested, 0);
});

test('attribution: a non-participant is not counted', () => {
  const hs = [
    { user: { id: 'host1' }, currency: 'USD', usdRate: 1, archivedAt: '2026-07-01T00:00:00Z',
      equity: [{ id: 'uuid-bbb', name: 'Joiner', discordId: 'u2', amount: 100 }],
      bonuses: [{ bet: 10, win: 300, mult: 30 }] },
  ];
  const s = computeUserHuntStats(hs, 'stranger');
  assert.strictEqual(s.tiles.hunts, 0);
});

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

test('records: extremes are USD-normalized across currencies', () => {
  const hs = [
    { user: { id: 'u' }, currency: 'USD', usdRate: 1, archivedAt: '2026-07-01T00:00:00Z',
      equity: [{ id: 'u', amount: 100 }], bonuses: [{ bet: 10, win: 400, mult: 40 }] },   // net +300 USD, win 400 USD
    { user: { id: 'u' }, currency: 'ARS', usdRate: 0.001, archivedAt: '2026-07-02T00:00:00Z',
      equity: [{ id: 'u', amount: 100000 }], bonuses: [{ bet: 1000, win: 500000, mult: 500 }] }, // native win 500000 -> 500 USD; net +400000 native -> +400 USD
  ];
  const s = computeUserHuntStats(hs, 'u');
  assert.strictEqual(s.records.biggestWin, 500);     // 500000*0.001 beats 400*1
  assert.strictEqual(s.records.bestHuntNet, 400);    // ARS +400000*0.001 beats USD +300
  assert.strictEqual(s.records.highestMult, 500);    // native mult unchanged
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

// --- PER-SLOT & PER-CALLER BREAKDOWNS (Task 4) --------------------------------

test('bySlot aggregates a slot across hunts', () => {
  const hs = [
    { user: { id: 'u' }, currency: 'USD', usdRate: 1, archivedAt: '2026-07-01T00:00:00Z',
      equity: [{ id: 'u', amount: 100 }],
      bonuses: [{ slot: 'Gates of Olympus', bet: 10, win: 100, mult: 10 },
                { slot: 'Sugar Rush', bet: 10, win: 5, mult: 0.5 }] },
    { user: { id: 'u' }, currency: 'USD', usdRate: 1, archivedAt: '2026-07-02T00:00:00Z',
      equity: [{ id: 'u', amount: 100 }],
      bonuses: [{ slot: 'Gates of Olympus', bet: 10, win: 40, mult: 4 }] },
  ];
  const s = computeUserHuntStats(hs, 'u');
  const gates = s.bySlot.find(r => r.slot === 'Gates of Olympus');
  assert.strictEqual(gates.hunts, 2);
  assert.strictEqual(gates.bet, 20);
  assert.strictEqual(gates.win, 140);
});

test('byCaller is money-weighted and sorted by x desc', () => {
  const hs = [
    { user: { id: 'u' }, currency: 'USD', usdRate: 1, archivedAt: '2026-07-01T00:00:00Z',
      equity: [{ id: 'u', amount: 100 }],
      bonuses: [{ slot: 'A', caller: 'alice', bet: 10, win: 200, mult: 20 },
                { slot: 'B', caller: 'bob', bet: 10, win: 5, mult: 0.5 }] },
  ];
  const s = computeUserHuntStats(hs, 'u');
  assert.strictEqual(s.byCaller[0].caller, 'alice');
  assert.strictEqual(s.byCaller[0].x, 20);
});

test('pastHunts rows carry huntKey (huntId, else user|startedAt) and srcCurrency', () => {
  const withId = computeUserHuntStats([
    { huntId: 'H1', user: { id: 'u1' }, startedAt: 'T0', archivedAt: '2026-07-01T00:00:00Z',
      currency: 'USD', usdRate: 1, equity: [{ id: 'u1', amount: 100 }],
      bonuses: [{ slot: 'A', bet: 10, win: 40, mult: 4 }] },
  ], 'u1');
  assert.strictEqual(withId.pastHunts[0].huntKey, 'H1');
  assert.strictEqual(withId.pastHunts[0].srcCurrency, 'USD');

  const noId = computeUserHuntStats([
    { user: { id: 'u1' }, startedAt: 'T0', archivedAt: '2026-07-01T00:00:00Z',
      currency: 'USD', usdRate: 1, equity: [{ id: 'u1', amount: 100 }],
      bonuses: [{ slot: 'A', bet: 10, win: 40, mult: 4 }] },
  ], 'u1');
  assert.strictEqual(noId.pastHunts[0].huntKey, 'u1|T0');
});

test('pastHunts srcCurrency is the STORED currency, distinct from the USD display currency', () => {
  const s = computeUserHuntStats([
    { huntId: 'H1', user: { id: 'u1' }, startedAt: 'T0', archivedAt: '2026-07-01T00:00:00Z',
      currency: 'GBP', usdRate: 1.25, equity: [{ id: 'u1', amount: 100 }],
      bonuses: [{ slot: 'A', bet: 10, win: 40, mult: 4 }] },
  ], 'u1');
  assert.strictEqual(s.pastHunts[0].currency, 'USD');    // display (normalized)
  assert.strictEqual(s.pastHunts[0].srcCurrency, 'GBP'); // stored
});

test('gift ledger: pre-hunt new money counts against the funder; post-hunt payout gift moves realized dollars', () => {
  const hs = [{
    user: { id: 'host' }, currency: 'USD', usdRate: 1, archivedAt: '2026-07-10T00:00:00Z',
    equity: [
      { id: 'e1', name: 'Jeter', discordId: 'jeter', amount: 2000 },
      { id: 'e2', name: 'Bean',  discordId: 'bean',  amount: 5000 },
      { id: 'e3', name: 'Cara',  discordId: 'cara',  amount: 3000 },
      { id: 'e4', name: 'Dan',   discordId: 'dan',   amount: 2000 },
    ],
    gifts: [
      { id: 'g1', type: 'equity', amount: 10000, funderId: 'e1', fromStake: false, split: 'proportional', excludeIds: ['e2'], createdAt: 1 },
      { id: 'g2', type: 'payout', amount: 2000,  funderId: 'e2', fromStake: true,  split: 'proportional', excludeIds: ['e1'], createdAt: 2 },
    ],
    bonuses: [{ bet: 0, win: 26400, mult: 0 }],
  }];
  const jeter = computeUserHuntStats(hs, 'jeter');
  assert.strictEqual(jeter.byCurrency.USD.invested, 2000);
  assert.strictEqual(jeter.byCurrency.USD.returned, 2400);
  assert.strictEqual(jeter.byCurrency.USD.net, -9600);   // 2400 − 2000 − 10000 new money
  const cara = computeUserHuntStats(hs, 'cara');
  assert.strictEqual(cara.byCurrency.USD.invested, 3000);
  assert.strictEqual(cara.byCurrency.USD.returned, 12000);
  assert.strictEqual(cara.byCurrency.USD.net, 9000);
});

// --- VAULT IN WINNINGS (Task 13) ----------------------------------------------
// THE RULE: vault -> winnings/P&L/payout split, NEVER a multiplier (win/bet).

const vaultBase = {
  user: { id: HOST }, huntId: 'hv1', huntType: 'community', currency: 'USD', usdRate: 1,
  archivedAt: '2026-07-05T00:00:00.000Z',
  equity: [{ id: HOST, amount: 100 }],
  bonuses: [{ bet: 10, win: 40, mult: 4, caller: 'Kyle' }],
};
const noVaultHunt = { ...vaultBase };
const withVaultHunt = { ...vaultBase, vault: [{ amount: 60 }] };

test('vault: raises host endBalance/returned/net without inflating avgX (multiplier)', () => {
  const noVault = computeUserHuntStats([noVaultHunt], HOST);
  const withVault = computeUserHuntStats([withVaultHunt], HOST);

  const rowNo = noVault.pastHunts[0];
  const rowVault = withVault.pastHunts[0];

  // Winnings/payout site: vault raises endBalance by exactly its amount (60).
  assert.strictEqual(rowNo.endBalance, 40);
  assert.strictEqual(rowVault.endBalance, 100);
  assert.strictEqual(rowVault.result - rowNo.result, 60, 'vault flows straight into P&L');
  assert.strictEqual(withVault.byCurrency.USD.won - noVault.byCurrency.USD.won, 60);
  assert.strictEqual(withVault.usd.net - noVault.usd.net, 60);

  // Multiplier site (avgX = won/betOpened): vault MUST NOT touch this.
  assert.strictEqual(rowNo.avgX, 4);
  assert.strictEqual(rowVault.avgX, 4, 'vault must never inflate a multiplier');
});

test('vault: joined member payout also rises with vault (via computeGiftResults totalWon)', () => {
  const mk = (vault) => ({
    user: { id: 'host2' }, huntId: 'hv2', huntType: 'vip', currency: 'USD', usdRate: 1,
    archivedAt: '2026-07-06T00:00:00.000Z',
    equity: [{ id: 'host2', amount: 100 }, { id: 'e2', discordId: 'member2', amount: 100 }], // 50% share
    bonuses: [{ bet: 10, win: 40, mult: 4 }],
    ...(vault ? { vault } : {}),
  });
  const noVault = computeUserHuntStats([mk(null)], 'member2');
  const withVault = computeUserHuntStats([mk([{ amount: 60 }])], 'member2');
  // Member share is 50%: vault 60 -> +30 payout for this member.
  assert.strictEqual(withVault.pastHunts[0].endBalance - noVault.pastHunts[0].endBalance, 30);
});

// --- HUNT TYPE CATEGORY DERIVATION (Task 1) -----------------------------------

test('pastHunts huntType is the DERIVED category, not the raw internal flag', () => {
  const hs = [
    // No huntType flag at all — this read `null` before, blanking the admin table's type column.
    { user: { id: 'u1' }, huntId: 'a', currency: 'USD', usdRate: 1, archivedAt: '2026-07-01T00:00:00Z',
      equity: [{ id: 'r1', discordId: 'u1', amount: 100 }], bonuses: [{ bet: 10, win: 20, mult: 2 }] },
    { user: { id: 'u1' }, huntId: 'b', huntType: 'solo', currency: 'USD', usdRate: 1, archivedAt: '2026-07-02T00:00:00Z',
      equity: [{ id: 'r2', discordId: 'u1', amount: 100 }], bonuses: [{ bet: 10, win: 20, mult: 2 }] },
    // 'vip' is NOT a storable category — a mod's VIP-shaped regular hunt reports as community.
    { user: { id: 'u1' }, huntId: 'c', huntType: 'vip', currency: 'USD', usdRate: 1, archivedAt: '2026-07-03T00:00:00Z',
      equity: [{ id: 'r3', discordId: 'u1', amount: 100 }], bonuses: [{ bet: 10, win: 20, mult: 2 }] },
  ];
  const byKey = Object.fromEntries(
    computeUserHuntStats(hs, 'u1').pastHunts.map(r => [r.huntKey, r.huntType]));
  assert.strictEqual(byKey.a, 'community');
  assert.strictEqual(byKey.b, 'solo');
  assert.strictEqual(byKey.c, 'community');
});

test('pastHunts huntType labels the three shared hunts by KEY, not by huntType', () => {
  const shared = (huntId, key) => ({
    user: { id: key }, huntId, huntType: 'community', currency: 'USD', usdRate: 1,
    archivedAt: '2026-07-01T00:00:00Z',
    equity: [{ id: 'r', discordId: 'u1', amount: 100 }],
    bonuses: [{ bet: 10, win: 20, mult: 2 }],
  });
  const byKey = Object.fromEntries(computeUserHuntStats([
    shared('t', '__tenant_hunt__'),
    shared('a', '__affiliate_hunt__'),
    shared('v', '__vip_hunt__'),
  ], 'u1').pastHunts.map(r => [r.huntKey, r.huntType]));
  assert.strictEqual(byKey.t, 'streamer');
  assert.strictEqual(byKey.a, 'affiliate');
  assert.strictEqual(byKey.v, 'vip');
});

// --- BET SIZING & VAULT TOTALS (Task 2) ---

test('bets: avgBet and biggestBet are USD-normalized and skip unconverted hunts', () => {
  const hs = [
    { user: { id: 'u1' }, huntId: 'rated', currency: 'GBP', usdRate: 2, archivedAt: '2026-07-01T00:00:00Z',
      equity: [{ id: 'r1', discordId: 'u1', amount: 100 }],
      bonuses: [{ bet: 10, win: 40, mult: 4 }, { bet: 30, win: 0, mult: 0 }] },
    // No usdRate: contributes to neither figure rather than being summed at face value.
    { user: { id: 'u1' }, huntId: 'unrated', currency: 'ARS', archivedAt: '2026-07-02T00:00:00Z',
      equity: [{ id: 'r2', discordId: 'u1', amount: 100 }],
      bonuses: [{ bet: 9999, win: 0, mult: 0 }] },
  ];
  const s = computeUserHuntStats(hs, 'u1');
  assert.strictEqual(s.records.biggestBet, 60);   // 30 GBP x 2
  assert.strictEqual(s.tiles.avgBet, 40);         // (10 + 30) x 2 / 2 bonuses
});

test('vault: reported on its own, USD-normalized, and never a multiplier', () => {
  const hs = [{
    user: { id: 'u1' }, huntId: 'v', currency: 'GBP', usdRate: 2, archivedAt: '2026-07-01T00:00:00Z',
    equity: [{ id: 'r1', discordId: 'u1', amount: 100 }],
    bonuses: [{ bet: 10, win: 40, mult: 4 }],
    vault: [{ amount: 15 }, { amount: 5 }],
  }];
  const s = computeUserHuntStats(hs, 'u1');
  assert.strictEqual(s.usd.vault, 40);            // (15 + 5) GBP x 2
  assert.strictEqual(s.usd.vaultHunts, 1);
  assert.strictEqual(s.tiles.avgMult, 4);         // vault must NOT reach a multiplier
});

test('vault: a hunt with no vault reports zero, not a missing field', () => {
  const s = computeUserHuntStats([{
    user: { id: 'u1' }, huntId: 'n', currency: 'USD', usdRate: 1, archivedAt: '2026-07-01T00:00:00Z',
    equity: [{ id: 'r1', discordId: 'u1', amount: 100 }], bonuses: [{ bet: 10, win: 40, mult: 4 }],
  }], 'u1');
  assert.strictEqual(s.usd.vault, 0);
  assert.strictEqual(s.usd.vaultHunts, 0);
});
