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

function initFeatures(deps) {
  subscriptions = deps.subscriptions;
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

module.exports = { canUse, initFeatures, requireTier, FEATURES };
