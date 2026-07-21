// GOTIN export key (3b): the key path must be tenant-BLIND — it pins to the platform tenant
// (Bean) and ignores the client-supplied slug, so a leaked key can't export another tenant's
// data. Without key AND without an admin session, the export is rejected. The daily headless
// script (which asks for bean) keeps working.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const express = require('express');
const adminRoutes = require('./admin.routes');

before(() => { process.env.GOTIN_EXPORT_KEY = 'topsecret'; });
after(() => { delete process.env.GOTIN_EXPORT_KEY; });

const BEAN = { id: 'bean', displayName: 'Bean' };
const TRASH = { id: 'trashguy', displayName: 'TrashGuy' };

function appWith({ session, clientTenant, capture }) {
  const app = express();
  // Simulate resolveTenant honoring the client slug (this is the spoofable input).
  app.use((req, res, next) => { req.user = session ? { id: 'admin1' } : null; req.tenant = clientTenant; next(); });
  const requireAuth = (req, res, next) => req.user ? next() : res.status(401).json({ error: 'auth' });
  const requireAdmin = (req, res, next) => req.user ? next() : res.status(403).json({ error: 'admin' });
  const requirePlatformAdmin = (req, res, next) => res.status(403).json({ error: 'platform' });
  const requireTenantAdmin = (req, res, next) => next();
  app.use(adminRoutes({
    requireAuth, requireAdmin, requirePlatformAdmin, requireTenantAdmin,
    getAllHunts: () => [], getArchivedHunts: () => [], getHuntsFullExport: () => [], getHuntStats: () => ({}),
    getGotInLog: (tid) => { if (capture) capture.tenantId = tid; return []; },
    pgPool: null, admins: {}, ADMIN_IDS: [], statsStore: {},
    tenants: { getTenantBySlug: (s) => (s === 'bean' ? BEAN : null), BEAN_TENANT: BEAN },
    hunts: {}, archive: [], archiveHunt() {}, unarchiveHunt() {}, persistArchive() {},
    emitHubUpdate() {}, publicHuntView: h => h, emitHuntUpdate() {}, io: { emit() {} }, uid: () => 'x', cleanupStaleHunts() {},
    subscriptions: {},
  }));
  return app;
}

async function get(app, pathname) {
  const server = await new Promise(r => { const s = app.listen(0, () => r(s)); });
  try {
    const r = await fetch(`http://127.0.0.1:${server.address().port}${pathname}`);
    return r.status;
  } finally {
    await new Promise(res => server.close(res));
  }
}

test('key auth ignores a spoofed client slug and pins the export to bean', async () => {
  const capture = {};
  // Client claims trashguy via _tenant AND presents the key. Export must still be bean.
  await get(appWith({ session: false, clientTenant: TRASH, capture }), '/api/admin/gotin-log.xlsx?key=topsecret&_tenant=trashguy');
  assert.strictEqual(capture.tenantId, 'bean');
});

test('no key and no session is rejected (401)', async () => {
  const status = await get(appWith({ session: false, clientTenant: BEAN }), '/api/admin/gotin-log.xlsx');
  assert.strictEqual(status, 401);
});

test('discord-config is gated on requireTenantAdmin, not requireAdmin (mods rejected)', async () => {
  const app = express();
  app.use((req, res, next) => { req.user = { id: 'mod1' }; req.tenant = { id: 'bean', displayName: 'Bean' }; next(); });
  const pass = (req, res, next) => next();
  const denyTenantAdmin = (req, res, next) => res.status(403).json({ error: 'tenant admin only' });
  app.use(adminRoutes({
    requireAuth: pass, requireAdmin: pass, requirePlatformAdmin: pass, requireTenantAdmin: denyTenantAdmin,
    getAllHunts: () => [], getArchivedHunts: () => [], getGotInLog: () => [], getHuntsFullExport: () => [], getHuntStats: () => ({}),
    pgPool: null, admins: {}, ADMIN_IDS: [], statsStore: {},
    tenants: { getTenantDiscordConfig: () => ({ botToken: 'SECRET' }), BEAN_TENANT: { id: 'bean' } },
    hunts: {}, archive: [], archiveHunt() {}, unarchiveHunt() {}, persistArchive() {},
    emitHubUpdate() {}, publicHuntView: h => h, emitHuntUpdate() {}, io: { emit() {} }, uid: () => 'x', cleanupStaleHunts() {},
    subscriptions: {},
  }));
  const server = await new Promise(r => { const s = app.listen(0, () => r(s)); });
  try {
    const r = await fetch(`http://127.0.0.1:${server.address().port}/api/admin/discord-config`);
    assert.strictEqual(r.status, 403); // requireTenantAdmin denies; requireAdmin (pass) would have 200'd
  } finally {
    await new Promise(res => server.close(res));
  }
});

test('GET /api/admin/communities returns cross-tenant list with plan + counts (platform-gated)', async () => {
  const app = express();
  app.use((req, res, next) => { req.user = { id: 'owner' }; req.tenant = { id: 'bean' }; next(); });
  const pass = (req, res, next) => next();
  app.use(adminRoutes({
    requireAuth: pass, requireAdmin: pass, requirePlatformAdmin: pass, requireTenantAdmin: pass,
    getAllHunts: (tid) => tid === 'bean' ? [{ isLive: true }, { isLive: true, archivedAt: 1 }, { isLive: false }] : [],
    getArchivedHunts: () => [], getGotInLog: () => [], getHuntsFullExport: () => [], getHuntStats: () => ({}),
    pgPool: { query: async () => ({ rows: [{ tenant_id: 'bean', n: 91 }] }) },
    admins: {}, ADMIN_IDS: [], statsStore: {},
    tenants: {
      getAllTenants: () => [
        { id: 'bean', slug: 'bean', displayName: 'Bean', branding: { accent: '#abc' }, plan: 'pro', isActive: true },
        { id: 'gone', slug: 'gone', displayName: 'Gone', branding: {}, plan: 'free', isActive: false },
      ],
    },
    hunts: {}, archive: [], archiveHunt() {}, unarchiveHunt() {}, persistArchive() {},
    emitHubUpdate() {}, publicHuntView: h => h, emitHuntUpdate() {}, io: { emit() {} }, uid: () => 'x', cleanupStaleHunts() {},
    subscriptions: {},
  }));
  const server = await new Promise(r => { const s = app.listen(0, () => r(s)); });
  try {
    const r = await fetch(`http://127.0.0.1:${server.address().port}/api/admin/communities`);
    const body = await r.json();
    assert.strictEqual(r.status, 200);
    assert.strictEqual(body.length, 1); // inactive tenant excluded
    assert.deepStrictEqual(body[0], { slug: 'bean', displayName: 'Bean', accent: '#abc', plan: 'pro', memberCount: 91, activeHunts: 1 });
  } finally {
    await new Promise(res => server.close(res));
  }
});

// ── Banned-user management ──────────────────────────────────────────
// A fake bans module + auditLog capturing calls, mounted behind a passing platform-admin gate.
function banApp({ platformAdmin = true, bansImpl, audit }) {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.user = { id: 'admin1', displayName: 'Admin' }; req.tenant = BEAN; next(); });
  const pass = (req, res, next) => next();
  const gate = platformAdmin ? pass : (req, res, next) => res.status(403).json({ error: 'platform' });
  app.use(adminRoutes({
    requireAuth: pass, requireAdmin: pass, requirePlatformAdmin: gate, requireTenantAdmin: pass,
    getAllHunts: () => [], getArchivedHunts: () => [], getGotInLog: () => [], getHuntsFullExport: () => [], getHuntStats: () => ({}),
    pgPool: null, admins: {}, bans: bansImpl, ADMIN_IDS: [], statsStore: {},
    tenants: { isPlatformOwnerId: (id) => id === '135203806676779008', BEAN_TENANT: BEAN },
    hunts: {}, archive: [], archiveHunt() {}, unarchiveHunt() {}, persistArchive() {},
    emitHubUpdate() {}, publicHuntView: h => h, emitHuntUpdate() {}, io: { emit() {} }, uid: () => 'x', cleanupStaleHunts() {},
    subscriptions: {}, auditLog: audit || { record() {} },
  }));
  return app;
}

async function req(app, method, pathname, body) {
  const server = await new Promise(r => { const s = app.listen(0, () => r(s)); });
  try {
    const r = await fetch(`http://127.0.0.1:${server.address().port}${pathname}`, {
      method, headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: r.status, body: await r.json().catch(() => null) };
  } finally { await new Promise(res => server.close(res)); }
}

test('POST /api/admin/banned-users bans a user (records banned_by + audit)', async () => {
  const added = [];
  const audit = { records: [], record(e) { this.records.push(e); } };
  const app = banApp({ bansImpl: { addBan: async (id, opts) => added.push({ id, opts }), listBans: async () => [] }, audit });
  const { status } = await req(app, 'POST', '/api/admin/banned-users', { discordId: '693694981457838140', reason: 'scamming' });
  assert.strictEqual(status, 200);
  assert.strictEqual(added[0].id, '693694981457838140');
  assert.strictEqual(added[0].opts.bannedBy, 'admin1');
  assert.ok(audit.records.some(r => r.action === 'ban.add'));
});

test('POST /api/admin/banned-users rejects a bad id and refuses the owner', async () => {
  const app = banApp({ bansImpl: { addBan: async () => { throw new Error('should not be called'); } } });
  assert.strictEqual((await req(app, 'POST', '/api/admin/banned-users', { discordId: 'nope' })).status, 400);
  assert.strictEqual((await req(app, 'POST', '/api/admin/banned-users', { discordId: '135203806676779008' })).status, 400);
});

test('DELETE /api/admin/banned-users/:id unbans (audit ban.remove)', async () => {
  const removed = [];
  const audit = { records: [], record(e) { this.records.push(e); } };
  const app = banApp({ bansImpl: { removeBan: async (id) => removed.push(id) }, audit });
  const { status } = await req(app, 'DELETE', '/api/admin/banned-users/693694981457838140');
  assert.strictEqual(status, 200);
  assert.deepStrictEqual(removed, ['693694981457838140']);
  assert.ok(audit.records.some(r => r.action === 'ban.remove'));
});

test('banned-user routes are platform-admin gated (403 for non-platform-admin)', async () => {
  const app = banApp({ platformAdmin: false, bansImpl: { listBans: async () => [] } });
  assert.strictEqual((await req(app, 'GET', '/api/admin/banned-users')).status, 403);
});
