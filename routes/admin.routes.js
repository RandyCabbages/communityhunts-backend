// Admin routes: hunt overview, platform-admin management, and admin hunt actions
// (force-end / reopen / delete / delete-archived) + the manual stale-hunt cleanup trigger.
// Thin router; mounted from the server.js composition root. The stale-hunt janitor itself
// (cleanupStaleHunts + its timers) stays in server.js; this router just exposes the manual
// trigger via the injected cleanupStaleHunts.
//
//   GET    /api/admin/hunts                              — all hunts (admin)
//   GET    /api/admin/overview                           — dashboard counts (admin)
//   GET    /api/admin/platform-admins                    — list platform admins (platform admin)
//   POST   /api/admin/platform-admins                    — add a DB platform admin
//   DELETE /api/admin/platform-admins/:id                — remove a DB platform admin
//   POST   /api/admin/hunts/cleanup                      — manual stale-hunt sweep
//   POST   /api/admin/hunts/:userId/end                  — force-end + archive a hunt
//   POST   /api/admin/hunts/:userId/reopen               — reopen an ended hunt
//   DELETE /api/admin/hunts/:userId                      — delete a hunt
//   DELETE /api/admin/hunts/archived/:userId/:archivedAt — delete an archived snapshot

const express = require('express');

module.exports = function adminRoutes(deps) {
  const {
    requireAuth, requireAdmin, requirePlatformAdmin,
    getAllHunts, getArchivedHunts,
    pgPool, admins, tenants, ADMIN_IDS,
    hunts, archive, archiveHunt, unarchiveHunt, persistArchive,
    emitHubUpdate, publicHuntView, io, uid, cleanupStaleHunts,
  } = deps;
  const router = express.Router();

  router.get('/api/admin/hunts', requireAdmin, (req, res) => res.json(getAllHunts(req.tenant.id)));

  // Lightweight dashboard counts for the current tenant.
  router.get('/api/admin/overview', requireAuth, requireAdmin, async (req, res) => {
    const tenantId = req.tenant?.id || 'bean';
    let userCount = 0, recentLogins = [];
    if (pgPool) {
      try {
        const c = await pgPool.query(
          'SELECT COUNT(*)::int AS n FROM community_members WHERE tenant_id=$1', [tenantId]);
        userCount = c.rows[0]?.n || 0;
        const r = await pgPool.query(`
          SELECT ku.user_id, ku.display_name, ku.avatar, ku.last_seen
          FROM community_members cm JOIN known_users ku ON ku.user_id = cm.user_id
          WHERE cm.tenant_id=$1 ORDER BY ku.last_seen DESC NULLS LAST LIMIT 10`, [tenantId]);
        recentLogins = r.rows.map(u => ({
          id: u.user_id, displayName: u.display_name, avatar: u.avatar, lastSeen: u.last_seen }));
      } catch (e) { console.error('[admin] overview failed:', e.message); }
    }
    // getAllHunts returns all hunts (live + created + archived snapshots) for the tenant.
    // getArchivedHunts returns only completed archived hunts for the tenant.
    const allTenantHunts = getAllHunts(tenantId);
    const activeHuntCount = allTenantHunts.filter(h => h.isLive && !h.archivedAt).length;
    const archivedHuntCount = getArchivedHunts(tenantId).length;
    res.json({
      communityName: req.tenant?.displayName || 'Bean',
      userCount, activeHuntCount, archivedHuntCount,
      recentLogins,
    });
  });

  // ── Platform-admin management ──────────────────────────────────────
  // List all platform admins with their source (owner | env | db) for the UI.
  router.get('/api/admin/platform-admins', requireAuth, requirePlatformAdmin, async (req, res) => {
    try {
      const OWNERS = tenants.PLATFORM_OWNER_IDS;
      const rows = []; // { discordId, source }
      for (const id of OWNERS) rows.push({ discordId: id, source: 'owner' });
      for (const id of ADMIN_IDS) if (!OWNERS.includes(id)) rows.push({ discordId: id, source: 'env' });
      const dbAdmins = await admins.listDbAdmins();
      for (const a of dbAdmins) {
        if (OWNERS.includes(a.discordId) || ADMIN_IDS.includes(a.discordId)) continue; // dedup; owner/env win
        rows.push({ discordId: a.discordId, source: 'db', addedBy: a.addedBy, addedAt: a.addedAt });
      }
      // Enrich with display name + avatar from known_users (best-effort).
      let enriched = rows;
      if (pgPool && rows.length) {
        try {
          const ids = rows.map(r => r.discordId);
          const r = await pgPool.query(
            `SELECT user_id, display_name, avatar FROM known_users WHERE user_id = ANY($1)`, [ids]);
          const byId = {};
          for (const u of r.rows) byId[u.user_id] = u;
          enriched = rows.map(row => ({
            ...row,
            displayName: byId[row.discordId]?.display_name || null,
            avatar: byId[row.discordId]?.avatar || null,
          }));
        } catch (e) { console.error('[admin] platform-admins enrich failed:', e.message); }
      }
      res.json(enriched);
    } catch (e) {
      console.error('[admin] platform-admins list failed:', e.message);
      res.status(500).json({ error: 'Failed to list admins' });
    }
  });

  // Add a DB platform admin. Owner/env entries are not addable here (they already are admins).
  router.post('/api/admin/platform-admins', requireAuth, requirePlatformAdmin, async (req, res) => {
    const discordId = String(req.body?.discordId || '').trim();
    if (!/^\d{5,}$/.test(discordId)) return res.status(400).json({error:'Valid Discord ID required'});
    if (tenants.isPlatformOwnerId(discordId)) return res.status(400).json({error:'Owner is always admin'});
    try {
      await admins.addDbAdmin(discordId, req.user.id);
      res.json({ ok: true });
    } catch (e) {
      console.error('[admin] platform-admins add failed:', e.message);
      res.status(500).json({ error: 'Failed to add admin' });
    }
  });

  // Remove a DB platform admin. Owner and env-var admins cannot be removed here.
  router.delete('/api/admin/platform-admins/:id', requireAuth, requirePlatformAdmin, async (req, res) => {
    const id = String(req.params.id || '').trim();
    if (tenants.isPlatformOwnerId(id)) return res.status(400).json({error:'Owner cannot be removed'});
    if (ADMIN_IDS.includes(id)) return res.status(400).json({error:'Env admin — managed via Railway ADMIN_IDS'});
    try {
      await admins.removeDbAdmin(id);
      res.json({ ok: true });
    } catch (e) {
      console.error('[admin] platform-admins remove failed:', e.message);
      res.status(500).json({ error: 'Failed to remove admin' });
    }
  });

  // Manual trigger for admins — used for verification and on-demand cleanup.
  router.post('/api/admin/hunts/cleanup', requireAdmin, (req, res) => res.json({ ok: true, ...cleanupStaleHunts() }));

  router.post('/api/admin/hunts/:userId/end', requireAdmin, (req, res) => {
    const h = hunts[req.params.userId];
    if (!h) return res.status(404).json({error:'Not found'});
    h.isLive = false;
    if (!h.huntId) h.huntId = uid();
    if (!h.archivedAt) h.archivedAt = new Date().toISOString();
    archiveHunt(h);
    emitHubUpdate(req.tenant.id); io.to(`hunt:${req.params.userId}`).emit('hunt:update', publicHuntView(h));
    res.json({ok:true});
  });

  router.post('/api/admin/hunts/:userId/reopen', requireAdmin, (req, res) => {
    const h = hunts[req.params.userId];
    if (!h) return res.status(404).json({error:'Not found'});
    unarchiveHunt(h);
    h.isLive = true; h.archivedAt = null;
    if (!h.startedAt) h.startedAt = new Date().toISOString();
    emitHubUpdate(req.tenant.id); io.to(`hunt:${req.params.userId}`).emit('hunt:update', publicHuntView(h));
    res.json({ok:true});
  });

  router.delete('/api/admin/hunts/:userId', requireAdmin, (req, res) => {
    if (!hunts[req.params.userId]) return res.status(404).json({error:'Not found'});
    delete hunts[req.params.userId]; emitHubUpdate(req.tenant.id);
    res.json({ok:true});
  });

  // Delete an archived hunt. Two archived hunts can share a userId (same user, multiple completed hunts),
  // so we need archivedAt as a tiebreaker to identify the exact entry.
  router.delete('/api/admin/hunts/archived/:userId/:archivedAt', requireAdmin, (req, res) => {
    const { userId, archivedAt } = req.params;
    const idx = archive.findIndex(h => h.user?.id === userId && h.archivedAt === archivedAt);
    if (idx === -1) return res.status(404).json({error:'Archived hunt not found'});
    archive.splice(idx, 1);
    persistArchive();
    emitHubUpdate(req.tenant.id);
    res.json({ok:true});
  });

  return router;
};
