// In-memory, per-tenant activity feed backing the admin Mission Control "Live feed" panel.
//
// Deliberately NOT persisted. This is a live ticker of what is happening right now, not an
// audit trail — the audit log (lib/auditLog.js) is the durable record and covers admin actions.
// A deploy clears this buffer, the same transient lifecycle as the OverDrop overlay state.
//
// Events are appended from existing choke points (a call submitted, a bonus opened, a login,
// a hunt started). Readers page with an opaque monotonic cursor so a 15s poll only ever
// transfers what it has not already seen.

function makeActivityFeed({ cap = 200 } = {}) {
  const buffers = new Map(); // tenantId -> Event[] (oldest first)
  let nextId = 1;

  function push(tenantId, event) {
    const key = tenantId || 'bean';
    if (!buffers.has(key)) buffers.set(key, []);
    const buf = buffers.get(key);
    const row = {
      id: nextId++,
      ts: Date.now(),
      type: event?.type || 'call',
      text: String(event?.text || ''),
      meta: event?.meta || null,
    };
    buf.push(row);
    if (buf.length > cap) buf.splice(0, buf.length - cap);
    return row;
  }

  function since(tenantId, cursor, limit = 20) {
    const buf = buffers.get(tenantId || 'bean') || [];
    const after = Number(cursor);
    const fresh = Number.isFinite(after) && after > 0 ? buf.filter(e => e.id > after) : buf;
    const events = fresh.slice(-limit).reverse(); // newest first
    // The cursor always advances to the newest event we HAVE, even when nothing was fresh,
    // so a reader that misses a poll does not re-receive the whole buffer.
    const newest = buf.length ? buf[buf.length - 1].id : (Number.isFinite(after) ? after : 0);
    return { events, cursor: newest };
  }

  function clear(tenantId) {
    if (tenantId) buffers.delete(tenantId); else buffers.clear();
  }

  return { push, since, clear };
}

module.exports = { makeActivityFeed };
