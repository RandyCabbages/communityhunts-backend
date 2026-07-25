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
//   GET    /api/admin/metrics/overview                   — Mission Control aggregates, ?range= ?scope= (admin)
//   GET    /api/admin/metrics/live                       — Mission Control live tick, ?cursor= ?scope= (admin)
//   GET    /api/admin/identity/proposals                 — alias-match link proposals (platform admin)
//   POST   /api/admin/identity/apply                     — apply confirmed name links (platform admin)
//   POST   /api/admin/identity/unlink-name               — undo an apply for one name (platform admin)
//   POST   /api/admin/identity/unlink                    — reverse a single row link (platform admin)
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
const { CURRENCIES, inTenant, MOD_HUNT_ID, AFFILIATE_HUNT_ID, VIP_HUNT_ID } = require('../lib/hunts-core');
// The mod/affiliate/vip hunts are persistent fixed-key shared hunts — always `isLive`, and they
// stay live (empty) even after a reset. They have their own hub panels, so they must NOT clutter
// the admin "live hunts" panel (a per-tenant key looks like `__mod_hunt__:<tenant>`, hence prefix).
const isSharedHuntKey = (id) => typeof id === 'string' &&
  (id.startsWith(MOD_HUNT_ID) || id.startsWith(AFFILIATE_HUNT_ID) || id.startsWith(VIP_HUNT_ID));
const { computeOverviewMetrics, groupHuntsByCurrency } = require('../lib/adminMetrics');
const { collectUnlinkedNames, applyNameLinks, unlinkNameLinks } = require('../lib/identityLink');
const confirmedAliases = require('../lib/confirmedAliases');
const { planImport } = require('../lib/huntBackfill');

module.exports = function adminRoutes(deps) {
  const {
    requireAuth, requireAdmin, requirePlatformAdmin, requireTenantAdmin,
    getAllHunts, getArchivedHunts, getGotInLog, getHuntsFullExport, getHuntStats,
    pgPool, admins, bans, supporters, tenants, ADMIN_IDS, statsStore,
    hunts, archive, archiveHunt, unarchiveHunt, persistArchive,
    emitHubUpdate, publicHuntView, emitHuntUpdate, io, uid, cleanupStaleHunts,
    subscriptions, auditLog, getPlatformBotToken, recordAlias, recordKnownUser,
    activityFeed, presence, findAliasOwners, findAliasOwnersLoose, deleteAlias,
    persistHunts, isKnownAccount,
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

  // ── Mission Control dashboard ──────────────────────────────────────────────
  const RANGE_MS = {
    today: 24 * 3600 * 1000,
    '7d': 7 * 24 * 3600 * 1000,
    '30d': 30 * 24 * 3600 * 1000,
    all: null,
  };

  // Monthly-equivalent list prices per individual tier. The subscriptions table stores tier +
  // expires_at but NO billing interval, so an annual sub is indistinguishable from a monthly one
  // — this is an ESTIMATE and the UI labels it as such. Community plans are negotiated per host
  // (no fixed price) and are deliberately excluded rather than guessed at.
  const TIER_MONTHLY = { basic: 9.99, pro: 19.99, ultimate: 39.99 };

  // RAW hunt objects for a tenant — NOT getAllHunts(), which maps through huntSummary and strips
  // bonuses/calls (and drops equity on live hunts). The metrics need those arrays. Mirrors
  // tenantHuntsUnion in lib/hunts-core.js (current ∪ archived, deduped by huntId), which is not
  // exported.
  //
  // The mod/affiliate/vip fixed-key hunts are NOT excluded here — the metrics aggregations still
  // count the community's own shared hunts. The "live hunts" panel (GET /api/admin/metrics/live)
  // filters them out via isSharedHuntKey, since they're always-live and persist (empty) after a
  // reset, so they'd otherwise clutter the "what's running now" list.
  function rawHuntsForTenant(tenantId) {
    const current = Object.values(hunts).filter(h => inTenant(h, tenantId));
    const seen = new Set(current.map(h => h.huntId).filter(Boolean));
    const archivedOnly = archive.filter(h => inTenant(h, tenantId) && (!h.huntId || !seen.has(h.huntId)));
    return [...current, ...archivedOnly];
  }

  // Every hunt visible at the requested scope. Platform scope unions every tenant and tags each
  // hunt, so the frontend can label blended rows — a cross-community leaderboard that hides which
  // community a row came from is unreadable.
  function huntsForScope(req, scope) {
    if (scope === 'platform') {
      const out = [];
      for (const t of tenants.getAllTenants()) {
        for (const h of rawHuntsForTenant(t.id)) out.push({ ...h, tenantId: t.id, tenantName: t.displayName });
      }
      return out;
    }
    const tenantId = req.tenant?.id || 'bean';
    const name = req.tenant?.displayName || 'Bean';
    return rawHuntsForTenant(tenantId).map(h => ({ ...h, tenantId, tenantName: name }));
  }

  const scopeOf = (req) => String(req.query.scope || '') === 'platform' ? 'platform' : 'community';

  // Platform scope crosses tenant boundaries, so it needs the platform gate ON TOP of requireAdmin
  // — a community admin must never aggregate other communities' data. Reuses the injected
  // requirePlatformAdmin middleware rather than re-deriving the predicate, so this can't drift
  // from every other platform-gated route.
  const gatePlatformScope = (req, res, next) =>
    scopeOf(req) === 'platform' ? requirePlatformAdmin(req, res, next) : next();

  router.get('/api/admin/metrics/overview', requireAuth, requireAdmin, gatePlatformScope, async (req, res) => {
    const scope = scopeOf(req);
    const range = Object.prototype.hasOwnProperty.call(RANGE_MS, String(req.query.range))
      ? String(req.query.range) : 'today';
    const rangeMs = RANGE_MS[range];
    const now = Date.now();

    const all = huntsForScope(req, scope);
    const groups = groupHuntsByCurrency(all);
    const currencies = [...groups.keys()]
      .sort((a, b) => groups.get(b).length - groups.get(a).length)
      .map(code => ({ code, hunts: groups.get(code).length }));

    const byCurrency = {};
    for (const { code } of currencies) {
      byCurrency[code] = computeOverviewMetrics(groups.get(code), { now, rangeMs, currency: code });
    }

    // Active non-free subscriptions, with a monthly-equivalent estimate (see TIER_MONTHLY).
    let subs = { active: 0, monthlyEstimate: 0 };
    try {
      const rows = await subscriptions.listSubscriptions();
      const alive = (rows || []).filter(r => !r.expiresAt || new Date(r.expiresAt).getTime() > now);
      subs = {
        active: alive.length,
        monthlyEstimate: alive.reduce((s, r) => s + (TIER_MONTHLY[r.tier] || 0), 0),
      };
    } catch (e) { console.error('[admin] metrics subs failed:', e.message); }

    let recentLogins = [];
    if (pgPool) {
      try {
        const sql = scope === 'platform'
          ? `SELECT user_id, display_name, avatar, last_seen FROM known_users
             ORDER BY last_seen DESC NULLS LAST LIMIT 8`
          : `SELECT ku.user_id, ku.display_name, ku.avatar, ku.last_seen
             FROM community_members cm JOIN known_users ku ON ku.user_id = cm.user_id
             WHERE cm.tenant_id=$1 ORDER BY ku.last_seen DESC NULLS LAST LIMIT 8`;
        const r = await pgPool.query(sql, scope === 'platform' ? [] : [req.tenant?.id || 'bean']);
        recentLogins = r.rows.map(u => ({
          id: u.user_id, displayName: u.display_name, avatar: u.avatar, lastSeen: u.last_seen }));
      } catch (e) { console.error('[admin] metrics logins failed:', e.message); }
    }

    res.json({
      scope,
      scopeLabel: scope === 'platform' ? 'All communities' : `${req.tenant?.displayName || 'Bean'} community`,
      range, currencies, byCurrency, subs, recentLogins, generatedAt: now,
    });
  });

  router.get('/api/admin/metrics/live', requireAuth, requireAdmin, gatePlatformScope, (req, res) => {
    const scope = scopeOf(req);
    const tenantId = req.tenant?.id || 'bean';
    // Presence filters on the socket's handshake slug; platform scope counts every tenant.
    const tenantSlug = scope === 'platform' ? null : (req.tenant?.slug || null);

    const live = huntsForScope(req, scope).filter(h => h.isLive && !h.archivedAt && !isSharedHuntKey(h.user?.id));
    const huntRows = live.map(h => {
      const bonuses = h.bonuses || [];
      const total = bonuses.length;
      const opened = bonuses.filter(b => b && b.win != null).length;
      const startCost = (h.equity || []).reduce((s, e) => s + (Number(e?.amount) || 0), 0);
      const won = bonuses.reduce((s, b) => s + (Number(b?.win) || 0), 0);
      const remaining = total - opened;
      return {
        userId: h.user?.id || null,
        name: h.user?.displayName || 'Hunter',
        avatar: h.user?.avatar || null,
        tenantName: scope === 'platform' ? (h.tenantName || null) : null,
        opened, total, startCost,
        pnl: won - startCost,
        currency: h.currency || 'USD',
        pct: total > 0 ? Math.round((opened / total) * 100) : 0,
        // What each remaining bonus must average to cover the start cost. null = already covered.
        breakEvenPerBonus: remaining > 0 && won < startCost ? (startCost - won) / remaining : null,
      };
    });

    const { events, cursor } = activityFeed
      ? activityFeed.since(scope === 'platform' ? null : tenantId, req.query.cursor, 20)
      : { events: [], cursor: 0 };

    res.json({
      online: presence ? presence.countOnline(tenantSlug) : 0,
      hunts: huntRows, feed: events, cursor, generatedAt: Date.now(),
    });
  });

  // ── Identity linking (Tier 2) ──────────────────────────────────────────────
  // Platform-wide alias matching is riskier than the hunt-local Tier 1 that runs on save, so it
  // NEVER applies automatically: this proposes, a human confirms, and every applied link is
  // audit-logged and reversible via /unlink below. Platform-admin only — this assigns identity,
  // and identity drives payout attribution.
  const identityKeyOf = (h) => h.huntId || `${h.user?.id}|${h.startedAt}`;
  const everyHunt = () => [...Object.values(hunts), ...archive];
  const huntByIdentityKey = (key) => everyHunt().find(h => identityKeyOf(h) === key) || null;

  // One entry per PERSON, not per row. Real data: 81 distinct names across 10,345 rows — a
  // per-row list is unreviewable, and shipping 10k objects back to /apply was O(links × hunts)
  // and would stall the event loop.
  router.get('/api/admin/identity/proposals', requireAuth, requirePlatformAdmin, async (req, res) => {
    const list = everyHunt();
    const unlinked = collectUnlinkedNames(list);   // [{ name, rows, hunts }] sorted by rows desc

    // Whitespace-INSENSITIVE lookup on purpose: `unlinked` is grouped with identityLink's
    // normName (all whitespace stripped), so matching against alias_norm (whitespace merely
    // collapsed) reported anyone whose typed name spaced differently as "No matching account".
    let owners = new Map();
    try {
      const lookup = findAliasOwnersLoose || findAliasOwners;
      owners = lookup ? await lookup(unlinked.map(u => u.name)) : new Map();
    } catch (e) { console.error('[admin] identity alias lookup failed:', e.message); }

    const names = [], ambiguous = [], unmatched = [];
    for (const u of unlinked) {
      const set = owners.get(u.name);
      if (!set || set.size === 0) { unmatched.push(u); continue; }
      if (set.size > 1) { ambiguous.push({ ...u, count: set.size }); continue; }
      const discordId = [...set][0];
      // A synthetic manual:<name> row is a placeholder, never an identity.
      if (!/^\d{17,20}$/.test(String(discordId))) { unmatched.push(u); continue; }
      names.push({ ...u, discordId });
    }

    res.json({
      names, ambiguous, unmatched,
      totals: {
        names: unlinked.length,
        matched: names.length,
        rows: names.reduce((s, n) => s + n.rows, 0),
        ambiguous: ambiguous.length,
        unmatched: unmatched.length,
      },
    });
  });

  // Body: { links: [{ name, discordId }] } — one decision per person. Applied in a SINGLE pass
  // over every hunt (see lib/identityLink.applyNameLinks), so cost is O(rows) regardless of how
  // many names were confirmed.
  router.post('/api/admin/identity/apply', requireAuth, requirePlatformAdmin, (req, res) => {
    const links = Array.isArray(req.body?.links) ? req.body.links : [];
    const nameToId = new Map();
    for (const l of links) {
      if (l && l.name && /^\d{17,20}$/.test(String(l.discordId || ''))) {
        nameToId.set(String(l.name), String(l.discordId));
      }
    }
    if (!nameToId.size) return res.json({ applied: 0, names: 0, byName: {} });

    const { applied, byName } = applyNameLinks(everyHunt(), nameToId);
    if (applied) { persistHunts(); persistArchive(); }

    // REMEMBER the decision, don't just patch today's rows. Without this the operator is re-asked
    // about the same person the next time any host types that name, and the queue never drains.
    // Recorded even when `applied` is 0: confirming someone who has no rows yet is still a real
    // decision, and it is the one that stops them ever entering the queue.
    for (const [name, discordId] of nameToId) {
      if (recordAlias) recordAlias(discordId, name, confirmedAliases.ADMIN_LINK_SOURCE);
      confirmedAliases.remember(name, discordId);   // live immediately, no reload
    }

    // ONE audit row for the batch — 10k rows would flood the log and bury everything else. The
    // per-name breakdown in `detail` is what makes it reversible/inspectable.
    auditLog.recordFromReq(req, {
      category: 'hunt', action: 'identity.link',
      targetId: nameToId.size === 1 ? [...nameToId.values()][0] : null,
      summary: `Linked ${applied} row(s) across ${Object.keys(byName).length} name(s)`,
      detail: { byName, links: [...nameToId.entries()].map(([name, discordId]) => ({ name, discordId })) },
    });
    res.json({ applied, names: Object.keys(byName).length, byName });
  });

  // Undo an /apply for ONE name, at the same granularity it was applied. Body: { name, discordId }.
  // Without this a 10,000-row apply is irreversible in practice and the "reversible" rail is a lie.
  router.post('/api/admin/identity/unlink-name', requireAuth, requirePlatformAdmin, async (req, res) => {
    const { name, discordId } = req.body || {};
    if (!name || !/^\d{17,20}$/.test(String(discordId || ''))) {
      return res.status(400).json({ error: 'name and a real discordId are required' });
    }
    const { cleared } = unlinkNameLinks(everyHunt(), name, discordId);
    if (cleared) { persistHunts(); persistArchive(); }

    // Forget the decision as well as the rows. The apply above writes an `admin-link` alias that
    // replays onto every future save, so clearing rows alone would leave the undo cosmetic — the
    // next save would put the same id straight back.
    confirmedAliases.forget(name, discordId);
    if (deleteAlias) await deleteAlias(discordId, name);

    auditLog.recordFromReq(req, {
      category: 'hunt', action: 'identity.unlink', targetId: String(discordId),
      summary: `Unlinked ${cleared} row(s) for "${name}"`,
      detail: { name, discordId, cleared },
    });
    res.json({ cleared });
  });

  // Row-level unlink — kept for surgical single-row corrections.
  router.post('/api/admin/identity/unlink', requireAuth, requirePlatformAdmin, (req, res) => {
    const { huntKey, kind, id } = req.body || {};
    const h = huntByIdentityKey(huntKey);
    if (!h) return res.status(404).json({ error: 'Hunt not found' });
    const row = kind === 'equity'
      ? (h.equity || []).find(e => e && e.id === id)
      : (h.calls  || []).find(c => c && c.id === id);
    if (!row) return res.status(404).json({ error: 'Row not found' });
    const was = kind === 'equity' ? row.discordId : row.callerId;
    if (kind === 'equity') delete row.discordId; else delete row.callerId;
    persistHunts(); persistArchive();
    auditLog.recordFromReq(req, {
      category: 'hunt', action: 'identity.unlink', targetId: was ? String(was) : null,
      summary: `Unlinked ${kind} row in hunt ${huntKey}`,
      detail: { huntKey, kind, rowId: id, previousId: was || null },
    });
    res.json({ ok: true });
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

  // ── Banned-user management ─────────────────────────────────────────
  // A banned user is blocked from the whole platform (website, extension, API, sockets) on
  // every tenant. Global, like platform admins — so platform-admin only. Managed here + on the
  // user profile Ban button; enforced by the global ban gate (server.js) + socket handshake.
  router.get('/api/admin/banned-users', requireAuth, requirePlatformAdmin, async (req, res) => {
    try {
      const rows = await bans.listBans(); // [{ discordId, reason, message, bannedBy, bannedAt }]
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
        } catch (e) { console.error('[admin] banned-users enrich failed:', e.message); }
      }
      res.json(enriched);
    } catch (e) {
      console.error('[admin] banned-users list failed:', e.message);
      res.status(500).json({ error: 'Failed to list banned users' });
    }
  });

  // Ban a user. reason/message optional — lib/bans defaults them to the standard scam copy.
  router.post('/api/admin/banned-users', requireAuth, requirePlatformAdmin, async (req, res) => {
    const discordId = String(req.body?.discordId || '').trim();
    if (!/^\d{5,}$/.test(discordId)) return res.status(400).json({ error: 'Valid Discord ID required' });
    if (tenants.isPlatformOwnerId(discordId)) return res.status(400).json({ error: 'Cannot ban the platform owner' });
    const reason = req.body?.reason ? String(req.body.reason).trim().slice(0, 200) : undefined;
    const message = req.body?.message ? String(req.body.message).trim().slice(0, 500) : undefined;
    try {
      await bans.addBan(discordId, { reason, message, bannedBy: req.user.id });
      // Manual aliases → directory (best-effort).
      const aliases = Array.isArray(req.body?.aliases) ? req.body.aliases : [];
      for (const a of aliases.slice(0, 20)) {
        if (recordAlias) recordAlias(discordId, a, 'manual');
      }
      // Best-effort Discord enrich — must NEVER block or fail the ban.
      try {
        const botToken = getPlatformBotToken && getPlatformBotToken();
        if (botToken) {
          const resp = await fetch(`https://discord.com/api/v10/users/${discordId}`,
            { headers: { Authorization: `Bot ${botToken}` } });
          if (resp.ok) {
            const u = await resp.json().catch(() => null);
            if (u && u.id) {
              if (recordAlias && u.username) recordAlias(discordId, u.username, 'discord');
              if (recordAlias && u.global_name) recordAlias(discordId, u.global_name, 'discord');
              if (recordKnownUser) recordKnownUser({
                id: String(u.id),
                displayName: u.global_name || u.username || `User ${discordId}`,
                username: u.username || null,
                avatar: u.avatar || null,
              });
            }
          }
        }
      } catch (e) { console.error('[admin] ban discord enrich failed:', e.message); }
      auditLog.record({ category: 'admin', action: 'ban.add', actorId: req.user.id,
        actorName: req.user.displayName, targetId: discordId,
        tenantId: req.tenant && req.tenant.id, ip: req.ip,
        summary: `${req.user.displayName || req.user.id} banned ${discordId}` });
      res.json({ ok: true });
    } catch (e) {
      console.error('[admin] banned-users add failed:', e.message);
      res.status(500).json({ error: 'Failed to ban user' });
    }
  });

  // Unban a user.
  router.delete('/api/admin/banned-users/:id', requireAuth, requirePlatformAdmin, async (req, res) => {
    const id = String(req.params.id || '').trim();
    try {
      await bans.removeBan(id);
      auditLog.record({ category: 'admin', action: 'ban.remove', actorId: req.user.id,
        actorName: req.user.displayName, targetId: id,
        tenantId: req.tenant && req.tenant.id, ip: req.ip,
        summary: `${req.user.displayName || req.user.id} unbanned ${id}` });
      res.json({ ok: true });
    } catch (e) {
      console.error('[admin] banned-users remove failed:', e.message);
      res.status(500).json({ error: 'Failed to unban user' });
    }
  });

  // ── Supporter management ───────────────────────────────────────────
  // Supporters are donors marked by hand. Global (all tenants). Platform-admin only.
  router.get('/api/admin/supporters', requireAuth, requirePlatformAdmin, async (req, res) => {
    try {
      const rows = await supporters.listSupporters(); // [{ discordId, addedBy, addedAt }]
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
        } catch (e) { console.error('[admin] supporters enrich failed:', e.message); }
      }
      res.json(enriched);
    } catch (e) {
      console.error('[admin] supporters list failed:', e.message);
      res.status(500).json({ error: 'Failed to list supporters' });
    }
  });

  router.post('/api/admin/supporters', requireAuth, requirePlatformAdmin, async (req, res) => {
    const discordId = String(req.body?.discordId || '').trim();
    if (!/^\d{5,}$/.test(discordId)) return res.status(400).json({ error: 'Valid Discord ID required' });
    try {
      await supporters.addSupporter(discordId, req.user.id);
      res.json({ ok: true });
    } catch (e) {
      console.error('[admin] supporters add failed:', e.message);
      res.status(500).json({ error: 'Failed to add supporter' });
    }
  });

  router.delete('/api/admin/supporters/:id', requireAuth, requirePlatformAdmin, async (req, res) => {
    const id = String(req.params.id || '').trim();
    try {
      await supporters.removeSupporter(id);
      res.json({ ok: true });
    } catch (e) {
      console.error('[admin] supporters remove failed:', e.message);
      res.status(500).json({ error: 'Failed to remove supporter' });
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
  // ── Change a community's plan ───────────────────────────────────────
  // The create endpoint above could SET a plan; nothing could CHANGE one, so every upgrade,
  // downgrade and comp meant hand-written SQL against production — and since `plan` is derived
  // into an in-memory cache at boot, a bare UPDATE stayed inert until the next deploy.
  // updateTenantPlan reloads the cache, so this takes effect immediately.
  //
  // Platform-admin only: plan drives feature gating and mod-seat caps, so a community admin
  // must never be able to upgrade their own tenant. Audited for the same reason.
  router.put('/api/admin/tenants/:slug/plan', requireAuth, requirePlatformAdmin, async (req, res) => {
    const slug = req.params.slug;
    const target = tenants.getTenantBySlug(slug);
    if (!target) return res.status(404).json({ error: 'Community not found' });
    const before = target.plan;
    try {
      const plan = await tenants.updateTenantPlan(target.id, (req.body || {}).plan);
      auditLog.recordFromReq(req, {
        category: 'admin', action: 'tenant.plan',
        targetId: target.id, targetName: target.displayName,
        summary: `${target.displayName} moved from ${before} to ${plan}`,
        detail: { before, after: plan },
      });
      res.json({ ok: true, slug, plan });
    } catch (e) {
      // updateTenantPlan throws on an unknown plan — that's a caller error, not a server fault.
      res.status(400).json({ error: e.message });
    }
  });

  // ── Bulk hunt backfill (admin importer, spec §3 Track B) ────────────────
  // A COMMUNITY admin imports their own PRE-PLATFORM hunt history (so Bean's own mods/admins run
  // this, not just the platform owner). Two-phase: POST with commit:false returns a dry-run diff
  // (creates/updates/rejects) and writes NOTHING; the operator reviews it and re-POSTs commit:true
  // to write. The public write endpoint deliberately refuses anything older than 48h — this is
  // where old history is allowed, behind a human confirm and the admin gate. Reuses
  // lib/huntBackfill.planImport, so a backfilled hunt is identical to an API-pushed one (idempotent
  // huntId, _approxRate:true, fail-closed identity vetting).
  //
  // TENANT ISOLATION: the target is ALWAYS req.tenant (resolved from X-Tenant-Slug by
  // resolveTenant), NEVER a client-supplied slug — requireAdmin has verified the caller
  // administers THIS tenant, so a community admin can only ever backfill their own community's
  // history. A platform owner keeps access here because they are an admin of every tenant.
  router.post('/api/admin/import-hunts', requireAuth, requireAdmin, async (req, res) => {
    const { commit } = req.body || {};
    const rows = Array.isArray(req.body?.hunts) ? req.body.hunts : null;
    if (!rows) return res.status(400).json({ error: 'hunts must be an array' });
    if (!rows.length) return res.status(400).json({ error: 'hunts is empty' });
    if (rows.length > 1000) return res.status(400).json({ error: 'Batch too large — max 1000 hunts per import' });

    const target = req.tenant;
    if (!target || !target.id) return res.status(400).json({ error: 'No community context' });

    // huntId embeds tenantId, so a global huntId set can never cross communities.
    const existingIds = new Set(archive.map(h => h && h.huntId).filter(Boolean));

    let plan;
    try {
      plan = await planImport(rows, {
        tenantId: target.id, hostDiscordId: target.hostDiscordId,
        now: Date.now(), existingIds, isKnownAccount,
      });
    } catch (e) {
      console.error('[admin] import-hunts plan failed:', e.message);
      return res.status(500).json({ error: 'Failed to plan import' });
    }

    const totals = { creates: plan.creates.length, updates: plan.updates.length, rejects: plan.rejects.length };
    const base = { slug: target.slug, community: target.displayName,
      creates: plan.creates, updates: plan.updates, rejects: plan.rejects, totals };

    if (!commit) return res.json({ dryRun: true, ...base });

    for (const hunt of plan.hunts) archiveHunt(hunt); // archiveHunt persists + records stats itself
    emitHubUpdate(target.id);                          // refresh the community's Archived tab

    // ONE batch audit row — a per-hunt row would flood the log. externalIds in `detail` make it
    // inspectable/reversible.
    auditLog.recordFromReq(req, {
      category: 'admin', action: 'hunt.backfill',
      targetId: target.id, targetName: target.displayName,
      summary: `Imported ${totals.creates} + updated ${totals.updates} hunt(s) into ${target.displayName} (${totals.rejects} rejected)`,
      detail: {
        slug: target.slug,
        created: plan.creates.map(c => c.externalId),
        updated: plan.updates.map(u => u.externalId),
        rejected: plan.rejects.map(r => ({ index: r.index, externalId: r.externalId, code: r.code })),
      },
    });

    res.json({ committed: true, ...base });
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

  // ── Community hashtags (owner-editable) ─────────────────────────────
  // The rotating taglines shown "up top" on this community (hub hero, hunt top bar). Stored in
  // branding.hashtags; sanitized in lib/tenants (leading #, no whitespace/markup). Tenant-scoped
  // via req.tenant, so a community only edits its own. Empty array clears them (display falls back
  // to the built-in defaults).
  router.get('/api/admin/hashtags', requireAuth, requireAdmin, (req, res) => {
    res.json({
      communityName: req.tenant?.displayName || 'Bean',
      hashtags: (req.tenant.branding && req.tenant.branding.hashtags) || [],
    });
  });
  router.put('/api/admin/hashtags', requireAuth, requireAdmin, async (req, res) => {
    try {
      const saved = await tenants.updateTenantHashtags(req.tenant.id, req.body && req.body.hashtags);
      res.json({ ok: true, hashtags: saved });
    } catch (e) {
      console.error('[admin] hashtags update failed:', e.message);
      res.status(500).json({ error: 'Failed to update hashtags' });
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
