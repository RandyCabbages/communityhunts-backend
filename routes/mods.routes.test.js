// Phase 3: a community's own admin (non-platform) can add/remove mods. Before, these were
// requirePlatformAdmin (owner-only); now requireTenantAdmin. A mod still cannot (requireTenantAdmin
// excludes mods — that gate's own test lives in lib/auth.test.js).
const { test } = require('node:test');
const assert = require('node:assert');
const express = require('express');
const modsRoutes = require('./mods.routes');

function appWith({ tenantAdmin }) {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.user = { id: 'u1' }; req.tenant = { id: 'bean', displayName: 'Bean' }; next(); });
  const pass = (req, res, next) => next();
  // Tenant admin passes requireTenantAdmin but NOT requirePlatformAdmin.
  const requireTenantAdmin = tenantAdmin ? pass : (req, res, next) => res.status(403).json({ error: 'tenant admin only' });
  const requirePlatformAdmin = (req, res, next) => res.status(403).json({ error: 'platform only' });
  app.use(modsRoutes({
    requireAuth: pass, requireAdmin: pass, requirePlatformAdmin, requireTenantAdmin,
    pgPool: null,
    tenants: {
      listTenantMods: async () => [],
      addTenantMod: async () => {},
      removeTenantMod: async () => {},
      isPlatformOwnerId: () => false,
      modSeatCap: () => Infinity,
    },
  }));
  return app;
}

async function call(app, method, pathname, body) {
  const server = await new Promise(r => { const s = app.listen(0, () => r(s)); });
  try {
    const r = await fetch(`http://127.0.0.1:${server.address().port}${pathname}`, {
      method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
    });
    return { status: r.status, body: await r.json().catch(() => null) };
  } finally {
    await new Promise(res => server.close(res));
  }
}

test('tenant admin can add a mod', async () => {
  const res = await call(appWith({ tenantAdmin: true }), 'POST', '/api/admin/mods', { discordId: '123456789' });
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(res.body, { ok: true });
});

test('tenant admin can remove a mod', async () => {
  const res = await call(appWith({ tenantAdmin: true }), 'DELETE', '/api/admin/mods/123456789');
  assert.strictEqual(res.status, 200);
});

test('a non-tenant-admin is rejected from adding a mod', async () => {
  const res = await call(appWith({ tenantAdmin: false }), 'POST', '/api/admin/mods', { discordId: '123456789' });
  assert.strictEqual(res.status, 403);
});
