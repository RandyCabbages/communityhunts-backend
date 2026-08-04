// Host-side member table + the anonymity rule.
//
// initHuntsCore below is LOAD-BEARING. `shouldMaskIdentity` is a rebindable module-level `let`
// inside hunts-core whose default masks NOTHING, and no unit test arms it. Without this call the
// anonymity assertions would pass while testing nothing at all. Safe to do at module scope:
// node:test runs each test FILE in its own process.
const { test } = require('node:test');
const assert = require('node:assert');
const { initHuntsCore } = require('./hunts-core');

initHuntsCore({
  hunts: {}, archive: [], viewers: {}, io: null,
  shouldMaskIdentity: ({ discordId }) => discordId === 'ghost',
});

const { computeUserHuntStats } = require('./userStats');

// pot 300 (me 100 + pal 100 + ghost 100; the seed row is 0), won 600.
// With no gifts each 100-stake member takes 600 x 100/300 = 200, so plNet = +100 each.
const HOSTED = [{
  user: { id: 'me' }, huntId: 'h1', huntType: 'community', currency: 'USD', usdRate: 1,
  startedAt: '2026-07-01T00:00:00.000Z', archivedAt: '2026-07-01T02:00:00.000Z',
  equity: [
    { id: 'r1', name: 'Me', discordId: 'me', amount: 100 },
    { id: 'r2', name: 'Pal', discordId: 'pal', amount: 100 },
    { id: 'r3', name: 'Ghost', discordId: 'ghost', amount: 100 },
    { id: 'creator_auto', name: 'Seed', amount: 0 },
  ],
  bonuses: [{ bet: 10, win: 600, mult: 60 }],
}];

test('topMembers: names the people who joined, with their own money', () => {
  const op = computeUserHuntStats(HOSTED, 'me').host.operator;
  assert.deepStrictEqual(op.topMembers, [
    { userId: 'pal', name: 'Pal', hunts: 1, invested: 100, returned: 200, net: 100 },
  ]);
});

test('topMembers: the host, seed placeholders and masked members are all excluded', () => {
  const op = computeUserHuntStats(HOSTED, 'me').host.operator;
  const ids = op.topMembers.map(m => m.userId);
  assert.ok(!ids.includes('me'), 'the host is not one of their own members');
  assert.ok(!ids.includes('creator_auto'), 'seed placeholders are not people');
  assert.ok(!ids.includes('ghost'), 'an anonymous member is never named');
});

test('topMembers: anonymous members are counted, and still count everywhere else', () => {
  const op = computeUserHuntStats(HOSTED, 'me').host.operator;
  assert.strictEqual(op.anonymousMembers, 1);
  // Excluded from the NAMED list only — they are still a participant and still got paid.
  assert.strictEqual(op.uniqueParticipants, 3);   // me + pal + ghost (creator_auto is not real)
  assert.strictEqual(op.paidOutToMembers, 400);   // pal 200 + ghost 200 + seed 0
});

test('topMembers: attribution is by discordId, never the per-row uuid', () => {
  const hs = [{
    user: { id: 'me' }, huntId: 'h2', currency: 'USD', usdRate: 1,
    archivedAt: '2026-07-02T00:00:00.000Z',
    equity: [
      { id: 'uuid-host', name: 'Me', discordId: 'me', amount: 100 },
      { id: 'uuid-one', name: 'Pal', discordId: 'pal', amount: 100 },
    ],
    bonuses: [{ bet: 10, win: 400, mult: 40 }],
  }, ...HOSTED];
  const op = computeUserHuntStats(hs, 'me').host.operator;
  const pal = op.topMembers.find(m => m.userId === 'pal');
  // Same person across two hunts with DIFFERENT row uuids — one row, not two.
  assert.strictEqual(op.topMembers.filter(m => m.userId === 'pal').length, 1);
  assert.strictEqual(pal.hunts, 2);
});
