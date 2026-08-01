// Which slot-call rows lead the round-robin queue on the PUBLIC share page.
//
// WHY THIS EXISTS: the host's tracker decides this client-side, from the badge roster
// (frontend src/badges/BadgeContext.js — `badgeFor(call.callerId) != null`). The share page
// cannot do the same, because publicHuntView deliberately STRIPS calls[].callerId (see
// lib/hunts-core.js maskCallerEntry, guarded by its own test) — so that page has no id to look
// up. The result was a real bug: badged callers led the rotation on the streamer's screen but
// not on the share link, so a viewer's "UP NEXT" disagreed with the streamer's.
//
// WHAT CROSSES THE WIRE: a coarse boolean, never an id. That leaks nothing publicHuntView
// exists to prevent — the resulting ORDER already implies it (a badged caller visibly leads),
// and the roster behind it is public anyway (GET /api/badges ships owners/king/mods/supporters
// to anyone who asks). It does NOT re-link a call to a person.

// Every Discord id holding ANY badge, flattened to strings. Mirrors pickBadge() != null in the
// frontend's src/badges/roles.js (owner | king | staff | supporter) — keep the two in step.
function badgedIds(roster = {}) {
  const s = new Set();
  for (const o of roster.owners || []) s.add(String(o));
  if (roster.king != null && roster.king !== '') s.add(String(roster.king));
  for (const m of roster.mods || []) s.add(String(m));
  for (const x of roster.supporters || []) s.add(String(x));
  s.delete('');
  s.delete('null');
  s.delete('undefined');
  return s;
}

// Zip `priority: true` onto the masked public call rows, resolved from the RAW hunt — the same
// shape lib/shareCards.js uses for equipped cards ("resolved off the RAW hunt, then attached to
// the masked rows"), because the ids it needs are exactly what publicHuntView removes.
//
// Index-zipping is safe: publicHuntView maps calls 1:1 (`h.calls.map(...)`) and never reorders,
// filters or pads. Guarded anyway — a length mismatch means that contract changed, and silently
// mislabelling callers is worse than shipping no flags at all.
//
// Only `true` is written, so unbadged rows stay byte-identical to today's payload and the client
// reads `!!c.priority`.
function withCallPriority(publicCalls, rawCalls, roster) {
  if (!Array.isArray(publicCalls)) return publicCalls;
  const raw = Array.isArray(rawCalls) ? rawCalls : [];
  if (raw.length !== publicCalls.length) return publicCalls;
  const badged = badgedIds(roster);
  if (!badged.size) return publicCalls;
  return publicCalls.map((c, i) => {
    const id = raw[i] && raw[i].callerId;
    return id && badged.has(String(id)) ? { ...c, priority: true } : c;
  });
}

module.exports = { badgedIds, withCallPriority };
