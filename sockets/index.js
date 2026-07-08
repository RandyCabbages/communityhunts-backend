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
  const { getPublicHunts, publicHuntView, emitHubUpdate, tenantOf, integrations, viewers, hunts, overdrop, verifyToken } = deps;

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
    socket.data.userId = uid;
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

    socket.on('watch:hunt', userId => {
      socket.join(`hunt:${userId}`);
      socketUsers[socket.id] = { watchingHuntId: userId };
      viewers[userId] = (viewers[userId]||0) + 1;
      const h = hunts[userId];
      // Serialize for THIS viewer. socket.data.userId comes from the verified handshake token
      // (io.use above), or null for anonymous sockets → the privacy-safe masked view.
      if (h) socket.emit('hunt:update', publicHuntView(h, socket.data && socket.data.userId));
      emitHubUpdate(tenantOf(h || {}));
      socket.on('disconnect', () => {
        viewers[userId] = Math.max(0,(viewers[userId]||1)-1);
        delete socketUsers[socket.id];
        emitHubUpdate(tenantOf(hunts[userId] || {}));
      });
    });

    socket.on('leave:hunt', userId => {
      socket.leave(`hunt:${userId}`);
      if (viewers[userId]) viewers[userId] = Math.max(0, viewers[userId] - 1);
      emitHubUpdate(tenantOf(hunts[userId] || {}));
    });

    // NOTE: there is no client 'identify' event any more — it let a socket claim any user id and
    // receive de-masked anonymous names. Identity is set once, from the verified handshake token
    // (io.use above); emitHuntUpdate's per-socket redaction reads that trustworthy socket.data.userId.

    // On reinvite, socket re-fetches permissions from the API (handled client-side in WatchHunt)
  });
};
