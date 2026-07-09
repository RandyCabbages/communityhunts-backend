const { test } = require('node:test');
const assert = require('node:assert');
const { huntHasContent, getPublicHunts, initHuntsCore } = require('./hunts-core');

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
