// "Online now" for the admin Mission Control dashboard.
//
// Counts DISTINCT signed-in users with at least one open socket — not sockets, because one
// person with the hunt page, an overlay and a second tab is one person, not three.
//
// Identity is socket.data.userId, set ONCE in sockets/index.js from the verified handshake
// token. Anonymous sockets (public overlays, offline hunts, logged-out hub browsing) carry no
// userId and are deliberately not counted: this number is "members online", not "traffic".
//
// There is no separate presence store to drift — the socket server IS the source of truth.

function makePresence(io) {
  function onlineIds(tenantSlug) {
    const ids = new Set();
    if (!io?.sockets?.sockets) return [];
    for (const socket of io.sockets.sockets.values()) {
      const uid = socket?.data?.userId;
      if (!uid) continue;
      if (tenantSlug && socket?.data?.tenantSlug && socket.data.tenantSlug !== tenantSlug) continue;
      ids.add(String(uid));
    }
    return [...ids];
  }

  const countOnline = (tenantSlug) => onlineIds(tenantSlug).length;

  return { onlineIds, countOnline };
}

module.exports = { makePresence };
