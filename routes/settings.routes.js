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

module.exports = function settingsRoutes(deps) {
  const { settings, pgPool, memberships, isPlatformAdmin, requireAuth, requireAdmin } = deps;
  const { getSettings, saveSettings, nameMatchesSettings, allSettingsRows, resolveUserIdByName } = settings;
  const router = express.Router();

  // Overlay Studio config — cosmetic per-streamer prefs stored in user_settings JSONB.
  // Enums must stay in sync with the frontend src/overlay/overlayConfig.js.
  const OVERLAY_AESTHETICS = ['classic', 'pass', 'linecheck', 'docket'];
  const OVERLAY_SIZES = ['board', 'compact'];
  const HEX6 = /^#[0-9a-fA-F]{6}$/;
  const DEFAULT_OVERLAY_CONFIG = { aesthetic: 'classic', size: 'board', accent: null };

  function sanitizeOverlayConfig(raw) {
    const r = (raw && typeof raw === 'object') ? raw : {};
    return {
      aesthetic: OVERLAY_AESTHETICS.includes(r.aesthetic) ? r.aesthetic : 'classic',
      size:      OVERLAY_SIZES.includes(r.size) ? r.size : 'board',
      accent:    (typeof r.accent === 'string' && HEX6.test(r.accent)) ? r.accent : null,
    };
  }

  // GET /api/settings — get current user's settings
  router.get('/api/settings', requireAuth, async (req, res) => {
    res.json(await getSettings(req.user.id));
  });

  // PUT /api/settings — save current user's settings (also stores their Discord names for lookup)
  router.put('/api/settings', requireAuth, async (req, res) => {
    const current = await getSettings(req.user.id);
    const { rainbetName, twitchName, preferredSlots } = req.body;
    if (rainbetName !== undefined)    current.rainbetName    = String(rainbetName).trim().slice(0, 64);
    if (twitchName  !== undefined)    current.twitchName     = String(twitchName).trim().slice(0, 64);
    if (preferredSlots !== undefined) current.preferredSlots = (preferredSlots || []).filter(Boolean);
    if (req.body.overlayConfig !== undefined) current.overlayConfig = sanitizeOverlayConfig(req.body.overlayConfig);
    // Always update Discord identity for name-based lookup by other hunt owners
    current.discordUsername    = req.user.username || '';
    current.discordDisplayName = req.user.displayName || req.user.username || '';
    current.discordId          = req.user.id;
    await saveSettings(req.user.id, current);
    res.json({ ok: true, settings: current });
  });

  // GET /api/settings/:userId — get another user's preferred slots and rainbet name by Discord ID
  router.get('/api/settings/:userId', requireAuth, async (req, res) => {
    const s = await getSettings(req.params.userId);
    res.json({ preferredSlots: s.preferredSlots || [], rainbetName: s.rainbetName || '', twitchName: s.twitchName || '' });
  });

  // GET /api/overlay-config/:userId — PUBLIC (no requireAuth). The OBS browser-source is
  // unauthenticated and reads the streamer's chosen overlay style by Discord ID. Cosmetic
  // prefs only (no secrets); always returns a valid, defaults-merged config.
  router.get('/api/overlay-config/:userId', async (req, res) => {
    const s = await getSettings(req.params.userId);
    res.json({ ...DEFAULT_OVERLAY_CONFIG, ...sanitizeOverlayConfig(s.overlayConfig || {}) });
  });

  // GET /api/settings/by-name/:name — look up another user's preferred slots & rainbet by their Discord username/displayName
  // Used when a hunt owner adds a member by name and we don't know their Discord ID
  router.get('/api/settings/by-name/:name', requireAuth, async (req, res) => {
    const search = (req.params.name || '').toLowerCase().trim();
    if (!search) return res.json({ preferredSlots: [], rainbetName: '', twitchName: '' });
    const searchNoSp = search.replace(/\s+/g,'');

    const allSettings = await allSettingsRows();

    // Find match by Discord username or displayName (case-insensitive, space-insensitive)
    const match = allSettings.find(s => nameMatchesSettings(s, search, searchNoSp));

    if (match) {
      return res.json({
        preferredSlots: match.preferredSlots || [],
        rainbetName:    match.rainbetName    || '',
        twitchName:     match.twitchName     || '',
        userId:         match.userId         || null,
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

  // GET /api/admin/users — list users in the CURRENT tenant (community_members ⨝ known_users ⨝ user_settings).
  // Tenant-scoped: a community admin only sees their own community's members.
  router.get('/api/admin/users', requireAuth, requireAdmin, async (req, res) => {
    if (!pgPool) return res.json({ users: [] });
    const tenantId = req.tenant?.id || 'bean';
    const q = String(req.query.q || '').trim().toLowerCase();
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
    try {
      const params = [tenantId];
      let where = `cm.tenant_id = $1`;
      if (q) {
        params.push(`%${q}%`);
        where += ` AND (LOWER(ku.display_name) LIKE $${params.length}
                     OR LOWER(ku.username) LIKE $${params.length}
                     OR ku.user_id LIKE $${params.length})`;
      }
      params.push(limit, offset);
      const sql = `
        SELECT ku.user_id, ku.display_name, ku.username, ku.avatar, ku.last_seen,
               us.settings
        FROM community_members cm
        JOIN known_users ku ON ku.user_id = cm.user_id
        LEFT JOIN user_settings us ON us.user_id = cm.user_id
        WHERE ${where}
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

  // GET /api/admin/users/:userId — one user's full profile. Tenant-guarded: 404 unless the target
  // is a member of req.tenant — UNLESS the caller is a platform admin (who may inspect anyone).
  router.get('/api/admin/users/:userId', requireAuth, requireAdmin, async (req, res) => {
    const userId = String(req.params.userId);
    const tenantId = req.tenant?.id || 'bean';
    const platform = isPlatformAdmin(req.user);
    try {
      if (pgPool && !platform) {
        const m = await pgPool.query(
          'SELECT 1 FROM community_members WHERE user_id=$1 AND tenant_id=$2', [userId, tenantId]);
        if (m.rowCount === 0) return res.status(404).json({ error: 'User not in this community' });
      }
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
      res.json({
        ...identity,
        rainbetName: userSettings.rainbetName || null,
        twitchName: userSettings.twitchName || null,
        preferredSlots: Array.isArray(userSettings.preferredSlots) ? userSettings.preferredSlots : [],
        communities,
      });
    } catch (e) {
      console.error('[admin] user profile failed:', e.message);
      res.status(500).json({ error: 'Failed to load user' });
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
    if (!value) return res.status(400).json({ error: 'value required' });
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
