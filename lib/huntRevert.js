// Pure revert math for the shared-hunt activity panel. Returns NEW arrays; never mutates the hunt.
// Routes in mod-hunt.routes.js apply these through the normal hunt-write path (preserveRowIdentity
// -> persist -> emit -> recordHuntChange), so a revert is itself audited and reversible.

function isRevertableRow(row, key) {
  return !!row && row.category === 'hunt' && row.target_id === key;
}

function equityKey(m) {
  return (m && m.discordId) ? `id:${m.discordId}` : `name:${((m && m.name) || '').toLowerCase()}`;
}

// bonus.delete / hunt.clear -> re-append removed bonuses. equity.remove -> re-add removed members
// not already present. Anything else has no scoped inverse.
function scopedUndoPatch(hunt, row) {
  const action = row && row.action;
  const detail = (row && row.detail) || {};
  if (action === 'bonus.delete' || action === 'hunt.clear') {
    return { bonuses: [...((hunt && hunt.bonuses) || []), ...(detail.removed || [])] };
  }
  if (action === 'equity.remove') {
    const present = new Set(((hunt && hunt.equity) || []).map(equityKey));
    const add = (detail.members || []).filter(m => !present.has(equityKey(m)));
    return { equity: [...((hunt && hunt.equity) || []), ...add] };
  }
  throw new Error('not undoable');
}

function fullRestorePatch(row) {
  const before = row && row.detail && row.detail.before;
  if (!before) throw new Error('no snapshot');
  return { bonuses: before.bonuses || [], equity: before.equity || [], calls: before.calls || [] };
}

module.exports = { isRevertableRow, scopedUndoPatch, fullRestorePatch, equityKey };
