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

test('summary.types counts the PUBLIC category, not the internal huntType', () => {
  // Two vocabularies shared one field name. `/api/public/v1/hunts[].huntType` reserves 'vip' for
  // THE shared VIP Hunt (huntCategoryOf), while this counter used the raw `huntType` behaviour
  // flag — so 'vip' meant two different things on two endpoints, and the affiliate + streamer runs
  // were folded into 'community'. Reported from outside as "stats declares vip but no vip hunts
  // exist", which was exactly right.
  const eq = [{ amount: 0 }];
  const list = [
    { user: { id: 'u1' }, huntType: 'community', equity: eq, bonuses: [] },
    { user: { id: 'u2' }, huntType: 'solo', equity: eq, bonuses: [] },
    // Stored as huntType 'vip' but keyed as the affiliate run: public label is 'affiliate'.
    { user: { id: '__affiliate_hunt__:acme' }, tenantId: 'acme', huntType: 'vip', equity: eq, bonuses: [] },
    // Stored as huntType 'solo' but keyed as the tenant run: public label is 'streamer'.
    { user: { id: '__tenant_hunt__:acme' }, tenantId: 'acme', huntType: 'solo', equity: eq, bonuses: [] },
    { user: { id: '__vip_hunt__:acme' }, tenantId: 'acme', huntType: 'vip', equity: eq, bonuses: [] },
    // A regular hunt a mod set huntType 'vip' on is a COMMUNITY hunt that is VIP-shaped underneath.
    { user: { id: 'u3' }, huntType: 'vip', equity: eq, bonuses: [] },
  ];
  const { types } = aggregateHuntStats(list, new Set(), 'UTC').summary;
  assert.deepStrictEqual(types, { community: 2, solo: 1, vip: 1, affiliate: 1, streamer: 1 });
});

// Shared-hunt hub visibility (2026-08-01). VIP + Affiliate list like any other live hunt; the
// tenant/mod hunt is the community's PRIVATE staff hunt and must never appear. If someone
// "simplifies" the filter in getPublicHunts, this is the test that should stop them.
test('getPublicHunts lists VIP + Affiliate but never the private tenant hunt', () => {
  const withContent = (id) => ({
    user: { id }, isLive: true, tenantId: 'bean', huntType: 'community',
    bonuses: [{ slot: 'x', win: null }], equity: [], calls: [],
  });
  const hunts = {
    regular: withContent('regular'),
    __vip_hunt__: withContent('__vip_hunt__'),
    __affiliate_hunt__: withContent('__affiliate_hunt__'),
    __tenant_hunt__: withContent('__tenant_hunt__'),
  };
  initHuntsCore({ hunts, archive: [], viewers: {}, io: { to: () => ({ emit: () => {} }) }, persistHunts: () => {} });
  const ids = getPublicHunts('bean').map(h => h.userId).sort();
  assert.deepStrictEqual(ids, ['__affiliate_hunt__', '__vip_hunt__', 'regular']);
});

// Same for a non-bean tenant, whose shared hunts carry namespaced keys.
test('getPublicHunts applies the same rule to a namespaced tenant', () => {
  const withContent = (id) => ({
    user: { id }, isLive: true, tenantId: 'acme', huntType: 'community',
    bonuses: [{ slot: 'x', win: null }], equity: [], calls: [],
  });
  const hunts = {
    '__vip_hunt__:acme': withContent('__vip_hunt__:acme'),
    '__tenant_hunt__:acme': withContent('__tenant_hunt__:acme'),
  };
  initHuntsCore({ hunts, archive: [], viewers: {}, io: { to: () => ({ emit: () => {} }) }, persistHunts: () => {} });
  assert.deepStrictEqual(getPublicHunts('acme').map(h => h.userId), ['__vip_hunt__:acme']);
});

// Shared hunts are owned by the community, so user.displayName is the tenant host ("Bean") no
// matter who is running them — which read as flatly wrong once VIP hunts hit the hub. The runner
// is the creator_auto equity row.
test('a VIP hunt card shows the runner, not the tenant host', () => {
  const hunts = {
    __vip_hunt__: {
      user: { id: '__vip_hunt__', displayName: 'Bean' }, isLive: true, tenantId: 'bean',
      huntType: 'vip', bonuses: [{ slot: 'x', win: null }], calls: [],
      equity: [
        { id: 'bean_auto', name: 'Bean', amount: 1000 },
        { id: 'creator_auto', name: 'Mcflurry', amount: 100 },
      ],
    },
  };
  initHuntsCore({ hunts, archive: [], viewers: {}, io: { to: () => ({ emit: () => {} }) }, persistHunts: () => {} });
  assert.strictEqual(getPublicHunts('bean')[0].username, 'Mcflurry');
});

test('a VIP hunt with no runner row falls back to the tenant host', () => {
  const hunts = {
    __vip_hunt__: {
      user: { id: '__vip_hunt__', displayName: 'Bean' }, isLive: true, tenantId: 'bean',
      huntType: 'vip', bonuses: [{ slot: 'x', win: null }], calls: [],
      equity: [{ id: 'bean_auto', name: 'Bean', amount: 1000 }],
    },
  };
  initHuntsCore({ hunts, archive: [], viewers: {}, io: { to: () => ({ emit: () => {} }) }, persistHunts: () => {} });
  assert.strictEqual(getPublicHunts('bean')[0].username, 'Bean');
});

// A renamed creator_auto row on a PERSONAL hunt must not be able to relabel the card as someone
// else — the override is scoped to the two shared community hunts on purpose.
test('a personal hunt keeps its owner name regardless of creator_auto', () => {
  const hunts = {
    u1: {
      user: { id: 'u1', displayName: 'RealOwner' }, isLive: true, tenantId: 'bean',
      huntType: 'community', bonuses: [{ slot: 'x', win: null }], calls: [],
      equity: [{ id: 'creator_auto', name: 'Impostor', amount: 100 }],
    },
  };
  initHuntsCore({ hunts, archive: [], viewers: {}, io: { to: () => ({ emit: () => {} }) }, persistHunts: () => {} });
  assert.strictEqual(getPublicHunts('bean')[0].username, 'RealOwner');
});
