// Admin routes: hunt overview, platform-admin management, and admin hunt actions
// (force-end / reopen / delete / delete-archived) + the manual stale-hunt cleanup trigger.
// Thin router; mounted from the server.js composition root. The stale-hunt janitor itself
// (cleanupStaleHunts + its timers) stays in server.js; this router just exposes the manual
// trigger via the injected cleanupStaleHunts.
//
//   GET    /api/admin/hunts                              — all hunts (admin)
//   GET    /api/admin/hunt-stats                         — dashboard statistics, ?tz=<IANA> (admin)
//   GET    /api/admin/gotin-log                          — every got-in {ts,slot,bet}, newest first (admin)
//   GET    /api/admin/gotin-log.xlsx                     — multi-tab workbook (admin OR GOTIN_EXPORT_KEY)
//   GET    /api/admin/overview                           — dashboard counts (admin)
//   GET    /api/admin/platform-admins                    — list platform admins (platform admin)
//   POST   /api/admin/platform-admins                    — add a DB platform admin
//   DELETE /api/admin/platform-admins/:id                — remove a DB platform admin
//   POST   /api/admin/hunts/cleanup                      — manual stale-hunt sweep
//   POST   /api/admin/hunts/retag-currency               — fix a hunt's currency tag (single or all-untagged)
//   PATCH  /api/admin/hunt-history/:huntKey/currency     — correct a stored hunt's currency (+recompute)
//   DELETE /api/admin/hunt-history/:huntKey              — delete a stored hunt (+recompute)
//   POST   /api/admin/hunts/:userId/end                  — force-end + archive a hunt
//   POST   /api/admin/hunts/:userId/reopen               — reopen an ended hunt
//   DELETE /api/admin/hunts/:userId                      — delete a hunt
//   DELETE /api/admin/hunts/archived/:userId/:archivedAt — delete an archived snapshot

const express = require('express');
const { buildGotInWorkbook, ymdInTz } = require('../lib/gotin-export');
const { CURRENCIES, inTenant } = require('../lib/hunts-core');

module.exports = function adminRoutes(deps) {
  const {
    requireAuth, requireAdmin, requirePlatformAdmin, requireTenantAdmin,
    getAllHunts, getArchivedHunts, getGotInLog, getHuntsFullExport, getHuntStats,
    pgPool, admins, tenants, ADMIN_IDS, statsStore,
    hunts, archive, archiveHunt, unarchiveHunt, persistArchive,
    emitHubUpdate, publicHuntView, emitHuntUpdate, io, uid, cleanupStaleHunts,
    subscriptions, auditLog,
  } = deps;
  const router = express.Router();

  router.get('/api/admin/hunts', requireAdmin, (req, res) => res.json(getAllHunts(req.tenant.id)));

  // Dashboard statistics for the admin Hunts tab. ?tz=<IANA> buckets the hour/weekday/week
  // charts in the admin's own timezone (frontend sends the browser zone).
  router.get('/api/admin/hunt-stats', requireAuth, requireAdmin, (req, res) => {
    res.json({ ...getHuntStats(req.tenant?.id || 'bean', String(req.query.tz || '')), generatedAt: Date.now() });
  });

  // Got-In log — every slot that got in, with timestamp + bet, newest first (tenant-scoped).
  // Backs the admin "Export Got-In Sheet" download in the frontend Settings page.
  router.get('/api/admin/gotin-log', requireAuth, requireAdmin, (req, res) => {
    res.json({ rows: getGotInLog(req.tenant?.id || 'bean'), generatedAt: Date.now() });
  });

  // Allow either an admin session (in-app button, scoped to the caller's own tenant) OR a matching
  // GOTIN_EXPORT_KEY (headless daily script — no Discord login). The key is a shared secret with no
  // tenant identity, so it MUST be tenant-blind: pin req.tenant to the platform tenant (Bean) and
  // IGNORE the client-supplied X-Tenant-Slug/_tenant. Otherwise a leaked key + a spoofed slug would
  // export any tenant's got-in log. The daily script asks for bean, so it is unaffected.
  function requireAdminOrKey(req, res, next) {
    const KEY = process.env.GOTIN_EXPORT_KEY;
    const provided = req.headers['x-export-key'] || req.query.key;
    if (KEY && provided && provided === KEY) {
      req.tenant = tenants.getTenantBySlug('bean') || tenants.BEAN_TENANT || req.tenant;
      return next();
    }
    return requireAuth(req, res, () => requireAdmin(req, res, next));
  }

  // Got-In workbook — multi-tab .xlsx (Overview + one tab per day, newest first).
  // ?tz=<IANA> sets the day-boundary timezone (default America/Chicago). Same bytes for the
  // in-app button and the daily local script.
  router.get('/api/admin/gotin-log.xlsx', requireAdminOrKey, async (req, res) => {
    const tz = String(req.query.tz || 'America/Chicago');
    const tenantId = req.tenant?.id || 'bean';
    try {
      const rows = getGotInLog(tenantId);
      const buf = await buildGotInWorkbook(rows, { tz, tenantName: req.tenant?.displayName || 'Bean' });
      const fname = `${tenantId}-got-in-${ymdInTz(Date.now(), tz)}.xlsx`;
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="${fname}"`);
      res.send(Buffer.from(buf));
    } catch (e) {
      console.error('[admin] gotin xlsx failed:', e.message);
      res.status(500).json({ error: 'Export failed' });
    }
  });

  router.get('/api/admin/hunts/export.csv', requireAuth, requireAdmin, (req, res) => {
    const rows = getHuntsFullExport(req.tenant?.id || 'bean');
    if (!rows.length) return res.status(204).end();
    const cols = ['gotInAt','slot','provider','bet','win','mult','scat','caller','slotIndex','totalSlots',
      'hunter','huntType','huntMode','currency','pot','equityCount','startedAt','archivedAt','completed','huntId'];
    const esc = v => {
      if (v == null) return '';
      const s = String(v);
      return s.includes(',') || s.includes('"') || s.includes('\n') ? '"' + s.replace(/"/g,'""') + '"' : s;
    };
    const fmtTs = v => v ? new Date(v).toISOString() : '';
    const lines = [cols.join(',')];
    for (const r of rows) {
      lines.push(cols.map(c => {
        if (c === 'gotInAt' || c === 'startedAt' || c === 'archivedAt') return esc(fmtTs(r[c]));
        return esc(r[c]);
      }).join(','));
    }
    const csv = lines.join('\r\n');
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="hunt-data-export.csv"');
    res.send(csv);
  });

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

  // Cross-tenant community directory for the platform overseer grid (platform-admin only).
  // Distinct from the PUBLIC GET /api/tenants (which carries no plan/counts): this exposes plan +
  // member/active-hunt counts, so it must stay platform-gated. accent/plan are display data;
  // avatar + enabledTools don't exist yet (later phases).
  router.get('/api/admin/communities', requireAuth, requirePlatformAdmin, async (req, res) => {
    const counts = {};
    if (pgPool) {
      try {
        const r = await pgPool.query('SELECT tenant_id, COUNT(*)::int AS n FROM community_members GROUP BY tenant_id');
        for (const row of r.rows) counts[row.tenant_id] = row.n;
      } catch (e) { console.error('[admin] communities counts failed:', e.message); }
    }
    const list = tenants.getAllTenants()
      .filter(t => t.isActive)
      .map(t => ({
        slug: t.slug,
        displayName: t.displayName,
        accent: (t.branding || {}).accent || null,
        plan: t.plan,
        memberCount: counts[t.id] || 0,
        activeHunts: getAllHunts(t.id).filter(h => h.isLive && !h.archivedAt).length,
      }));
    res.json(list);
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

  // ── Create a community tenant (platform-admin provisioning) ─────────
  // Turns the 48h manual provisioning into one action, and is the exact primitive the
  // (future) Stripe self-serve webhook will call. Platform-admin only for now.
  router.get('/api/admin/tenants/check-slug', requireAuth, requirePlatformAdmin, async (req, res) => {
    res.json({ available: await tenants.slugAvailable(req.query.slug) });
  });
  router.post('/api/admin/tenants', requireAuth, requirePlatformAdmin, async (req, res) => {
    try {
      const { slug, displayName, ownerId, plan, accent, twitchChannel, socials } = req.body || {};
      const t = await tenants.createTenant({ slug, displayName, ownerId, plan, accent, twitchChannel, socials });
      res.json({ ok: true, tenant: { slug: t.slug, displayName: t.displayName, plan: (t.branding || {}).plan || null } });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });
  router.delete('/api/admin/tenants/:slug', requireAuth, requirePlatformAdmin, async (req, res) => {
    try {
      await tenants.deleteTenant(req.params.slug);
      res.json({ ok: true });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  // ── Tenant Discord config ──────────────────────────────────────────
  // Read/write the tenant's Discord integration settings (bot token, guild ID, role IDs,
  // channel IDs). Admin-only — secrets are never exposed to non-admins or public endpoints.
  router.get('/api/admin/discord-config', requireAuth, requireTenantAdmin, (req, res) => {
    res.json(tenants.getTenantDiscordConfig(req.tenant));
  });

  router.put('/api/admin/discord-config', requireAuth, requireTenantAdmin, async (req, res) => {
    try {
      await tenants.updateTenantDiscordConfig(req.tenant.id, req.body || {});
      res.json({ ok: true });
    } catch (e) {
      console.error('[admin] discord-config update failed:', e.message);
      res.status(500).json({ error: 'Failed to update Discord config' });
    }
  });

  // ── Community socials (owner-editable) ──────────────────────────────
  // The tenant admin (owner) sets THIS community's public social links, stored in branding.
  // Sanitized in lib/tenants (whitelisted platforms, http(s) only). Tenant-scoped via req.tenant.
  router.get('/api/admin/socials', requireAuth, requireAdmin, (req, res) => {
    res.json({
      communityName: req.tenant?.displayName || 'Bean',
      socials: (req.tenant.branding && req.tenant.branding.socials) || [],
    });
  });
  router.put('/api/admin/socials', requireAuth, requireAdmin, async (req, res) => {
    try {
      const saved = await tenants.updateTenantSocials(req.tenant.id, req.body && req.body.socials);
      res.json({ ok: true, socials: saved });
    } catch (e) {
      console.error('[admin] socials update failed:', e.message);
      res.status(500).json({ error: 'Failed to update socials' });
    }
  });

  // Manual trigger for admins — used for verification and on-demand cleanup.
  router.post('/api/admin/hunts/cleanup', requireAdmin, (req, res) => res.json({ ok: true, ...cleanupStaleHunts() }));

  router.post('/api/admin/hunts/:userId/golive', requireAdmin, (req, res) => {
    const h = hunts[req.params.userId];
    if (!h || !inTenant(h, req.tenant.id)) return res.status(404).json({error:'Not found'});
    h.isLive = true;
    h.startedAt = h.startedAt || new Date().toISOString();
    h.updatedAt = new Date().toISOString();
    h.archivedAt = null;
    emitHubUpdate(req.tenant.id); emitHuntUpdate(req.params.userId);
    res.json({ok:true});
  });

  router.post('/api/admin/hunts/:userId/gooffline', requireAdmin, (req, res) => {
    const h = hunts[req.params.userId];
    if (!h || !inTenant(h, req.tenant.id)) return res.status(404).json({error:'Not found'});
    h.isLive = false;
    h.updatedAt = new Date().toISOString();
    emitHubUpdate(req.tenant.id); emitHuntUpdate(req.params.userId);
    res.json({ok:true});
  });

  router.post('/api/admin/hunts/:userId/end', requireAdmin, (req, res) => {
    const h = hunts[req.params.userId];
    if (!h || !inTenant(h, req.tenant.id)) return res.status(404).json({error:'Not found'});
    h.isLive = false;
    if (!h.huntId) h.huntId = uid();
    if (!h.archivedAt) h.archivedAt = new Date().toISOString();
    archiveHunt(h);
    emitHubUpdate(req.tenant.id); emitHuntUpdate(req.params.userId);
    auditLog.recordFromReq(req, { category: 'admin', action: 'admin.force_end', targetId: req.params.userId,
      summary: `${req.user.displayName || 'admin'} force-ended ${req.params.userId}'s hunt` });
    res.json({ok:true});
  });

  router.post('/api/admin/hunts/:userId/reopen', requireAdmin, (req, res) => {
    const h = hunts[req.params.userId];
    if (!h || !inTenant(h, req.tenant.id)) return res.status(404).json({error:'Not found'});
    unarchiveHunt(h);
    h.isLive = true; h.archivedAt = null;
    if (!h.startedAt) h.startedAt = new Date().toISOString();
    emitHubUpdate(req.tenant.id); emitHuntUpdate(req.params.userId);
    res.json({ok:true});
  });

  router.delete('/api/admin/hunts/:userId', requireAdmin, (req, res) => {
    const h = hunts[req.params.userId];
    if (!h || !inTenant(h, req.tenant.id)) return res.status(404).json({error:'Not found'});
    // Snapshot before the delete — this is the row an owner restores someone's hunt from.
    auditLog.recordFromReq(req, { category: 'admin', action: 'admin.delete_hunt', targetId: req.params.userId,
      summary: `${req.user.displayName || 'admin'} deleted ${req.params.userId}'s hunt`,
      detail: { before: { bonuses: h.bonuses || [], equity: h.equity || [], calls: h.calls || [] } } });
    delete hunts[req.params.userId]; emitHubUpdate(req.tenant.id);
    res.json({ok:true});
  });

  // Retag a hunt's currency. Legacy hunts logged before currency tracking carry no currency
  // field and get bucketed as USD in the stats, which skews every USD total when they were
  // actually played in another currency. Two forms:
  //   { currency, scope: 'untagged' }      — every tenant hunt (current + archived) with no tag
  //   { currency, userId, archivedAt? }    — one hunt; archivedAt targets an archived snapshot
  // Retagging a current hunt also updates any archived snapshot sharing its huntId so the
  // stats union (which dedups by huntId) can never see two currencies for one hunt.
  router.post('/api/admin/hunts/retag-currency', requireAuth, requireAdmin, (req, res) => {
    const { currency, scope, userId, archivedAt } = req.body || {};
    if (!CURRENCIES.includes(currency)) return res.status(400).json({ error: 'Invalid currency' });
    const tid = req.tenant?.id || 'bean';
    let updated = 0;
    if (scope === 'untagged') {
      for (const h of Object.values(hunts)) if (inTenant(h, tid) && !h.currency) { h.currency = currency; updated++; }
      for (const h of archive) if (inTenant(h, tid) && !h.currency) { h.currency = currency; updated++; }
    } else if (userId && archivedAt) {
      const h = archive.find(x => inTenant(x, tid) && x.user?.id === userId && x.archivedAt === archivedAt);
      if (!h) return res.status(404).json({ error: 'Archived hunt not found' });
      h.currency = currency; updated = 1;
    } else if (userId) {
      const h = hunts[userId];
      if (!h || !inTenant(h, tid)) return res.status(404).json({ error: 'Not found' });
      h.currency = currency; updated = 1;
      if (h.huntId) for (const a of archive) if (a.huntId === h.huntId && a.currency !== currency) { a.currency = currency; updated++; }
    } else {
      return res.status(400).json({ error: 'userId or scope required' });
    }
    persistArchive();
    emitHubUpdate(tid); // also persists current hunts
    res.json({ ok: true, updated });
  });

  // Correct a past hunt's currency in the DURABLE stats store (hunt_history) and recompute the
  // rollup for the host + every participant. Distinct from retag-currency above, which only
  // touches the live/file-archive copies (not the stats source of truth). Optional usdRate lets
  // an admin supply the rate that applied at hunt time (fxRates otherwise stamps today's rate for
  // an old date — meaningful for volatile currencies like ARS). :huntKey may contain '|'.
  router.patch('/api/admin/hunt-history/:huntKey/currency', requireAuth, requireAdmin, async (req, res) => {
    const { currency, usdRate } = req.body || {};
    if (!CURRENCIES.includes(currency)) return res.status(400).json({ error: 'Invalid currency' });
    if (usdRate != null && !(Number(usdRate) > 0)) return res.status(400).json({ error: 'Invalid rate' });
    if (!statsStore) return res.status(503).json({ error: 'Stats store unavailable' });
    try {
      const r = await statsStore.correctHuntCurrency(req.tenant.id, req.params.huntKey,
        { currency, usdRate: usdRate != null ? Number(usdRate) : undefined });
      if (r && r.notFound) return res.status(404).json({ error: 'Hunt not found in history' });
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Delete a past hunt from the durable stats store and recompute affected participants.
  router.delete('/api/admin/hunt-history/:huntKey', requireAuth, requireAdmin, async (req, res) => {
    if (!statsStore) return res.status(503).json({ error: 'Stats store unavailable' });
    try {
      await statsStore.deleteHuntByKey(req.tenant.id, req.params.huntKey);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Delete an archived hunt. Two archived hunts can share a userId (same user, multiple completed hunts),
  // so we need archivedAt as a tiebreaker to identify the exact entry.
  router.delete('/api/admin/hunts/archived/:userId/:archivedAt', requireAdmin, (req, res) => {
    const { userId, archivedAt } = req.params;
    const idx = archive.findIndex(h => h.user?.id === userId && h.archivedAt === archivedAt && inTenant(h, req.tenant.id));
    if (idx === -1) return res.status(404).json({error:'Archived hunt not found'});
    archive.splice(idx, 1);
    persistArchive();
    emitHubUpdate(req.tenant.id);
    res.json({ok:true});
  });

  // ── Subscription management ──────────────────────────────────────
  // Individual subscriptions are a PLATFORM-level (global) product, not per-tenant — a community
  // mod/admin must never grant tiers or read every user's subscription PII. Platform-admin only.
  router.get('/api/admin/subscriptions', requireAuth, requirePlatformAdmin, async (req, res) => {
    try {
      res.json({ subscriptions: await subscriptions.listSubscriptions() });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.post('/api/admin/subscriptions', requireAuth, requirePlatformAdmin, async (req, res) => {
    const { userId, tier, expiresAt } = req.body || {};
    if (!userId || !tier) return res.status(400).json({ error: 'userId and tier required' });
    try {
      await subscriptions.setSubscription(userId, tier, expiresAt || null, req.user.id);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  return router;
};
