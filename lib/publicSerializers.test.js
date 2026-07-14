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
