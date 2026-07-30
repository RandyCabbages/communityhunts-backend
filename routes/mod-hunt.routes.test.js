// Shared hunts (tenant / affiliate / VIP) are SINGLETON keys that were never removable: the
// router offered /reset (replace the key with a fresh BORN-LIVE hunt) and /end (archive in
// place), but no delete. The frontend's "Delete without saving" therefore called /reset, which
// for affiliate and VIP re-seeds `hostEquityRow(tenantId, 1000)` — so a "deleted" hunt came
// straight back as a LIVE hunt with a $1000 pot. /end left the spent hunt as the active
// singleton, which reads as "Not running / Idle" forever with no way to clear it.
//
// DELETE removes the key outright. It deliberately does NOT archive — that is what /end is for,
// which keeps "save it first" composable as /end then DELETE.
//
// Watchers are the subtle part: emitHuntUpdate early-returns on a missing hunt (`if (!h) return`),
// so deleting and then calling it emits NOTHING and a second mod's tab (or the OBS source) keeps
// rendering a hunt that no longer exists. Hence a distinct `hunt:deleted` event, fanned out
// through emitToHuntRoom so it stays per-socket tenant-gated like every other hunt emit.

const { test } = require('node:test');
const assert = require('node:assert');
const express = require('express');
const core = require('../lib/hunts-core');
const modHuntRoutes = require('./mod-hunt.routes');

const VIP_KEY = '__vip_hunt__:bean';
const AFF_KEY = '__affiliate_hunt__:bean';
const MOD_KEY = '__tenant_hunt__';

function makeSocket(id, tenantSlug, room) {
  return {
    id, rooms: new Set([room]), received: [],
    data: { userId: 'someMod', tenantSlug },
    emit(ev, payload) { this.received.push({ ev, payload }); },
  };
}

function wire(hunts, sockets) {
  const io = {
    in: (room) => ({ fetchSockets: async () => sockets.filter(s => s.rooms.has(room)) }),
    to: () => ({ emit() {} }),
  };
  core.initHuntsCore({
    hunts, archive: [], viewers: {}, io, persistHunts() {},
    isAnonymousUser: () => false,
    isPrivilegedViewer: () => true,
    shouldMaskIdentity: () => false,
  });
  return io;
}

const pass = (req, res, next) => next();

function appWith({ hunts, archive = [], audits = [], io, requireMod = pass, persisted = { n: 0 } }) {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.user = { id: 'modId', displayName: 'A Mod' }; req.tenant = { id: 'bean' }; next(); });
  app.use(modHuntRoutes({
    hunts, archive, io,
    persistHunts() { persisted.n++; },
    archiveHunt(h) { archive.push(h); },
    unarchiveHunt() {},
    requireMod,
    modHuntKey: () => MOD_KEY,
    affiliateHuntKey: () => AFF_KEY,
    vipHuntKey: () => VIP_KEY,
    tenants: { getTenantBySlug: () => ({ displayName: 'Bean', branding: { hostName: 'Bean' } }) },
    uid: () => 'uid1',
    touch() {},
    publicHuntView: (h) => h,
    emitHuntUpdate: async () => {},
    emitToHuntRoom: core.emitToHuntRoom,
    rejectBadHuntInput: () => false,
    auditLog: {
      record() {}, recordHuntChange() {},
      recordFromReq(req, row) { audits.push(row); },
      query: async () => ({ rows: [] }), getById: async () => null,
    },
    getSettings: async () => ({}), saveSettings: async () => {},
    persistOverlayConfig: async () => ({}),
  }));
  return app;
}

async function call(app, method, pathname, body) {
  const server = await new Promise(r => { const s = app.listen(0, () => r(s)); });
  try {
    const r = await fetch(`http://127.0.0.1:${server.address().port}${pathname}`, {
      method, headers: { 'Content-Type': 'application/json' },
      body: method === 'DELETE' ? undefined : JSON.stringify(body === undefined ? {} : body),
      signal: AbortSignal.timeout(5000),
    });
    return { status: r.status, body: await r.json().catch(() => null) };
  } finally {
    server.closeAllConnections();
    await new Promise(res => server.close(res));
  }
}

const vipHunt = () => ({
  [VIP_KEY]: {
    user: { id: VIP_KEY, displayName: 'Bean' }, tenantId: 'bean', huntId: 'h1',
    isLive: true, archivedAt: null, huntType: 'vip',
    bonuses: [{ slot: 'Gates', bet: 2, win: 400 }],
    equity: [{ id: 'bean_auto', name: 'Bean', amount: 1000 }],
    calls: [],
  },
});

test('DELETE /api/vip-hunt removes the key entirely', async () => {
  const hunts = vipHunt();
  const io = wire(hunts, []);
  const res = await call(appWith({ hunts, io }), 'DELETE', '/api/vip-hunt');
  assert.strictEqual(res.status, 200);
  assert.strictEqual(hunts[VIP_KEY], undefined, 'the singleton key must be gone, not replaced');
});

test('DELETE does NOT archive — /end is the save path', async () => {
  const hunts = vipHunt();
  const archive = [];
  const io = wire(hunts, []);
  await call(appWith({ hunts, archive, io }), 'DELETE', '/api/vip-hunt');
  assert.deepStrictEqual(archive, [], 'delete must not write to history');
});

test('DELETE persists, so the hunt cannot resurrect on the next boot', async () => {
  const hunts = vipHunt();
  const persisted = { n: 0 };
  const io = wire(hunts, []);
  await call(appWith({ hunts, io, persisted }), 'DELETE', '/api/vip-hunt');
  assert.ok(persisted.n > 0, 'a missed persist means the row is deleted in memory only');
});

test('DELETE 404s when there is no hunt', async () => {
  const hunts = {};
  const io = wire(hunts, []);
  const res = await call(appWith({ hunts, io }), 'DELETE', '/api/vip-hunt');
  assert.strictEqual(res.status, 404);
});

test('DELETE audits a before-snapshot so the hunt is recoverable', async () => {
  const hunts = vipHunt();
  const audits = [];
  const io = wire(hunts, []);
  await call(appWith({ hunts, audits, io }), 'DELETE', '/api/vip-hunt');
  const row = audits.find(a => a.action === 'hunt.delete');
  assert.ok(row, 'a hunt.delete audit row must be written');
  assert.strictEqual(row.detail.before.bonuses.length, 1, 'the snapshot must carry the bonuses');
  assert.strictEqual(row.detail.before.equity.length, 1, 'the snapshot must carry the equity');
});

test('DELETE tells watchers the hunt is gone, tenant-gated', async () => {
  const hunts = vipHunt();
  const watcher = makeSocket('s-watch', 'bean', `hunt:${VIP_KEY}`);
  const other   = makeSocket('s-other', 'otherco', `hunt:${VIP_KEY}`);
  const io = wire(hunts, [watcher, other]);
  await call(appWith({ hunts, io }), 'DELETE', '/api/vip-hunt');
  // emitToHuntRoom's fanout is async and not awaited by the response; let it drain.
  await new Promise(r => setTimeout(r, 50));
  assert.strictEqual(watcher.received.filter(r => r.ev === 'hunt:deleted').length, 1,
    'the same-tenant watcher must be told, or its tab renders a hunt that no longer exists');
  assert.strictEqual(other.received.length, 0,
    'a cross-tenant socket in the room must receive nothing — same gate as every other hunt emit');
});

test('DELETE is behind requireMod', async () => {
  const hunts = vipHunt();
  const io = wire(hunts, []);
  const deny = (req, res) => res.status(403).json({ error: 'Access denied' });
  const res = await call(appWith({ hunts, io, requireMod: deny }), 'DELETE', '/api/vip-hunt');
  assert.strictEqual(res.status, 403);
  assert.ok(hunts[VIP_KEY], 'a denied request must not have deleted anything');
});

test('affiliate and tenant hunts delete the same way', async () => {
  for (const [path, key] of [['/api/affiliate-hunt', AFF_KEY], ['/api/mod-hunt', MOD_KEY]]) {
    const hunts = { [key]: { user: { id: key }, tenantId: 'bean', bonuses: [], equity: [], calls: [] } };
    const io = wire(hunts, []);
    const res = await call(appWith({ hunts, io }), 'DELETE', path);
    assert.strictEqual(res.status, 200, `${path} should delete`);
    assert.strictEqual(hunts[key], undefined, `${path} should remove its key`);
  }
});
