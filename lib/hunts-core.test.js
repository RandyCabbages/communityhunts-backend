const { test } = require('node:test');
const assert = require('node:assert');
const { huntHasContent, getPublicHunts, initHuntsCore, sumVault } = require('./hunts-core');

const base = { huntType: 'community', bonuses: [], equity: [], calls: [] };

test('empty community hunt has no content', () => {
  assert.strictEqual(huntHasContent({ ...base }), false);
});
test('auto-seed only (creator_auto amount 0) is not content', () => {
  assert.strictEqual(huntHasContent({ ...base, huntType: 'solo',
    equity: [{ id: 'creator_auto', amount: 0 }] }), false);
});
test('a bonus is content', () => {
  assert.strictEqual(huntHasContent({ ...base, bonuses: [{ slot: 'x', win: null }] }), true);
});
test('equity member with amount > 0 is content', () => {
  assert.strictEqual(huntHasContent({ ...base, equity: [{ id: 'creator_auto', amount: 50 }] }), true);
});
test('non-auto equity id is content even at amount 0', () => {
  assert.strictEqual(huntHasContent({ ...base, equity: [{ id: 'abc123', amount: 0 }] }), true);
});
test('VIP auto-seed (Bean 1000 + creator 100) counts as content', () => {
  assert.strictEqual(huntHasContent({ ...base, huntType: 'vip',
    equity: [{ id: 'bean_auto', amount: 1000 }, { id: 'creator_auto', amount: 100 }] }), true);
});
test('non-solo calls are content', () => {
  assert.strictEqual(huntHasContent({ ...base, huntType: 'community',
    calls: [{ slot: 'x' }] }), true);
});
test('solo calls are NOT content (auto preferred injection)', () => {
  assert.strictEqual(huntHasContent({ ...base, huntType: 'solo',
    equity: [{ id: 'creator_auto', amount: 0 }], calls: [{ slot: 'x' }] }), false);
});

test('getPublicHunts hides empty live hunts, shows ones with content', () => {
  const hunts = {
    a: { user: { id: 'a' }, isLive: true, tenantId: 'bean', huntType: 'community', bonuses: [], equity: [], calls: [] },
    b: { user: { id: 'b' }, isLive: true, tenantId: 'bean', huntType: 'community', bonuses: [{ slot: 'x', win: null }], equity: [], calls: [] },
  };
  initHuntsCore({ hunts, archive: [], viewers: {}, io: { to: () => ({ emit: () => {} }) }, persistHunts: () => {} });
  const ids = getPublicHunts('bean').map(h => h.userId);
  assert.deepStrictEqual(ids, ['b']);
});

test('getPublicHunts keeps a completed live hunt (10-min editable grace window)', () => {
  const hunts = {
    open: { user: { id: 'open' }, isLive: true, tenantId: 'bean', huntType: 'community',
      bonuses: [{ slot: 'x', win: null }], equity: [], calls: [] },
    done: { user: { id: 'done' }, isLive: true, tenantId: 'bean', huntType: 'community',
      bonuses: [{ slot: 'x', win: 100 }, { slot: 'y', win: 0 }], equity: [], calls: [] },
  };
  initHuntsCore({ hunts, archive: [], viewers: {}, io: { to: () => ({ emit: () => {} }) }, persistHunts: () => {} });
  const ids = getPublicHunts('bean').map(h => h.userId);
  // 'done' has all bonuses opened but stays live/editable — it remains on the hub until the
  // janitor's completed-reap ends it after 10m of inactivity (server.js cleanupStaleHunts).
  assert.deepStrictEqual(ids.sort(), ['done', 'open']);
});

test('sumVault totals vault amounts, 0 for legacy', () => {
  assert.strictEqual(sumVault({ vault: [{ amount: 300 }, { amount: 50 }] }), 350);
  assert.strictEqual(sumVault({}), 0);
});

const { aggregateHuntStats } = require('./hunts-core');
test('vault raises P&L but not overallMulti', () => {
  const list = [{ user: { id: 'u1', displayName: 'A' }, huntType: 'solo',
    equity: [{ amount: 100 }], bonuses: [{ bet: 10, win: 40 }], vault: [{ amount: 60 }] }];
  const s = aggregateHuntStats(list, new Set(), 'UTC');
  assert.strictEqual(s.summary.totalWon, 100);   // 40 bonus + 60 vault
  assert.strictEqual(s.summary.overallMulti, 4); // 40 / 10 bonus-only, vault excluded
  assert.strictEqual(s.summary.pnl, 0);          // 100 won - 100 pot
});
