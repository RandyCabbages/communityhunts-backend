// communityhunts-backend/lib/userStatsSlice.js
// Reduces a list of per-hunt details (userStatsHunt.perHunt) into ONE stat slice: tiles, charts,
// records, per-currency and USD money, top slots and top callers.
//
// This is the whole of the old computeUserHuntStats loop, unchanged, with the per-hunt math lifted
// out. It is now run three times — over all hunts, host-only and joined-only — which is the point:
// the host slice and the combined slice are the same code over different inputs, so they cannot
// disagree.
const { isoWeek, multBucket } = require('./userStatsHunt');

const BUCKETS = ['<1x', '1–5x', '5–20x', '20–100x', '100x+'];

// bySlot/byCaller were unbounded. The UI shows five; the blob is cached as JSONB per user and is
// now written three times over (one per slice), so they get a cap. 25 leaves room for a deeper
// table later without the row growing with a user's lifetime slot variety.
const LIST_CAP = 25;

function aggregate(details, { includePastHunts = false, listCap = LIST_CAP } = {}) {
  const histo = Object.fromEntries(BUCKETS.map(b => [b, 0]));
  const activityMap = new Map();
  let wagered = 0, won = 0, wins = 0, multSum = 0, multN = 0, hosted = 0, joined = 0, potSum = 0;
  let biggestWin = 0, highestMult = 0;
  let bestHuntNet = 0, worstHuntNet = 0, netSeen = false;   // USD-normalized net extremes
  const pastHunts = [];
  const profitByPeriod = new Map();
  const curMap = new Map();   // code -> { hunts, wagered, won, net, potSum, invested, returned }
  let usdWagered = 0, usdWon = 0, usdNet = 0, usdStartSum = 0, usdConv = 0, usdUnconv = 0;
  let usdInvested = 0, usdReturned = 0;
  const slotMap = new Map();      // slot -> { hunts, bet, win }
  const callerAll = new Map();    // caller -> { bet, win }

  for (const d of details) {
    const { hunt: h, bonuses, isOwner, hw, hn, pot, invested, returned, result, rate, code } = d;

    if (isOwner) hosted++; else joined++;

    const cc = curMap.get(code) || { hunts: 0, wagered: 0, won: 0, net: 0, potSum: 0, invested: 0, returned: 0 };
    cc.hunts++; cc.wagered += hw; cc.won += returned; cc.net += result; cc.potSum += pot;
    cc.invested += invested; cc.returned += returned;
    curMap.set(code, cc);

    if (rate != null) {
      usdWagered += hw * rate; usdWon += returned * rate; usdNet += result * rate;
      usdInvested += invested * rate; usdReturned += returned * rate;
      usdStartSum += pot * rate; usdConv++;
      const rnet = result * rate;   // USD-normalized hunt net for best/worst records
      if (!netSeen) { bestHuntNet = rnet; worstHuntNet = rnet; netSeen = true; }
      else { if (rnet > bestHuntNet) bestHuntNet = rnet; if (rnet < worstHuntNet) worstHuntNet = rnet; }
    } else {
      usdUnconv++;
    }

    // Per-slot and per-caller aggregation, USD-normalized (skip hunts with no FX rate).
    // bet/win are scaled by the hunt's rate; the x ratio (win/bet) is unaffected by scaling.
    if (rate != null) {
      const seenSlots = new Set();
      for (const b of bonuses) {
        const bet = (Number(b.bet) || 0) * rate;
        const win = (Number(b.win) || 0) * rate;
        const slot = String(b.slot || '').trim();
        if (slot) {
          const sm = slotMap.get(slot) || { hunts: 0, bet: 0, win: 0 };
          if (!seenSlots.has(slot)) { sm.hunts++; seenSlots.add(slot); }
          sm.bet += bet; sm.win += win;
          slotMap.set(slot, sm);
        }
        const caller = String(b.caller || '').trim();
        if (caller) {
          const cm = callerAll.get(caller) || { bet: 0, win: 0 };
          cm.bet += bet; cm.win += win;
          callerAll.set(caller, cm);
        }
      }
    }

    // Tiles + histogram. `won` is the user's share-adjusted return; a win is a positive net.
    wagered += hw; won += returned; potSum += pot;
    if (result > 0) wins++;
    for (const b of bonuses) {
      const m = Number(b.mult) || 0; histo[multBucket(m)]++; multSum += m; multN++;
      if (m > highestMult) highestMult = m;                        // native multiplier (currency-agnostic)
      if (rate != null) {                                          // USD-normalized; skip unconverted hunts
        const w = (Number(b.win) || 0) * rate; if (w > biggestWin) biggestWin = w;
      }
    }

    const period = d.when ? isoWeek(d.when) : 'unknown';
    activityMap.set(period, (activityMap.get(period) || 0) + 1);
    if (rate != null) profitByPeriod.set(period, (profitByPeriod.get(period) || 0) + result * rate);

    // Per-hunt row: the user's OWN money, USD-normalized where a rate exists (else native).
    const usdRow = rate != null;
    pastHunts.push({
      huntId: h.huntId || h.id,
      // Durable address for the admin fix/delete tool. MUST match statsStore.huntKey.
      huntKey: h.huntId || `${h.user?.id}|${h.startedAt}`,
      srcCurrency: h.currency || 'USD',   // stored currency (display `currency` is USD-normalized)
      date: d.when, huntType: h.huntType || null,
      role: isOwner ? 'host' : 'member', slots: bonuses.length,
      currency: usdRow ? 'USD' : (h.currency || 'USD'),
      startBalance: usdRow ? invested * rate : invested,
      endBalance: usdRow ? returned * rate : returned,
      result: usdRow ? result * rate : result,
      reqX: d.reqX, avgX: d.avgX, bestCaller: d.bestCaller, worstCaller: d.worstCaller,
    });
  }

  pastHunts.sort((a, b) => new Date(b.date) - new Date(a.date));

  // Streaks are currency-agnostic (rate > 0 preserves the sign of result), so they run on the
  // per-hunt row result in chronological order. Net extremes are USD-normalized in the main loop.
  const chron = [...pastHunts].sort((a, b) => new Date(a.date) - new Date(b.date));
  let wStreak = 0, lStreak = 0, wRun = 0, lRun = 0;
  for (const h of chron) {
    if (h.result > 0) { wRun++; lRun = 0; } else { lRun++; wRun = 0; }
    if (wRun > wStreak) wStreak = wRun;
    if (lRun > lStreak) lStreak = lRun;
  }

  const activity = [...activityMap.entries()].sort().map(([period, count]) => ({ period, count }));
  let running = 0;
  const profit = [...profitByPeriod.entries()].sort().map(([period, n]) => { running += n; return { period, net: running }; });

  const byCurrency = {};
  for (const [code, c] of curMap) byCurrency[code] = {
    hunts: c.hunts, wagered: c.wagered, won: c.won, net: c.net,
    avgStart: c.hunts ? c.potSum / c.hunts : 0,
    invested: c.invested, returned: c.returned,
    roi: c.invested > 0 ? c.net / c.invested : null,
  };
  const usd = {
    wagered: usdWagered, won: usdWon, net: usdNet,
    avgStart: usdConv ? usdStartSum / usdConv : 0,
    unconvertedCount: usdUnconv,
    invested: usdInvested, returned: usdReturned,
    roi: usdInvested > 0 ? usdNet / usdInvested : null,
  };

  const bySlot = [...slotMap.entries()]
    .map(([slot, v]) => ({ slot, hunts: v.hunts, bet: v.bet, win: v.win, x: v.bet > 0 ? v.win / v.bet : 0 }))
    .sort((a, b) => b.win - a.win)
    .slice(0, listCap);
  const byCaller = [...callerAll.entries()]
    .filter(([, v]) => v.bet > 0)
    .map(([caller, v]) => ({ caller, bet: v.bet, win: v.win, x: v.win / v.bet }))
    .sort((a, b) => b.x - a.x)
    .slice(0, listCap);

  const slice = {
    tiles: {
      hunts: details.length,
      hosted, joined,
      winRate: details.length ? wins / details.length : 0,
      wagered, won,
      avgStart: details.length ? potSum / details.length : 0,
      avgMult: multN ? multSum / multN : 0,
    },
    activity, profit,
    multHistogram: BUCKETS.map(b => ({ bucket: b, count: histo[b] })),
    records: {
      biggestWin, highestMult,
      bestHuntNet, worstHuntNet, longestWinStreak: wStreak, longestLossStreak: lStreak,
    },
    byCurrency, usd,
    bySlot, byCaller,
  };
  // Only the combined slice carries the table — every row already has `role`, so the host and
  // joined views filter it client-side rather than the blob storing it three times.
  if (includePastHunts) slice.pastHunts = pastHunts;
  return slice;
}

module.exports = { aggregate, BUCKETS, LIST_CAP };
