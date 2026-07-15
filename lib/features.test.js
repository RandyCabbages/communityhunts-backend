const { test } = require('node:test');
const assert = require('node:assert');
const features = require('./features');

// ── computeFullExtension (pure) ──────────────────────────────────────────────

test('computeFullExtension: no paths → no access', () => {
  const r = features.computeFullExtension({});
  assert.strictEqual(r.access, false);
  assert.deepStrictEqual(r.sources, []);
});

test('computeFullExtension: vip_host alone', () => {
  const r = features.computeFullExtension({ isVipHost: true });
  assert.strictEqual(r.access, true);
  assert.deepStrictEqual(r.sources, ['vip_host']);
});

test('computeFullExtension: community_mod alone', () => {
  const r = features.computeFullExtension({ isCommunityMod: true });
  assert.deepStrictEqual(r.sources, ['community_mod']);
});

test('computeFullExtension: discord_vip alone', () => {
  const r = features.computeFullExtension({ isDiscordVip: true });
  assert.deepStrictEqual(r.sources, ['discord_vip']);
});

// Ladder isolation: a Partner tenant with a free sub reports ONLY partner_plan.
test('computeFullExtension: partner community plan alone', () => {
  const r = features.computeFullExtension({ tenantPlan: 'partner', subTier: 'free' });
  assert.strictEqual(r.access, true);
  assert.deepStrictEqual(r.sources, ['partner_plan']);
});

// ...and the reverse: an Ultimate sub on a pro tenant reports ONLY ultimate_sub.
test('computeFullExtension: ultimate individual sub alone', () => {
  const r = features.computeFullExtension({ tenantPlan: 'pro', subTier: 'ultimate' });
  assert.strictEqual(r.access, true);
  assert.deepStrictEqual(r.sources, ['ultimate_sub']);
});

test('computeFullExtension: comp alone — the case where the toggle decides', () => {
  const r = features.computeFullExtension({ hasComp: true });
  assert.strictEqual(r.access, true);
  assert.deepStrictEqual(r.sources, ['admin_comp']);
});

test('computeFullExtension: overlapping paths all listed, in FULL_EXT_SOURCES order', () => {
  const r = features.computeFullExtension({
    isDiscordVip: true, tenantPlan: 'pro', subTier: 'ultimate', hasComp: true,
  });
  assert.strictEqual(r.access, true);
  assert.deepStrictEqual(r.sources, ['discord_vip', 'ultimate_sub', 'admin_comp']);
});

// The original bug, pinned: a VIP has access even with no comp granted.
test('computeFullExtension: VIP with no comp still has access', () => {
  const r = features.computeFullExtension({ isDiscordVip: true, hasComp: false });
  assert.strictEqual(r.access, true);
  assert.ok(!r.sources.includes('admin_comp'));
});

// FULL_EXT_SOURCES is a cross-repo sync constraint (frontend SOURCE_LABELS keys off it), so
// pin it: every source the core can emit must be declared, in the declared order. Without
// this the core could emit a key the frontend has no label for and every other test passes.
test('computeFullExtension: every path on → all six sources, in FULL_EXT_SOURCES order', () => {
  const r = features.computeFullExtension({
    isVipHost: true, isCommunityMod: true, isDiscordVip: true,
    tenantPlan: 'partner', subTier: 'ultimate', hasComp: true,
  });
  assert.strictEqual(r.access, true);
  assert.deepStrictEqual(r.sources, features.FULL_EXT_SOURCES);
});

test('computeFullExtension: emitted sources are always a subset of FULL_EXT_SOURCES', () => {
  const r = features.computeFullExtension({
    isVipHost: true, tenantPlan: 'partner', subTier: 'ultimate', hasComp: true,
  });
  for (const s of r.sources) assert.ok(features.FULL_EXT_SOURCES.includes(s), `undeclared source: ${s}`);
});

// ── fullExtensionFor (fetches subTier + hasComp) ─────────────────────────────

test('fullExtensionFor: no subscriptions dep → free tier, no throw', async () => {
  features.initFeatures({ subscriptions: null, featureGrants: null });
  const r = await features.fullExtensionFor('123', { tenantPlan: 'pro' });
  assert.strictEqual(r.access, false);
  assert.deepStrictEqual(r.sources, []);
});

test('fullExtensionFor: getSubscription rejects → fails closed to free', async () => {
  features.initFeatures({
    subscriptions: { getSubscription: async () => { throw new Error('db down'); } },
    featureGrants: null,
  });
  const r = await features.fullExtensionFor('123', { tenantPlan: 'pro' });
  assert.strictEqual(r.access, false);
  assert.deepStrictEqual(r.sources, []);
});

test('fullExtensionFor: comp grant surfaces admin_comp', async () => {
  features.initFeatures({
    subscriptions: { getSubscription: async () => ({ tier: 'free' }) },
    featureGrants: { hasGrant: (id, key) => id === '123' && key === 'full_extension' },
  });
  const r = await features.fullExtensionFor('123', { tenantPlan: 'pro' });
  assert.strictEqual(r.access, true);
  assert.deepStrictEqual(r.sources, ['admin_comp']);
});

test('fullExtensionFor: caller role flags pass through to the core', async () => {
  features.initFeatures({ subscriptions: null, featureGrants: null });
  const r = await features.fullExtensionFor('123', { tenantPlan: 'pro', isDiscordVip: true });
  assert.deepStrictEqual(r.sources, ['discord_vip']);
});

test('fullExtensionFor: sub tier is read from the subscriptions dep', async () => {
  features.initFeatures({
    subscriptions: { getSubscription: async () => ({ tier: 'ultimate' }) },
    featureGrants: null,
  });
  const r = await features.fullExtensionFor('123', { tenantPlan: 'free' });
  assert.deepStrictEqual(r.sources, ['ultimate_sub']);
});
