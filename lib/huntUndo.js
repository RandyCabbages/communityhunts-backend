// Shared undo history for a hunt.
//
// WHY THIS IS SERVER-SIDE
//
// The site and the extension each kept their own undo stack of whole-hunt snapshots, so each could
// only undo its OWN actions — and restoring a snapshot re-sent whole arrays, which erased whatever
// the other client had done since (PUT /api/my-hunt assigns arrays wholesale; see the extension's
// utils/huntSave.js for the same lesson learned twice). Two partial histories can never agree.
//
// Only the server sees every write from every client in one ordered sequence, so the history lives
// here and both Undo buttons call the same endpoint. They stop being two implementations.
//
// WHAT IS RECORDED
//
// The write path can't be told what changed — clients PUT whole arrays — so the entry is DERIVED by
// diffing stored state against the incoming state. That is exactly "what this write changed",
// whoever sent it, with no client cooperation. Only the changed rows and their previous values are
// stored, never a snapshot: the log rides inside the hunt's JSONB blob, which is read and written on
// every hunt operation.

// Row collections that participate in undo, and the scalar fields worth restoring.
const ROW_FIELDS = ['bonuses', 'equity', 'calls', 'vault'];
const SCALAR_FIELDS = [
  'huntMode', 'manualOrder', 'callLimit', 'currentSlot', 'roundRobin',
  'lockTop4', 'publicCalls', 'huntType', 'currency',
];

const MAX_ENTRIES = 30;

const rowsOf = (h, f) => (h && Array.isArray(h[f]) ? h[f] : []);
const idsOf = (rows) => rows.map((r) => r && r.id);

function byId(rows) {
  const m = new Map();
  for (const r of rows) if (r && r.id != null) m.set(r.id, r);
  return m;
}

// Deep-equal by serialisation. Rows are plain JSON out of the store, and key order is stable
// because both sides originate from the same shapes.
const same = (a, b) => JSON.stringify(a === undefined ? null : a) === JSON.stringify(b === undefined ? null : b);

// Build the entry that would undo `before -> after`, or null when nothing undoable changed.
// Clients save on a debounce and re-PUT unchanged state constantly, so a no-op MUST return null or
// the history fills with entries that do nothing when replayed.
function buildUndoEntry(before, after, meta = {}) {
  const entry = { rows: {}, order: {}, scalars: {} };
  let changed = false;

  for (const f of ROW_FIELDS) {
    const b = rowsOf(before, f);
    const a = rowsOf(after, f);
    const afterById = byId(a);

    // Rows that changed or vanished — keep the previous copy plus where it sat, so an undo can put
    // a deleted row back roughly where it was rather than at the end.
    const prev = [];
    b.forEach((row, i) => {
      if (!row || row.id == null) return;
      // CLONE. The entry outlives this request inside the hunt blob, and a later PUT that omits a
      // field leaves the stored array identical to this one — server-side identity linking then
      // mutates those very row objects in place, which would silently rewrite recorded history.
      if (!same(row, afterById.get(row.id))) prev.push({ i, row: JSON.parse(JSON.stringify(row)) });
    });

    const beforeIds = new Set(idsOf(b));
    const addedIds = idsOf(a).filter((id) => id != null && !beforeIds.has(id));

    if (prev.length || addedIds.length) {
      entry.rows[f] = {};
      if (prev.length) entry.rows[f].prev = prev;
      if (addedIds.length) entry.rows[f].addedIds = addedIds;
      changed = true;
    }

    // Order is recorded separately: a pure reorder changes no row at all, and a row edit must not
    // drag the sequence back with it.
    const bIds = idsOf(b);
    const aIds = idsOf(a);
    const sameSet = bIds.length === aIds.length && bIds.every((id) => aIds.includes(id));
    if (sameSet && bIds.some((id, i) => id !== aIds[i])) {
      entry.order[f] = bIds;
      changed = true;
    }
  }

  for (const f of SCALAR_FIELDS) {
    if (!before || !after) break;
    if (!same(before[f], after[f])) {
      entry.scalars[f] = before[f] === undefined ? null : before[f];
      changed = true;
    }
  }

  if (!changed) return null;
  entry.at = new Date().toISOString();
  if (meta.actorId != null) entry.actorId = String(meta.actorId);
  if (meta.actorName) entry.actorName = meta.actorName;
  if (meta.source) entry.source = meta.source; // 'site' | 'extension' — display only
  if (meta.summary) entry.summary = meta.summary;
  return entry;
}

// Append an entry to the hunt's history, capped. Mutates `hunt` (it is the live shared object).
function pushUndoEntry(hunt, entry) {
  if (!hunt || !entry) return;
  if (!Array.isArray(hunt.undoLog)) hunt.undoLog = [];
  hunt.undoLog.push(entry);
  if (hunt.undoLog.length > MAX_ENTRIES) hunt.undoLog.splice(0, hunt.undoLog.length - MAX_ENTRIES);
}

// Apply an entry's inverse to CURRENT state. Returns a patch of only the fields it touches, so the
// caller assigns nothing it didn't need to — anything absent from the entry is left exactly as the
// server holds it, which is what makes a stale entry safe to apply.
function undoPatch(current, entry) {
  if (!current || !entry) return null;
  const patch = {};

  for (const f of ROW_FIELDS) {
    const spec = entry.rows && entry.rows[f];
    const wantOrder = entry.order && entry.order[f];
    if (!spec && !wantOrder) continue;

    let rows = rowsOf(current, f).slice();

    if (spec && spec.addedIds && spec.addedIds.length) {
      const drop = new Set(spec.addedIds);
      rows = rows.filter((r) => !drop.has(r && r.id));
    }

    if (spec && spec.prev) {
      for (const { i, row } of spec.prev) {
        const at = rows.findIndex((r) => r && r.id === row.id);
        if (at >= 0) rows[at] = row;                                  // changed → put it back
        else rows.splice(Math.min(i, rows.length), 0, row);           // deleted → reinsert near home
      }
    }

    if (wantOrder) {
      const rank = new Map(wantOrder.map((id, i) => [id, i]));
      const known = rows.filter((r) => rank.has(r && r.id)).sort((x, y) => rank.get(x.id) - rank.get(y.id));
      const rest = rows.filter((r) => !rank.has(r && r.id)); // added since — keep them, at the end
      rows = [...known, ...rest];
    }

    patch[f] = rows;
  }

  for (const [k, v] of Object.entries(entry.scalars || {})) patch[k] = v;

  return patch;
}

// Pop the newest entry and produce the patch that reverses it. Returns null when there's nothing to
// undo. Mutates only `hunt.undoLog` — the caller applies the patch.
function popUndo(hunt) {
  if (!hunt || !Array.isArray(hunt.undoLog) || !hunt.undoLog.length) return null;
  const entry = hunt.undoLog[hunt.undoLog.length - 1];
  const patch = undoPatch(hunt, entry);
  if (!patch) return null;
  hunt.undoLog.pop();
  return { entry, patch };
}

module.exports = { buildUndoEntry, pushUndoEntry, undoPatch, popUndo, MAX_ENTRIES, ROW_FIELDS, SCALAR_FIELDS };
