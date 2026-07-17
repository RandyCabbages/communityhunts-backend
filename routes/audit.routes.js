// Owner-only audit-log read endpoint. GET /api/admin/audit — returns rows across ALL tenants
// (requirePlatformAdmin makes that safe; NEVER filter by req.tenant.id). Query is delegated to
// lib/auditLog. Thin router, mounted from the server.js composition root.
//
//   GET /api/admin/audit?category=&actor=&target=&q=&from=&to=&cursor=&limit=
const express = require('express');

module.exports = function auditRoutes(deps) {
  const { requireAuth, requirePlatformAdmin, auditLog } = deps;
  const router = express.Router();

  router.get('/api/admin/audit', requireAuth, requirePlatformAdmin, async (req, res) => {
    try {
      const { category, actor, target, q, from, to, cursor, limit } = req.query;
      const out = await auditLog.query({
        category: category || null, actorId: actor || null, targetId: target || null,
        q: q || null, from: from || null, to: to || null,
        cursor: cursor || null, limit: limit || 50,
      });
      res.json(out);
    } catch (e) {
      console.error('[audit] query failed:', e.message);
      res.status(500).json({ error: 'Audit query failed' });
    }
  });

  return router;
};
