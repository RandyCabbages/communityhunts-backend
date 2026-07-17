// Focused gate test: POST /api/admin/grandfather-full-extension must require PLATFORM admin,
// not merely a tenant admin. Follows the app.listen(0) + stub-deps pattern.
const { test } = require('node:test');
const assert = require('node:assert');
const express = require('express');
const settingsRoutes = require('./settings.routes');

function appWith({ platformAdmin }) {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.user = { id: 'caller' }; req.tenant = { id: 'bean' }; next(); });
  const pass = (req, res, next) => next();
  const requirePlatformAdmin = platformAdmin
    ? pass
    : (req, res, next) => res.status(403).json({ error: 'Platform admin only' });
  app.use(settingsRoutes({
    settings: { getSettings: async () => ({}), saveSettings: async () => {}, deleteSettings: async () => {}, resolveUserIdByName: async () => null },
    pgPool: null, memberships: {},
    isPlatformAdmin: () => platformAdmin,
    reqIsMod: () => false, reqIsVipHost: () => false, reqHasFullExtension: async () => false,
    requireAuth: pass, requireAdmin: pass, requirePlatformAdmin,
    io: { emit() {} }, subscriptions: {},
    featureGrants: { grandfatherGrant: async () => 7 },
    hunts: {}, archive: [], statsStore: {}, refreshGuildRoles: async () => null,
  }));
  return app;
}

async function req(app, method, pathname) {
  const server = await new Promise(r => { const s = app.listen(0, () => r(s)); });
  try {
    const r = await fetch(`http://127.0.0.1:${server.address().port}${pathname}`, {
      method, headers: { 'Content-Type': 'application/json' }, body: '{}',
    });
    return { status: r.status, body: await r.json().catch(() => null) };
  } finally {
    await new Promise(res => server.close(res));
  }
}

test('tenant admin (non-platform) is rejected', async () => {
  const res = await req(appWith({ platformAdmin: false }), 'POST', '/api/admin/grandfather-full-extension');
  assert.strictEqual(res.status, 403);
});

test('platform admin succeeds and backfills', async () => {
  const res = await req(appWith({ platformAdmin: true }), 'POST', '/api/admin/grandfather-full-extension');
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(res.body, { ok: true, granted: 7 });
});
