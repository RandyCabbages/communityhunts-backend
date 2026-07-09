// Feature gating — backend mirror of src/auth/features.js (frontend).
// Two independent tiers stack: community plan (tenant-level) + individual
// subscription (user-level). User gets the HIGHER of the two.

const COMMUNITY_RANK = { free: 0, starter: 1, pro: 2, enterprise: 3 };
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
  // The Rainbet-linking Full extension. Top-tier: Enterprise community OR Ultimate
  // individual — plus a standalone $5/mo subscription or admin grant (see hasFullExtension).
  full_extension: { community: 'enterprise', individual: 'ultimate' },
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

// Full (Rainbet) extension entitlement — the composite check for Sub-project B.
// True when the user has it via a plan ladder (Enterprise / Ultimate) OR a
// `full_extension` grant (the $5/mo Stripe subscription — set/cleared by the
// subscription webhook — or an admin comp).
async function hasFullExtension(userId, tenantPlan) {
  let tier = 'free';
  if (userId && subscriptions) {
    try { tier = (await subscriptions.getSubscription(userId))?.tier || 'free'; } catch {}
  }
  if (canUse('full_extension', tier, tenantPlan)) return true;                 // Ultimate / Enterprise
  if (featureGrants && featureGrants.hasGrant(userId, 'full_extension')) return true; // $5/mo sub or admin grant
  return false;
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

module.exports = { canUse, userCanUse, initFeatures, requireTier, hasFullExtension, FEATURES };
