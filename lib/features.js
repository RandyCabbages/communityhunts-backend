// Feature gating — backend mirror of src/auth/features.js (frontend).
// Two independent tiers stack: community plan (tenant-level) + individual
// subscription (user-level). User gets the HIGHER of the two.

// Community ladder. Internal rank keys stay tied to the Stripe plan ids
// (community_starter/pro/partner → stripped starter/pro/partner); the marketing labels
// are Creator/Pro/Partner (decoupled — see frontend pricingData.js). 'partner' replaced the
// phantom 'enterprise' top tier (nothing was ever sold at enterprise).
const COMMUNITY_RANK = { free: 0, starter: 1, pro: 2, partner: 3 };
const INDIVIDUAL_RANK = { free: 0, basic: 1, pro: 2, ultimate: 3 };

const FEATURES = {
  persistent:     { community: 'starter', individual: 'basic' },
  discord_export: { community: 'starter', individual: 'basic' },
  call_queue:     { community: 'starter', individual: 'ultimate' },
  equity:         { community: 'starter', individual: 'ultimate' },
  hunt_history:   { community: 'starter', individual: 'pro' },
  leaderboard:    { community: 'starter', individual: 'pro' },
  undo:           { community: 'starter', individual: 'pro' },
  copy_results:   { community: 'starter', individual: 'basic' },
  obs_overlay:    { community: 'pro',     individual: 'pro' },
  co_edit:        { community: 'pro',     individual: 'pro' },
  share:          { community: 'pro',     individual: 'pro' },
  overdrop:       { community: 'pro',     individual: null },
  mod_console:    { community: 'pro',     individual: null },
  personal_stats: { community: null,      individual: 'pro' },
  // Big-win replay capture + threshold-driven overlay celebration. Pro-and-above
  // on either ladder (Bean's tenant is 'pro', so his community keeps it).
  replay:         { community: 'pro',     individual: 'pro' },
  // The Rainbet-linking Full extension. NO COMMUNITY TIER — deliberately null, not an omission.
  //
  // It was community:'partner' until 2026-08-02, which made every verified member of a Partner
  // tenant entitled ("free for ALL your members"). Membership is earned by holding any role in
  // that tenant's branding.requiredRoles, and those are wager-tiered — Bean's entry role is
  // `affiliate` — so $1 wagered bought a $14.99/mo product outright. Partner now matches Pro:
  // free for VIPs and mods, which is a ROLE the community actually reserves.
  //
  // Access is decided ONLY by computeFullExtension (role / individual sub / grant). Do not gate
  // full_extension on a bare canUse() anywhere, and do not restore a community tier here without
  // re-reading why it left.
  full_extension: { community: null, individual: 'ultimate' },
  // Developer API — community-plan capability only (individual subs never unlock a community's API).
  developer_api:         { community: 'pro',     individual: null },
  developer_api_premium: { community: 'partner', individual: null },
  // The Discord bot's shared-hunt endpoints: open a run, merge roll winners onto its equity,
  // ask which winners have an account here. Community capability only — an individual sub
  // never unlocks writes against a community's hunt.
  //
  // Partner, deliberately: this hands an outside process write access to a live equity sheet,
  // which is the most trusted thing the public API does.
  //
  // NOTE the default. normalizePlan() falls back to 'pro' for a tenant with no plan set, so
  // partner is the one tier nobody arrives at by accident — a community only has this if its
  // `branding.plan` actually says `community_partner`.
  //
  // It MUST be listed here even though it looks like it could be inferred: canUse() returns
  // true for a feature name it does not recognise, so a requireApiFeature('discord_hunts')
  // guarding an unlisted name is not a gate at all — it would admit every key on every plan.
  discord_hunts:         { community: 'partner', individual: null },
};

function canUse(featureName, individualTier, tenantPlan) {
  const feat = FEATURES[featureName];
  if (!feat) return true;

  const cPlan = tenantPlan || 'free';
  const iTier = individualTier || 'free';

  if (feat.community && (COMMUNITY_RANK[cPlan] || 0) >= (COMMUNITY_RANK[feat.community] || 0)) {
    return true;
  }
  if (feat.individual && (INDIVIDUAL_RANK[iTier] || 0) >= (INDIVIDUAL_RANK[feat.individual] || 0)) {
    return true;
  }

  return false;
}

let subscriptions = null;
let featureGrants = null;
let memberships = null;

function initFeatures(deps) {
  subscriptions = deps.subscriptions;
  featureGrants = deps.featureGrants || null;
  memberships = deps.memberships || null;
}

// Source keys for the Full (Rainbet) extension, in report order. The frontend's
// SOURCE_LABELS map (src/admin/userProfile/AdminControls.js) MUST use these exact keys —
// sync constraint, same class as catalog.js <-> ITEM_TIERS.
// paid_sub and admin_comp are mutually exclusive: both are one feature_grants row, told apart
// only by granted_by ('stripe-sub' = the customer is paying).
const FULL_EXT_SOURCES = ['vip_host', 'community_mod', 'discord_vip',
                          'ultimate_sub', 'paid_sub', 'admin_comp'];

// granted_by written by the Stripe webhook (server.js setFullExtensionFn). Any other value —
// an admin's Discord id, 'grandfather', null — is a comp.
const STRIPE_GRANT_BY = 'stripe-sub';

// The single definition of who has the Full extension, and WHY. Pure — it fetches nothing,
// so each caller supplies role flags its own way: the extension's hot path passes the cached
// session flag (free), the admin panel passes a live Discord lookup. Callers must never
// re-implement this OR-list; that drift is the bug this function exists to prevent.
// NO COMMUNITY-PLAN LADDER HERE, deliberately — the Full extension is unlocked by ROLE, an
// individual subscription, or a grant. Never by a tenant's plan alone.
//
// The Partner plan used to add a 'partner_plan' source for any VERIFIED MEMBER of a Partner
// tenant ("free for ALL your members"). Removed 2026-08-02: membership is reachable by holding
// ANY role the tenant lists in branding.requiredRoles, and those are wager-tiered — on Bean's
// config the entry role is `affiliate`. So a viewer could wager $1, take the affiliate role,
// and hold a $14.99/mo product free, permanently. That is not a leak in the membership check
// (it works); the perk itself was priced wrong. Partner now matches Pro: VIPs and mods.
//
// If a broad perk is ever wanted again, gate it on a ROLE the tenant treats as premium — never
// on membership, which is the cheapest thing a community sells.
function computeFullExtension({ isVipHost, isCommunityMod, isDiscordVip,
                                subTier, hasComp, compSource } = {}) {
  const sources = [];
  if (isVipHost)      sources.push('vip_host');
  if (isCommunityMod) sources.push('community_mod');
  if (isDiscordVip)   sources.push('discord_vip');
  // 'free' on the community ladder isolates the INDIVIDUAL one — canUse folds both together
  // and could not report which fired. full_extension has no community tier now, so this is
  // belt-and-braces rather than load-bearing; it keeps the call honest if that ever changes.
  if (canUse('full_extension', subTier, 'free'))    sources.push('ultimate_sub');
  if (hasComp)        sources.push(compSource === STRIPE_GRANT_BY ? 'paid_sub' : 'admin_comp');
  return { access: sources.length > 0, sources };
}

// User-scoped entitlement. Fetches the two inputs this module owns (individual sub tier and the
// full_extension grant + who granted it) and defers the decision to computeFullExtension. Role
// flags come from the caller. Every lookup fails CLOSED — a DB error means no access, never a
// free extension.
//
// The tenant membership lookup that used to live here is GONE with the partner_plan source. It
// also means this no longer queries memberships on a path the extension hits on every load.
// tenantPlan/tenantId/isGuildMember are still ACCEPTED and ignored so existing callers keep
// working; nothing about a tenant grants this any more.
async function fullExtensionFor(userId, { isVipHost, isCommunityMod, isDiscordVip } = {}) {
  let subTier = 'free';
  if (userId && subscriptions) {
    try { subTier = (await subscriptions.getSubscription(userId))?.tier || 'free'; } catch {}
  }
  const hasComp = !!(featureGrants && featureGrants.hasGrant(userId, 'full_extension'));
  return computeFullExtension({
    isVipHost, isCommunityMod, isDiscordVip, subTier, hasComp,
    compSource: hasComp && featureGrants.grantedBy
      ? featureGrants.grantedBy(userId, 'full_extension') : null,
  });
}

// Resolve a specific user's tier and answer canUse() — for inline gating (not
// middleware), e.g. gating a field in a response or a value on save. Looks up
// the individual subscription tier; the tenant plan is passed in by the caller
// (usually req.tenant?.plan). Fails closed to 'free' if the lookup errors.
async function userCanUse(featureName, userId, tenantPlan) {
  let individualTier = 'free';
  if (userId && subscriptions) {
    try {
      const sub = await subscriptions.getSubscription(userId);
      individualTier = sub?.tier || 'free';
    } catch {}
  }
  return canUse(featureName, individualTier, tenantPlan || 'free');
}

function requireTier(featureName) {
  return async (req, res, next) => {
    const tenantPlan = req.tenant?.plan || 'free';
    let individualTier = 'free';
    if (req.user?.id && subscriptions) {
      try {
        const sub = await subscriptions.getSubscription(req.user.id);
        individualTier = sub?.tier || 'free';
      } catch {}
    }
    if (!canUse(featureName, individualTier, tenantPlan)) {
      return res.status(403).json({ error: 'Upgrade required', feature: featureName });
    }
    next();
  };
}

module.exports = { canUse, userCanUse, initFeatures, requireTier,
  computeFullExtension, fullExtensionFor, FULL_EXT_SOURCES, FEATURES };
