// Per-caller hit-rate leaderboard for the admin Mission Control dashboard.
//
// "Hit rate" = the share of a caller's suggested slots that actually got into a hunt.
// A call is a row in hunt.calls; a got-in is a row in hunt.bonuses. Both carry an OPTIONAL
// callerId (routes/calls.routes.js sets it only when the caller has a Discord session).
//
// The join is on callerId ONLY. Joining on display name would be cheaper and would cover more
// rows, but display names change and are not unique — name-based identity is the single worst
// regression pattern in this codebase. Nameless calls are counted in `excludedCalls` so the UI
// can be honest about coverage instead of silently under-reporting.
//
// Pure: no I/O, no clock. Safe to unit test.

const norm = (s) => String(s || '').trim().toLowerCase();

function computeCallerStats(hunts, { minColdCalls = 15, limit = 5 } = {}) {
  const byCaller = new Map(); // callerId -> { callerId, name, calls, gotIn, multSum, multCount }
  let excludedCalls = 0;

  const entry = (callerId, name) => {
    let e = byCaller.get(callerId);
    if (!e) {
      e = { callerId, name: name || callerId, calls: 0, gotIn: 0, multSum: 0, multCount: 0 };
      byCaller.set(callerId, e);
    }
    // Last-seen display name wins — purely cosmetic; identity is the id.
    if (name) e.name = name;
    return e;
  };

  for (const h of hunts || []) {
    // Which slots actually got in, per caller, so a got-in can be matched to its call.
    const gotInByCaller = new Map(); // callerId -> Set(normalized slot)
    for (const b of h?.bonuses || []) {
      if (!b) continue;
      const id = b.callerId != null && b.callerId !== '' ? String(b.callerId) : null;
      if (!id) continue;
      const slot = norm(b.slot);
      if (!slot) continue;
      if (!gotInByCaller.has(id)) gotInByCaller.set(id, new Set());
      gotInByCaller.get(id).add(slot);

      const bet = Number(b.bet) || 0;
      const win = Number(b.win) || 0;
      if (bet > 0 && win > 0) {
        const e = entry(id, b.caller);
        e.multSum += win / bet;
        e.multCount++;
      }
    }

    for (const c of h?.calls || []) {
      if (!c) continue;
      const id = c.callerId != null && c.callerId !== '' ? String(c.callerId) : null;
      if (!id) { excludedCalls++; continue; }
      const e = entry(id, c.user);
      e.calls++;
      if (gotInByCaller.get(id)?.has(norm(c.slot))) e.gotIn++;
    }
  }

  const rows = [...byCaller.values()]
    .filter(e => e.calls > 0)
    .map(e => ({
      callerId: e.callerId,
      name: e.name,
      calls: e.calls,
      gotIn: e.gotIn,
      hitRate: e.calls > 0 ? e.gotIn / e.calls : 0,
      avgMulti: e.multCount > 0 ? e.multSum / e.multCount : null,
    }));

  const best = [...rows].sort((a, b) => b.hitRate - a.hitRate || b.calls - a.calls).slice(0, limit);
  const cold = rows
    .filter(r => r.calls >= minColdCalls)
    .sort((a, b) => a.hitRate - b.hitRate || b.calls - a.calls)
    .slice(0, limit);

  return { best, cold, excludedCalls };
}

module.exports = { computeCallerStats };
