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
const FAME_PAGE_DEFAULT = 24;
const FAME_PAGE_MAX = 50;

function collectHallOfFame(hunts, archive, tenantId, { isAnon = () => false } = {}) {
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
      const anon = isAnon({ discordId: h.user.id, name: h.user.displayName });
      out.push({
        slot: b.slot || 'Unknown', bet, win, mult: +mult.toFixed(2),
        // Legacy hunts predate currency tracking; USD is the same fallback used by
        // hunts-core.js and the frontend's `hunt.currency || 'USD'`.
        currency: h.currency || 'USD',
        userId: h.user.id,
        username: anon ? 'Anonymous' : h.user.displayName,
        avatar: anon ? null : h.user.avatar,
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

// Page a collectHallOfFame() list for GET /api/hall-of-fame/all. Inputs are untrusted
// query-string values, so every bad shape (garbage, NaN, negative, 0, object) falls back
// to the default rather than erroring. `total` is the FULL set — the client needs it to
// render "N more" and to know when to stop.
function pageHallOfFame(list, { limit, offset } = {}) {
  const int = (v) => {
    const n = typeof v === 'string' || typeof v === 'number' ? Math.floor(Number(v)) : NaN;
    return Number.isFinite(n) ? n : NaN;
  };
  const l = int(limit);
  const o = int(offset);
  const safeLimit = Number.isFinite(l) && l >= 1 ? Math.min(l, FAME_PAGE_MAX) : FAME_PAGE_DEFAULT;
  const safeOffset = Number.isFinite(o) && o >= 0 ? o : 0;
  return {
    items: list.slice(safeOffset, safeOffset + safeLimit),
    total: list.length,
    offset: safeOffset,
    limit: safeLimit,
  };
}

module.exports = {
  collectHallOfFame, pageHallOfFame,
  FAME_MIN_MULT, FAME_CAP, FAME_PAGE_DEFAULT, FAME_PAGE_MAX,
};
