// Attach verified Discord ids to hunt rows that carry only a typed display name.
//
// WHY THIS EXISTS: a host builds a hunt by TYPING names — `+ Add person` for equity, the Add Call
// modal and the generate/curated-list paths for calls. Typing a name is not authentication, so
// most rows have no id. Only the two auth'd REST call endpoints ever stamp one. Per-person
// features (caller leaderboards, payout attribution, the ledger) then silently lose those people.
//
// WHY IT IS PARANOID: money flows through equity rows. A wrong link pays the wrong person, and
// display-name-based identity is this codebase's most repeated regression. So:
//   - a match must be UNIQUE or nothing happens
//   - the narrow tier only ever consults THIS HUNT's own equity list
//   - a blank is filled; an existing id is never overwritten
//   - synthetic `manual:<name>` ids are not identities and are never written
//
// Tier 1 (linkWithinHunt) generalizes lib/hunts-core.js bindEquityIdentityByName — the same
// uniqueness rule, applied to calls and bonuses rather than only equity, and triggered on save
// rather than only on a granted call request.
//
// Tier 2 (proposeFromAliases) is PROPOSAL ONLY and never mutates. Platform-wide alias matching is
// materially riskier than hunt-local matching, so it goes through human confirmation.

const { isRealDiscordId } = require('./userIds');

// Same normalization as bindEquityIdentityByName: lowercase, whitespace-insensitive.
const norm = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, '');

// A usable identity: present and a REAL Discord snowflake. `manual:<name>` rows are synthetic
// placeholders for people who never signed in — never an identity.
const usableId = (id) => !!id && isRealDiscordId(String(id));

function linkWithinHunt(hunt) {
  const out = { equity: 0, calls: 0, bonuses: 0, links: [] };
  if (!hunt) return out;

  // Build name -> id from this hunt's ALREADY-LINKED equity rows. A name mapping to more than one
  // DISTINCT id is ambiguous and is dropped; the same id repeated across rows is not.
  const byName = new Map(); // normName -> Set(discordId)
  for (const e of hunt.equity || []) {
    if (!e || !usableId(e.discordId)) continue;
    const k = norm(e.name);
    if (!k) continue;
    if (!byName.has(k)) byName.set(k, new Set());
    byName.get(k).add(String(e.discordId));
  }
  const resolve = (name) => {
    const k = norm(name);
    if (!k) return null;
    const ids = byName.get(k);
    return ids && ids.size === 1 ? [...ids][0] : null;
  };

  for (const c of hunt.calls || []) {
    if (!c || c.callerId) continue;          // fill blanks only
    const id = resolve(c.user);
    if (!id) continue;
    c.callerId = id;
    out.calls++;
    out.links.push({ kind: 'call', id: c.id || null, name: c.user, discordId: id });
  }

  // Bonuses carry the caller forward from the call that got in, and the caller leaderboard reads
  // got-ins from here — linking only calls would leave every hit rate at zero.
  for (const b of hunt.bonuses || []) {
    if (!b || b.callerId) continue;
    const id = resolve(b.caller);
    if (!id) continue;
    b.callerId = id;
    out.bonuses++;
    out.links.push({ kind: 'bonus', id: b.id || null, name: b.caller, discordId: id });
  }

  return out;
}

function proposeFromAliases(hunt, ownersByName) {
  const proposals = [];
  const ambiguousMap = new Map();
  if (!hunt || !ownersByName) return { proposals, ambiguous: [] };

  const consider = (kind, id, name, hasId) => {
    if (hasId) return;                       // never overwrite
    const raw = String(name || '').trim();
    if (!raw) return;
    const owners = ownersByName.get(raw);
    if (!owners || owners.size === 0) return;
    if (owners.size > 1) { ambiguousMap.set(raw, owners.size); return; }
    const discordId = [...owners][0];
    if (!usableId(discordId)) return;
    proposals.push({ kind, id, name: raw, discordId });
  };

  for (const e of hunt.equity || []) if (e) consider('equity', e.id || null, e.name, !!e.discordId);
  for (const c of hunt.calls || [])  if (c) consider('call',   c.id || null, c.user, !!c.callerId);

  return {
    proposals,
    ambiguous: [...ambiguousMap.entries()].map(([name, count]) => ({ name, count })),
  };
}

// ── Name-grouped review ─────────────────────────────────────────────────────
// The operator reviews PEOPLE, not rows. On real data one community produced 81 distinct
// unlinked names spread across 10,345 rows — asking for 10,345 decisions (and shipping them back
// as 10,345 objects) is unusable and, applied naively, blocks the event loop for minutes.
// One decision per name, applied server-side in a single pass, is the same outcome for ~1% of
// the work.

// Every distinct unlinked name, with how much of the data it accounts for. Rows already carrying
// an id are skipped — they need no decision.
function collectUnlinkedNames(huntList) {
  const byName = new Map(); // normName -> { name, rows, hunts:Set }
  const bump = (rawName, huntKey) => {
    const raw = String(rawName || '').trim();
    const k = norm(raw);
    if (!k) return;
    let e = byName.get(k);
    if (!e) { e = { name: raw, rows: 0, hunts: new Set() }; byName.set(k, e); }
    e.rows++;
    e.hunts.add(huntKey);
  };

  for (const h of huntList || []) {
    const key = h?.huntId || `${h?.user?.id}|${h?.startedAt}`;
    for (const e of h?.equity  || []) if (e && !e.discordId) bump(e.name, key);
    for (const c of h?.calls   || []) if (c && !c.callerId) bump(c.user, key);
    // Bonuses are counted because applyNameLinks links them too — omitting them here would show
    // the operator a row count smaller than the number the apply then reports.
    for (const b of h?.bonuses || []) if (b && !b.callerId) bump(b.caller, key);
  }

  return [...byName.values()]
    .map(e => ({ name: e.name, rows: e.rows, hunts: e.hunts.size }))
    .sort((a, b) => b.rows - a.rows || a.name.localeCompare(b.name));
}

// Apply one decision per name across EVERY hunt in a single pass. `nameToId` may be keyed by any
// casing/spacing — it is normalized here. Same rails as everywhere else: blanks only, never
// overwrite, never write a synthetic id. Mutates in place; returns a per-name breakdown so the
// audit entry can say what actually changed.
function applyNameLinks(huntList, nameToId) {
  const byName = new Map();
  for (const [name, id] of (nameToId instanceof Map ? nameToId : new Map(Object.entries(nameToId || {})))) {
    const k = norm(name);
    if (k && usableId(id)) byName.set(k, String(id));
  }

  const byNameCount = {};
  let applied = 0;
  if (!byName.size) return { applied, byName: byNameCount };

  const hit = (rawName) => byName.get(norm(rawName)) || null;
  const count = (rawName) => {
    const disp = String(rawName || '').trim();
    byNameCount[disp] = (byNameCount[disp] || 0) + 1;
    applied++;
  };

  for (const h of huntList || []) {
    for (const e of h?.equity || []) {
      if (!e || e.discordId) continue;
      const id = hit(e.name);
      if (!id) continue;
      e.discordId = id; count(e.name);
    }
    for (const c of h?.calls || []) {
      if (!c || c.callerId) continue;
      const id = hit(c.user);
      if (!id) continue;
      c.callerId = id; count(c.user);
    }
    // Bonuses too — the caller leaderboard reads got-ins from bonuses[].callerId.
    for (const b of h?.bonuses || []) {
      if (!b || b.callerId) continue;
      const id = hit(b.caller);
      if (!id) continue;
      b.callerId = id; count(b.caller);
    }
  }

  return { applied, byName: byNameCount };
}

// Reverse applyNameLinks for ONE name. Clears only rows whose name matches AND whose current id
// is exactly `discordId`, so it can never strip an unrelated person's linkage.
//
// It CAN clear an id that arrived legitimately (a REST-submitted call by that same user), but the
// operation is effectively idempotent — re-applying the same name link restores the same id — and
// without this, a 10,000-row apply would be irreversible in practice, which would make the
// "everything is reversible" rail a lie.
function unlinkNameLinks(huntList, name, discordId) {
  const k = norm(name);
  const id = String(discordId || '');
  let cleared = 0;
  if (!k || !usableId(id)) return { cleared };

  for (const h of huntList || []) {
    for (const e of h?.equity || []) {
      if (e && norm(e.name) === k && String(e.discordId || '') === id) { delete e.discordId; cleared++; }
    }
    for (const c of h?.calls || []) {
      if (c && norm(c.user) === k && String(c.callerId || '') === id) { delete c.callerId; cleared++; }
    }
    for (const b of h?.bonuses || []) {
      if (b && norm(b.caller) === k && String(b.callerId || '') === id) { delete b.callerId; cleared++; }
    }
  }
  return { cleared };
}

module.exports = {
  linkWithinHunt, proposeFromAliases, collectUnlinkedNames, applyNameLinks, unlinkNameLinks,
};
