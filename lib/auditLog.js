// Append-only audit log. Records important state-changing actions (bonus deletions detected by
// diffing the hunt on PUT, hunt reset/delete, admin/mod actions, auth) into a Postgres audit_log
// table (real indexed rows — NOT the hunts_kv blob). Owner-only read via routes/audit.routes.js.
// DI: initAuditLog({ pgPool }). All writes are fire-and-forget and never throw to the caller.

function keyOf(b) {
  if (b && b.id != null && b.id !== '') return `id:${String(b.id)}`;
  return `slot:${String((b && b.slot) || '').trim().toLowerCase()}`;
}

// Multiset diff: an occurrence in `before` is "removed" only if `after` has fewer of that key.
// Reorder-stable (counts unchanged) and value-edit-stable (key is id-or-slot, not the whole row).
function diffBonuses(before = [], after = []) {
  const afterCount = new Map();
  for (const b of after) { const k = keyOf(b); afterCount.set(k, (afterCount.get(k) || 0) + 1); }
  const used = new Map();
  const removed = [];
  for (const b of before) {
    const k = keyOf(b);
    const u = used.get(k) || 0;
    const avail = afterCount.get(k) || 0;
    if (u >= avail) removed.push(b);
    used.set(k, u + 1);
  }
  const cleared = before.length > 0 && after.length === 0;
  return { removed, cleared };
}

function summarize(action, ctx = {}) {
  const who = ctx.actorName || 'someone';
  const whose = ctx.targetName ? `${ctx.targetName}'s` : 'a';
  if (action === 'hunt.clear') return `${who} cleared all bonuses from ${whose} hunt`;
  if (action === 'hunt.reset') return `${who} reset ${whose} hunt`;
  if (action === 'hunt.delete') return `${who} deleted ${whose} hunt`;
  if (action === 'bonus.delete') {
    const names = (ctx.removed || []).map(b => (b && b.slot) || '?');
    const shown = names.slice(0, 3).join(', ');
    const extra = names.length > 3 ? `, +${names.length - 3}` : '';
    const noun = names.length === 1 ? 'bonus' : 'bonuses';
    return `${who} removed ${names.length} ${noun} (${shown}${extra}) from ${whose} hunt`;
  }
  return `${who} — ${action}`;
}

module.exports = { keyOf, diffBonuses, summarize };
