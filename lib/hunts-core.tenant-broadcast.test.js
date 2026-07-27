// emitHuntUpdate must not deliver a hunt to a socket from a different tenant.
//
// The `watch:hunt` guard in sockets/index.js is `if (h && tenantOf(h) !== slug) return;` — it can
// only check a hunt that ALREADY EXISTS. A socket that emits watch:hunt for a Discord id with no
// hunt yet skips the guard entirely and joins `hunt:<id>`; socket.io room membership then persists,
// so when the hunt is later created in a DIFFERENT tenant every hunt:update lands on that socket.
// That is the same cross-tenant leak the 2026-07-18 audit (#4) closed on REST and BE #110 closed on
// the socket join — reached through a timing window instead.
//
// The room join cannot be the only gate (it happens before the hunt has a tenant to compare
// against), so the guard belongs at the authoritative broadcast point: delivery.

const { test } = require('node:test');
const assert = require('node:assert');
const core = require('./hunts-core');

// io double: `to(room).emit()` broadcasts to every socket in the room, `in(room).fetchSockets()`
// returns them — mirroring socket.io closely enough to tell WHICH sockets received a payload.
function makeSocket(id, tenantSlug, userId = null) {
  return {
    id, rooms: new Set(), received: [],
    data: { userId, tenantSlug },
    emit(ev, payload) { this.received.push({ ev, payload }); },
  };
}
function wire(hunts, sockets) {
  const io = {
    to: (room) => ({
      emit: (ev, payload) => sockets.filter(s => s.rooms.has(room)).forEach(s => s.received.push({ ev, payload })),
    }),
    in: (room) => ({ fetchSockets: async () => sockets.filter(s => s.rooms.has(room)) }),
  };
  core.initHuntsCore({
    hunts, archive: [], viewers: {}, io, persistHunts() {},
    isAnonymousUser: id => id === 'idAnon',
    isPrivilegedViewer: () => false,
    shouldMaskIdentity: ({ name }) => (name || '').toLowerCase().trim() === 'anon guy',
  });
  return io;
}

const got = (s) => s.received.filter(r => r.ev === 'hunt:update');

test('emitHuntUpdate does not deliver a hunt to a socket from another tenant', async () => {
  const hunts = { victim: { tenantId: 'tenantA', equity: [{ id: 'm', name: 'Alice', amount: 100 }], calls: [], bonuses: [] } };
  const intruder = makeSocket('s-intruder', 'tenantB');
  intruder.rooms.add('hunt:victim');           // pre-joined while the hunt did not exist yet
  wire(hunts, [intruder]);

  await core.emitHuntUpdate('victim');

  assert.deepStrictEqual(got(intruder), [], 'a tenantB socket must never receive a tenantA hunt');
});

test('emitHuntUpdate still delivers to a socket in the hunt\'s own tenant', async () => {
  const hunts = { victim: { tenantId: 'tenantA', equity: [{ id: 'm', name: 'Alice', amount: 100 }], calls: [], bonuses: [] } };
  const viewer = makeSocket('s-viewer', 'tenantA');
  viewer.rooms.add('hunt:victim');
  wire(hunts, [viewer]);

  await core.emitHuntUpdate('victim');

  assert.strictEqual(got(viewer).length, 1, 'same-tenant viewers must still get live updates');
  assert.strictEqual(got(viewer)[0].payload.equity[0].name, 'Alice');
});

// The anonymous path already fans out per socket (to keep real names for privileged viewers).
// It must apply the same tenant filter, not just the name masking.
test('the anonymous per-socket path also filters by tenant', async () => {
  const hunts = { victim: { tenantId: 'tenantA', equity: [{ id: 'm', name: 'Anon Guy', amount: 100 }], calls: [], bonuses: [] } };
  const intruder = makeSocket('s-intruder', 'tenantB');
  const viewer = makeSocket('s-viewer', 'tenantA');
  intruder.rooms.add('hunt:victim'); viewer.rooms.add('hunt:victim');
  wire(hunts, [intruder, viewer]);

  await core.emitHuntUpdate('victim');

  assert.deepStrictEqual(got(intruder), [], 'cross-tenant socket must get nothing on the anon path either');
  assert.strictEqual(got(viewer).length, 1, 'same-tenant viewer still served');
});

// Untagged hunts belong to Bean (tenantOf back-compat) and the socket layer defaults an absent
// ?_tenant= to 'bean' — so the single-tenant install must keep working unchanged.
test('an untagged hunt still reaches a default-tenant (bean) socket', async () => {
  const hunts = { victim: { equity: [{ id: 'm', name: 'Alice', amount: 5 }], calls: [], bonuses: [] } };
  const viewer = makeSocket('s-viewer', 'bean');
  viewer.rooms.add('hunt:victim');
  wire(hunts, [viewer]);

  await core.emitHuntUpdate('victim');

  assert.strictEqual(got(viewer).length, 1, 'back-compat: untagged hunt + bean socket must still work');
});
