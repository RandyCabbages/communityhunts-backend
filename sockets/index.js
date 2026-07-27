// Socket.IO connection handling: hub/hunt watch rooms, live viewer counts, and the
// permission-identify channel. Extracted from server.js (de-slop refactor, 2026-06-20).
// BEHAVIOR UNCHANGED.
//
// registerSockets(io, deps) wires io.on('connection'). deps:
//   { getPublicHunts, publicHuntView, emitHubUpdate, tenantOf, integrations, viewers, hunts }
// viewers is the SAME live viewer-count map shared (by reference) with lib/hunts-core.js, so
// huntSummary's viewer counts and these increments/decrements stay coherent.
//
// LIFECYCLE NOTE: the 'disconnect' handler is registered INSIDE 'watch:hunt' (per watch room),
// not globally — this is intentional so the viewer count decrements for the room the socket
// was watching. Keep it nested.

module.exports = function registerSockets(io, deps) {
  const { getPublicHunts, publicHuntView, emitHubUpdate, tenantOf, integrations, viewers, hunts, overdrop, verifyToken, isBanned } = deps;

  // Authenticate the handshake: a socket's identity comes from its VERIFIED bearer token, never a
  // client-sent 'identify' event (which was spoofable — any socket could claim any user id and be
  // handed the de-masked view of anonymous equity members). No/invalid token → anonymous, which
  // only ever gets the privacy-safe masked view. NEVER reject: public overlays, offline hunts and
  // anonymous hub browsing all connect with no session.
  io.use((socket, next) => {
    let uid = null;
    try {
      const token = socket.handshake.auth && socket.handshake.auth.token;
      if (token && verifyToken) { const v = verifyToken(token); if (v && v.id) uid = String(v.id); }
    } catch { /* stay anonymous */ }
    // A banned user is cut off from live data too — reject the handshake. (Anonymous/invalid
    // tokens stay anonymous and connect normally; only a VERIFIED banned id is refused.)
    if (uid && isBanned && isBanned(uid)) return next(new Error('banned'));
    socket.data.userId = uid;
    // Stamp the tenant the socket connected to, so presence (lib/presence.js) can be counted
    // per community. Same source + 'bean' default as the connection handler's `slug` below.
    // Client-supplied and therefore untrusted — but it only ever NARROWS a count, never grants
    // access, so spoofing it achieves nothing.
    socket.data.tenantSlug = socket.handshake.query._tenant || 'bean';
    next();
  });

  // Track socket → { watchingHuntId } for viewer-count bookkeeping
  const socketUsers = {};

  io.on('connection', socket => {
    // Tenant slug from the handshake query (?_tenant=); defaults to bean for back-compat.
    const slug = socket.handshake.query._tenant || 'bean';

    socket.on('watch:hub', () => {
      socket.join('hub:' + slug);
      socket.emit('hub:update', getPublicHunts(slug));
      socket.emit('bean:live', integrations.getLiveStatus(slug));
    });

    // OverDrop (mod-controlled stream overlay): join is READ-ONLY — sockets are
    // unauthenticated, so all mutations go through the requireMod REST routes
    // (routes/overdrop.routes.js). This only subscribes + syncs current state.
    socket.on('watch:overdrop', () => {
      socket.join('overdrop:' + slug);
      socket.emit('overdrop:sync', overdrop.getState(slug));
    });

    // Rooms this socket is actually counted in. Without it, a client emitting watch:hunt N times
    // incremented viewers N times AND registered N disconnect listeners (they were nested in this
    // handler), from an UNAUTHENTICATED socket: forged viewer counts on the hub plus unbounded
    // listener growth. Membership is now a set, so watch:hunt is idempotent per socket.
    const watched = new Set();

    // One disconnect handler for the socket, not one per watch:hunt call.
    socket.on('disconnect', () => {
      for (const id of watched) {
        viewers[id] = Math.max(0, (viewers[id] || 1) - 1);
        emitHubUpdate(tenantOf(hunts[id] || {}));
      }
      watched.clear();
      delete socketUsers[socket.id];
    });

    socket.on('watch:hunt', userId => {
      const id = String(userId || '');
      if (!id) return;
      const h = hunts[id];
      // Tenant guard — parity with GET /api/hunts/:userId (routes/hunts.routes.js), which got this
      // in the 2026-07-18 security audit (#4) precisely because serving a hunt outside the caller's
      // tenant leaks non-anonymous equity names, bonuses, calls and the existence of in-setup /
      // offline hunts to anyone who knows a Discord id. That fix closed the REST path and missed
      // this one, so the same data stayed reachable over Socket.IO — and joining the room also
      // subscribes to every future hunt:update for it. Fail the same way REST does: silently.
      if (h && tenantOf(h) !== slug) return;

      socket.join(`hunt:${id}`);
      socketUsers[socket.id] = { watchingHuntId: id };
      if (!watched.has(id)) {           // count each socket once per hunt
        watched.add(id);
        viewers[id] = (viewers[id] || 0) + 1;
      }
      // Serialize for THIS viewer. socket.data.userId comes from the verified handshake token
      // (io.use above), or null for anonymous sockets → the privacy-safe masked view.
      if (h) socket.emit('hunt:update', publicHuntView(h, socket.data && socket.data.userId));
      emitHubUpdate(tenantOf(h || {}));
    });

    socket.on('leave:hunt', userId => {
      const id = String(userId || '');
      socket.leave(`hunt:${id}`);
      // Only decrement if THIS socket was actually counted, and drop it from the set so the
      // disconnect handler above doesn't decrement a second time. Previously leave:hunt could be
      // spammed to drive another hunt's viewer count to zero.
      if (watched.delete(id)) {
        viewers[id] = Math.max(0, (viewers[id] || 1) - 1);
      }
      emitHubUpdate(tenantOf(hunts[id] || {}));
    });

    // NOTE: there is no client 'identify' event any more — it let a socket claim any user id and
    // receive de-masked anonymous names. Identity is set once, from the verified handshake token
    // (io.use above); emitHuntUpdate's per-socket redaction reads that trustworthy socket.data.userId.

    // On reinvite, socket re-fetches permissions from the API (handled client-side in WatchHunt)
  });
};
