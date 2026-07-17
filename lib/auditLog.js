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

const RING_MAX = 500;
const RETENTION_DAYS = Number(process.env.AUDIT_RETENTION_DAYS) || 90;
const MAX_ROWS = Number(process.env.AUDIT_MAX_ROWS) || 50000;

let pgPool = null;
let ring = [];        // newest first; only used when pgPool is null
let ringSeq = 0;

async function initAuditLog(deps) {
  pgPool = (deps && deps.pgPool) || null;
  ring = [];
  ringSeq = 0;
  if (pgPool) {
    try {
      await pgPool.query(`
        CREATE TABLE IF NOT EXISTS audit_log (
          id BIGSERIAL PRIMARY KEY,
          ts TIMESTAMPTZ NOT NULL DEFAULT now(),
          tenant_id TEXT, category TEXT NOT NULL, action TEXT NOT NULL,
          actor_id TEXT, actor_name TEXT, target_id TEXT,
          summary TEXT NOT NULL, detail JSONB, ip TEXT
        )`);
      await pgPool.query(`CREATE INDEX IF NOT EXISTS audit_ts     ON audit_log (ts DESC)`);
      await pgPool.query(`CREATE INDEX IF NOT EXISTS audit_cat    ON audit_log (category, ts DESC)`);
      await pgPool.query(`CREATE INDEX IF NOT EXISTS audit_actor  ON audit_log (actor_id, ts DESC)`);
      await pgPool.query(`CREATE INDEX IF NOT EXISTS audit_target ON audit_log (target_id, ts DESC)`);
      console.log('[audit] audit_log table ready');
    } catch (e) { console.error('[audit] init failed:', e.message); }
  }
}

async function record(e) {
  const entry = {
    id: ++ringSeq,
    ts: new Date().toISOString(),
    tenant_id: e.tenantId || null, category: e.category, action: e.action,
    actor_id: e.actorId || null, actor_name: e.actorName || null, target_id: e.targetId || null,
    summary: e.summary, detail: e.detail || null, ip: e.ip || null,
  };
  if (!pgPool) {
    ring.unshift(entry);
    if (ring.length > RING_MAX) ring.length = RING_MAX;
    return;
  }
  try {
    await pgPool.query(
      `INSERT INTO audit_log (tenant_id, category, action, actor_id, actor_name, target_id, summary, detail, ip)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [entry.tenant_id, entry.category, entry.action, entry.actor_id, entry.actor_name,
       entry.target_id, entry.summary, entry.detail ? JSON.stringify(entry.detail) : null, entry.ip]);
  } catch (err) { console.error('[audit] insert failed:', err.message); }
}

function recordFromReq(req, o) {
  record({
    category: o.category, action: o.action,
    actorId: req.user && req.user.id, actorName: req.user && req.user.displayName,
    targetId: o.targetId || null, tenantId: req.tenant && req.tenant.id,
    summary: o.summary, detail: o.detail || null, ip: req.ip,
  });
}

function recordHuntChange(req, before, after, o = {}) {
  const d = diffBonuses((before && before.bonuses) || [], (after && after.bonuses) || []);
  if (!d.removed.length && !d.cleared) return; // noise filter
  const action = d.cleared ? 'hunt.clear' : 'bonus.delete';
  recordFromReq(req, {
    category: 'hunt', action, targetId: o.targetId || null,
    summary: summarize(action, { actorName: req.user && req.user.displayName, targetName: o.targetName, removed: d.removed }),
    detail: {
      removed: d.removed,
      counts: { from: ((before && before.bonuses) || []).length, to: ((after && after.bonuses) || []).length },
      before: { bonuses: (before && before.bonuses) || [], equity: (before && before.equity) || [], calls: (before && before.calls) || [] },
    },
  });
}

async function query(opts = {}) {
  const limit = Math.min(Math.max(Number(opts.limit) || 50, 1), 200);
  if (!pgPool) {
    let rows = ring.slice();
    if (opts.category) rows = rows.filter(r => r.category === opts.category);
    if (opts.actorId)  rows = rows.filter(r => r.actor_id === String(opts.actorId));
    if (opts.targetId) rows = rows.filter(r => r.target_id === String(opts.targetId));
    if (opts.q)        rows = rows.filter(r => (r.summary || '').toLowerCase().includes(String(opts.q).toLowerCase()));
    if (opts.from)     rows = rows.filter(r => r.ts >= opts.from);
    if (opts.to)       rows = rows.filter(r => r.ts <= opts.to);
    if (opts.cursor) {
      const [cts, cid] = String(opts.cursor).split('|');
      rows = rows.filter(r => r.ts < cts || (r.ts === cts && r.id < Number(cid)));
    }
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return { rows: page, nextCursor: page.length === limit && last ? `${last.ts}|${last.id}` : null };
  }
  const where = []; const p = [];
  if (opts.category) { p.push(opts.category); where.push(`category = $${p.length}`); }
  if (opts.actorId)  { p.push(String(opts.actorId)); where.push(`actor_id = $${p.length}`); }
  if (opts.targetId) { p.push(String(opts.targetId)); where.push(`target_id = $${p.length}`); }
  if (opts.q)        { p.push(`%${opts.q}%`); where.push(`summary ILIKE $${p.length}`); }
  if (opts.from)     { p.push(opts.from); where.push(`ts >= $${p.length}`); }
  if (opts.to)       { p.push(opts.to); where.push(`ts <= $${p.length}`); }
  if (opts.cursor) {
    const [cts, cid] = String(opts.cursor).split('|');
    p.push(cts); p.push(cid);
    where.push(`(ts, id) < ($${p.length - 1}::timestamptz, $${p.length}::bigint)`);
  }
  const sql = `SELECT id, ts, tenant_id, category, action, actor_id, actor_name, target_id, summary, detail, ip
               FROM audit_log ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
               ORDER BY ts DESC, id DESC LIMIT ${limit}`;
  const r = await pgPool.query(sql, p);
  const last = r.rows[r.rows.length - 1];
  return { rows: r.rows, nextCursor: r.rows.length === limit && last ? `${new Date(last.ts).toISOString()}|${last.id}` : null };
}

async function prune() {
  if (!pgPool) { if (ring.length > RING_MAX) ring.length = RING_MAX; return; }
  try {
    await pgPool.query(`DELETE FROM audit_log WHERE ts < now() - ($1 || ' days')::interval`, [String(RETENTION_DAYS)]);
    await pgPool.query(`DELETE FROM audit_log WHERE id NOT IN (SELECT id FROM audit_log ORDER BY id DESC LIMIT $1)`, [MAX_ROWS]);
  } catch (e) { console.error('[audit] prune failed:', e.message); }
}

module.exports = {
  keyOf, diffBonuses, summarize,
  initAuditLog, record, recordFromReq, recordHuntChange, query, prune, RING_MAX,
};
