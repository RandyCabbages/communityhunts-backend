// Role slices (All / Host / Joined) + the four stat groups.
// The combined-only line merged two unrelated things: RUNNING a hunt (you own the whole pot and
// the whole result) and JOINING one (you own an equity fraction). These pin them apart.
// The pre-split math itself is pinned by userStats.test.js — that suite must stay green too.
const { test } = require('node:test');
const assert = require('node:assert');
const { computeUserHuntStats, STATS_VERSION } = require('./userStats');

const MIXED = [
  // Hosted, profitable: pot 100 -> won 400, net +300.
  { user: { id: 'me' }, huntId: 'h-host-1', huntType: 'community', currency: 'USD', usdRate: 1,
    startedAt: '2026-07-01T00:00:00.000Z', archivedAt: '2026-07-01T02:00:00.000Z',
    equity: [{ id: 'r1', name: 'Me', discordId: 'me', amount: 60 },
      { id: 'r2', name: 'Pal', discordId: 'pal', amount: 40 }],
    bonuses: [{ slot: 'Gates', bet: 10, win: 400, mult: 40, caller: 'Randy' }] },
  // Joined, losing: pot 200, their stake 50 (25%), won 40 -> returned 10, net -40.
  { user: { id: 'someone', displayName: 'Someone' }, huntId: 'h-join-1', huntType: 'community',
    currency: 'USD', usdRate: 1,
    startedAt: '2026-07-02T00:00:00.000Z', archivedAt: '2026-07-02T01:00:00.000Z',
    equity: [{ id: 'r3', name: 'Someone', discordId: 'someone', amount: 150 },
      { id: 'r4', name: 'Me', discordId: 'me', amount: 50 }],
    bonuses: [{ slot: 'Dog House', bet: 10, win: 40, mult: 4, caller: 'Randy' }] },
];

test('slices: host and joined PARTITION the combined slice', () => {
  const s = computeUserHuntStats(MIXED, 'me');
  assert.strictEqual(s.tiles.hunts, 2);
  assert.strictEqual(s.host.tiles.hunts, 1);
  assert.strictEqual(s.joined.tiles.hunts, 1);
  assert.strictEqual(s.host.tiles.hosted, 1);
  assert.strictEqual(s.host.tiles.joined, 0);
  assert.strictEqual(s.joined.tiles.hosted, 0);
  assert.strictEqual(s.joined.tiles.joined, 1);
  // A partition, not a filter that drops or double-counts: the parts sum to the whole.
  assert.strictEqual(s.host.usd.net + s.joined.usd.net, s.usd.net);
});

test('slices: a profitable host and a losing joiner stop cancelling out', () => {
  const s = computeUserHuntStats(MIXED, 'me');
  assert.strictEqual(s.host.usd.net, 300);      // 400 won - 100 pot
  assert.strictEqual(s.joined.usd.net, -40);    // 25% of 40 won = 10, minus 50 staked
  assert.strictEqual(s.usd.net, 260);           // all the old single line could tell you
  assert.strictEqual(s.host.tiles.winRate, 1);
  assert.strictEqual(s.joined.tiles.winRate, 0);
});

test('slices: pastHunts is carried ONCE, on the combined slice only', () => {
  const s = computeUserHuntStats(MIXED, 'me');
  assert.strictEqual(s.pastHunts.length, 2);
  assert.strictEqual(s.host.pastHunts, undefined);
  assert.strictEqual(s.joined.pastHunts, undefined);
  // Rows carry the role, which is what lets the table filter client-side instead.
  assert.deepStrictEqual(s.pastHunts.map(r => r.role).sort(), ['host', 'member']);
});

test('back-compat: the combined slice stays SPREAD at the top level', () => {
  const s = computeUserHuntStats(MIXED, 'me');
  // StatsBox and the admin profile read these directly. The split must not move them.
  for (const k of ['tiles', 'usd', 'byCurrency', 'records', 'activity', 'profit',
    'multHistogram', 'bySlot', 'byCaller', 'pastHunts']) {
    assert.ok(s[k] !== undefined, `${k} must remain at the top level`);
  }
  assert.strictEqual(s.v, STATS_VERSION, 'blob carries a version stamp for cache invalidation');
});

test('operator: pot, payout to members, people, completion, duration, type mix', () => {
  const op = computeUserHuntStats(MIXED, 'me').host.operator;
  assert.strictEqual(op.hunts, 1);
  assert.strictEqual(op.totalPot, 100);
  assert.strictEqual(op.avgPot, 100);
  // 400 won on a 100 pot; the non-host member holds 40 of the pot -> 40% of 400.
  assert.strictEqual(op.paidOutToMembers, 160);
  assert.strictEqual(op.uniqueParticipants, 2);
  assert.strictEqual(op.avgPeople, 2);
  assert.strictEqual(op.completionRate, 1);      // the single bonus has a win
  assert.strictEqual(op.avgSlots, 1);
  assert.strictEqual(op.avgDurationMs, 2 * 60 * 60 * 1000);
  assert.deepStrictEqual(op.typeMix, { community: 1 });
});

test('operator: beatReqRate compares what the hunt NEEDED against what it GOT', () => {
  const hs = [
    // pot 100 over 10 opened bet -> req 10x, got 40x. Cleared.
    { user: { id: 'me' }, huntId: 'a', currency: 'USD', usdRate: 1, archivedAt: '2026-07-01T00:00:00Z',
      equity: [{ id: 'r', name: 'Me', discordId: 'me', amount: 100 }],
      bonuses: [{ bet: 10, win: 400, mult: 40 }] },
    // pot 100 over 10 opened bet -> req 10x, got 4x. Missed.
    { user: { id: 'me' }, huntId: 'b', currency: 'USD', usdRate: 1, archivedAt: '2026-07-02T00:00:00Z',
      equity: [{ id: 'r', name: 'Me', discordId: 'me', amount: 100 }],
      bonuses: [{ bet: 10, win: 40, mult: 4 }] },
  ];
  const op = computeUserHuntStats(hs, 'me').host.operator;
  assert.strictEqual(op.beatReqHunts, 2);
  assert.strictEqual(op.beatReqRate, 0.5);
});

test('operator: an unfinished hunt drags completionRate, an auto-seed row is not a person', () => {
  const hs = [
    { user: { id: 'me' }, huntId: 'x', currency: 'USD', usdRate: 1, archivedAt: '2026-07-01T00:00:00Z',
      equity: [{ id: 'creator_auto', name: 'Me', amount: 50 }],
      bonuses: [{ bet: 10, win: 20, mult: 2 }, { bet: 10, mult: 0 }] },   // second never opened
  ];
  const op = computeUserHuntStats(hs, 'me').host.operator;
  assert.strictEqual(op.completionRate, 0);
  assert.strictEqual(op.uniqueParticipants, 0, 'creator_auto is a placeholder, not a participant');
});

test('player: equity share, top hosts with per-host ROI', () => {
  const p = computeUserHuntStats(MIXED, 'me').joined.player;
  assert.strictEqual(p.avgSharePct, 0.25);        // 50 of a 200 pot
  assert.strictEqual(p.topHosts.length, 1);
  assert.strictEqual(p.topHosts[0].hostId, 'someone');
  assert.strictEqual(p.topHosts[0].hostName, 'Someone');
  assert.strictEqual(p.topHosts[0].hunts, 1);
  assert.strictEqual(p.topHosts[0].net, -40);
  assert.strictEqual(p.topHosts[0].roi, -0.8);    // -40 on 50 staked
  assert.strictEqual(p.giftsGiven, 0);
  assert.strictEqual(p.giftsReceived, 0);
});

test('player: equity gifted TO them is not counted as money they staked', () => {
  const hs = [
    { user: { id: 'host' }, huntId: 'g1', currency: 'USD', usdRate: 1, archivedAt: '2026-07-03T00:00:00Z',
      equity: [{ id: 'rh', name: 'Host', discordId: 'host', amount: 100 },
        { id: 'rm', name: 'Me', discordId: 'me', amount: 100 }],
      // Host gifts 50 of NEW money; the only eligible recipient is Me.
      gifts: [{ type: 'equity', funderId: 'rh', amount: 50, createdAt: 1 }],
      bonuses: [{ bet: 10, win: 500, mult: 50 }] },
  ];
  const p = computeUserHuntStats(hs, 'me').joined.player;
  assert.strictEqual(p.giftsReceived, 50, 'equity handed to them, above their own stake');
  assert.strictEqual(p.giftsGiven, 0);
});

test('calling: attributes the free-text caller field via known handles, per slice', () => {
  const s = computeUserHuntStats(MIXED, 'me', { names: ['Randy', 'RandyCabbages'] });
  assert.strictEqual(s.calling.calls, 2);
  assert.strictEqual(s.calling.bet, 20);
  assert.strictEqual(s.calling.win, 440);
  assert.strictEqual(s.calling.x, 22);
  assert.strictEqual(s.calling.bestCall.mult, 40);
  assert.strictEqual(s.calling.bestCall.slot, 'Gates');
  assert.strictEqual(s.calling.worstCall.mult, 4);
  // The All/Host/Joined toggle applies to the calling record too.
  assert.strictEqual(s.host.calling.calls, 1);
  assert.strictEqual(s.joined.calling.calls, 1);
});

test('calling: no known names means no guesses, not a wrong attribution', () => {
  const s = computeUserHuntStats(MIXED, 'me');
  assert.strictEqual(s.calling.calls, 0);
  assert.strictEqual(s.calling.x, null);
  assert.strictEqual(s.calling.bestCall, null);
});

test('calling: match is case-insensitive and tolerates the host typing whitespace', () => {
  const hs = [
    { user: { id: 'host' }, huntId: 'c1', currency: 'USD', usdRate: 1, archivedAt: '2026-07-04T00:00:00Z',
      equity: [{ id: 'r', name: 'Me', discordId: 'me', amount: 100 }],
      bonuses: [{ slot: 'Wanted', bet: 10, win: 100, mult: 10, caller: '  rAnDy ' }] },
  ];
  assert.strictEqual(computeUserHuntStats(hs, 'me', { names: ['Randy'] }).calling.calls, 1);
});

test('calling: an unconverted hunt is counted but kept out of the money', () => {
  const hs = [
    { user: { id: 'host' }, huntId: 'c2', currency: 'ARS', archivedAt: '2026-07-04T00:00:00Z',
      equity: [{ id: 'r', name: 'Me', discordId: 'me', amount: 100 }],
      bonuses: [{ slot: 'Wanted', bet: 1000, win: 5000, mult: 5, caller: 'Randy' }] },  // no usdRate
  ];
  const c = computeUserHuntStats(hs, 'me', { names: ['Randy'] }).calling;
  assert.strictEqual(c.calls, 1);
  assert.strictEqual(c.unconvertedCalls, 1);
  assert.strictEqual(c.bet, 0, 'ARS must never be summed into USD at face value');
  assert.strictEqual(c.bestCall.mult, 5, 'a multiplier needs no conversion');
});

test('lists are capped so three slices cannot inflate the cached blob', () => {
  const bonuses = [];
  for (let i = 0; i < 40; i++) bonuses.push({ slot: `Slot ${i}`, bet: 10, win: i, mult: i, caller: `C${i}` });
  const hs = [{ user: { id: 'me' }, huntId: 'cap', currency: 'USD', usdRate: 1,
    archivedAt: '2026-07-05T00:00:00Z',
    equity: [{ id: 'r', name: 'Me', discordId: 'me', amount: 100 }], bonuses }];
  const s = computeUserHuntStats(hs, 'me');
  assert.strictEqual(s.bySlot.length, 25);
  assert.strictEqual(s.byCaller.length, 25);
});

test('a user with no hunts gets empty slices, not undefined', () => {
  const s = computeUserHuntStats([], 'nobody');
  assert.strictEqual(s.tiles.hunts, 0);
  assert.strictEqual(s.host.tiles.hunts, 0);
  assert.strictEqual(s.joined.tiles.hunts, 0);
  assert.strictEqual(s.host.operator.avgDurationMs, null);
  assert.strictEqual(s.host.operator.beatReqRate, null);
  assert.strictEqual(s.joined.player.avgSharePct, null);
  assert.deepStrictEqual(s.joined.player.topHosts, []);
});

// A third hunt for the type axis: solo, hosted, pot 20 -> won 100, net +80.
const SOLO = {
  user: { id: 'me' }, huntId: 'h-solo-1', huntType: 'solo', currency: 'USD', usdRate: 1,
  startedAt: '2026-07-03T00:00:00.000Z', archivedAt: '2026-07-03T01:00:00.000Z',
  equity: [{ id: 'r5', name: 'Me', discordId: 'me', amount: 20 }],
  bonuses: [{ slot: 'Wanted', bet: 5, win: 100, mult: 20, caller: 'Randy' }],
};

test('byType: one sub-tree per category the user actually has, and nothing else', () => {
  const s = computeUserHuntStats(MIXED, 'me');
  assert.deepStrictEqual(Object.keys(s.byType), ['community']);
  assert.strictEqual(s.byType.community.tiles.hunts, 2);
});

test('byType: type slices PARTITION the combined slice', () => {
  const s = computeUserHuntStats([...MIXED, SOLO], 'me');
  assert.deepStrictEqual(Object.keys(s.byType).sort(), ['community', 'solo']);
  assert.strictEqual(s.byType.community.tiles.hunts + s.byType.solo.tiles.hunts, s.tiles.hunts);
  assert.strictEqual(s.byType.community.usd.net + s.byType.solo.usd.net, s.usd.net);
  assert.strictEqual(s.byType.solo.usd.net, 80);
});

test('byType: the role axis survives inside a type slice', () => {
  const s = computeUserHuntStats([...MIXED, SOLO], 'me');
  assert.strictEqual(s.byType.solo.host.tiles.hunts, 1);
  assert.strictEqual(s.byType.solo.joined.tiles.hunts, 0);
  assert.strictEqual(s.byType.community.host.tiles.hunts, 1);
  assert.strictEqual(s.byType.community.joined.tiles.hunts, 1);
  // The group cards follow both axes too.
  assert.strictEqual(s.byType.solo.host.operator.hunts, 1);
  assert.ok(s.byType.community.joined.player, 'joined player group exists inside a type slice');
});

test('byType: sub-trees carry no pastHunts — the top-level array filters client-side', () => {
  const s = computeUserHuntStats([...MIXED, SOLO], 'me');
  assert.strictEqual(s.byType.community.pastHunts, undefined);
  assert.strictEqual(s.byType.solo.pastHunts, undefined);
  assert.strictEqual(s.pastHunts.length, 3);
  // Every row carries the category, which is what makes the client-side filter possible.
  assert.deepStrictEqual(s.pastHunts.map(r => r.huntType).sort(),
    ['community', 'community', 'solo']);
});

test('byType: version stamp is 3 so cached v2 rows recompute themselves', () => {
  assert.strictEqual(STATS_VERSION, 3);
  assert.strictEqual(computeUserHuntStats(MIXED, 'me').v, 3);
});

test('byType: a user with no hunts gets an empty map, not undefined', () => {
  assert.deepStrictEqual(computeUserHuntStats([], 'nobody').byType, {});
});
