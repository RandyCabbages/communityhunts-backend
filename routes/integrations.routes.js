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
  const { integrations, tenants, memberships, hunts, normalizeSlot, requireAuth, supporters, getKnownUser, getSettings } = deps;
  const router = express.Router();

  // Lightweight per-caller throttle for the upstream-proxy endpoints (security audit 2026-07-18 #7):
  // /leaderboard, /discord/import-calls and /discord/parse-winners each fan out to Discord/beantwitch.
  // They're auth-gated (except leaderboard) and cached, so this only clips a hot loop — the window is
  // deliberately generous. In-memory fixed window, single instance, resets on deploy. Keyed by user id
  // when authenticated, else tenant slug + ip so one caller can't drive repeated upstream fetches.
  const _hits = new Map(); // key -> { start, count }
  let _lastSweep = 0;
  function throttle(max, windowMs) {
    return (req, res, next) => {
      const now = Date.now();
      if (now - _lastSweep > windowMs) { // evict expired windows so the map can't grow unbounded
        _lastSweep = now;
        for (const [k, b] of _hits) if (now - b.start >= windowMs) _hits.delete(k);
      }
      const key = `${req.path}:${req.user?.id || `${req.tenant?.slug || '-'}:${req.ip || ''}`}`;
      let b = _hits.get(key);
      if (!b || now - b.start >= windowMs) { b = { start: now, count: 0 }; _hits.set(key, b); }
      if (++b.count > max) {
        res.set('Retry-After', String(Math.max(1, Math.ceil((b.start + windowMs - now) / 1000))));
        return res.status(429).json({ error: 'Too many requests, slow down' });
      }
      next();
    };
  }

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

  // Public badge roster for the ACTIVE tenant. owners+supporters are global; king+mods are this
  // tenant's. Powers the frontend flair badges. No secrets — these badges are shown publicly.
  // Served from in-memory caches; no per-request DB hit.
  router.get('/api/badges', (req, res) => {
    const t = req.tenant || {};
    res.json({
      owners: (tenants.PLATFORM_OWNER_IDS || []).map(String),
      king: t.hostDiscordId ? String(t.hostDiscordId) : null,
      mods: (t.modIds || []).map(String),
      supporters: supporters.getSupporterIds(),
    });
  });

  // Public supporters roster for the Wall of Supporters on /support-us. Enriched with display
  // name + avatar from the known_users directory (best-effort; unknown ids still list by id).
  // No secrets — supporter status is already public via the flair badge.
  router.get('/api/supporters/public', throttle(30, 60_000), async (req, res) => {
    let rows = [];
    try { rows = await supporters.listSupporters(); } catch (e) { console.error('[supporters] listSupporters failed:', e.message); rows = []; }
    const out = await Promise.all(rows.map(async (r) => {
      let known = null, settings = null;
      try { known = getKnownUser ? await getKnownUser(r.discordId) : null; } catch (e) { console.error('[supporters] getKnownUser failed:', e.message); }
      try { settings = getSettings ? await getSettings(r.discordId) : null; } catch (e) { console.error('[supporters] getSettings failed:', e.message); }
      const card = settings && settings.cosmetics && settings.cosmetics.card ? String(settings.cosmetics.card) : null;
      return {
        discordId: String(r.discordId),
        displayName: known && known.displayName ? String(known.displayName) : null,
        avatar: known && known.avatar ? String(known.avatar) : null,
        cosmeticCard: card,   // their equipped equity card (public; shown in hunts to everyone anyway)
      };
    }));
    res.json({ supporters: out });
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

  router.get('/api/leaderboard', throttle(30, 60_000), async (req, res) => {
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
  router.get('/api/discord/import-calls', requireAuth, throttle(20, 60_000), async (req, res) => {
    try {
      const hunt = hunts[req.user.id];
      if (!hunt) return res.status(404).json({ error: 'No active hunt' });
      res.json(await integrations.importCalls(hunt, normalizeSlot, req.tenant));
    } catch(e) {
      res.status(500).json({ error: e.message });
    }
  });

  // Parse winners from Discord — ?type=affiliate uses the affiliate channel; default is VIP.
  router.get('/api/discord/parse-winners', requireAuth, throttle(20, 60_000), async (req, res) => {
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
