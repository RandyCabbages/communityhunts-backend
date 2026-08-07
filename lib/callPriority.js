// The badge roster, flattened for the call queue.
//
// WHY THIS EXISTS: the host's tracker decides which callers lead the round-robin client-side,
// from the badge roster (frontend src/badges/BadgeContext.js — `badgeFor(call.callerId) != null`).
// No public surface can do the same, because publicHuntView deliberately STRIPS calls[].callerId
// (see lib/hunts-core.js maskCallerEntry, guarded by its own test) — so those pages have no id to
// look up. The result was a real bug: badged callers led the rotation on the streamer's screen but
// not on the share link, so a viewer's "UP NEXT" disagreed with the streamer's.
//
// WHAT CROSSES THE WIRE: a coarse boolean (`priority`), never an id. That leaks nothing
// publicHuntView exists to prevent — the resulting ORDER already implies it (a badged caller
// visibly leads), and the roster behind it is public anyway (GET /api/badges ships
// owners/king/mods/supporters to anyone who asks). It does NOT re-link a call to a person.
//
// The flag is ATTACHED in lib/hunts-core.js publicCallRows, not here and not per route. It used to
// be zipped onto the share route's rows only, which left the live watcher on /hunt/:userId — who
// receives the same masked calls over REST *and* over the hunt:update socket — with no priority at
// all. Doing it inside publicHuntView covers every public surface and cannot drift between them.

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

module.exports = { badgedIds };
