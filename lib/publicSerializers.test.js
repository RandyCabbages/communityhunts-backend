const { test } = require('node:test');
const assert = require('node:assert');
const S = require('./publicSerializers');

// Inject a fake publicHuntView that mimics anonymity masking + secret strip.
S._setPublicHuntView(h => ({
  ...h,
  equity: (h.equity || []).map(e => e.discordId === 'anon1' ? { ...e, name: 'Anonymous' } : e),
}));

const HUNT = {
  huntId: 'h_1', user: { id: '111', displayName: 'Runner' }, tenantId: 'acme',
  huntType: 'community', isLive: false, archivedAt: '2026-07-10T00:00:00Z',
  startedAt: '2026-07-09T00:00:00Z', createdAt: '2026-07-09T00:00:00Z', currency: 'USD',
  invitedEditors: ['secret'], callsPermissions: { x: 1 },
  bonuses: [{ slot: 'Le Bandit', bet: 2, win: 200, ts: 1 }],
  equity: [{ name: 'Alice', amount: 100, discordId: '222' }, { name: 'Bob', amount: 50, discordId: 'anon1' }],
};

test('publicHunt whitelists — no Discord IDs / editor lists / permissions leak', () => {
  const out = S.publicHunt(HUNT);
  const json = JSON.stringify(out);
  assert.ok(!json.includes('invitedEditors') && !json.includes('callsPermissions'));
  assert.ok(!json.includes('"111"') && !json.includes('discordId'));
  assert.strictEqual(out.id, 'h_1');
  assert.strictEqual(out.status, 'archived');
  assert.strictEqual(out.bonuses[0].multiplier, 100);
});

test('publicHunt keeps anonymous member masked', () => {
  const out = S.publicHunt(HUNT);
  const bob = out.equity.find(e => e.amount === 50);
  assert.strictEqual(bob.name, 'Anonymous');
});

test('publicHunt rounds a float-accumulated totalWon to 2dp and keeps it a number', () => {
  // 0.1 + 0.2 + 184.24 === 184.54000000000002 in IEEE-754 — the real prod artifact.
  const hunt = { ...HUNT, bonuses: [
    { slot: 'A', bet: 1, win: 0.1 },
    { slot: 'B', bet: 1, win: 0.2 },
    { slot: 'C', bet: 1, win: 184.24 },
  ] };
  const out = S.publicHunt(hunt);
  assert.strictEqual(out.totalWon, 184.54);
  assert.strictEqual(typeof out.totalWon, 'number');
});

test('publicStats drops name-bearing lists (topHunters/biggestHits)', () => {
  const raw = { currencies: [{ code: 'USD', hunts: 3 }], tz: 'UTC',
    byCurrency: { USD: { summary: { totalHunts: 3, totalWon: 9 }, topGotIn: [{ slot: 'X', count: 2 }],
      topCalled: [], topHunters: [{ name: 'Alice' }], biggestHits: [{ member: 'Bob' }], hours: [], weekdays: [], weeks: [] } } };
  const out = S.publicStats(raw);
  const json = JSON.stringify(out);
  assert.ok(!json.includes('topHunters') && !json.includes('biggestHits'));
  assert.strictEqual(out.byCurrency.USD.summary.totalWon, 9);
  assert.deepStrictEqual(out.byCurrency.USD.topGotIn, [{ slot: 'X', count: 2 }]);
});

test('publicStats rounds money/ratio fields, preserves null pnl, leaves counts + types untouched', () => {
  const raw = { currencies: [{ code: 'USD', hunts: 5 }], tz: 'UTC',
    byCurrency: { USD: {
      summary: {
        totalHunts: 5, completedHunts: 5, liveNow: 0, totalBonuses: 12, openedBonuses: 10,
        totalBet: 3726.789999999982, totalWon: 109644.79200000022, overallMulti: 29.667484353818995,
        avgSlotsPerHunt: 2.4, avgPot: 745.357999999996, totalPot: 3726.79,
        pnl: null, pnlHunts: 0, untagged: 0, types: { community: 5, vip: 0, solo: 0 },
      },
      topGotIn: [{ name: 'Slot A', entries: 3, hunts: 2, totalBet: 61.513333333333336, totalWin: 184.54000000000002,
                   avgMulti: 12.336666666666667, bestMulti: 20.111111111111668, bestWin: 500 }],
      topCalled: [{ name: 'Slot A', called: 4, gotIn: 3 }],
      hours: [], weekdays: [], weeks: [],
    } } };
  const out = S.publicStats(raw);
  const sum = out.byCurrency.USD.summary;
  // money/ratio fields rounded to 2dp
  assert.strictEqual(sum.totalBet, 3726.79);
  assert.strictEqual(sum.totalWon, 109644.79);
  assert.strictEqual(sum.overallMulti, 29.67);
  assert.strictEqual(sum.avgPot, 745.36);
  // pnl stays null (unknowable), never coerced to 0
  assert.strictEqual(sum.pnl, null);
  // integer counts + types untouched
  assert.strictEqual(sum.totalHunts, 5);
  assert.strictEqual(sum.completedHunts, 5);
  assert.strictEqual(sum.liveNow, 0);
  assert.strictEqual(sum.totalBonuses, 12);
  assert.strictEqual(sum.openedBonuses, 10);
  assert.strictEqual(sum.pnlHunts, 0);
  assert.strictEqual(sum.untagged, 0);
  assert.deepStrictEqual(sum.types, { community: 5, vip: 0, solo: 0 });
  // topGotIn: money/ratio rounded, counts untouched
  const g = out.byCurrency.USD.topGotIn[0];
  assert.strictEqual(g.totalBet, 61.51);
  assert.strictEqual(g.totalWin, 184.54);
  assert.strictEqual(g.avgMulti, 12.34);
  assert.strictEqual(g.entries, 3);
  assert.strictEqual(g.hunts, 2);
  // topCalled has no money/ratio fields — passes through unchanged
  assert.deepStrictEqual(out.byCurrency.USD.topCalled, [{ name: 'Slot A', called: 4, gotIn: 3 }]);
});

test('an already-clean number is left unchanged and stays a number (not a "100.00" string)', () => {
  const raw = { byCurrency: { USD: { summary: { totalBet: 100, totalWon: 0, pnl: null },
    topGotIn: [], topCalled: [], hours: [], weekdays: [], weeks: [] } } };
  const out = S.publicStats(raw);
  assert.strictEqual(out.byCurrency.USD.summary.totalBet, 100);
  assert.strictEqual(typeof out.byCurrency.USD.summary.totalBet, 'number');
});

test('publicGotIn + publicBanger shape', () => {
  assert.deepStrictEqual(S.publicGotIn([{ ts: 5, slot: 'Y', bet: 1 }]), [{ slot: 'Y', bet: 1, at: 5 }]);
  const b = S.publicBanger({ slot: 'Z', bet: 1, win: 500, mult: 500, userId: 'x', avatar: 'a', username: 'Runner', huntType: 'solo', at: 't' });
  assert.deepStrictEqual(b, { slot: 'Z', bet: 1, win: 500, multiplier: 500, username: 'Runner', huntType: 'solo', at: 't' });
});

test('fail-closed default masks all equity names when publicHuntView is unconfigured', () => {
  delete require.cache[require.resolve('./publicSerializers')];
  const Fresh = require('./publicSerializers');
  const out = Fresh.publicHunt({ huntId: 'h', bonuses: [], equity: [{ name: 'Alice', amount: 10, discordId: '1' }] });
  assert.strictEqual(out.equity[0].name, 'Hidden');
  delete require.cache[require.resolve('./publicSerializers')]; // restore for any later tests
});
