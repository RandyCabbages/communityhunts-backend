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
    // The board gate is exercised for real in the co-edit block at the bottom of this file;
    // everything above it predates board editors and only cares about the mod path.
    requireBoardEditor: () => requireMod,
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
      body: (method === 'DELETE' || method === 'GET') ? undefined : JSON.stringify(body === undefined ? {} : body),
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

test('PUT /api/mod-hunt stores hunt kind and tournament fields', async () => {
  const hunts = {};
  const io = wire(hunts, []);
  const app = appWith({ hunts, io });
  await call(app, 'PUT', '/api/mod-hunt', {
    huntKind: 'buy', isTournament: true, tournamentProvider: 'hacksaw',
    tournamentRound: 'Quarter final 2', targetBonuses: 10, betSize: 500, buySpend: 4200,
  });
  const h = await call(app, 'GET', '/api/mod-hunt');
  assert.strictEqual(h.body.huntKind, 'buy');
  assert.strictEqual(h.body.isTournament, true);
  assert.strictEqual(h.body.tournamentProvider, 'hacksaw');
  assert.strictEqual(h.body.targetBonuses, 10);
});

test('a save that omits the kind does not clear it', async () => {
  const hunts = {};
  const io = wire(hunts, []);
  const app = appWith({ hunts, io });
  await call(app, 'PUT', '/api/mod-hunt', { huntKind: 'natty' });
  await call(app, 'PUT', '/api/mod-hunt', { bonuses: [] });
  const h = await call(app, 'GET', '/api/mod-hunt');
  assert.strictEqual(h.body.huntKind, 'natty');
});

test('an unknown kind is refused silently rather than stored', async () => {
  const hunts = {};
  const io = wire(hunts, []);
  const app = appWith({ hunts, io });
  await call(app, 'PUT', '/api/mod-hunt', { huntKind: 'natty' });
  await call(app, 'PUT', '/api/mod-hunt', { huntKind: 'megaways' });
  const h = await call(app, 'GET', '/api/mod-hunt');
  assert.strictEqual(h.body.huntKind, 'natty');
});

// ── The extension writing to a shared hunt (communityhunts-extension, 2026-08-01) ──
//
// The extension used to be hardwired to /api/my-hunt and could only ever edit a PERSONAL hunt. It
// now targets the shared hunts too, which means its save body — huntSaveBody() in
// communityhunts-extension/src/utils/huntSave.js — hits THESE routes. That body is not identical
// to the site's: it carries fields this router does not destructure (huntType, publicCalls,
// publicCallsPin) and omits ones it does (gifts, chases, payouts, currency, title).
//
// These tests pin that contract from the backend side. Keep the fixture below in sync with
// huntSaveBody if it changes — a drift here is a host entering wins into an extension that
// silently writes nothing.

// Exactly what huntSaveBody() produces, JSON round-tripped (undefined fields drop out, which is
// how gifts/chases/payouts stay untouched rather than being nulled).
const extensionSaveBody = (h) => JSON.parse(JSON.stringify({
  bonuses: h.bonuses,
  equity: h.equity,
  vault: h.vault,
  calls: h.calls,
  callLimit: h.callLimit,
  huntMode: h.huntMode,
  lockTop4: !!h.lockTop4,
  roundRobin: h.roundRobin,
  currentSlot: h.currentSlot ?? null,
  huntType: h.huntType,
  publicCalls: h.publicCalls,
  publicCallsPin: h.publicCallsPin ?? null,
  manualOrder: h.manualOrder ?? false,
}));

test("the extension's save body lands a win on the VIP hunt", async () => {
  const hunts = vipHunt();
  hunts[VIP_KEY].bonuses = [
    { id: 'b1', slot: 'Gates', bet: 2, win: 400 },
    { id: 'b2', slot: 'Wanted', bet: 5, win: null },
  ];
  const io = wire(hunts, []);
  const app = appWith({ hunts, io });

  // What the extension does: take server state, apply the win, save the whole body back.
  const local = JSON.parse(JSON.stringify(hunts[VIP_KEY]));
  local.bonuses[1].win = 500;

  const res = await call(app, 'PUT', '/api/vip-hunt', extensionSaveBody(local));
  assert.strictEqual(res.status, 200);

  const after = await call(app, 'GET', '/api/vip-hunt');
  assert.strictEqual(after.body.bonuses[1].win, 500, 'the win must persist');
  assert.strictEqual(after.body.bonuses[0].win, 400, 'the untouched bonus must survive');
});

// The extension sends huntType (it means it for a personal hunt, where solo/community/vip is a real
// per-hunt field). On a shared hunt the route hardcodes it — so an extension save can never
// re-label a VIP hunt as something else.
test("the extension's huntType cannot re-label a shared VIP hunt", async () => {
  const hunts = vipHunt();
  const io = wire(hunts, []);
  const app = appWith({ hunts, io });

  const local = JSON.parse(JSON.stringify(hunts[VIP_KEY]));
  local.huntType = 'solo'; // what a stale extension copy could carry over from a personal hunt

  await call(app, 'PUT', '/api/vip-hunt', extensionSaveBody(local));
  const after = await call(app, 'GET', '/api/vip-hunt');
  assert.strictEqual(after.body.huntType, 'vip');
});

// Vault = base-game wins. huntSaveBody passes it through as-is and deliberately does NOT coerce it
// to [] — sending [] would make every extension save an authoritative "vault is empty" write and
// delete entries added on the site.
test('an extension save does not wipe vault entries added on the site', async () => {
  const hunts = vipHunt();
  hunts[VIP_KEY].vault = [{ id: 'v1', amount: 250, note: 'base game' }];
  const io = wire(hunts, []);
  const app = appWith({ hunts, io });

  const local = JSON.parse(JSON.stringify(hunts[VIP_KEY]));
  local.bonuses[0].win = 999;

  await call(app, 'PUT', '/api/vip-hunt', extensionSaveBody(local));
  const after = await call(app, 'GET', '/api/vip-hunt');
  assert.strictEqual(after.body.vault.length, 1);
  assert.strictEqual(after.body.vault[0].amount, 250);
});

// Equity carries the identities (discordId) that publicHuntView masks out of a viewer's copy. The
// route re-attaches them via preserveRowIdentity; this pins that an extension save — built from a
// possibly-masked copy — cannot blank them.
test('an extension save preserves equity identities it never saw', async () => {
  const hunts = vipHunt();
  hunts[VIP_KEY].equity = [
    { id: 'bean_auto', name: 'Bean', amount: 1000, discordId: '110983319176384512' },
  ];
  const io = wire(hunts, []);
  const app = appWith({ hunts, io });

  // The masked copy the extension could be holding — no discordId.
  const local = JSON.parse(JSON.stringify(hunts[VIP_KEY]));
  delete local.equity[0].discordId;

  await call(app, 'PUT', '/api/vip-hunt', extensionSaveBody(local));
  const after = await call(app, 'GET', '/api/vip-hunt');
  assert.strictEqual(after.body.equity[0].discordId, '110983319176384512');
});

// Same contract on the affiliate hunt — the extension targets all three shared hunts, and they are
// three separate route blocks that have drifted from each other before.
test("the extension's save body lands a win on the affiliate hunt", async () => {
  const hunts = { [AFF_KEY]: {
    user: { id: AFF_KEY, displayName: 'Bean' }, tenantId: 'bean',
    isLive: true, archivedAt: null, huntType: 'vip',
    bonuses: [{ id: 'b1', slot: 'Gates', bet: 2, win: null }],
    equity: [], calls: [],
  } };
  const io = wire(hunts, []);
  const app = appWith({ hunts, io });

  const local = JSON.parse(JSON.stringify(hunts[AFF_KEY]));
  local.bonuses[0].win = 750;

  const res = await call(app, 'PUT', '/api/affiliate-hunt', extensionSaveBody(local));
  assert.strictEqual(res.status, 200);
  const after = await call(app, 'GET', '/api/affiliate-hunt');
  assert.strictEqual(after.body.bonuses[0].win, 750);
});

// ── Board editors: co-edit on the two shared singleton hunts ────────────────
// Affiliate and VIP have no owner id to hang canEditHunt off, so every route was requireMod.
// A mod can now invite a named helper to run the BOARD without granting the mod role: five
// routes per surface open up (GET, PUT, activity, undo, restore) and the other nine — delete,
// reset, end, reopen, reopen-archived, golive, offline, history, overlay-config — do not.
//
// These wire the REAL gates from lib/auth rather than the `pass` stub the suite uses elsewhere:
// the thing worth pinning is the composition (which gate sits on which route), and a stub gate
// would pin nothing.
const auth = require('../lib/auth');

function appWithGates({ hunts, archive = [], audits = [], io, user, persisted = { n: 0 } }) {
  auth.initAuth({
    ADMIN_IDS: [], VIP_IDS: [], SESSION_SECRET: 'x', MULTI_TENANT: true,
    tenants: {
      isPlatformOwnerId: () => false,
      isTenantAdmin: () => false,
      isTenantMod: (u) => !!u && u.id === 'modId',
      BEAN_TENANT: { id: 'bean' },
    },
    admins: { isDbAdmin: () => false },
    hunts, recordKnownUser() {},
  });
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.user = user; req.tenant = { id: 'bean' }; next(); });
  app.use(modHuntRoutes({
    hunts, archive, io,
    persistHunts() { persisted.n++; },
    archiveHunt(h) { archive.push(h); },
    unarchiveHunt() {},
    requireMod: auth.requireMod,
    requireBoardEditor: auth.requireBoardEditor,
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

const MOD = { id: 'modId', displayName: 'A Mod' };
const HELPER = { id: 'helperId', displayName: 'A Helper' };

const sharedHunt = (key) => ({
  [key]: {
    user: { id: key, displayName: 'Bean' }, tenantId: 'bean', huntId: 'h1',
    isLive: true, archivedAt: null, huntType: 'vip',
    bonuses: [{ id: 'b1', slot: 'Gates', bet: 2, win: null }],
    equity: [], calls: [], boardEditors: ['helperId'],
  },
});

for (const [label, base, key] of [['affiliate', '/api/affiliate-hunt', AFF_KEY], ['vip', '/api/vip-hunt', VIP_KEY]]) {
  test(`${label}: a board editor can read the hunt`, async () => {
    const hunts = sharedHunt(key);
    const app = appWithGates({ hunts, io: wire(hunts, []), user: HELPER });
    assert.strictEqual((await call(app, 'GET', base)).status, 200);
  });

  test(`${label}: a board editor can edit the board`, async () => {
    const hunts = sharedHunt(key);
    const app = appWithGates({ hunts, io: wire(hunts, []), user: HELPER });
    const res = await call(app, 'PUT', base, { bonuses: [{ id: 'b1', slot: 'Gates', bet: 2, win: 750 }] });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(hunts[key].bonuses[0].win, 750);
  });

  test(`${label}: a board editor can read the activity feed and undo`, async () => {
    const hunts = sharedHunt(key);
    const app = appWithGates({ hunts, io: wire(hunts, []), user: HELPER });
    assert.strictEqual((await call(app, 'GET', `${base}/activity`)).status, 200);
  });

  test(`${label}: a board editor is refused the destructive + history routes`, async () => {
    const hunts = sharedHunt(key);
    const app = appWithGates({ hunts, io: wire(hunts, []), user: HELPER });
    for (const [method, path] of [
      ['DELETE', base],
      ['POST', `${base}/reset`],
      ['POST', `${base}/end`],
      ['POST', `${base}/reopen`],
      ['GET', `${base}/history`],
      ['PUT', `${base}/overlay-config`],
    ]) {
      const res = await call(app, method, path);
      assert.strictEqual(res.status, 403, `${method} ${path} should be mod-only, got ${res.status}`);
    }
  });

  test(`${label}: a stranger is refused the board routes`, async () => {
    const hunts = sharedHunt(key);
    const app = appWithGates({ hunts, io: wire(hunts, []), user: { id: 'nobody' } });
    assert.strictEqual((await call(app, 'GET', base)).status, 403);
    assert.strictEqual((await call(app, 'PUT', base, { calls: [] })).status, 403);
  });

  test(`${label}: a mod adds and removes a board editor`, async () => {
    const hunts = sharedHunt(key);
    delete hunts[key].boardEditors;
    const app = appWithGates({ hunts, io: wire(hunts, []), user: MOD });

    const add = await call(app, 'POST', `${base}/editors`, { userId: 'helperId' });
    assert.strictEqual(add.status, 200);
    assert.deepStrictEqual(add.body.boardEditors, ['helperId']);

    // Idempotent — inviting twice must not duplicate the entry.
    const again = await call(app, 'POST', `${base}/editors`, { userId: 'helperId' });
    assert.deepStrictEqual(again.body.boardEditors, ['helperId']);

    const del = await call(app, 'DELETE', `${base}/editors?id=helperId`);
    assert.strictEqual(del.status, 200);
    assert.deepStrictEqual(del.body.boardEditors, []);
  });

  test(`${label}: a board editor cannot invite anyone else`, async () => {
    const hunts = sharedHunt(key);
    const app = appWithGates({ hunts, io: wire(hunts, []), user: HELPER });
    const res = await call(app, 'POST', `${base}/editors`, { userId: 'friendOfHelper' });
    assert.strictEqual(res.status, 403);
    assert.deepStrictEqual(hunts[key].boardEditors, ['helperId']);
  });

  test(`${label}: inviting into an empty slot 404s — there is no hunt to attach to`, async () => {
    const hunts = {};
    const app = appWithGates({ hunts, io: wire(hunts, []), user: MOD });
    assert.strictEqual((await call(app, 'POST', `${base}/editors`, { userId: 'helperId' })).status, 404);
  });

  test(`${label}: Start New Hunt clears the board editors`, async () => {
    const hunts = sharedHunt(key);
    const app = appWithGates({ hunts, io: wire(hunts, []), user: MOD });
    assert.strictEqual((await call(app, 'POST', `${base}/reset`)).status, 200);
    assert.deepStrictEqual(hunts[key].boardEditors || [], []);
  });

  test(`${label}: a signed-out request is 401, not 403`, async () => {
    const hunts = sharedHunt(key);
    const app = appWithGates({ hunts, io: wire(hunts, []), user: null });
    assert.strictEqual((await call(app, 'GET', base)).status, 401);
  });
}
