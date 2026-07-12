// communityhunts-backend/lib/userStats.js
// Pure per-user hunt aggregation for the admin profile. No DB, no side effects.
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

function computeUserHuntStats(hunts, userId) {
  const id = String(userId);
  const mine = (hunts || []).filter(h =>
    String(h.user?.id) === id || (h.equity || []).some(e => String(e.id) === id));

  const BUCKETS = ['<1x', '1–5x', '5–20x', '20–100x', '100x+'];
  const histo = Object.fromEntries(BUCKETS.map(b => [b, 0]));
  const activityMap = new Map();
  let wagered = 0, won = 0, wins = 0, multSum = 0, multN = 0, hosted = 0, joined = 0, potSum = 0;
  let biggestWin = 0, highestMult = 0;
  const pastHunts = [];
  const profitByPeriod = new Map();
  const curMap = new Map();   // code -> { hunts, wagered, won, net, potSum }
  let usdWagered = 0, usdWon = 0, usdNet = 0, usdStartSum = 0, usdConv = 0, usdUnconv = 0;
  const slotMap = new Map();      // slot -> { hunts, bet, win }
  const callerAll = new Map();    // caller -> { bet, win }

  for (const h of mine) {
    const bonuses = h.bonuses || [];
    const opened = bonuses.filter(b => b.win != null && b.win !== '');
    const hw = bonuses.reduce((a, b) => a + (Number(b.bet) || 0), 0);   // Σ all bets (tiles only)
    const hn = bonuses.reduce((a, b) => a + (Number(b.win) || 0), 0);   // total won = end balance
    const betOpened = opened.reduce((a, b) => a + (Number(b.bet) || 0), 0);
    const pot = (h.equity || []).reduce((a, e) => a + (Number(e.amount) || 0), 0); // start balance

    const isOwner = String(h.user?.id) === id;
    if (isOwner) hosted++; else joined++;

    // Correct baseline: profit = end balance (won) − start balance (pot).
    let result = hn - pot;
    if (!isOwner) {
      const total = (h.equity || []).reduce((a, e) => a + (Number(e.amount) || 0), 0) || 1;
      const share = (Number((h.equity || []).find(e => String(e.id) === id)?.amount) || 0) / total;
      result = result * share;
    }

    const code = h.currency || 'USD';
    const cc = curMap.get(code) || { hunts: 0, wagered: 0, won: 0, net: 0, potSum: 0 };
    cc.hunts++; cc.wagered += hw; cc.won += hn; cc.net += result; cc.potSum += pot;
    curMap.set(code, cc);

    const rate = (typeof h.usdRate === 'number' && isFinite(h.usdRate)) ? h.usdRate : null;
    if (rate != null) {
      usdWagered += hw * rate; usdWon += hn * rate; usdNet += result * rate;
      usdStartSum += pot * rate; usdConv++;
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

    // Per-slot and per-caller aggregation (dedup slot-per-hunt with a local set)
    const seenSlots = new Set();
    for (const b of bonuses) {
      const slot = String(b.slot || '').trim();
      if (slot) {
        const sm = slotMap.get(slot) || { hunts: 0, bet: 0, win: 0 };
        if (!seenSlots.has(slot)) { sm.hunts++; seenSlots.add(slot); }
        sm.bet += Number(b.bet) || 0; sm.win += Number(b.win) || 0;
        slotMap.set(slot, sm);
      }
      const caller = String(b.caller || '').trim();
      if (caller) {
        const cm = callerAll.get(caller) || { bet: 0, win: 0 };
        cm.bet += Number(b.bet) || 0; cm.win += Number(b.win) || 0;
        callerAll.set(caller, cm);
      }
    }

    // Tiles + histogram (baseline shared with the per-row fix: a win is won > pot).
    wagered += hw; won += hn; potSum += pot;
    if (hn > pot) wins++;
    for (const b of bonuses) {
      const m = Number(b.mult) || 0; histo[multBucket(m)]++; multSum += m; multN++;
      const w = Number(b.win) || 0; if (w > biggestWin) biggestWin = w;
      const mm = Number(b.mult) || 0; if (mm > highestMult) highestMult = mm;
    }

    const when = h.archivedAt || h.updatedAt || h.createdAt || h.startedAt;
    const period = when ? isoWeek(when) : 'unknown';
    activityMap.set(period, (activityMap.get(period) || 0) + 1);
    profitByPeriod.set(period, (profitByPeriod.get(period) || 0) + result);

    pastHunts.push({
      huntId: h.huntId || h.id, date: when, huntType: h.huntType || null,
      role: isOwner ? 'host' : 'member', slots: bonuses.length, currency: h.currency || 'USD',
      startBalance: pot, endBalance: hn, result, reqX, avgX, bestCaller, worstCaller,
    });
  }

  pastHunts.sort((a, b) => new Date(b.date) - new Date(a.date));

  const chron = [...pastHunts].sort((a, b) => new Date(a.date) - new Date(b.date));
  let bestHuntNet = 0, worstHuntNet = 0, wStreak = 0, lStreak = 0, wRun = 0, lRun = 0;
  if (chron.length) { bestHuntNet = -Infinity; worstHuntNet = Infinity; }
  for (const h of chron) {
    if (h.result > bestHuntNet) bestHuntNet = h.result;
    if (h.result < worstHuntNet) worstHuntNet = h.result;
    if (h.result > 0) { wRun++; lRun = 0; } else { lRun++; wRun = 0; }
    if (wRun > wStreak) wStreak = wRun;
    if (lRun > lStreak) lStreak = lRun;
  }
  if (!chron.length) { bestHuntNet = 0; worstHuntNet = 0; }
  const records = {
    biggestWin, biggestWinUsd: biggestWin, highestMult,
    bestHuntNet, worstHuntNet, longestWinStreak: wStreak, longestLossStreak: lStreak,
  };

  const activity = [...activityMap.entries()].sort().map(([period, count]) => ({ period, count }));
  let running = 0;
  const profit = [...profitByPeriod.entries()].sort().map(([period, n]) => { running += n; return { period, net: running }; });

  const byCurrency = {};
  for (const [code, c] of curMap) byCurrency[code] = {
    hunts: c.hunts, wagered: c.wagered, won: c.won, net: c.net,
    avgStart: c.hunts ? c.potSum / c.hunts : 0,
  };
  const usd = {
    wagered: usdWagered, won: usdWon, net: usdNet,
    avgStart: usdConv ? usdStartSum / usdConv : 0,
    unconvertedCount: usdUnconv,
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
