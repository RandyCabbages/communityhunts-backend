// Vet client-supplied identity before it is stored.
//
// A hunt host legitimately decides WHO is in their hunt — typing a name has always been their
// call. What they must not be able to do is INVENT a Discord identity for that name: an equity
// row's `discordId` is what `lib/userStats.js` uses to decide whose profile a hunt appears on
// (`eqUserId`), and what payout attribution reads. An unvetted id lets one host's hunt surface in
// someone else's stats.
//
// Two different rules, because the two fields have different corroboration available:
//
//   equity[].discordId  — this is where NEW people enter the hunt, so there is nothing in the
//                         hunt to check against. Verified against known_users: a hit means that
//                         person actually signed in with that id (the same proof the admin
//                         on-behalf card flow relies on). Costs a query, so it runs ONLY when a
//                         value actually changes — a steady-state save, which happens every
//                         ~500ms while editing, does no I/O at all.
//
//   calls[]/bonuses[].callerId — must already appear as a linked equity row's discordId in THIS
//                         hunt. That is exactly the rule the frontend applies when it stamps one
//                         (src/hunt/callerIdentity.js) and the rule Tier 1 applies on the server
//                         (lib/identityLink.js), so mirroring it here costs nothing and admits
//                         nothing new. Free, synchronous, no database.
//
// A rejected value is STRIPPED, not overwritten — hunts-core's preserveRowIdentity then restores
// whatever the server already had, so a bad write degrades to "no change" instead of data loss.

const { isRealDiscordId } = require('./userIds');

// Map of rowId -> current stored value for `field`.
const indexBy = (rows, field) => {
  const m = new Map();
  for (const r of rows || []) if (r && r.id != null) m.set(String(r.id), r[field] ? String(r[field]) : null);
  return m;
};

// Rows whose `field` is present AND differs from what is stored — the only ones worth vetting.
function changedValues(prev, next, field) {
  const was = indexBy(prev, field);
  const out = [];
  for (const r of next || []) {
    if (!r || r.id == null || !r[field]) continue;
    const to = String(r[field]);
    if (was.get(String(r.id)) === to) continue;
    out.push({ rowId: String(r.id), from: was.get(String(r.id)) || null, to });
  }
  return out;
}

// Strip `field` from the rows named in `bad`. Returns the same array when nothing is rejected.
function stripRejected(next, field, bad) {
  if (!bad.size) return next;
  return next.map(r => {
    if (!r || r.id == null || !r[field] || !bad.has(String(r.id))) return r;
    const { [field]: _dropped, ...rest } = r;
    return rest;
  });
}

/**
 * Vet equity `discordId` writes against real accounts.
 * `isKnownAccount(id)` → truthy when that id has signed in. Injected so this stays testable and
 * so a database outage can be made to fail CLOSED by the caller.
 * Returns { rows, accepted, rejected } — `rows` is safe to store.
 */
async function vetEquityIdentity(prev, next, { isKnownAccount } = {}) {
  if (!Array.isArray(next)) return { rows: next, accepted: [], rejected: [] };
  const changed = changedValues(prev, next, 'discordId');
  if (!changed.length) return { rows: next, accepted: [], rejected: [] };

  const verdict = new Map();
  for (const { to } of changed) {
    if (verdict.has(to)) continue;
    // Shape first — it is free, and it rejects row ids (`creator_auto`) and `manual:<name>`
    // placeholders without touching the database.
    if (!isRealDiscordId(to)) { verdict.set(to, false); continue; }
    if (!isKnownAccount) { verdict.set(to, false); continue; }
    let ok = false;
    try { ok = !!(await isKnownAccount(to)); } catch { ok = false; }  // unreachable DB → reject
    verdict.set(to, ok);
  }

  const accepted = changed.filter(c => verdict.get(c.to));
  const rejected = changed.filter(c => !verdict.get(c.to));
  return { rows: stripRejected(next, 'discordId', new Set(rejected.map(r => r.rowId))), accepted, rejected };
}

/**
 * Vet `callerId` on calls/bonuses against the identities this hunt's equity already establishes.
 * `equity` should be the POST-vet equity, so a caller can never be corroborated by an id that was
 * itself just rejected.
 */
function vetCallerIdentity(prev, next, equity) {
  if (!Array.isArray(next)) return { rows: next, accepted: [], rejected: [] };
  const changed = changedValues(prev, next, 'callerId');
  if (!changed.length) return { rows: next, accepted: [], rejected: [] };

  const linked = new Set();
  for (const e of equity || []) if (e && isRealDiscordId(e.discordId)) linked.add(String(e.discordId));

  const accepted = changed.filter(c => linked.has(c.to));
  const rejected = changed.filter(c => !linked.has(c.to));
  return { rows: stripRejected(next, 'callerId', new Set(rejected.map(r => r.rowId))), accepted, rejected };
}

module.exports = { vetEquityIdentity, vetCallerIdentity };
