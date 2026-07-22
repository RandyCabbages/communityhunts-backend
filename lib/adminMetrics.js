// Aggregations backing GET /api/admin/metrics/overview (the admin Mission Control dashboard).
//
// MONEY NEVER CROSSES CURRENCIES. Hunts are grouped by hunt.currency first (legacy untagged
// rows count as USD, matching getHuntStats in hunts-core.js) and every money figure below is
// computed within ONE currency group. The frontend picks the group with a currency selector.
// Summing a mixed board would repeat the bug the ProofBand USD normalization had to fix —
// on this platform ARS rows dominate the count while contributing a fraction of the value.
//
// Pure: `now` is injected, never read from the clock, so the buckets are testable.

const { computeCallerStats } = require('./callerStats');

const HOUR = 3600 * 1000;
const norm = (s) => String(s || '').trim().toLowerCase();

function groupHuntsByCurrency(hunts) {
  const g = new Map();
  for (const h of hunts || []) {
    const code = h?.currency || 'USD';
    if (!g.has(code)) g.set(code, []);
    g.get(code).push(h);
  }
  return g;
}

function computeOverviewMetrics(hunts, { now, rangeMs = null, limit = 6, currency = 'USD' } = {}) {
  const list = hunts || [];
  const from = rangeMs == null ? -Infinity : now - rangeMs;
  const inRange = (ts) => ts != null && ts >= from && ts <= now;

  let liveHunts = 0, nearBreakEven = 0, bonusesOpened = 0, wagered = 0, calls = 0;
  const games = new Map();  // normalized slot -> { name, opens, bestMulti }
  const wins = [];
  // Bucket 23 is the CURRENT hour; bucket 0 is 23 hours ago. `yesterday` is the 24h before that.
  const today = new Array(24).fill(0);
  const yesterday = new Array(24).fill(0);

  for (const h of list) {
    const isLive = !!h?.isLive && !h?.archivedAt;
    if (isLive) {
      liveHunts++;
      const pot = (h.equity || []).reduce((s, e) => s + (Number(e?.amount) || 0), 0);
      const won = (h.bonuses || []).reduce((s, b) => s + (Number(b?.win) || 0), 0);
      // "Near break-even": recovered >= 80% of the start cost but not yet all of it.
      if (pot > 0 && won < pot && won / pot >= 0.8) nearBreakEven++;
    }

    for (const c of h?.calls || []) if (c) calls++;

    for (const b of h?.bonuses || []) {
      if (!b) continue;
      const ts = Number(b.ts) || null;
      const bet = Number(b.bet) || 0;
      const win = Number(b.win) || 0;

      // The activity chart is a fixed live 48h window — it ignores the selected range.
      if (ts != null) {
        const agoH = Math.floor((now - ts) / HOUR);
        if (agoH >= 0 && agoH < 24) today[23 - agoH]++;
        else if (agoH >= 24 && agoH < 48) yesterday[23 - (agoH - 24)]++;
      }

      if (!inRange(ts)) continue;
      wagered += bet;
      if (win > 0) {
        bonusesOpened++;
        const key = norm(b.slot);
        if (key) {
          const g = games.get(key) || { name: String(b.slot || '').trim(), opens: 0, bestMulti: 0 };
          g.opens++;
          if (bet > 0 && win / bet > g.bestMulti) g.bestMulti = win / bet;
          games.set(key, g);
        }
        wins.push({
          slot: String(b.slot || '').trim(),
          mult: bet > 0 ? win / bet : 0,
          win,
          hunter: h?.user?.displayName || null,
        });
      }
    }
  }

  const rangedHunts = rangeMs == null ? list : list.map(h => ({
    ...h,
    calls: (h?.calls || []),
    bonuses: (h?.bonuses || []).filter(b => inRange(Number(b?.ts) || null)),
  }));

  return {
    kpis: { liveHunts, nearBreakEven, bonusesOpened, calls, wagered, currency },
    activity: { today, yesterday },
    topGames: [...games.values()].sort((a, b) => b.opens - a.opens).slice(0, limit),
    biggestWins: wins.sort((a, b) => b.mult - a.mult).slice(0, 12),
    callers: computeCallerStats(rangedHunts, { minColdCalls: 15, limit: 5 }),
  };
}

module.exports = { computeOverviewMetrics, groupHuntsByCurrency };
