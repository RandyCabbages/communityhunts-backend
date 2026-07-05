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
  const { getPublicHunts, publicHuntView, emitHubUpdate, tenantOf, integrations, viewers, hunts, overdrop } = deps;

  // Track socket → { watchingHuntId, user } for permission-aware updates
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
      // Serialize for THIS viewer (socket.data.userId is set once they 'identify'; until then this
      // is the privacy-safe masked view). A re-emit fires in the identify handler below.
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

    // Client sends their user id so we can compute canEdit for them — and, for anonymous-mode
    // name redaction, so per-socket broadcasts (emitHuntUpdate) know who is watching. Stash it on
    // socket.data (what fetchSockets() exposes) and re-emit the watched hunt now that we know the
    // viewer, so a privileged viewer (runner/mod/admin) gets real names instead of the masked
    // view they received at watch:hunt time.
    socket.on('identify', (userId) => {
      socket.data.userId = userId;
      const rec = socketUsers[socket.id];
      if (rec) {
        rec.userId = userId;
        const h = hunts[rec.watchingHuntId];
        if (h) socket.emit('hunt:update', publicHuntView(h, userId));
      }
    });

    // On reinvite, socket re-fetches permissions from the API
    // (handled client-side in WatchHunt)
  });
};
