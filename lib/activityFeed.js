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

// Which bonuses gained a win between two snapshots of a hunt's bonus array.
//
// The client PUTs the WHOLE array on every save, so "a bonus just opened" is only visible as a
// diff — the same reason lib/auditLog.js diffs deletions. Keyed with that file's id-or-slot
// strategy so a reorder or an unrelated field edit emits nothing.
//
// Deliberately conservative: when a hunt lists the same slot twice and neither row carries an
// id, the second one opening emits nothing. Under-emitting into a live ticker is the right
// failure — a duplicate event fired on every subsequent save would not be.
function diffOpenedBonuses(before = [], after = []) {
  const keyOf = (b) => (b && b.id != null && b.id !== '')
    ? `id:${String(b.id)}`
    : `slot:${String((b && b.slot) || '').trim().toLowerCase()}`;
  const wonBefore = new Set();
  for (const b of before) if (b && Number(b.win) > 0) wonBefore.add(keyOf(b));
  const opened = [];
  for (const b of after) {
    if (!b || !(Number(b.win) > 0)) continue;
    const k = keyOf(b);
    if (wonBefore.has(k)) continue;
    wonBefore.add(k); // never emit the same key twice in one diff
    opened.push(b);
  }
  return opened;
}

module.exports = { makeActivityFeed, diffOpenedBonuses };
