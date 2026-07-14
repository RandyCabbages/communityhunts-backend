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
    getPublicHunts, getArchivedHunts, getHuntStats, hunts, archive, tenantOf,
  } = deps;
  const router = express.Router();

  // Own CORS: open to any origin, NO credentials (Bearer-key auth, no cookies).
  router.use((req, res, next) => {
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Methods', 'GET,OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Authorization,Content-Type');
    if (req.method === 'OPTIONS') return res.status(204).end();
    next();
  });

  // Every route: key → rate limit → (tier) → handler.
  router.use('/api/public/v1', requireApiKey, rateLimit);

  router.get('/api/public/v1/hunts', requireApiFeature('developer_api'), (req, res) => {
    const tid = req.apiTenantId;
    const status = String(req.query.status || 'all');
    let list = [];
    if (status === 'live' || status === 'all')     list = list.concat(Object.values(hunts).filter(h => h.isLive && tenantOf(h) === tid));
    if (status === 'archived' || status === 'all') list = list.concat(archive.filter(h => tenantOf(h) === tid));
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

  // Public-scoped error envelope (the global handler returns a bare string — wrong shape).
  router.use((err, req, res, next) => {
    console.error('[public-api] error:', err && err.message);
    res.status(500).json({ error: { code: 'server_error', message: 'Internal error' } });
  });

  return router;
};
