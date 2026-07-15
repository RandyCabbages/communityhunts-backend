// Selection logic for GET /api/hall-of-fame: the all-time biggest hits that carry
// a watchable replay (mult >= FAME_MIN_MULT AND an http(s) replayUrl).
// Deliberately separate from /api/bangers, which is a recency rail (newest-first,
// 2-per-user diversity cap, 24-window) — under those rules an old record hit falls
// out. Here: multiplier-descending, NO per-user cap (records are records).
// Returns the FULL eligible list — truncation belongs to the caller: the hub route
// slices to FAME_CAP, the /all route pages with limit/offset (routes/misc.routes.js).
// replayUrl is sanitized at write time (sanitizeBonusReplayUrls, lib/hunts-core.js);
// the regex check here is defense-in-depth for pre-sanitizer rows.

const FAME_MIN_MULT = 300;
const FAME_CAP = 12;

function collectHallOfFame(hunts, archive, tenantId) {
  const out = [], seen = new Set();
  const tid = tenantId || 'bean';
  const collect = (h, live) => {
    if (!h || !h.user || !Array.isArray(h.bonuses)) return;
    if ((h.tenantId || 'bean') !== tid) return;
    const at = h.archivedAt || h.startedAt || null;
    for (const b of h.bonuses) {
      const bet = +b.bet || 0, win = +b.win || 0;
      if (bet <= 0 || win <= 0) continue;
      const mult = win / bet;
      if (mult < FAME_MIN_MULT) continue;
      const replayUrl = typeof b.replayUrl === 'string' ? b.replayUrl.trim() : '';
      if (!/^https?:\/\//i.test(replayUrl)) continue;
      const key = `${h.user.id}|${(b.slot || '').toLowerCase()}|${bet}|${win}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        slot: b.slot || 'Unknown', bet, win, mult: +mult.toFixed(2),
        userId: h.user.id, username: h.user.displayName, avatar: h.user.avatar,
        huntType: h.huntType || 'community', live: !!live,
        at, archivedAt: h.archivedAt || null, replayUrl,
      });
    }
  };
  // Live hunts first so their fresher copy wins the dedupe over an archived snapshot.
  Object.values(hunts).forEach(h => { if (h.isLive) collect(h, true); });
  archive.forEach(h => collect(h, false));
  out.sort((a, b) => {
    if (b.mult !== a.mult) return b.mult - a.mult;
    const ta = a.at ? new Date(a.at).getTime() : 0;
    const tb = b.at ? new Date(b.at).getTime() : 0;
    return tb - ta; // tiebreak: newer first
  });
  return out;
}

module.exports = { collectHallOfFame, FAME_MIN_MULT, FAME_CAP };
