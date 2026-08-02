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

// NO COMMUNITY PLAN GRANTS THIS — removed 2026-08-02. Membership of a Partner tenant is earned
// by holding any role in branding.requiredRoles, and those are wager-tiered (Bean's entry role
// is `affiliate`), so "free for ALL your members" meant $1 wagered bought a $14.99/mo product
// for life. Partner now matches Pro: VIPs and mods.
//
// Pinned at the top tier with a verified member, i.e. the most generous case the old rule had.
test('computeFullExtension: a Partner plan grants NOTHING on its own', () => {
  const r = features.computeFullExtension({
    tenantPlan: 'partner', subTier: 'free', isVerifiedMember: true,
  });
  assert.strictEqual(r.access, false);
  assert.deepStrictEqual(r.sources, []);
});

// The affiliate route, stated as the scenario rather than as flags: wagered $1, holds the entry
// role, therefore a verified member of a Partner community. Must buy the extension like anyone else.
test('computeFullExtension: an affiliate-tier member of a Partner tenant has NO access', () => {
  const affiliate = { tenantPlan: 'partner', isVerifiedMember: true, subTier: 'free',
                      isVipHost: false, isCommunityMod: false, isDiscordVip: false };
  assert.strictEqual(features.computeFullExtension(affiliate).access, false);
});

// The flip side, and the point of the change: the SAME community's VIPs and mods keep it free.
test('computeFullExtension: VIPs and mods of that tenant still get it', () => {
  for (const role of ['isVipHost', 'isCommunityMod', 'isDiscordVip']) {
    const r = features.computeFullExtension({ tenantPlan: 'partner', subTier: 'free', [role]: true });
    assert.strictEqual(r.access, true, `${role} must still grant access`);
  }
});

// tenantPlan must not suppress a path earned some other way either.
test('computeFullExtension: a plan of any kind never suppresses the other paths', () => {
  const r = features.computeFullExtension({
    tenantPlan: 'partner', subTier: 'ultimate', isVipHost: true,
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
    isVipHost: true, isCommunityMod: true, isDiscordVip: true,
    subTier: 'ultimate', hasComp: true, compSource: 'stripe-sub',
  });
  assert.strictEqual(r.access, true);
  // paid_sub and admin_comp are mutually exclusive (one grant row, one granted_by), so the
  // full set is never emitted at once — assert against the declared order minus the other one.
  assert.deepStrictEqual(r.sources, features.FULL_EXT_SOURCES.filter(s => s !== 'admin_comp'));
});

// tenantPlan/isVerifiedMember are passed deliberately even though nothing reads them — they are
// the inputs the removed partner_plan source used, so this also asserts they cannot bring back an
// undeclared source. Don't "tidy" them away.
test('computeFullExtension: emitted sources are always a subset of FULL_EXT_SOURCES', () => {
  const r = features.computeFullExtension({
    isVipHost: true, tenantPlan: 'partner', subTier: 'ultimate', hasComp: true, isVerifiedMember: true,
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

// Membership no longer participates at all (partner_plan removed 2026-08-02). These pin that
// it CANNOT come back through the data: whatever a membership lookup would have said, and
// whatever tenant the request is scoped to, the answer is no.
const partnerAsk = (opts) => features.fullExtensionFor('123',
  { tenantPlan: 'partner', tenantId: 'partnerco', ...opts });

// Every membership shape the old rule accepted — a role membership, a guild-verified self-join —
// now grants nothing. Previously the first two returned ['partner_plan'].
test('fullExtensionFor: no membership shape grants access on a Partner tenant', async () => {
  for (const source of ['role', 'self', null]) {
    features.initFeatures({
      subscriptions: null, featureGrants: null,
      memberships: { getMembershipSource: async () => source },
    });
    for (const isGuildMember of [true, false]) {
      const r = await partnerAsk({ isGuildMember });
      assert.strictEqual(r.access, false,
        `source=${source} isGuildMember=${isGuildMember} must not grant the paid extension`);
    }
  }
});

// The lookup is gone, not merely ignored — a memberships dep that would throw or hand back a
// membership must never be consulted on the extension's hot path.
test('fullExtensionFor: the memberships dep is not consulted at all', async () => {
  let asked = false;
  features.initFeatures({
    subscriptions: null, featureGrants: null,
    memberships: { getMembershipSource: async () => { asked = true; return 'role'; } },
  });
  await partnerAsk({ isGuildMember: true });
  assert.strictEqual(asked, false, 'no membership query belongs on this path any more');
});

// Removing the partner path must not suppress a path earned elsewhere.
test('fullExtensionFor: a user on a Partner tenant keeps access earned another way', async () => {
  features.initFeatures({
    subscriptions: { getSubscription: async () => ({ tier: 'ultimate' }) }, featureGrants: null,
    memberships: { getMembershipSource: async () => null },
  });
  assert.deepStrictEqual((await partnerAsk()).sources, ['ultimate_sub']);
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

// ── discord_hunts: the Discord bot's write access to a live equity sheet ─────

test('discord_hunts: partner only', () => {
  for (const plan of ['free', 'starter', 'pro']) {
    assert.strictEqual(features.canUse('discord_hunts', null, plan), false, plan);
  }
  assert.strictEqual(features.canUse('discord_hunts', 'partner'), false, 'not an individual perk');
  assert.strictEqual(features.canUse('discord_hunts', null, 'partner'), true);
});

test('discord_hunts: is DECLARED, not falling through the unknown-name default', () => {
  // canUse() returns true for a name it does not recognise, so requireApiFeature() guarding an
  // undeclared feature is not a gate at all — it admits every key on every plan. This asserts
  // the gate exists by asserting a free tenant is refused; a typo'd or deleted entry here would
  // silently reopen the endpoints to everyone, which is exactly the kind of hole nothing else
  // would notice.
  assert.strictEqual(features.canUse('discord_hunts', null, 'free'), false);
  assert.strictEqual(features.canUse('a_feature_nobody_declared', null, 'free'), true,
    'the fail-open default this guards against');
});

test('discord_hunts: a tenant with no plan set does NOT get it', () => {
  // normalizePlan() falls back to 'pro' for an unset plan, so pro is reachable by accident and
  // partner is not. That is the reason this sits at partner rather than pro.
  assert.strictEqual(features.canUse('discord_hunts', null, undefined), false);
  assert.strictEqual(features.canUse('discord_hunts', null, 'pro'), false);
});
