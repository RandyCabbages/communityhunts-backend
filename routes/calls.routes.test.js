// Pending call-requests are OWNER-ONLY data, and the socket must not hand out what the REST route
// refuses.
//
// `GET /api/hunts/:userId/call-requests` 403s anyone who is not the hunt owner or an admin with
// authority over the hunt. The socket beside it broadcast the SAME array into `hunt:<ownerId>` —
// a room every viewer of a live hunt joins, including unauthenticated ones — so the Discord id,
// display name and avatar URL of everyone who asked for call permission (including the ones the
// owner then DENIES) went to the whole audience. The route comment says "Notify the hunt owner";
// the delivery was a broadcast.
//
// Same shape as the 2026-07-18 audit #4 miss: a REST gate with no socket twin.
//
// Who must still receive it: exactly whoever the frontend shows the popup to, which is `canEdit`
// (HuntTracker.js gates the panel on it) = host, admin/mod with authority, invited editor. The
// socket list is its only data source — there is no REST fetch to fall back on — so
// under-delivering here silently empties the host's request panel.

const { test } = require('node:test');
const assert = require('node:assert');
const express = require('express');
const core = require('../lib/hunts-core');
const callsRoutes = require('./calls.routes');

const OWNER = 'ownerId';

function makeSocket(id, tenantSlug, userId = null) {
  return {
    id, rooms: new Set([`hunt:${OWNER}`]), received: [],
    data: { userId, tenantSlug },
    emit(ev, payload) { this.received.push({ ev, payload }); },
  };
}

// Wire the REAL emitToHuntRoom against socket doubles, so the assertion is on what each socket
// actually received rather than on a recorded call to a stub.
function wire(hunts, sockets) {
  const io = {
    to: (room) => ({
      emit: (ev, payload) => sockets.filter(s => s.rooms.has(room)).forEach(s => s.received.push({ ev, payload })),
    }),
    in: (room) => ({ fetchSockets: async () => sockets.filter(s => s.rooms.has(room)) }),
  };
  core.initHuntsCore({
    hunts, archive: [], viewers: {}, io, persistHunts() {},
    isAnonymousUser: () => false,
    isPrivilegedViewer: (viewerId, hunt) => String(viewerId) === String(hunt?.user?.id) || viewerId === 'modId',
    shouldMaskIdentity: () => false,
  });
  return io;
}

const pass = (req, res, next) => next();

// `callerRef.current` rather than a fixed user: huntCallRequests is module-local to each router
// factory, so a second app() would not see the first one's pending requests.
function appWith({ hunts, callerRef, io }) {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.user = callerRef.current; req.tenant = { id: 'bean' }; next(); });
  let n = 0;
  app.use(callsRoutes({
    hunts, io, persistHunts() {},
    requireAuth: pass,
    canEditHunt: () => false,
    isEquityMember: () => false,
    reqCanAdminHunt: (req, ownerId) => req.user && req.user.id === 'modId',
    isPrivileged: () => false,
    isPrivilegedViewer: (viewerId, hunt) => String(viewerId) === String(hunt?.user?.id) || viewerId === 'modId',
    emitToHuntRoom: core.emitToHuntRoom,
    normalizeSlot: s => s,
    nameOf: u => (u && (u.displayName || u.username)) || '',
    publicHuntView: core.publicHuntView,
    emitHubUpdate() {},
    emitHuntUpdate: async () => {},
    uid: () => `req${++n}`,
    rejectBadHuntInput: pass,
    auditLog: { record() {} },
    activityFeed: { push() {} },
    getKnownUser: () => null,
  }));
  return app;
}

async function call(app, method, pathname, body) {
  const server = await new Promise(r => { const s = app.listen(0, () => r(s)); });
  try {
    const r = await fetch(`http://127.0.0.1:${server.address().port}${pathname}`, {
      method, headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body === undefined ? {} : body),
    });
    return { status: r.status, body: await r.json().catch(() => null) };
  } finally {
    server.closeAllConnections();          // fetch keep-alive sockets never drain otherwise
    await new Promise(res => server.close(res));
  }
}

const liveHunt = (extra = {}) => ({
  [OWNER]: { user: { id: OWNER }, tenantId: 'bean', isLive: true, equity: [], calls: [], bonuses: [], ...extra },
});
const got = (s, ev) => s.received.filter(r => r.ev === ev);

test('a viewer of the hunt does NOT receive the owner\'s pending call-request list', async () => {
  const hunts = liveHunt();
  const owner  = makeSocket('s-owner',  'bean', OWNER);
  const viewer = makeSocket('s-viewer', 'bean', 'randomViewer');
  const anon   = makeSocket('s-anon',   'bean', null);
  const io = wire(hunts, [owner, viewer, anon]);

  const app = appWith({ hunts, callerRef: { current: { id: 'requester', displayName: 'Requester' } }, io });
  const res = await call(app, 'POST', `/api/hunts/${OWNER}/request-calls`);
  assert.strictEqual(res.body.status, 'requested');

  assert.deepStrictEqual(got(viewer, 'calls:request:new'), [], 'a plain viewer must not see who requested');
  assert.deepStrictEqual(got(anon, 'calls:request:new'), [], 'an anonymous socket must not see it either');
});

test('the hunt owner still receives the request list, with the requester details', async () => {
  const hunts = liveHunt();
  const owner = makeSocket('s-owner', 'bean', OWNER);
  const io = wire(hunts, [owner]);

  const app = appWith({ hunts, callerRef: { current: { id: 'requester', displayName: 'Requester' } }, io });
  await call(app, 'POST', `/api/hunts/${OWNER}/request-calls`);

  const ev = got(owner, 'calls:request:new');
  assert.strictEqual(ev.length, 1, 'the owner must still be notified');
  assert.strictEqual(ev[0].payload.requests.length, 1);
  assert.strictEqual(ev[0].payload.requests[0].userId, 'requester');
});

// The popup is gated on `canEdit`, which includes invited co-editors and mods — they must keep
// working, or the fix trades a leak for a broken panel.
test('an invited editor still receives the request list', async () => {
  const hunts = liveHunt({ invitedEditors: ['editorId'] });
  const editor = makeSocket('s-editor', 'bean', 'editorId');
  const io = wire(hunts, [editor]);

  const app = appWith({ hunts, callerRef: { current: { id: 'requester', displayName: 'Requester' } }, io });
  await call(app, 'POST', `/api/hunts/${OWNER}/request-calls`);

  assert.strictEqual(got(editor, 'calls:request:new').length, 1, 'co-editors run the hunt too');
});

test('a mod with authority over the hunt still receives the request list', async () => {
  const hunts = liveHunt();
  const mod = makeSocket('s-mod', 'bean', 'modId');
  const io = wire(hunts, [mod]);

  const app = appWith({ hunts, callerRef: { current: { id: 'requester', displayName: 'Requester' } }, io });
  await call(app, 'POST', `/api/hunts/${OWNER}/request-calls`);

  assert.strictEqual(got(mod, 'calls:request:new').length, 1, 'admins/mods see the panel too');
});

// The grant/deny path re-sends the same array to refresh the owner's badge count.
test('the post-decision request list is gated the same way', async () => {
  const hunts = liveHunt();
  const owner  = makeSocket('s-owner',  'bean', OWNER);
  const viewer = makeSocket('s-viewer', 'bean', 'randomViewer');
  const io = wire(hunts, [owner, viewer]);

  const callerRef = { current: { id: 'requester', displayName: 'Requester' } };
  const app = appWith({ hunts, callerRef, io });
  await call(app, 'POST', `/api/hunts/${OWNER}/request-calls`);
  const reqId = got(owner, 'calls:request:new')[0].payload.requests[0].id;

  callerRef.current = { id: OWNER };          // the owner now denies it, same router instance
  const res = await call(app, 'POST', `/api/hunts/${OWNER}/call-requests/${reqId}`, { action: 'deny' });
  assert.strictEqual(res.status, 200);

  assert.deepStrictEqual(got(viewer, 'calls:request:update'), [], 'a denied request must not be announced to the room');
  assert.strictEqual(got(owner, 'calls:request:update').length, 1, 'the owner\'s badge still refreshes');
});
