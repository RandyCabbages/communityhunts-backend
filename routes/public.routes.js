// Public Developer API — key-authed, tier-gated, rate-limited, stable serializers.
// Mounted AFTER resolveTenant in server.js (with the other DI routers): requireApiKey derives
// the tenant from the KEY and overrides req.tenant, so tenant never comes from a header here.

const express = require('express');

function paginate(req) {
  let limit = parseInt(req.query.limit, 10); if (!Number.isFinite(limit) || limit <= 0) limit = 25;
  limit = Math.min(limit, 100);
  let offset = parseInt(req.query.offset, 10); if (!Number.isFinite(offset) || offset < 0) offset = 0;
  return { limit, offset };
}

module.exports = function publicRoutes(deps) {
  const {
    requireApiKey, requireApiFeature, rateLimit, serializers,
    getHuntStats, hunts, archive, tenantOf,
    huntHasContent, huntCompleted, modHuntKey, affiliateHuntKey,
    getGotInLog, collectBangers,
  } = deps;
  const router = express.Router();

  // Own CORS: open to any origin, NO credentials (Bearer-key auth, no cookies). Path-scoped —
  // this router is mounted app-wide (server.js), so an unscoped `router.use` would run on every
  // request in the app and clobber the global cors() headers on unrelated routes.
  router.use('/api/public/v1', (req, res, next) => {
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Methods', 'GET,OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Authorization,Content-Type');
    // ACAO:* + ACAC:true is an invalid combination (browsers reject it). The global CORS
    // middleware now skips /api/public/* entirely (server.js), but strip defensively in case
    // something upstream ever sets it again.
    res.removeHeader('Access-Control-Allow-Credentials');
    if (req.method === 'OPTIONS') return res.status(204).end();
    next();
  });

  // Every route: key → rate limit → (tier) → handler.
  router.use('/api/public/v1', requireApiKey, rateLimit);

  router.get('/api/public/v1/hunts', requireApiFeature('developer_api'), (req, res) => {
    const tid = req.apiTenantId;
    const status = String(req.query.status || 'all');
    let list = [];
    // Mirrors lib/hunts-core.js getPublicHunts/getArchivedHunts eligibility predicates EXACTLY,
    // applied to the raw hunt objects (not huntSummary — serializers.publicHunt needs the full
    // hunt). Keep this in sync with hunts-core.js by hand; do not call getPublicHunts/
    // getArchivedHunts directly here.
    if (status === 'live' || status === 'all') {
      list = list.concat(Object.values(hunts).filter(h =>
        h.isLive && huntHasContent(h) && !huntCompleted(h) && tenantOf(h) === tid &&
        h.user?.id !== modHuntKey(tid) && h.user?.id !== affiliateHuntKey(tid)));
    }
    if (status === 'archived' || status === 'all') {
      list = list.concat(archive.filter(h => tenantOf(h) === tid && huntCompleted(h)));
    }
    list.sort((a, b) => new Date(b.archivedAt || b.startedAt || 0) - new Date(a.archivedAt || a.startedAt || 0));
    const { limit, offset } = paginate(req);
    const page = list.slice(offset, offset + limit).map(serializers.publicHunt);
    res.set('Cache-Control', 'no-store');
    res.json({ data: page, pagination: { limit, offset, total: list.length } });
  });

  router.get('/api/public/v1/hunts/:id', requireApiFeature('developer_api'), (req, res) => {
    const tid = req.apiTenantId, id = req.params.id;
    const found = [...Object.values(hunts), ...archive].find(h => h.huntId === id && tenantOf(h) === tid);
    if (!found) return res.status(404).json({ error: { code: 'not_found', message: 'Hunt not found' } });
    res.json({ data: serializers.publicHunt(found) });
  });

  router.get('/api/public/v1/stats', requireApiFeature('developer_api'), (req, res) => {
    const stats = getHuntStats(req.apiTenantId);
    res.set('Cache-Control', 'public, max-age=60');
    res.json({ data: serializers.publicStats(stats) });
  });

  // Premium tier (developer_api_premium): got-in event log + banger rail, same selection
  // logic as the session-authed admin export / public /api/bangers route respectively.
  router.get('/api/public/v1/got-in', requireApiFeature('developer_api_premium'), (req, res) => {
    const rows = getGotInLog(req.apiTenantId);
    const { limit, offset } = paginate(req);
    const page = serializers.publicGotIn(rows.slice(offset, offset + limit));
    res.set('Cache-Control', 'no-store');
    res.json({ data: page, pagination: { limit, offset, total: rows.length } });
  });

  router.get('/api/public/v1/bangers', requireApiFeature('developer_api_premium'), (req, res) => {
    const list = collectBangers(hunts, archive, req.apiTenantId).map(serializers.publicBanger);
    res.set('Cache-Control', 'public, max-age=60');
    res.json({ data: list, pagination: { limit: list.length, offset: 0, total: list.length } });
  });

  // Public-scoped error envelope (the global handler returns a bare string — wrong shape).
  router.use((err, req, res, next) => {
    console.error('[public-api] error:', err && err.message);
    res.status(500).json({ error: { code: 'server_error', message: 'Internal error' } });
  });

  return router;
};
