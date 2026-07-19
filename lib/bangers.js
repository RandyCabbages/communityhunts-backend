// Top recent big-multiplier wins ("bangers", >=300x) for a tenant. Extracted from
// routes/misc.routes.js so the Developer API can reuse the exact selection logic.

const BANGER_MIN_MULT = 300;

function collectBangers(hunts, archive, tenantId, opts = {}) {
  const minMult = opts.minMult ?? BANGER_MIN_MULT;
  const maxPerUser = opts.maxPerUser ?? 2;
  const cap = opts.cap ?? 24;
  const isAnon = opts.isAnon ?? (() => false);
  const tid = tenantId || 'bean';
  const out = [], seen = new Set();
  const collect = (h, live) => {
    if (!h || !h.user || !Array.isArray(h.bonuses)) return;
    if ((h.tenantId || 'bean') !== tid) return;
    const at = h.archivedAt || h.startedAt || null;
    for (const b of h.bonuses) {
      const bet = +b.bet || 0, win = +b.win || 0;
      if (bet <= 0 || win <= 0) continue;
      const mult = win / bet;
      if (mult < minMult) continue;
      const key = `${h.user.id}|${(b.slot || '').toLowerCase()}|${bet}|${win}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const anon = isAnon({ discordId: h.user.id, name: h.user.displayName });
      out.push({ slot: b.slot || 'Unknown', bet, win, mult: +mult.toFixed(2),
        userId: h.user.id,
        username: anon ? 'Anonymous' : h.user.displayName,
        avatar: anon ? null : h.user.avatar,
        huntType: h.huntType || 'community', live: !!live, at, archivedAt: h.archivedAt || null });
    }
  };
  Object.values(hunts).forEach(h => { if (h.isLive) collect(h, true); });
  archive.forEach(h => collect(h, false));
  out.sort((a, b) => {
    const ta = a.at ? new Date(a.at).getTime() : 0, tb = b.at ? new Date(b.at).getTime() : 0;
    return tb - ta || b.mult - a.mult;
  });
  const userCount = new Map(), diverse = [];
  for (const b of out) {
    const c = userCount.get(b.userId) || 0;
    if (c >= maxPerUser) continue;
    userCount.set(b.userId, c + 1);
    diverse.push(b);
    if (diverse.length >= cap) break;
  }
  return diverse;
}

module.exports = { collectBangers, BANGER_MIN_MULT };
