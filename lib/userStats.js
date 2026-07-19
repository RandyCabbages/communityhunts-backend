// communityhunts-backend/lib/userStats.js
// Pure per-user hunt aggregation for the admin profile. No DB, no side effects.
const { computeGiftResults } = require('./giftLedger');
const { sumVault } = require('./hunts-core');

function isoWeek(d) {
  const dt = new Date(d);
  const day = (dt.getUTCDay() + 6) % 7;
  dt.setUTCDate(dt.getUTCDate() - day + 3);
  const firstThu = new Date(Date.UTC(dt.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round(((dt - firstThu) / 86400000 - 3 + ((firstThu.getUTCDay() + 6) % 7)) / 7);
  return `${dt.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

function multBucket(m) {
  if (m < 1) return '<1x';
  if (m < 5) return '1–5x';
  if (m < 20) return '5–20x';
  if (m < 100) return '20–100x';
  return '100x+';
}

// An equity row identifies a person by `discordId` (reliable — present on newer hunts and
// stamped onto older ones by statsStore's name match). The `id` field is a per-row UUID, NOT
// a user id, so it must never be used for attribution. Fall back to `id` only for legacy/test
// rows that carry no discordId (e.g. `{ id: 'u1' }` in unit tests).
const eqUserId = (e) =>
  (e && e.discordId != null && e.discordId !== '') ? String(e.discordId) : String(e?.id);

function computeUserHuntStats(hunts, userId) {
  const id = String(userId);
  const mine = (hunts || []).filter(h =>
    String(h.user?.id) === id || (h.equity || []).some(e => eqUserId(e) === id));

  const BUCKETS = ['<1x', '1–5x', '5–20x', '20–100x', '100x+'];
  const histo = Object.fromEntries(BUCKETS.map(b => [b, 0]));
  const activityMap = new Map();
  let wagered = 0, won = 0, wins = 0, multSum = 0, multN = 0, hosted = 0, joined = 0, potSum = 0;
  let biggestWin = 0, highestMult = 0;
  let bestHuntNet = 0, worstHuntNet = 0, netSeen = false;   // USD-normalized net extremes
  const pastHunts = [];
  const profitByPeriod = new Map();
  const curMap = new Map();   // code -> { hunts, wagered, won, net, potSum }
  let usdWagered = 0, usdWon = 0, usdNet = 0, usdStartSum = 0, usdConv = 0, usdUnconv = 0;
  let usdInvested = 0, usdReturned = 0;
  const slotMap = new Map();      // slot -> { hunts, bet, win }
  const callerAll = new Map();    // caller -> { bet, win }

  for (const h of mine) {
    const bonuses = h.bonuses || [];
    const opened = bonuses.filter(b => b.win != null && b.win !== '');
    const hw = bonuses.reduce((a, b) => a + (Number(b.bet) || 0), 0);   // Σ all bets (tiles only)
    const hn = bonuses.reduce((a, b) => a + (Number(b.win) || 0), 0);   // bonus-only won — feeds avgX (multiplier), vault MUST stay excluded here
    const hnWinnings = hn + sumVault(h);   // total won incl. vault = end balance — winnings/payout site, never a multiplier numerator
    const betOpened = opened.reduce((a, b) => a + (Number(b.bet) || 0), 0);
    const pot = (h.equity || []).reduce((a, e) => a + (Number(e.amount) || 0), 0); // start balance

    const isOwner = String(h.user?.id) === id;
    if (isOwner) hosted++; else joined++;

    // Share-adjusted money: what THIS user put in and got back. Host is treated as owning the
    // whole hunt (share 1); a member gets their equity fraction of the pot and the winnings.
    let invested, returned, result;
    if (isOwner) {
      invested = pot; returned = hnWinnings;          // host owns the whole hunt (share 1); winnings incl. vault
      result = returned - invested;
    } else {
      // Gift-aware: member's own stake in, gift-aware payout out, P/L incl. any new money they gifted.
      // With no gifts this reduces exactly to the classic amount/pot × winnings.
      const gr = computeGiftResults({ equity: h.equity || [], gifts: h.gifts || [], totalWon: hnWinnings });
      const memberRowId = (h.equity || []).find(e => eqUserId(e) === id)?.id;
      const gm = (memberRowId != null) ? gr.members[memberRowId] : null;
      invested = gm ? gm.selfInvested : 0;
      returned = gm ? gm.finalPayout : 0;
      result = gm ? gm.plNet : (returned - invested);
    }

    const code = h.currency || 'USD';
    const cc = curMap.get(code) || { hunts: 0, wagered: 0, won: 0, net: 0, potSum: 0, invested: 0, returned: 0 };
    cc.hunts++; cc.wagered += hw; cc.won += returned; cc.net += result; cc.potSum += pot;
    cc.invested += invested; cc.returned += returned;
    curMap.set(code, cc);

    const rate = (typeof h.usdRate === 'number' && isFinite(h.usdRate)) ? h.usdRate : null;
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

    const reqX = pot > 0 && betOpened > 0 ? pot / betOpened : null;
    const avgX = betOpened > 0 ? hn / betOpened : null;

    // Best/worst caller (money-weighted avg X per named caller; ≥2 named callers required).
    const callerMap = new Map();
    for (const b of opened) {
      const name = String(b.caller || '').trim();
      if (!name) continue;
      const c = callerMap.get(name) || { name, bet: 0, win: 0 };
      c.bet += Number(b.bet) || 0;
      c.win += Number(b.win) || 0;
      callerMap.set(name, c);
    }
    const callers = [...callerMap.values()]
      .filter(c => c.bet > 0)
      .map(c => ({ name: c.name, x: c.win / c.bet }))
      .sort((a, b) => b.x - a.x);
    let bestCaller = null, worstCaller = null;
    if (callers.length >= 2) {
      bestCaller = { name: callers[0].name, x: callers[0].x };
      worstCaller = { name: callers[callers.length - 1].name, x: callers[callers.length - 1].x };
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

    const when = h.archivedAt || h.updatedAt || h.createdAt || h.startedAt;
    const period = when ? isoWeek(when) : 'unknown';
    activityMap.set(period, (activityMap.get(period) || 0) + 1);
    if (rate != null) profitByPeriod.set(period, (profitByPeriod.get(period) || 0) + result * rate);

    // Per-hunt row: the user's OWN money, USD-normalized where a rate exists (else native).
    const usd = rate != null;
    pastHunts.push({
      huntId: h.huntId || h.id,
      // Durable address for the admin fix/delete tool. MUST match statsStore.huntKey.
      huntKey: h.huntId || `${h.user?.id}|${h.startedAt}`,
      srcCurrency: h.currency || 'USD',   // stored currency (display `currency` is USD-normalized)
      date: when, huntType: h.huntType || null,
      role: isOwner ? 'host' : 'member', slots: bonuses.length,
      currency: usd ? 'USD' : (h.currency || 'USD'),
      startBalance: usd ? invested * rate : invested,
      endBalance: usd ? returned * rate : returned,
      result: usd ? result * rate : result,
      reqX, avgX, bestCaller, worstCaller,
    });
  }

  pastHunts.sort((a, b) => new Date(b.date) - new Date(a.date));

  // Streaks are currency-agnostic (rate > 0 preserves the sign of result), so they run on
  // native per-hunt result in chronological order. Net extremes are USD-normalized in the main loop.
  const chron = [...pastHunts].sort((a, b) => new Date(a.date) - new Date(b.date));
  let wStreak = 0, lStreak = 0, wRun = 0, lRun = 0;
  for (const h of chron) {
    if (h.result > 0) { wRun++; lRun = 0; } else { lRun++; wRun = 0; }
    if (wRun > wStreak) wStreak = wRun;
    if (lRun > lStreak) lStreak = lRun;
  }
  const records = {
    biggestWin, highestMult,
    bestHuntNet, worstHuntNet, longestWinStreak: wStreak, longestLossStreak: lStreak,
  };

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
    .sort((a, b) => b.win - a.win);
  const byCaller = [...callerAll.entries()]
    .filter(([, v]) => v.bet > 0)
    .map(([caller, v]) => ({ caller, bet: v.bet, win: v.win, x: v.win / v.bet }))
    .sort((a, b) => b.x - a.x);

  return {
    tiles: {
      hunts: mine.length,
      hosted, joined,
      winRate: mine.length ? wins / mine.length : 0,
      wagered, won,
      avgStart: mine.length ? potSum / mine.length : 0,
      avgMult: multN ? multSum / multN : 0,
    },
    activity, profit,
    multHistogram: BUCKETS.map(b => ({ bucket: b, count: histo[b] })),
    pastHunts,
    records,
    byCurrency, usd,
    bySlot, byCaller,
  };
}

module.exports = { computeUserHuntStats };
