// External-integration routes. Logic lives in lib/integrations.js; these are thin
// delegations. Mounted from the server.js composition root.
//
//   GET /api/bean-live             → active tenant's Twitch live status
//   GET /api/tenant-config         → PUBLIC branding (no secrets) — field names are contract
//   GET /api/tenants               → PUBLIC directory for the platform home — field names are contract
//   GET /api/leaderboard           → per-tenant leaderboard proxy (serves stale cache on upstream blip)
//   GET /api/discord/import-calls  → import slot calls from Discord (auth; user's active hunt)
//   GET /api/discord/parse-winners → parse VIP winners from Discord (auth)

const express = require('express');

module.exports = function integrationsRoutes(deps) {
  const { integrations, tenants, memberships, hunts, normalizeSlot, requireAuth } = deps;
  const router = express.Router();

  router.get('/api/bean-live', (req, res) => res.json(integrations.getLiveStatus(req.tenant.slug)));

  // Active tenant's public branding — NO secrets (bot tokens, channel ids excluded).
  router.get('/api/tenant-config', (req, res) => {
    const t = req.tenant;
    const b = t.branding || {};
    res.json({
      slug: t.slug, displayName: t.displayName,
      branding: b,
      leaderboardUrl: !!t.leaderboardUrl,
      twitchChannel: t.twitchChannel || null,
      // The community's own social links ([{ type, url }]); the hub renders these, never Bean's.
      socials: Array.isArray(b.socials) ? b.socials : null,
      requiredRoles: b.requiredRoles || null,
      discordInvite: b.discordInvite || null,
      // Which casino the slot deep-links point at (null = none → linkless slot art).
      casino: b.casino || null,
      // Community plan drives feature gating. Send the NORMALIZED, stripped form
      // ('starter'/'pro'/'partner') that canUse() ranks — never the raw 'community_*'
      // Stripe id, which ranks as 0 (free). A tenant with no plan set resolves to 'pro'
      // (normalizePlan fallback), matching the TenantLayout default. Field name is contract.
      plan: tenants.normalizePlan(b.plan),
    });
  });

  // Directory for the platform home — minimal public fields per tenant, incl. member count.
  router.get('/api/tenants', async (req, res) => {
    const counts = await memberships.getMemberCounts();
    res.json(tenants.getAllTenants().filter(t => t.isActive).map(t => ({
      slug: t.slug, displayName: t.displayName,
      accent: (t.branding || {}).accent || null,
      twitchChannel: t.twitchChannel || null,
      memberCount: counts[t.id] || 0,
    })));
  });

  router.get('/api/leaderboard', async (req, res) => {
    try {
      res.json(await integrations.getLeaderboard(req.tenant));
    } catch (e) {
      console.error('[leaderboard] proxy error:', e.message);
      // Serve stale cache if we have it, so a transient upstream blip doesn't blank the panel.
      const stale = integrations.getLeaderboardCache(req.tenant.slug);
      if (stale) return res.json(stale);
      res.status(502).json({ error: 'leaderboard unavailable' });
    }
  });

  // Import slot calls from last 20 mins — only from equity members of the user's hunt.
  router.get('/api/discord/import-calls', requireAuth, async (req, res) => {
    try {
      const hunt = hunts[req.user.id];
      if (!hunt) return res.status(404).json({ error: 'No active hunt' });
      res.json(await integrations.importCalls(hunt, normalizeSlot, req.tenant));
    } catch(e) {
      res.status(500).json({ error: e.message });
    }
  });

  // Parse winners from Discord — ?type=affiliate uses the affiliate channel; default is VIP.
  router.get('/api/discord/parse-winners', requireAuth, async (req, res) => {
    try {
      const type = req.query.type === 'affiliate' ? 'affiliate' : 'vip';
      const t = req.tenant;
      const ch = type === 'affiliate' ? t?.discordAffiliateWinnersChannelId : t?.discordVipWinnersChannelId;
      // Never log any slice of the bot token (CWE-532, security audit 2026-07-18 #5) — boolean only.
      console.log(`[parse-winners] tenant=${t?.id} type=${type} channel=${ch} hasToken=${!!t?.discordBotToken}`);
      res.json(await integrations.parseWinners(req.tenant, type));
    } catch(e) {
      res.status(500).json({ error: e.message });
    }
  });

  return router;
};
