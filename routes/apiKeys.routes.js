// Session-authed management of the community's Developer API key. Owner + platform admin only
// (mods excluded). Tenant from X-Tenant-Slug as usual (this is NOT the public key-authed layer).

const express = require('express');
const { LIMITS } = require('../lib/rateLimit');

module.exports = function apiKeysRoutes(deps) {
  const { requireAuth, apiKeys, tenants, isPlatformAdmin, canUse } = deps;
  const router = express.Router();

  function requireOwnerOrPlatform(req, res, next) {
    const u = req.user;
    if (u && (isPlatformAdmin(u) || tenants.isTenantAdmin(u, req.tenant))) return next();
    return res.status(403).json({ error: 'Owner or platform admin only' });
  }
  function qualifies(req) { return canUse('developer_api', null, req.tenant.plan); }

  router.get('/api/admin/api-key', requireAuth, requireOwnerOrPlatform, (req, res) => {
    const tier = req.tenant.plan;
    res.json({
      key: apiKeys.getKeyMeta(req.tenant.slug),      // null if none
      qualifies: qualifies(req),
      tier,
      limits: LIMITS[tier] || null,
      premium: canUse('developer_api_premium', null, tier),
    });
  });

  router.post('/api/admin/api-key', requireAuth, requireOwnerOrPlatform, (req, res) => {
    if (!qualifies(req)) return res.status(403).json({ error: 'Upgrade to Pro to use the Developer API' });
    const { rawKey, prefix } = apiKeys.generateKey(req.tenant.slug, req.user.id);
    res.set('Cache-Control', 'no-store');
    res.json({ rawKey, prefix }); // rawKey shown exactly once
  });

  router.delete('/api/admin/api-key', requireAuth, requireOwnerOrPlatform, (req, res) => {
    apiKeys.revokeKey(req.tenant.slug);
    res.json({ ok: true });
  });

  return router;
};
