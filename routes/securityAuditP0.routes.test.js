// End-to-end regression tests for the 2026-07-18 P0 security fixes, driving the REAL route
// handlers over HTTP (app.listen(0) + stub-deps pattern, same as settings.routes.test.js).
// Covers: FE #1 (exclusive-card equip gate) and BE #3 (anonymous PII redaction on the admin
// user list + profile routes). BE #2/#5 are covered by lib-level checks elsewhere.
const { test } = require('node:test');
const assert = require('node:assert');
const express = require('express');
const settingsRoutes = require('./settings.routes');
const { EXCLUSIVE_ITEMS } = require('./cosmetics.routes');

const TYLERRR_OWNER = EXCLUSIVE_ITEMS.card_tylerrr; // '1461157539759526121'
const pass = (req, res, next) => next();

// Mount the settings router with a given caller + role stubs + settings store.
function appWith({ caller, isPlatformAdmin = false, reqIsMod = false, getSettings, pgPool = null }) {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.user = caller; req.tenant = { id: 'bean' }; next(); });
  app.use(settingsRoutes({
    settings: { getSettings, saveSettings: async () => {}, deleteSettings: async () => {}, resolveUserIdByName: async () => null },
    pgPool, memberships: { getUserCommunities: async () => [] },
    isPlatformAdmin: () => isPlatformAdmin,
    reqIsMod: () => reqIsMod,
    reqIsVipHost: () => false,
    reqHasFullExtension: async () => false,
    requireAuth: pass, requireAdmin: pass, requirePlatformAdmin: pass,
    io: { emit() {}, to: () => ({ emit() {} }) },
    subscriptions: { getSubscription: async () => null },
    featureGrants: { getGrantsForUser: () => [] },
    hunts: {}, archive: [], statsStore: null,
    refreshGuildRoles: async () => null,
  }));
  return app;
}

async function call(app, method, pathname, body) {
  const server = await new Promise(r => { const s = app.listen(0, () => r(s)); });
  try {
    const noBody = method === 'GET' || method === 'HEAD';
    const r = await fetch(`http://127.0.0.1:${server.address().port}${pathname}`, {
      method, headers: { 'Content-Type': 'application/json' },
      ...(noBody ? {} : { body: body === undefined ? '{}' : JSON.stringify(body) }),
    });
    return { status: r.status, body: await r.json().catch(() => null) };
  } finally {
    await new Promise(res => server.close(res));
  }
}

// ── FE #1 — exclusive-card equip gate ──────────────────────────────────────
const equipStore = (owned = []) => async () => ({ cosmeticsOwned: owned, cosmetics: {} });

test('FE#1: non-owner equipping card_tylerrr is REJECTED (card dropped from save)', async () => {
  const app = appWith({ caller: { id: 'attacker' }, getSettings: equipStore() });
  const res = await call(app, 'PUT', '/api/settings', { cosmetics: { card: 'card_tylerrr' } });
  assert.strictEqual(res.status, 200);
  assert.notStrictEqual(res.body.settings.cosmetics.card, 'card_tylerrr'); // the exploit: must NOT stick
});

test('FE#1: the exclusive owner CAN equip their card', async () => {
  const app = appWith({ caller: { id: TYLERRR_OWNER }, getSettings: equipStore() });
  const res = await call(app, 'PUT', '/api/settings', { cosmetics: { card: 'card_tylerrr' } });
  assert.strictEqual(res.body.settings.cosmetics.card, 'card_tylerrr');
});

test('FE#1: admin-granted (in cosmeticsOwned) can equip', async () => {
  const app = appWith({ caller: { id: 'granted' }, getSettings: equipStore(['card_tylerrr']) });
  const res = await call(app, 'PUT', '/api/settings', { cosmetics: { card: 'card_tylerrr' } });
  assert.strictEqual(res.body.settings.cosmetics.card, 'card_tylerrr');
});

test('FE#1: a mod/admin (priv) can equip any exclusive', async () => {
  const app = appWith({ caller: { id: 'mod' }, reqIsMod: true, getSettings: equipStore() });
  const res = await call(app, 'PUT', '/api/settings', { cosmetics: { card: 'card_tylerrr' } });
  assert.strictEqual(res.body.settings.cosmetics.card, 'card_tylerrr');
});

// ── BE #3 — anonymous rainbet/twitch redaction (profile + list) ─────────────
const anonTarget = async () => ({ anonymous: true, rainbetName: 'secretRB', twitchName: 'secretTV', preferredSlots: [] });
const profilePg = { query: async () => ({ rows: [{ display_name: 'Victim', username: 'victim', avatar: null, last_seen: null }] }) };

test('BE#3 profile: a mod sees anonymous user handles REDACTED', async () => {
  const app = appWith({ caller: { id: 'mod' }, reqIsMod: true, getSettings: anonTarget, pgPool: profilePg });
  const res = await call(app, 'GET', '/api/admin/users/victim');
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.rainbetName, null);
  assert.strictEqual(res.body.twitchName, null);
});

test('BE#3 profile: a platform admin sees anonymous user handles', async () => {
  const app = appWith({ caller: { id: 'owner' }, isPlatformAdmin: true, getSettings: anonTarget, pgPool: profilePg });
  const res = await call(app, 'GET', '/api/admin/users/victim');
  assert.strictEqual(res.body.rainbetName, 'secretRB');
  assert.strictEqual(res.body.twitchName, 'secretTV');
});

const listPg = { query: async () => ({ rows: [{
  user_id: 'victim', display_name: 'Victim', username: 'victim', avatar: null, last_seen: null,
  settings: { anonymous: true, rainbetName: 'secretRB', twitchName: 'secretTV', preferredSlots: [] },
}] }) };

test('BE#3 list: a mod sees anonymous handles REDACTED in the list', async () => {
  const app = appWith({ caller: { id: 'mod' }, reqIsMod: true, getSettings: async () => ({}), pgPool: listPg });
  const res = await call(app, 'GET', '/api/admin/users');
  assert.strictEqual(res.body.users[0].rainbetName, null);
  assert.strictEqual(res.body.users[0].twitchName, null);
});

test('BE#3 list: a platform admin sees anonymous handles in the list', async () => {
  const app = appWith({ caller: { id: 'owner' }, isPlatformAdmin: true, getSettings: async () => ({}), pgPool: listPg });
  const res = await call(app, 'GET', '/api/admin/users');
  assert.strictEqual(res.body.users[0].rainbetName, 'secretRB');
  assert.strictEqual(res.body.users[0].twitchName, 'secretTV');
});
