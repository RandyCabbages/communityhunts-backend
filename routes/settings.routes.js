// User settings + admin user-management routes. Thin router over lib/settings.js.
// Mounted from the server.js composition root, AFTER the auth middlewares exist
// (requireAuth/requireAdmin and isPlatformAdmin are injected via deps).
//
//   GET  /api/settings                  → current user's settings
//   PUT  /api/settings                  → save current user's settings (+ Discord identity)
//   GET  /api/settings/:userId          → another user's preferred slots / rainbet name
//   GET  /api/settings/by-name/:name    → lookup by Discord username/displayName
//   POST /api/admin/set-rainbet-name    → admin sets another user's rainbet name
//   GET  /api/admin/users               → tenant-scoped user list
//   GET  /api/admin/users/:userId       → one user's full profile
//   POST /api/admin/set-user-field      → admin sets rainbetName/twitchName for someone
//   POST /api/admin/set-preferred-slots → admin sets another user's preferred slots

const express = require('express');
const { DEFAULT_OVERLAY_CONFIG, sanitizeOverlayConfig } = require('../lib/overlayConfig');
const { isItemAccessible, ITEM_TIERS, MOD_ONLY_ITEMS } = require('./cosmetics.routes');
const { userCanUse, fullExtensionFor } = require('../lib/features');

module.exports = function settingsRoutes(deps) {
  const { settings, pgPool, memberships, isPlatformAdmin, reqIsMod, reqHasFullExtension, requireAuth, requireAdmin, io, subscriptions, featureGrants, hunts, archive, statsStore, tenants, refreshGuildRoles } = deps;
  const { getSettings, saveSettings, resolveUserIdByName } = settings;
  const { computeUserHuntStats } = require('../lib/userStats');

  // Raw hunts (with bonuses/equity) for a tenant — union of current + archived, deduped by
  // huntId. Mirrors lib/hunts-core.getAllHunts but WITHOUT the summary map (aggregation needs
  // the raw bonuses/equity that huntSummary strips).
  function rawTenantHunts(tenantId) {
    const tid = tenantId || 'bean';
    const current = Object.values(hunts || {}).filter(h => (h.tenantId || 'bean') === tid);
    const seen = new Set(current.map(h => h.huntId).filter(Boolean));
    const archivedOnly = (archive || []).filter(h => (h.tenantId || 'bean') === tid && (!h.huntId || !seen.has(h.huntId)));
    return [...current, ...archivedOnly];
  }
  const router = express.Router();

  // Overlay/widget config — cosmetic per-streamer prefs stored in user_settings JSONB.
  // Shape + sanitizer live in lib/overlayConfig.js (mirrors frontend src/overlay/overlayConfig.js).

  // GET /api/settings — get current user's settings
  router.get('/api/settings', requireAuth, async (req, res) => {
    const s = await getSettings(req.user.id);
    // Big-win replay capture threshold (x). Absent for existing users → default 300.
    if (typeof s.replayThreshold !== 'number') s.replayThreshold = 300;
    // Replay is a Pro feature — a non-entitled caller gets 0, which disarms the
    // capture prompt on the site and the extension (both key off threshold > 0).
    if (!(await userCanUse('replay', req.user.id, req.tenant?.plan))) s.replayThreshold = 0;
    res.json(s);
  });

  // GET /api/my-stats — the caller's own all-time hunt stats for the active tenant.
  router.get('/api/my-stats', requireAuth, async (req, res) => {
    try {
      const tenantId = req.tenant?.id || 'bean';
      const stats = statsStore
        ? await statsStore.getUserStats(tenantId, String(req.user.id))
        : computeUserHuntStats(rawTenantHunts(tenantId), String(req.user.id));
      res.json(stats || {});
    } catch (e) {
      console.error('[my-stats] failed:', e.message);
      res.status(500).json({ error: 'Failed to load stats' });
    }
  });

  // PUT /api/settings — save current user's settings (also stores their Discord names for lookup)
  router.put('/api/settings', requireAuth, async (req, res) => {
    const current = await getSettings(req.user.id);
    const { rainbetName, twitchName, preferredSlots } = req.body;
    if (rainbetName !== undefined)    current.rainbetName    = String(rainbetName).trim().slice(0, 64);
    if (twitchName  !== undefined)    current.twitchName     = String(twitchName).trim().slice(0, 64);
    if (preferredSlots !== undefined) current.preferredSlots = (preferredSlots || []).filter(Boolean);
    if (req.body.anonymous !== undefined) current.anonymous  = !!req.body.anonymous;
    // Viewer-side equity-card display prefs (see frontend CardPrefsContext). Booleans, default off.
    if (req.body.hideEquityCards       !== undefined) current.hideEquityCards       = !!req.body.hideEquityCards;
    if (req.body.disableEquityCardAnim !== undefined) current.disableEquityCardAnim = !!req.body.disableEquityCardAnim;
    if (req.body.replayThreshold !== undefined
        && await userCanUse('replay', req.user.id, req.tenant?.plan)) {
      // Big-win replay threshold (x). 0 disables prompting. Garbage falls back to the default.
      // Pro-gated: a non-entitled caller's threshold change is ignored (value left as-is).
      const n = Number(req.body.replayThreshold);
      current.replayThreshold = Number.isFinite(n) && n >= 0 ? Math.min(n, 1000000) : 300;
    }
    if (req.body.overlayConfig !== undefined) current.overlayConfig = sanitizeOverlayConfig(req.body.overlayConfig);
    if (req.body.cosmetics !== undefined) {
      const c = req.body.cosmetics && typeof req.body.cosmetics === 'object' ? req.body.cosmetics : {};
      // Platform admins get the same "everything unlocked" bypass the Shop UI grants them
      // (frontend isAdmin ⇒ tier 'admin'). Without this, an owner (who has no Stripe sub, so
      // tier resolves to 'free') has every paid equip silently dropped by isItemAccessible
      // below — and the tracker, which trusts the backend as source of truth, then shows nothing.
      let userTier = isPlatformAdmin(req.user) ? 'admin' : 'free';
      if (userTier !== 'admin' && subscriptions) {
        try { const sub = await subscriptions.getSubscription(req.user.id); userTier = sub?.tier || 'free'; } catch {}
      }
      const owned = current.cosmeticsOwned || [];
      const safe = {};
      // Community mods + platform admins get the ENTIRE cosmetics catalog free (mirrors the frontend
      // isItemAccessible/getAccessLabel mod grant): any KNOWN item is equippable. Everyone else goes
      // through the unchanged tier/ownership gate.
      const priv = isPlatformAdmin(req.user) || reqIsMod(req);
      for (const k of ['card','theme','sound','effect','flair','background']) {
        if (c[k] === undefined) continue;
        const itemId = c[k] ? String(c[k]).slice(0, 64) : null;
        // Mod-only items (e.g. card_mod): only community mods or platform admins may equip.
        if (itemId && MOD_ONLY_ITEMS && MOD_ONLY_ITEMS.has(itemId) && !priv) continue;
        // priv → allow any known item; non-priv → normal accessibility gate (unchanged behaviour).
        if (itemId && (priv ? !(itemId in ITEM_TIERS) : !isItemAccessible(itemId, userTier, owned))) continue;
        safe[k] = itemId;
      }
      if (typeof c.soundVolume === 'number') safe.soundVolume = Math.max(0, Math.min(1, c.soundVolume));
      if (c.effectsEnabled !== undefined) safe.effectsEnabled = !!c.effectsEnabled;
      current.cosmetics = { ...(current.cosmetics || {}), ...safe };
    }
    // Always update Discord identity for name-based lookup by other hunt owners
    current.discordUsername    = req.user.username || '';
    current.discordDisplayName = req.user.displayName || req.user.username || '';
    current.discordId          = req.user.id;
    await saveSettings(req.user.id, current);
    // Live-restyle: the streamer's OBS overlay sits in room hunt:<their id> (watch:hunt join),
    // so a Studio save restyles it without a source refresh. Cosmetic config only — already
    // public via GET /api/overlay-config/:userId.
    if (req.body.overlayConfig !== undefined && io) {
      io.to(`hunt:${req.user.id}`).emit('overlay-config:update', current.overlayConfig);
    }
    res.json({ ok: true, settings: current });
  });

  // Is the caller allowed to see an anonymous user's identity (Rainbet/Twitch)? Yes when it's
  // themselves, or a mod/admin of the current tenant (reqIsMod folds in platform admins). The
  // hunt-runner case is covered separately: the Discord name reaches them via the hunt payload
  // (publicHuntView marks the host privileged), not this lookup.
  const canSeeIdentity = (req, targetId, s) =>
    !s.anonymous
    || (req.user && String(req.user.id) === String(targetId))
    || (typeof reqIsMod === 'function' && reqIsMod(req));

  // GET /api/extension/entitlement — does the caller have Full (Rainbet) extension access?
  // The self-distributed Full extension calls this on load to gate its Rainbet features
  // (Sub-project B). Tenant VIPs/mods/guild-VIPs get it free (see reqHasFullExtension in
  // server.js). CORS already allows chrome-extension:// / moz-extension:// origins.
  router.get('/api/extension/entitlement', requireAuth, async (req, res) => {
    res.json({ fullAccess: await reqHasFullExtension(req) });
  });

  // POST /api/admin/grandfather-full-extension — one-time backfill granting Full-extension
  // access to all existing users (run once at Sub-project B launch so updates don't cut
  // anyone off). Idempotent.
  router.post('/api/admin/grandfather-full-extension', requireAuth, requireAdmin, async (req, res) => {
    if (!featureGrants?.grandfatherGrant) return res.status(503).json({ error: 'grants unavailable' });
    try {
      const granted = await featureGrants.grandfatherGrant('full_extension', `grandfather-by-${req.user.id}`);
      res.json({ ok: true, granted });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // GET /api/settings/:userId — get another user's preferred slots and rainbet name by Discord ID
  router.get('/api/settings/:userId', requireAuth, async (req, res) => {
    const s = await getSettings(req.params.userId);
    const show = canSeeIdentity(req, req.params.userId, s);
    res.json({
      preferredSlots: s.preferredSlots || [],
      rainbetName: show ? (s.rainbetName || '') : '',
      twitchName:  show ? (s.twitchName  || '') : '',
      anonymous: !!s.anonymous,
      cosmetics: s.cosmetics || null,
    });
  });

  // GET /api/overlay-config/:userId — PUBLIC (no requireAuth). The OBS browser-source is
  // unauthenticated and reads the streamer's chosen overlay style by Discord ID. Cosmetic
  // prefs only (no secrets); always returns a valid, defaults-merged config.
  router.get('/api/overlay-config/:userId', async (req, res) => {
    const s = await getSettings(req.params.userId);
    // Big-win celebration + "big" row highlight fire at the streamer's replay
    // threshold. Gate by the STREAMER's (target's) entitlement — 0 when the
    // streamer isn't Pro, so the overlay celebrates nothing. Tenant plan comes
    // from the request's tenant context (global resolveTenant).
    let replayThreshold = typeof s.replayThreshold === 'number' ? s.replayThreshold : 300;
    if (!(await userCanUse('replay', req.params.userId, req.tenant?.plan))) replayThreshold = 0;
    res.json({ ...DEFAULT_OVERLAY_CONFIG, ...sanitizeOverlayConfig(s.overlayConfig || {}), replayThreshold });
  });

  // GET /api/settings/by-name/:name — look up another user's preferred slots & rainbet by their Discord username/displayName
  // Used when a hunt owner adds a member by name and we don't know their Discord ID
  // Delegates to resolveUserIdByName so this stays real-ID-priority — same as the admin
  // write routes below — instead of an unsorted find() that could return a stale
  // synthetic `manual:<name>` row (no preferredSlots) ahead of the member's real account.
  router.get('/api/settings/by-name/:name', requireAuth, async (req, res) => {
    const userId = await resolveUserIdByName(req.params.name || '');
    if (userId) {
      const s = await getSettings(userId);
      const show = canSeeIdentity(req, userId, s);
      return res.json({
        preferredSlots: s.preferredSlots || [],
        rainbetName:    show ? (s.rainbetName || '') : '',
        twitchName:     show ? (s.twitchName  || '') : '',
        anonymous:      !!s.anonymous,
        cosmetics:      s.cosmetics || null,
        userId,
      });
    }
    res.json({ preferredSlots: [], rainbetName: '', twitchName: '' });
  });

  // POST /api/admin/set-rainbet-name — let an admin manually set another user's Rainbet name.
  // Accepts either { userId, rainbetName } (Discord ID known) or { name, rainbetName } (only name known).
  // When only a name is supplied, a synthetic settings row is keyed by `manual:<lowercased-name>` so the
  // existing by-name lookup matches via discordDisplayName.
  router.post('/api/admin/set-rainbet-name', requireAdmin, async (req, res) => {
    const rainbetName = String(req.body?.rainbetName || '').trim().slice(0, 64);
    if (!rainbetName) return res.status(400).json({ error: 'rainbetName required' });
    const userId = (req.body?.userId || '').toString().trim();
    const name   = (req.body?.name   || '').toString().trim();
    if (!userId && !name) return res.status(400).json({ error: 'Provide userId or name' });

    if (userId) {
      const current = await getSettings(userId);
      current.rainbetName = rainbetName;
      await saveSettings(userId, current);
      return res.json({ ok: true, scope: 'userId', userId, rainbetName });
    }

    // Name-only path: create or update a synthetic entry so the by-name lookup will find it later.
    const syntheticId = `manual:${name.toLowerCase()}`;
    const current = await getSettings(syntheticId);
    current.rainbetName       = rainbetName;
    current.discordDisplayName = name;     // makes /api/settings/by-name/:name match this row
    current.discordUsername    = name;
    await saveSettings(syntheticId, current);
    res.json({ ok: true, scope: 'name', name, syntheticId, rainbetName });
  });

  // GET /api/admin/users — list users (known_users ⨝ user_settings). INTERIM: not tenant-scoped
  // (known_users has no tenant column); fine while Bean is the only user-bearing tenant. Per-tenant
  // scoping is P4. Membership (community_members) is now affiliate-only, so it can't back this list.
  router.get('/api/admin/users', requireAuth, requireAdmin, async (req, res) => {
    if (!pgPool) return res.json({ users: [] });
    const q = String(req.query.q || '').trim().toLowerCase();
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
    try {
      const params = [];
      let where = '';
      if (q) {
        params.push(`%${q}%`);
        where = `WHERE (LOWER(ku.display_name) LIKE $${params.length}
                     OR LOWER(ku.username) LIKE $${params.length}
                     OR ku.user_id LIKE $${params.length})`;
      }
      params.push(limit, offset);
      const sql = `
        SELECT ku.user_id, ku.display_name, ku.username, ku.avatar, ku.last_seen,
               us.settings
        FROM known_users ku
        LEFT JOIN user_settings us ON us.user_id = ku.user_id
        ${where}
        ORDER BY ku.last_seen DESC NULLS LAST
        LIMIT $${params.length - 1} OFFSET $${params.length}`;
      const r = await pgPool.query(sql, params);
      const users = r.rows.map(row => {
        const s = row.settings || {};
        return {
          id: row.user_id, displayName: row.display_name, username: row.username,
          avatar: row.avatar, lastSeen: row.last_seen,
          rainbetName: s.rainbetName || null, twitchName: s.twitchName || null,
          slotPickCount: Array.isArray(s.preferredSlots) ? s.preferredSlots.length : 0,
        };
      });
      res.json({ users });
    } catch (e) {
      console.error('[admin] users list failed:', e.message);
      res.status(500).json({ error: 'Failed to list users' });
    }
  });

  // GET /api/admin/users/:userId — one user's full profile. INTERIM: no membership guard (see the
  // /api/admin/users comment above) — any known user's profile is visible to any tenant admin.
  // Per-tenant scoping is P4. `stats` below are still computed against req.tenant's hunts.
  router.get('/api/admin/users/:userId', requireAuth, requireAdmin, async (req, res) => {
    const userId = String(req.params.userId);
    const tenantId = req.tenant?.id || 'bean';
    try {
      let identity = { id: userId, displayName: null, username: null, avatar: null, lastSeen: null };
      if (pgPool) {
        const r = await pgPool.query(
          'SELECT display_name, username, avatar, last_seen FROM known_users WHERE user_id=$1', [userId]);
        if (r.rows[0]) identity = {
          id: userId, displayName: r.rows[0].display_name, username: r.rows[0].username,
          avatar: r.rows[0].avatar, lastSeen: r.rows[0].last_seen };
      }
      const userSettings = await getSettings(userId); // existing helper
      const communities = await memberships.getUserCommunities(userId);

      // Effective Full-extension entitlement for the TARGET user (not req.user). The comp grant
      // is only one of six OR'd paths, so the admin panel must report the computed result and
      // its sources — a bare grant toggle reads OFF for a VIP who already has access.
      // Live guild lookup (bot token, so it works for any target ID). refreshGuildRoles returns
      // null BOTH when the lookup fails AND when no guild is configured — only the former is
      // "undetermined"; conflating them would show a permanent spurious warning on tenants
      // without Discord.
      const tenant = req.tenant;
      const guildRoles = refreshGuildRoles ? await refreshGuildRoles(userId, tenant) : null;
      const guildConfigured = !!(tenant?.discordGuildId && tenant?.discordBotToken);
      const fullExtension = await fullExtensionFor(userId, {
        tenantPlan:     tenant?.plan,
        isVipHost:      tenants ? tenants.isTenantVip({ id: userId }, tenant) : false,
        isCommunityMod: tenants ? tenants.isTenantMod({ id: userId }, tenant) : false,
        isDiscordVip:   !!guildRoles?.isDiscordVip,
      });

      res.json({
        ...identity,
        rainbetName: userSettings.rainbetName || null,
        twitchName: userSettings.twitchName || null,
        preferredSlots: Array.isArray(userSettings.preferredSlots) ? userSettings.preferredSlots : [],
        communities,
        featureGrants: featureGrants ? featureGrants.getGrantsForUser(userId) : [],
        fullExtension: { ...fullExtension, discordVipUndetermined: guildConfigured && !guildRoles },
        cosmetics: (userSettings.cosmetics && typeof userSettings.cosmetics === 'object') ? userSettings.cosmetics : {},
        cosmeticsOwned: Array.isArray(userSettings.cosmeticsOwned) ? userSettings.cosmeticsOwned : [],
        stats: statsStore ? await statsStore.getUserStats(tenantId, userId)
                          : computeUserHuntStats(rawTenantHunts(tenantId), userId),
      });
    } catch (e) {
      console.error('[admin] user profile failed:', e.message);
      res.status(500).json({ error: 'Failed to load user' });
    }
  });

  // POST /api/admin/users/:userId/grants — toggle a feature grant for a user.
  // 'full_extension' is the only grant left: the 'shop' grant died when browsing opened to
  // everyone (2026-07-09 shop umbrella) — buying is gated by isPurchaseEligible, not a grant.
  router.post('/api/admin/users/:userId/grants', requireAuth, requireAdmin, async (req, res) => {
    const userId = String(req.params.userId);
    const feature = String(req.body?.feature || '').trim();
    const on = !!req.body?.on;
    const ALLOWED = ['full_extension'];
    if (!ALLOWED.includes(feature)) return res.status(400).json({ error: 'unknown feature' });
    if (!featureGrants) return res.status(503).json({ error: 'grants unavailable' });
    try {
      if (on) await featureGrants.addGrant(userId, feature, req.user.id);
      else    await featureGrants.removeGrant(userId, feature);
      res.json({ ok: true, featureGrants: featureGrants.getGrantsForUser(userId) });
    } catch (e) {
      console.error('[grants] toggle failed:', e.message);
      res.status(500).json({ error: 'Failed to update grant' });
    }
  });

  // POST /api/admin/users/:userId/cosmetics — admin manages another user's cosmetics.
  // Body: { action: 'grant'|'revoke'|'equip', itemId?, category? }
  //   grant  { itemId }            → add to cosmeticsOwned
  //   revoke { itemId }            → remove from cosmeticsOwned; unequip anywhere it's active
  //   equip  { category, itemId? } → set the active item (null/'' = unequip). Equip implies
  //     grant when the target's subscription tier doesn't already cover the item — otherwise
  //     the user's own next PUT /api/settings would strip the equip as inaccessible.
  const COSMETIC_CATEGORIES = ['card', 'theme', 'sound', 'effect', 'background'];
  router.post('/api/admin/users/:userId/cosmetics', requireAuth, requireAdmin, async (req, res) => {
    const userId = String(req.params.userId);
    const action = String(req.body?.action || '');
    const rawItem = req.body?.itemId;
    const itemId = (rawItem === undefined || rawItem === null || rawItem === '') ? null : String(rawItem).slice(0, 64);
    const category = req.body?.category != null ? String(req.body.category) : null;
    try {
      const s = await getSettings(userId);
      const owned = Array.isArray(s.cosmeticsOwned) ? [...s.cosmeticsOwned] : [];
      const active = (s.cosmetics && typeof s.cosmetics === 'object') ? { ...s.cosmetics } : {};

      if (action === 'grant') {
        if (!itemId || !(itemId in ITEM_TIERS)) return res.status(400).json({ error: 'Invalid item' });
        if (!owned.includes(itemId)) owned.push(itemId);
      } else if (action === 'revoke') {
        if (!itemId) return res.status(400).json({ error: 'itemId required' });
        const i = owned.indexOf(itemId);
        if (i !== -1) owned.splice(i, 1);
        for (const k of COSMETIC_CATEGORIES) if (active[k] === itemId) active[k] = null;
      } else if (action === 'equip') {
        if (!COSMETIC_CATEGORIES.includes(category)) return res.status(400).json({ error: 'Invalid category' });
        if (itemId) {
          if (!(itemId in ITEM_TIERS)) return res.status(400).json({ error: 'Invalid item' });
          let userTier = 'free';
          if (subscriptions) {
            try { const sub = await subscriptions.getSubscription(userId); userTier = sub?.tier || 'free'; } catch {}
          }
          if (!isItemAccessible(itemId, userTier, owned) && !owned.includes(itemId)) owned.push(itemId);
        }
        active[category] = itemId;
      } else {
        return res.status(400).json({ error: "action must be 'grant', 'revoke', or 'equip'" });
      }

      s.cosmeticsOwned = owned;
      s.cosmetics = active;
      await saveSettings(userId, s);
      res.json({ ok: true, cosmetics: active, cosmeticsOwned: owned });
    } catch (e) {
      console.error('[admin] cosmetics update failed:', e.message);
      res.status(500).json({ error: 'Failed to update cosmetics' });
    }
  });

  // POST /api/admin/set-user-field — let an admin manually set a per-user identity field
  // (rainbetName or twitchName) for someone else. Accepts either { userId, field, value } or
  // { name, field, value }. Name-only path first tries to resolve to an existing settings row
  // so writes hit the same record reads find; falls back to a synthetic manual: id when missing.
  router.post('/api/admin/set-user-field', requireAdmin, async (req, res) => {
    const field = String(req.body?.field || '').trim();
    if (!['rainbetName', 'twitchName'].includes(field))
      return res.status(400).json({ error: "field must be 'rainbetName' or 'twitchName'" });
    const value = String(req.body?.value || '').trim().slice(0, 64);
    if (!value) {
      return res.status(400).json({ error: 'value required' });
    }
    const userId = (req.body?.userId || '').toString().trim();
    const name   = (req.body?.name   || '').toString().trim();
    if (!userId && !name) return res.status(400).json({ error: 'Provide userId or name' });

    if (userId) {
      const current = await getSettings(userId);
      current[field] = value;
      await saveSettings(userId, current);
      return res.json({ ok: true, scope: 'userId', userId, field, value });
    }

    const resolvedId = await resolveUserIdByName(name);
    if (resolvedId) {
      const current = await getSettings(resolvedId);
      current[field] = value;
      await saveSettings(resolvedId, current);
      return res.json({ ok: true, scope: 'resolved', name, userId: resolvedId, field, value });
    }

    const syntheticId = `manual:${name.toLowerCase()}`;
    const current = await getSettings(syntheticId);
    current[field]              = value;
    current.discordDisplayName  = current.discordDisplayName || name;
    current.discordUsername     = current.discordUsername    || name;
    await saveSettings(syntheticId, current);
    res.json({ ok: true, scope: 'name', name, syntheticId, field, value });
  });

  // POST /api/admin/set-preferred-slots — admin sets another user's preferred-slots list.
  // Body: { userId?, name?, slots: [{name, thumb, slug, provider}, ...] }
  // When only `name` is provided, uses synthetic `manual:<lowercased>` id so by-name lookup works.
  router.post('/api/admin/set-preferred-slots', requireAdmin, async (req, res) => {
    const slots = Array.isArray(req.body?.slots) ? req.body.slots : null;
    if (!slots) return res.status(400).json({ error: 'slots array required' });
    // Sanitize: keep up to 50 slots, normalize fields, drop empties.
    const cleaned = slots
      .filter(s => s && typeof s === 'object' && s.name)
      .slice(0, 50)
      .map(s => ({
        name:     String(s.name).slice(0, 120),
        thumb:    s.thumb    ? String(s.thumb).slice(0, 500) : null,
        slug:     s.slug     ? String(s.slug).slice(0, 200)  : null,
        provider: s.provider ? String(s.provider).slice(0, 80) : null,
      }));
    const userId = (req.body?.userId || '').toString().trim();
    const name   = (req.body?.name   || '').toString().trim();
    if (!userId && !name) return res.status(400).json({ error: 'Provide userId or name' });

    if (userId) {
      const current = await getSettings(userId);
      current.preferredSlots = cleaned;
      await saveSettings(userId, current);
      return res.json({ ok: true, scope: 'userId', userId, count: cleaned.length });
    }

    const resolvedId = await resolveUserIdByName(name);
    if (resolvedId) {
      const current = await getSettings(resolvedId);
      current.preferredSlots = cleaned;
      await saveSettings(resolvedId, current);
      return res.json({ ok: true, scope: 'resolved', name, userId: resolvedId, count: cleaned.length });
    }

    const syntheticId = `manual:${name.toLowerCase()}`;
    const current = await getSettings(syntheticId);
    current.preferredSlots     = cleaned;
    current.discordDisplayName = current.discordDisplayName || name;
    current.discordUsername    = current.discordUsername    || name;
    await saveSettings(syntheticId, current);
    res.json({ ok: true, scope: 'name', name, syntheticId, count: cleaned.length });
  });

  return router;
};
