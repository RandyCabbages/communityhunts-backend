// GET /api/cosmetics/releases must be PUBLIC: the Shop renders for logged-out visitors, and a
// 401 here would hide every released `hidden` card from exactly the audience it exists to entice.
// The write path (PUT /api/admin/cosmetics/releases/:itemId) stays platform-admin only.
const { test } = require('node:test');
const assert = require('node:assert');
const express = require('express');
const cosmeticsRoutes = require('./cosmetics.routes');

// requireAuth here mimics the real gate: 401 when there is no req.user.
function appWith({ user = null } = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { if (user) req.user = user; req.tenant = { id: 'bean' }; next(); });
  const requireAuth = (req, res, next) =>
    req.user ? next() : res.status(401).json({ error: 'Not authenticated' });
  const requirePlatformAdmin = (req, res, next) =>
    res.status(403).json({ error: 'Platform admin only' });
  app.use(cosmeticsRoutes({
    requireAuth, requirePlatformAdmin,
    settings: { getSettings: async () => ({ cosmeticsOwned: [] }), saveSettings: async () => {} },
    stripeLib: null, subscriptions: {}, FRONTEND_URL: 'https://example.test',
    isAdmin: () => false, reqHasFullExtension: async () => false,
    cardReleases: { listReleased: () => ['card_cook'], setReleased: () => ['card_cook'] },
    auditLog: { record() {}, recordFromReq() {} },
  }));
  return app;
}

async function req(app, method, pathname) {
  const server = await new Promise(r => { const s = app.listen(0, () => r(s)); });
  try {
    const r = await fetch(`http://127.0.0.1:${server.address().port}${pathname}`, { method });
    return { status: r.status, body: await r.json().catch(() => null) };
  } finally {
    await new Promise(res => server.close(res));
  }
}

test('GET /api/cosmetics/releases is public — 200 with no session', async () => {
  const res = await req(appWith({ user: null }), 'GET', '/api/cosmetics/releases');
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(res.body, { released: ['card_cook'] });
});

test('GET /api/cosmetics/releases still works for a signed-in user', async () => {
  const res = await req(appWith({ user: { id: 'u1' } }), 'GET', '/api/cosmetics/releases');
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(res.body, { released: ['card_cook'] });
});

test('the release WRITE path stays admin-gated', async () => {
  const res = await req(appWith({ user: { id: 'u1' } }), 'PUT', '/api/admin/cosmetics/releases/card_cook');
  assert.strictEqual(res.status, 403);
});
