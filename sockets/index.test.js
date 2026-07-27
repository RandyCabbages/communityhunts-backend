// Socket authz + viewer-count integrity.
//
// The socket layer is deliberately UNAUTHENTICATED for reads (public overlays, offline hunts and
// anonymous hub browsing all connect with no session), which makes these handlers reachable by
// anyone. These tests pin the two things that must still hold.
//
// Driven with a fake socket rather than a real io server: these are handler-level invariants and
// a real server would only add ports and flakiness. registerSockets() is called exactly as
// server.js calls it.

const { test } = require('node:test');
const assert = require('node:assert');

const registerSockets = require('./index');

// Minimal io/socket doubles capturing joins, emits and registered handlers.
function harness({ hunts = {}, slug = 'bean', token = null } = {}) {
  const emitted = [];
  const joined = [];
  const left = [];
  const handlers = {};
  const disconnectHandlers = [];
  const viewers = {};

  const socket = {
    id: 'sock-1',
    data: {},
    handshake: { query: { _tenant: slug }, auth: token ? { token } : {} },
    join: (r) => joined.push(r),
    leave: (r) => left.push(r),
    emit: (ev, payload) => emitted.push({ ev, payload }),
    on: (ev, fn) => {
      if (ev === 'disconnect') disconnectHandlers.push(fn);
      else handlers[ev] = fn;
    },
  };

  const io = {
    use: (fn) => { io._mw = fn; },
    on: (ev, fn) => { if (ev === 'connection') io._conn = fn; },
    _mw: null, _conn: null,
  };

  registerSockets(io, {
    getPublicHunts: () => [],
    publicHuntView: (h) => ({ huntId: h.huntId, bonuses: h.bonuses, equity: h.equity }),
    emitHubUpdate: () => {},
    tenantOf: (h) => h.tenantId || 'bean',
    integrations: { getLiveStatus: () => ({ isLive: false }) },
    viewers,
    hunts,
    overdrop: { getState: () => ({}) },
    verifyToken: () => null,
    isBanned: () => false,
  });

  io._mw(socket, () => {});   // run handshake middleware
  io._conn(socket);           // run connection handler

  return { socket, emitted, joined, left, handlers, disconnectHandlers, viewers };
}

const HUNT_A = { huntId: 'hA', tenantId: 'tenantA', bonuses: [{ slot: 'Secret Slot' }], equity: [{ name: 'Alice' }] };

// The core leak. GET /api/hunts/:userId got this guard in the 2026-07-18 security audit (#4);
// the socket path did not, so the same data stayed reachable over Socket.IO.
test('watch:hunt does NOT serve a hunt belonging to another tenant', () => {
  const h = harness({ hunts: { victim: HUNT_A }, slug: 'tenantB' });
  h.handlers['watch:hunt']('victim');

  assert.deepStrictEqual(h.emitted.filter(e => e.ev === 'hunt:update'), [],
    'cross-tenant hunt state must not be emitted');
  assert.deepStrictEqual(h.joined, [],
    'must not join the hunt room either — that subscribes to every future hunt:update');
  assert.strictEqual(h.viewers.victim, undefined, 'must not count a viewer for a hunt it cannot see');
});

test('watch:hunt DOES serve a hunt in the caller\'s own tenant', () => {
  const h = harness({ hunts: { mine: HUNT_A }, slug: 'tenantA' });
  h.handlers['watch:hunt']('mine');

  const upd = h.emitted.filter(e => e.ev === 'hunt:update');
  assert.strictEqual(upd.length, 1);
  assert.strictEqual(upd[0].payload.huntId, 'hA');
  assert.deepStrictEqual(h.joined, ['hunt:mine']);
  assert.strictEqual(h.viewers.mine, 1);
});

// An unknown hunt id must still be joinable — a viewer can legitimately open a hunt page before
// the hunt exists in memory. It just must not be counted twice or crash.
//
// NOTE the join is deliberately NOT tenant-checked here: there is no hunt yet to read a tenant
// from. That is exactly why the tenant gate also lives at DELIVERY, in emitHuntUpdate
// (lib/hunts-core.js) — see lib/hunts-core.tenant-broadcast.test.js. Joining is harmless; being
// served another tenant's hunt is not.
test('watch:hunt on an unknown hunt joins without emitting state', () => {
  const h = harness({ hunts: {}, slug: 'bean' });
  h.handlers['watch:hunt']('nobody');
  assert.deepStrictEqual(h.joined, ['hunt:nobody']);
  assert.deepStrictEqual(h.emitted.filter(e => e.ev === 'hunt:update'), []);
});

// Viewer-count forgery, second variant. The dedupe fix stopped ONE socket inflating a hunt it can
// see; this is the hunt it CANNOT see. A hunt that doesn't exist has no tenant to check, so
// counting the watcher lets any anonymous socket pre-inflate the hub number for a Discord id in
// another community — the count survives into the hunt the moment it's created.
test('watch:hunt on an unknown hunt does NOT count a viewer', () => {
  const h = harness({ hunts: {}, slug: 'bean' });
  h.handlers['watch:hunt']('nobody');
  assert.strictEqual(h.viewers.nobody, undefined,
    'a hunt with no tenant to verify must not accrue viewers');
});

// Viewer-count forgery: the increment had no dedupe, so an unauthenticated socket could inflate
// the hub's viewer number arbitrarily.
test('repeated watch:hunt counts the socket ONCE', () => {
  const h = harness({ hunts: { mine: HUNT_A }, slug: 'tenantA' });
  for (let i = 0; i < 500; i++) h.handlers['watch:hunt']('mine');
  assert.strictEqual(h.viewers.mine, 1, '500 watch:hunt calls must still be one viewer');
});

// The disconnect handler used to be registered INSIDE watch:hunt, so N calls left N listeners.
test('disconnect handler is registered once, not per watch:hunt', () => {
  const h = harness({ hunts: { mine: HUNT_A }, slug: 'tenantA' });
  for (let i = 0; i < 50; i++) h.handlers['watch:hunt']('mine');
  assert.strictEqual(h.disconnectHandlers.length, 1,
    'one listener per socket — nesting them leaked a listener per call');
});

test('disconnect decrements each watched hunt exactly once', () => {
  const hunts = { a: { ...HUNT_A, huntId: 'a' }, b: { ...HUNT_A, huntId: 'b' } };
  const h = harness({ hunts, slug: 'tenantA' });
  h.handlers['watch:hunt']('a');
  h.handlers['watch:hunt']('a');
  h.handlers['watch:hunt']('b');
  assert.strictEqual(h.viewers.a, 1);
  assert.strictEqual(h.viewers.b, 1);

  h.disconnectHandlers[0]();
  assert.strictEqual(h.viewers.a, 0);
  assert.strictEqual(h.viewers.b, 0);
});

// leave:hunt could be spammed to drive a count to zero for a hunt the socket never watched.
test('leave:hunt only decrements a hunt this socket actually watched', () => {
  const h = harness({ hunts: { mine: HUNT_A }, slug: 'tenantA' });
  h.handlers['watch:hunt']('mine');
  assert.strictEqual(h.viewers.mine, 1);

  h.handlers['leave:hunt']('mine');
  assert.strictEqual(h.viewers.mine, 0);

  // Spamming leave must not push it negative or below other viewers' real count.
  for (let i = 0; i < 20; i++) h.handlers['leave:hunt']('mine');
  assert.strictEqual(h.viewers.mine, 0);

  // And disconnect must not decrement again after an explicit leave.
  h.disconnectHandlers[0]();
  assert.strictEqual(h.viewers.mine, 0);
});
