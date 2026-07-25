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
// The perk is "free for ALL YOUR MEMBERS", so it needs isTenantMember — see the
// non-member test below for the hole this closes.
test('computeFullExtension: partner community plan alone (member)', () => {
  const r = features.computeFullExtension({ tenantPlan: 'partner', subTier: 'free', isTenantMember: true });
  assert.strictEqual(r.access, true);
  assert.deepStrictEqual(r.sources, ['partner_plan']);
});

// THE BUG (2026-07-25): reqHasFullExtension passes req.tenant.plan, which is whatever tenant the
// REQUEST is scoped to (X-Tenant-Slug header / ?_tenant=) — membership was never consulted. Any
// signed-in user reading a Partner community's page was handed the paid extension.
test('computeFullExtension: partner plan does NOT grant to a non-member', () => {
  const r = features.computeFullExtension({ tenantPlan: 'partner', subTier: 'free', isTenantMember: false });
  assert.strictEqual(r.access, false);
  assert.deepStrictEqual(r.sources, []);
});

// Membership is a gate on the PARTNER path only — it must never suppress a path the user earned
// some other way. A non-member VIP keeps access.
test('computeFullExtension: non-membership does not suppress the other paths', () => {
  const r = features.computeFullExtension({
    tenantPlan: 'partner', subTier: 'ultimate', isVipHost: true, isTenantMember: false,
  });
  assert.strictEqual(r.access, true);
  assert.deepStrictEqual(r.sources, ['vip_host', 'ultimate_sub']);
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
test('computeFullExtension: every path on → every source, in FULL_EXT_SOURCES order', () => {
  const r = features.computeFullExtension({
    isVipHost: true, isCommunityMod: true, isDiscordVip: true, isTenantMember: true,
    tenantPlan: 'partner', subTier: 'ultimate', hasComp: true, compSource: 'stripe-sub',
  });
  assert.strictEqual(r.access, true);
  // paid_sub and admin_comp are mutually exclusive (one grant row, one granted_by), so the
  // full set is never emitted at once — assert against the declared order minus the other one.
  assert.deepStrictEqual(r.sources, features.FULL_EXT_SOURCES.filter(s => s !== 'admin_comp'));
});

test('computeFullExtension: emitted sources are always a subset of FULL_EXT_SOURCES', () => {
  const r = features.computeFullExtension({
    isVipHost: true, tenantPlan: 'partner', subTier: 'ultimate', hasComp: true, isTenantMember: true,
  });
  for (const s of r.sources) assert.ok(features.FULL_EXT_SOURCES.includes(s), `undeclared source: ${s}`);
});

// A $5/mo Stripe subscriber and a free admin comp both land in the SAME feature_grants row;
// only granted_by tells them apart ('stripe-sub', set by server.js setFullExtensionFn). Before
// this split, every paying customer was reported to admins as a comp.
test('computeFullExtension: a stripe-sub grant reports paid_sub, not admin_comp', () => {
  const r = features.computeFullExtension({ hasComp: true, compSource: 'stripe-sub' });
  assert.strictEqual(r.access, true);
  assert.deepStrictEqual(r.sources, ['paid_sub']);
});

test('computeFullExtension: a grant with any other granted_by is still admin_comp', () => {
  for (const src of [null, undefined, 'grandfather', '135203806676779008']) {
    const r = features.computeFullExtension({ hasComp: true, compSource: src });
    assert.deepStrictEqual(r.sources, ['admin_comp'], `compSource=${src}`);
  }
});

// ── fullExtensionFor (fetches subTier + hasComp) ─────────────────────────────

// The membership lookup is fullExtensionFor's job, mirroring how it resolves subTier — so no
// caller can forget it and silently reopen the hole.
test('fullExtensionFor: resolves membership from the memberships dep', async () => {
  features.initFeatures({
    subscriptions: null, featureGrants: null,
    memberships: { getUserCommunities: async () => ['someone-else'] },
  });
  const away = await features.fullExtensionFor('123', { tenantPlan: 'partner', tenantId: 'partnerco' });
  assert.strictEqual(away.access, false, 'non-member must not get the partner perk');

  features.initFeatures({
    subscriptions: null, featureGrants: null,
    memberships: { getUserCommunities: async () => ['partnerco'] },
  });
  const member = await features.fullExtensionFor('123', { tenantPlan: 'partner', tenantId: 'partnerco' });
  assert.deepStrictEqual(member.sources, ['partner_plan']);
});

// Fails CLOSED, matching the subscription lookup: a membership query error must not hand out
// the paid extension.
test('fullExtensionFor: membership lookup rejects → no partner_plan', async () => {
  features.initFeatures({
    subscriptions: null, featureGrants: null,
    memberships: { getUserCommunities: async () => { throw new Error('db down'); } },
  });
  const r = await features.fullExtensionFor('123', { tenantPlan: 'partner', tenantId: 'partnerco' });
  assert.strictEqual(r.access, false);
});

test('fullExtensionFor: no memberships dep → no partner_plan (fails closed)', async () => {
  features.initFeatures({ subscriptions: null, featureGrants: null, memberships: null });
  const r = await features.fullExtensionFor('123', { tenantPlan: 'partner', tenantId: 'partnerco' });
  assert.strictEqual(r.access, false);
});

test('fullExtensionFor: paid grant surfaces paid_sub via grantedBy', async () => {
  features.initFeatures({
    subscriptions: null,
    featureGrants: {
      hasGrant: (id, key) => id === '123' && key === 'full_extension',
      grantedBy: () => 'stripe-sub',
    },
  });
  const r = await features.fullExtensionFor('123', { tenantPlan: 'pro' });
  assert.deepStrictEqual(r.sources, ['paid_sub']);
});

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
