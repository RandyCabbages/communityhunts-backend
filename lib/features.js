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
  // The Rainbet-linking Full extension. The Partner community plan is the headline perk:
  // EVERY member of a Partner tenant gets it free (community:'partner'). On lower tiers it's
  // still unlocked per-user by ROLE (tenant VIP/mod/Discord-guild VIP — free, via
  // reqHasFullExtension), a standalone $5/mo subscription or admin grant, or the top INDIVIDUAL
  // tier. See computeFullExtension for the composite check.
  full_extension: { community: 'partner', individual: 'ultimate' },
  // Developer API — community-plan capability only (individual subs never unlock a community's API).
  developer_api:         { community: 'pro',     individual: null },
  developer_api_premium: { community: 'partner', individual: null },
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

function initFeatures(deps) {
  subscriptions = deps.subscriptions;
  featureGrants = deps.featureGrants || null;
}

// Source keys for the Full (Rainbet) extension, in report order. The frontend's
// SOURCE_LABELS map (src/admin/userProfile/AdminControls.js) MUST use these exact keys —
// sync constraint, same class as catalog.js <-> ITEM_TIERS.
const FULL_EXT_SOURCES = ['vip_host', 'community_mod', 'discord_vip',
                          'partner_plan', 'ultimate_sub', 'admin_comp'];

// The single definition of who has the Full extension, and WHY. Pure — it fetches nothing,
// so each caller supplies role flags its own way: the extension's hot path passes the cached
// session flag (free), the admin panel passes a live Discord lookup. Callers must never
// re-implement this OR-list; that drift is the bug this function exists to prevent.
function computeFullExtension({ isVipHost, isCommunityMod, isDiscordVip,
                                tenantPlan, subTier, hasComp } = {}) {
  const sources = [];
  if (isVipHost)      sources.push('vip_host');
  if (isCommunityMod) sources.push('community_mod');
  if (isDiscordVip)   sources.push('discord_vip');
  // Passing the neutral 'free' on the OPPOSITE ladder isolates which ladder granted it —
  // canUse alone folds both together and can't report which one fired.
  if (canUse('full_extension', 'free', tenantPlan)) sources.push('partner_plan');
  if (canUse('full_extension', subTier, 'free'))    sources.push('ultimate_sub');
  if (hasComp)        sources.push('admin_comp');
  return { access: sources.length > 0, sources };
}

// User-scoped entitlement. Fetches the two inputs this module owns (individual sub tier and
// the full_extension comp grant) and defers the decision to computeFullExtension. Role flags
// come from the caller. Fails closed to 'free' if the subscription lookup errors, matching
// userCanUse.
async function fullExtensionFor(userId, { tenantPlan, isVipHost, isCommunityMod, isDiscordVip } = {}) {
  let subTier = 'free';
  if (userId && subscriptions) {
    try { subTier = (await subscriptions.getSubscription(userId))?.tier || 'free'; } catch {}
  }
  return computeFullExtension({
    isVipHost, isCommunityMod, isDiscordVip, tenantPlan, subTier,
    hasComp: !!(featureGrants && featureGrants.hasGrant(userId, 'full_extension')),
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
