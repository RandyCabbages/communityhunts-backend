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
  // `ts` is stamped by the frontend when "Got In" is pressed — it only exists on bonuses added
  // AFTER the got-in log shipped, so a large share of historical bonuses carry none. A windowed
  // range must drop those (there is no way to place them in time), but ALL TIME must not: gating
  // it on `ts != null` silently excluded every legacy bonus and made "All" a synonym for "since
  // got-in logging began" (it understated all-time ARS bet volume by ~47% on prod).
  const inRange = (ts) => rangeMs == null || (ts != null && ts >= from && ts <= now);

  let liveHunts = 0, nearBreakEven = 0, bonusesOpened = 0, calls = 0;
  let staked = 0, stakedHunts = 0, betVolume = 0;
  const games = new Map();  // normalized slot -> { name, opens, bestMulti }
  const wins = [];
  // Bucket 23 is the CURRENT hour; bucket 0 is 23 hours ago. `yesterday` is the 24h before that.
  const today = new Array(24).fill(0);
  const yesterday = new Array(24).fill(0);

  for (const h of list) {
    // The hunt's starting pot — the money actually put up to fund it. Same definition as
    // getHuntStats in hunts-core.js (sum of equity contributions); potless hunts are excluded
    // from `staked` rather than counted as a zero-cost hunt.
    const pot = (h?.equity || []).reduce((s, e) => s + (Number(e?.amount) || 0), 0);

    const isLive = !!h?.isLive && !h?.archivedAt;
    if (isLive) {
      liveHunts++;
      const won = (h.bonuses || []).reduce((s, b) => s + (Number(b?.win) || 0), 0);
      // "Near break-even": recovered >= 80% of the start cost but not yet all of it.
      if (pot > 0 && won < pot && won / pot >= 0.8) nearBreakEven++;
    }

    // `staked` buckets by when the HUNT started (not when its bonuses were collected), so the
    // range tabs read as "money put up in this window". Same all-time escape hatch as `inRange`:
    // a hunt with no parseable start can't be placed in a window, but must not vanish from All.
    const startTs = Date.parse(h?.startedAt || h?.createdAt || '');
    const startedInRange = rangeMs == null
      || (!isNaN(startTs) && startTs >= from && startTs <= now);
    if (pot > 0 && startedInRange) { staked += pot; stakedHunts++; }

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
      betVolume += bet;
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

  return {
    // `staked` replaced a KPI labelled "Wagered" that was actually `betVolume` — the sum of bonus
    // BET SIZES, which on prod ran at ~1% of the money hunts were funded with (18.4M ARS staked vs
    // 176K ARS of bet volume). Reading that as turnover next to the live-hunt cards was misleading,
    // so the pot is the headline now and betVolume stays in the payload for anyone who wants it.
    kpis: { liveHunts, nearBreakEven, bonusesOpened, calls, staked, stakedHunts, betVolume, currency },
    activity: { today, yesterday },
    topGames: [...games.values()].sort((a, b) => b.opens - a.opens).slice(0, limit),
    biggestWins: wins.sort((a, b) => b.mult - a.mult).slice(0, 12),
    // ALL-TIME, deliberately ignoring `rangeMs`. A call carries NO timestamp
    // (routes/calls.routes.js builds it with id/slot/user/callerId/status only), so it cannot be
    // range-filtered. Filtering just the bonuses left an all-time denominator against an in-range
    // numerator, which read as ~0% for everyone on the DEFAULT "Today" range even for a caller
    // with a perfect record. Reporting one honest all-time figure beats a range-shaped lie.
    // New calls now stamp `ts`; once enough history carries it this can become range-aware.
    callers: computeCallerStats(list, { minColdCalls: 15, limit: 5 }),
  };
}

module.exports = { computeOverviewMetrics, groupHuntsByCurrency };
