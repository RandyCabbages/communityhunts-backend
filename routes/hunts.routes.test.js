// Archived-snapshot route must (a) 404 across tenants and (b) return a publicHuntView-stripped
// body, never the raw snapshot with equity discordIds. No requireAuth (public WatchHunt consumer).
const { test } = require('node:test');
const assert = require('node:assert');
const express = require('express');
const huntsRoutes = require('./hunts.routes');

const ARCHIVED = {
  user: { id: 'u1' }, archivedAt: '2026-07-01T00:00:00.000Z', tenantId: 'bean',
  equity: [{ name: 'Ann', discordId: 'SECRET_DISCORD_ID', amount: 5 }],
  invitedEditors: ['ed1'],
};

function appWith({ tenantId }) {
  const app = express();
  app.use((req, res, next) => { req.tenant = { id: tenantId }; req.user = null; next(); });
  app.use(huntsRoutes({
    requireAuth: (req, res, next) => next(),
    canEditHunt: () => false, isEquityMember: () => false, reqIsMod: () => false,
    hunts: {}, archive: [ARCHIVED],
    getPublicHunts: () => [], getArchivedHunts: () => [],
    emitHubUpdate() {}, emitHuntUpdate() {},
    // Stub strips discordId + editor list, marks that it ran.
    publicHuntView: (h) => ({ user: h.user, archivedAt: h.archivedAt, equity: (h.equity || []).map(e => ({ name: e.name, amount: e.amount })), _stripped: true }),
    uid: () => 'x', touch() {}, persistHunts() {}, archiveHunt() {}, unarchiveHunt() {},
    io: { emit() {} }, rejectBadHuntInput: () => null,
    resolveUserIdByName: async () => null, getCreatorLive: () => ({ isLive: false }), refreshCreatorsLive() {},
  }));
  return app;
}

async function get(app, pathname) {
  const server = await new Promise(r => { const s = app.listen(0, () => r(s)); });
  try {
    const r = await fetch(`http://127.0.0.1:${server.address().port}${pathname}`);
    return { status: r.status, body: await r.json().catch(() => null) };
  } finally {
    await new Promise(res => server.close(res));
  }
}

const PATH = '/api/hunts/u1/archived/' + encodeURIComponent('2026-07-01T00:00:00.000Z');

test('same tenant: returns stripped snapshot, no discordId', async () => {
  const res = await get(appWith({ tenantId: 'bean' }), PATH);
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body._stripped, true);
  assert.strictEqual(res.body.canEdit, false);
  assert.ok(!JSON.stringify(res.body).includes('SECRET_DISCORD_ID'));
  assert.ok(!JSON.stringify(res.body).includes('invitedEditors'));
});

test('other tenant: 404 (inTenant guard)', async () => {
  const res = await get(appWith({ tenantId: 'trashguy' }), PATH);
  assert.strictEqual(res.status, 404);
});
