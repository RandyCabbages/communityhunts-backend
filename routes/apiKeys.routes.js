// Session-authed management of the community's Developer API key. Owner + platform admin only
// (mods excluded). Tenant from X-Tenant-Slug as usual (this is NOT the public key-authed layer).

const express = require('express');
const { LIMITS } = require('../lib/rateLimit');
const { PUBLIC_HUNT_CATEGORIES } = require('../lib/hunts-core');
// The same resolvers GET /api/public/v1/me reads through, plus the validator that guards writes
// into them — so the editor's preview, the saved value and the published value are one thing.
const {
  sanitizeApiConfig, resolveHouseHuntTypes, resolveHuntTypeLabels,
  DEFAULT_HOUSE_HUNT_TYPES, DEFAULT_HUNT_TYPE_LABELS,
} = require('../lib/apiIdentity');

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
    // Write is opt-in PER KEY. Omitting `scopes` yields a read-only key, so the safe key is what
    // you get by default and the powerful one has to be asked for. normalizeScopes drops anything
    // that isn't a real scope, so a junk body can't widen the grant.
    const { rawKey, prefix, scopes } = apiKeys.generateKey(req.tenant.slug, req.user.id, req.body && req.body.scopes);
    res.set('Cache-Control', 'no-store');
    res.json({ rawKey, prefix, scopes }); // rawKey shown exactly once
  });

  router.delete('/api/admin/api-key', requireAuth, requireOwnerOrPlatform, (req, res) => {
    apiKeys.revokeKey(req.tenant.slug);
    res.json({ ok: true });
  });

  // ── Developer API vocabulary ────────────────────────────────────────────────────────────────
  // What GET /api/public/v1/me tells an integrator about THIS community: which hunt types are the
  // community's own, and what it calls each type. Per-tenant policy, previously settable only by
  // editing Postgres.
  //
  // Gated at requireOwnerOrPlatform, the same bar as the key itself rather than the looser
  // requireAdmin used by socials/hashtags. Deliberate: this shapes what the community's PUBLIC API
  // publishes, it sits on the same screen as the key, and reqIsAdmin folds mods in — a weaker gate
  // here would let a mod rewrite the contract an integrator builds against.
  //
  // Returns the platform defaults alongside the saved overrides so the editor can show them as
  // placeholders. That is what makes "empty means inherit" legible: a blank field is a live link
  // to the default, not a copy of it frozen at the moment someone opened the page.
  router.get('/api/admin/api-vocabulary', requireAuth, requireOwnerOrPlatform, (req, res) => {
    const saved = (req.tenant.branding && req.tenant.branding.api) || {};
    res.json({
      huntTypes: [...PUBLIC_HUNT_CATEGORIES],
      defaults: {
        houseHuntTypes: [...DEFAULT_HOUSE_HUNT_TYPES],
        huntTypeLabels: { ...DEFAULT_HUNT_TYPE_LABELS },
      },
      saved: {
        houseHuntTypes: Array.isArray(saved.houseHuntTypes) ? saved.houseHuntTypes : null,
        huntTypeLabels: (saved.huntTypeLabels && typeof saved.huntTypeLabels === 'object') ? saved.huntTypeLabels : {},
      },
      // Exactly what /me will serve after this save — resolved through the same functions the
      // public endpoint uses, so the preview cannot claim something the API then contradicts.
      effective: {
        houseHuntTypes: resolveHouseHuntTypes(req.tenant),
        huntTypeLabels: resolveHuntTypeLabels(req.tenant),
      },
    });
  });

  // FULL REPLACE, not a patch: the body is the complete vocabulary state and it overwrites
  // `branding.api` wholesale. That is what makes "reset to default" possible — submitting the
  // defaults sanitizes to `{}`, which resolves back to the platform defaults. Merging instead
  // would leave an override unclearable, since sanitizeApiConfig drops default-equal values and
  // there would be nothing left to overwrite the stored one with. The editor sends both fields.
  router.put('/api/admin/api-vocabulary', requireAuth, requireOwnerOrPlatform, async (req, res) => {
    // Rejected loudly rather than normalised: the resolvers fall back to defaults on read, so a
    // silently-dropped bad value would look saved and then serve something else.
    const parsed = sanitizeApiConfig(req.body || {});
    if (!parsed.ok) return res.status(400).json({ error: parsed.error });
    try {
      await tenants.updateTenantApiConfig(req.tenant.id, parsed.value);
      // Re-read through the cache updateTenantApiConfig just reloaded, so the response is the new
      // truth rather than this request's stale req.tenant.
      const fresh = tenants.getTenantBySlug(req.tenant.slug) || req.tenant;
      res.json({
        ok: true,
        saved: parsed.value,
        effective: {
          houseHuntTypes: resolveHouseHuntTypes(fresh),
          huntTypeLabels: resolveHuntTypeLabels(fresh),
        },
      });
    } catch (e) {
      console.error('[admin] api-vocabulary update failed:', e.message);
      res.status(500).json({ error: 'Failed to save API vocabulary' });
    }
  });

  return router;
};
