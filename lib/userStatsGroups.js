// communityhunts-backend/lib/userStatsGroups.js
// The stat groups that only make sense for ONE role, plus the calling record.
//
// `operator` answers "is this person good at RUNNING hunts" (pot size, who turns up, what they pay
// out, do they finish). `player` answers "is this person good at JOINING them" (share size, who
// they ride with, gifts, chase deposits). `calling` is their own slot calls, which is meaningful
// for either role and so is computed per slice.
//
// Money follows the same rule as everywhere else in this pipeline: USD-normalized, and a hunt with
// no FX rate is skipped rather than summed at face value.
const { huntCompleted, huntCategoryOf } = require('./hunts-core');
const { eqUserId } = require('./userStatsHunt');

const TOP_HOSTS_CAP = 10;

function hostOperator(details) {
  let potUsd = 0, potHunts = 0, paidOut = 0;
  let peopleSum = 0, slotSum = 0, completed = 0;
  let durSum = 0, durN = 0;
  let reqN = 0, beatReq = 0;
  const participants = new Set();
  const typeMix = {};

  for (const d of details) {
    const h = d.hunt;
    const rate = d.rate;

    if (rate != null) {
      potUsd += d.pot * rate; potHunts++;
      // What everyone who ISN'T the host walked away with, gift- and chase-aware.
      const hostId = String(h.user?.id ?? '');
      for (const e of (h.equity || [])) {
        if (eqUserId(e) === hostId) continue;
        const m = d.ledger.members[e.id];
        if (m) paidOut += (Number(m.finalPayout) || 0) * rate;
      }
    }

    peopleSum += d.people;
    slotSum += d.bonuses.length;
    for (const uid of d.memberIds) participants.add(uid);
    if (huntCompleted(h)) completed++;

    const started = h.startedAt ? new Date(h.startedAt).getTime() : NaN;
    const ended = h.archivedAt ? new Date(h.archivedAt).getTime() : NaN;
    if (isFinite(started) && isFinite(ended) && ended > started) { durSum += ended - started; durN++; }

    // Did the hunt clear the multiplier it needed? Only decidable where both are known.
    if (d.reqX != null && d.avgX != null) { reqN++; if (d.avgX >= d.reqX) beatReq++; }

    const cat = huntCategoryOf(h) || 'community';
    typeMix[cat] = (typeMix[cat] || 0) + 1;
  }

  const n = details.length;
  return {
    hunts: n,
    totalPot: potUsd,
    avgPot: potHunts ? potUsd / potHunts : 0,
    paidOutToMembers: paidOut,
    avgPeople: n ? peopleSum / n : 0,
    uniqueParticipants: participants.size,
    avgSlots: n ? slotSum / n : 0,
    completionRate: n ? completed / n : 0,
    avgDurationMs: durN ? durSum / durN : null,
    beatReqRate: reqN ? beatReq / reqN : null,
    beatReqHunts: reqN,
    typeMix,
  };
}

function joinedPlayer(details) {
  let shareSum = 0, shareN = 0;
  let given = 0, received = 0, deposits = 0;
  const hosts = new Map();   // hostId -> { hostId, hostName, hunts, invested, returned, net }

  for (const d of details) {
    const h = d.hunt;
    const rate = d.rate;
    const me = d.me;

    if (me && d.pot > 0) { shareSum += (Number(me.totalEquity) || 0) / d.pot; shareN++; }

    if (me && rate != null) {
      given += (Number(me.newMoneyGiven) || 0) * rate;
      // Equity handed TO them rides the multiplier, so it shows up as totalEquity above their
      // own stake. Gifts taken from their stake move the other way and are not "received".
      received += Math.max(0, (Number(me.totalEquity) || 0) - (Number(me.selfInvested) || 0)) * rate;
      deposits += (Number(me.depositTotal) || 0) * rate;
    }

    const hostId = String(h.user?.id ?? '');
    if (!hostId) continue;
    const row = hosts.get(hostId) || {
      hostId, hostName: h.user?.displayName || h.user?.username || h.user?.name || null,
      hunts: 0, invested: 0, returned: 0, net: 0,
    };
    row.hunts++;
    if (rate != null) {
      row.invested += d.invested * rate;
      row.returned += d.returned * rate;
      row.net += d.result * rate;
    }
    hosts.set(hostId, row);
  }

  const topHosts = [...hosts.values()]
    .map(r => ({ ...r, roi: r.invested > 0 ? r.net / r.invested : null }))
    .sort((a, b) => b.hunts - a.hunts || b.net - a.net)
    .slice(0, TOP_HOSTS_CAP);

  return {
    hunts: details.length,
    avgSharePct: shareN ? shareSum / shareN : null,
    giftsGiven: given, giftsReceived: received, chaseDeposits: deposits,
    topHosts,
  };
}

// Bonuses this user called, matched on the free-text `caller` field against every handle we know
// them by. Deliberately fuzzy — the host types that field — so the UI labels it as a best guess.
// `calls` counts every match; the money only counts hunts that carry an FX rate, which is why
// `unconvertedCalls` is reported alongside rather than silently folded in. Best/worst rank on the
// native multiplier, which needs no conversion at all.
function callingRecord(details, names) {
  const known = new Set((names || [])
    .map(n => String(n || '').trim().toLowerCase())
    .filter(Boolean));
  const empty = { calls: 0, unconvertedCalls: 0, bet: 0, win: 0, x: null, bestCall: null, worstCall: null, matchedNames: [] };
  if (!known.size) return empty;

  let calls = 0, unconverted = 0, bet = 0, win = 0;
  let best = null, worst = null;
  const matched = new Set();

  for (const d of details) {
    for (const b of d.opened) {
      const caller = String(b.caller || '').trim().toLowerCase();
      if (!caller || !known.has(caller)) continue;
      calls++;
      matched.add(caller);
      if (d.rate != null) {
        bet += (Number(b.bet) || 0) * d.rate;
        win += (Number(b.win) || 0) * d.rate;
      } else {
        unconverted++;
      }
      const m = Number(b.mult) || 0;
      const call = { slot: String(b.slot || '').trim() || null, mult: m, win: Number(b.win) || 0, currency: d.code, date: d.when };
      if (!best || m > best.mult) best = call;
      if (!worst || m < worst.mult) worst = call;
    }
  }

  return {
    calls, unconvertedCalls: unconverted, bet, win,
    x: bet > 0 ? win / bet : null,
    bestCall: best, worstCall: worst,
    matchedNames: [...matched],
  };
}

module.exports = { hostOperator, joinedPlayer, callingRecord, TOP_HOSTS_CAP };
