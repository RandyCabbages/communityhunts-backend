// GET /api/admin/users — the search predicate.
//
// The admin Users box has always advertised "Search by name, Discord ID, or Rainbet handle…"
// while the SQL matched only the three known_users columns, so a Rainbet handle returned
// "No users found". These tests pin the added clause AND the anonymity gate on it: the gate is
// the whole reason the clause is safe to add, and it is the kind of thing a later refactor
// silently drops, so it is asserted structurally rather than by outcome.
const { test } = require('node:test');
const assert = require('node:assert');
const express = require('express');
const settingsRoutes = require('./settings.routes');

const pass = (req, res, next) => next();
const ROW = {
  user_id: 'victim', display_name: 'Victim', username: 'victim', avatar: null, last_seen: null,
  settings: { anonymous: true, rainbetName: 'secretRB', twitchName: 'secretTV', preferredSlots: [] },
};

// Captures what the route actually sends to Postgres — the search gate lives in the SQL, so the
// query itself is the observable, not the response body.
function appWith({ caller = { id: 'mod' }, isPlatformAdmin = false, rows = [ROW] } = {}) {
  const seen = [];
  const pgPool = { query: async (sql, params) => { seen.push({ sql, params }); return { rows }; } };
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.user = caller; req.tenant = { id: 'bean' }; next(); });
  app.use(settingsRoutes({
    settings: { getSettings: async () => ({}), saveSettings: async () => {}, deleteSettings: async () => {}, resolveUserIdByName: async () => null },
    pgPool, memberships: { getUserCommunities: async () => [] },
    isPlatformAdmin: () => isPlatformAdmin,
    reqIsMod: () => false, reqIsVipHost: () => false, reqHasFullExtension: async () => false,
    requireAuth: pass, requireAdmin: pass, requirePlatformAdmin: pass,
    io: { emit() {}, to: () => ({ emit() {} }) },
    subscriptions: { getSubscription: async () => null },
    featureGrants: { getGrantsForUser: () => [] },
    hunts: {}, archive: [], statsStore: null, refreshGuildRoles: async () => null,
  }));
  return { app, seen };
}

// closeAllConnections() before close() — see the CLAUDE.md note: close() alone waits forever on
// fetch's idle keep-alive sockets and hangs the suite.
async function call(app, pathname) {
  const server = await new Promise(r => { const s = app.listen(0, () => r(s)); });
  try {
    const r = await fetch(`http://127.0.0.1:${server.address().port}${pathname}`);
    return { status: r.status, body: await r.json().catch(() => null) };
  } finally {
    server.closeAllConnections();
    await new Promise(res => server.close(res));
  }
}

// ── the clause exists at all ────────────────────────────────────────────────
test('search matches the Rainbet handle, not just the known_users columns', async () => {
  const { app, seen } = appWith();
  await call(app, '/api/admin/users?q=secretrb');
  assert.match(seen[0].sql, /settings->>'rainbetName'/);
  assert.ok(seen[0].params.includes('%secretrb%'), 'the search term is bound, not interpolated');
});

test('no q → no search predicate at all (the clause is not added unconditionally)', async () => {
  const { app, seen } = appWith();
  await call(app, '/api/admin/users');
  assert.doesNotMatch(seen[0].sql, /rainbetName/);
  assert.doesNotMatch(seen[0].sql, /WHERE/);
});

// ── the anonymity gate on that clause ───────────────────────────────────────
// A hit leaks as much as the value. The list route already redacts an anonymous user's handle
// from the RESPONSE for non-platform-admins; without the matching gate here a community mod
// could confirm the same handle a character at a time off the result count.
test('a non-platform-admin never gets a bare rainbetName match — it is anonymity-gated', async () => {
  const { app, seen } = appWith({ caller: { id: 'mod' }, isPlatformAdmin: false });
  await call(app, '/api/admin/users?q=secretrb');
  const { sql, params } = seen[0];
  assert.match(sql, /rainbetName.*\n?.*anonymous/s, 'the rainbet clause carries the anonymous guard');
  assert.ok(params.includes('mod'), "the caller's own id is bound, so they can still find themselves");
});

test('a platform admin searches Rainbet handles ungated', async () => {
  const { app, seen } = appWith({ caller: { id: 'owner' }, isPlatformAdmin: true });
  await call(app, '/api/admin/users?q=secretrb');
  assert.match(seen[0].sql, /settings->>'rainbetName'/);
  assert.doesNotMatch(seen[0].sql, /anonymous/);
});

// ── the flag that lets the UI tell "none" from "hidden" ─────────────────────
test('list rows carry the anonymous FLAG while still redacting the handle', async () => {
  const { app } = appWith({ caller: { id: 'mod' }, isPlatformAdmin: false });
  const res = await call(app, '/api/admin/users');
  assert.strictEqual(res.body.users[0].rainbetName, null, 'handle still redacted');
  assert.strictEqual(res.body.users[0].anonymous, true, 'but the UI can say "hidden", not "not set"');
});

test('a non-anonymous user reports anonymous:false and keeps their handle', async () => {
  const rows = [{ ...ROW, settings: { rainbetName: 'openRB', preferredSlots: [] } }];
  const { app } = appWith({ caller: { id: 'mod' }, isPlatformAdmin: false, rows });
  const res = await call(app, '/api/admin/users');
  assert.strictEqual(res.body.users[0].rainbetName, 'openRB');
  assert.strictEqual(res.body.users[0].anonymous, false);
});
