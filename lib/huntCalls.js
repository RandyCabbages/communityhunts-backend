// Adding a slot call to a hunt — the one implementation.
//
// Lifted out of routes/calls.routes.js because a second caller now needs it: the Discord bot's
// public endpoint files a checked-in winner's calls. Three rules live in here — the normalized
// duplicate check, the rolling-mode gate and the per-person call limit — and a second copy of any
// of them is how the bot and the website start disagreeing about what "already suggested" means.
// The bot deliberately has no local duplicate check at all: it cannot see a call the website
// added a second ago, so it asks.
//
// A factory over its deps, matching lib/sharedHunts.js — `normalizeSlot` and `nameOf` are
// server.js-level helpers, and the emit/feed side effects have to be injectable to test this
// without a socket server.

module.exports = function huntCalls({ normalizeSlot, nameOf, emitHuntUpdate, activityFeed }) {
  /**
   * Add one call. Mutates `hunt`; returns the new call or a refusal.
   *
   * `code` exists alongside `error` so a caller can tell a duplicate from a limit without
   * pattern-matching the English. The session routes send only `error` to the browser, so this
   * addition is invisible to them.
   */
  function addCallToHunt(hunt, user, slot, { isEditor = false, source, limitExempt = false } = {}) {
    if (!slot?.trim()) return { error: 'Slot name required', status: 400, code: 'empty' };

    // Block non-editors from adding calls when the hunt is rolling
    if (hunt.huntMode === 'rolling' && !isEditor)
      return { error: 'Cannot add calls while the hunt is rolling', status: 403, code: 'rolling' };

    // Duplicate check (normalized: "CULT" === "CULT.")
    if (hunt.calls.some(c => normalizeSlot(c.slot) === normalizeSlot(slot)))
      return { error: `"${slot}" was already suggested`, status: 400, code: 'duplicate' };

    // Per-person limit (not applied to editors/admins, or limit-exempt privileged callers)
    const callerName = nameOf(user);
    if (hunt.callLimit > 0 && !isEditor && !limitExempt) {
      const myCount = hunt.calls.filter(c => c.user.toLowerCase() === callerName).length;
      if (myCount >= hunt.callLimit)
        return { error: `You've reached the limit of ${hunt.callLimit} calls`, status: 400, code: 'limit' };
    }

    // `ts` exists so caller stats can eventually be range-filtered. Until enough history carries
    // it, lib/adminMetrics.js reports caller hit rates ALL-TIME — filtering got-ins by range while
    // the calls behind them are undateable produced a ~0% hit rate for everyone.
    const newCall = { id: Math.random().toString(36).slice(2,8), slot: slot.trim(),
      user: user.displayName||user.username, callerId: user.id ? String(user.id) : undefined,
      status: 'pending', ts: Date.now(), ...(source ? { source } : {}) };
    // New calls go to the END of the pending queue. The old "insert after first 3"
    // splice predates round-robin + the top-4 lock: it shoved every incoming call up
    // top — even INTO the locked top 4, pushing locked calls down. Queue order is the
    // frontend's job now (round-robin at render time; frozen stored order while
    // lockTop4 is on), and the host's own local add already appends to the end.
    const pendingCalls = hunt.calls.filter(c=>c.status==='pending');
    const otherCalls   = hunt.calls.filter(c=>c.status!=='pending');
    hunt.calls = [...pendingCalls, newCall, ...otherCalls];
    hunt.updatedAt = new Date().toISOString();
    emitHuntUpdate(hunt.user.id); // per-socket (persists + redacts anonymous names)
    // Admin Mission Control live feed (transient, best-effort — optional-chained so a missing
    // dep can never break a call submission).
    activityFeed?.push(hunt.tenantId || 'bean', {
      type: 'call',
      text: `${newCall.user} called ${newCall.slot}`,
      meta: { slot: newCall.slot, callerId: newCall.callerId || null },
    });
    return { ok: true, call: newCall };
  }

  return { addCallToHunt };
};
