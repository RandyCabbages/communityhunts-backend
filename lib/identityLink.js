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

module.exports = { linkWithinHunt, proposeFromAliases };
