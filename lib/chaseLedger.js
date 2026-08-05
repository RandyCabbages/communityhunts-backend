/* ── Post-hunt chase ledger (CommonJS port). ──
   MUST stay behaviourally identical to communityhunts-frontend/src/hunt/chaseLedger.js.
   Pinned by lib/__fixtures__/chaseLedgerGolden.json (copied from the frontend). */

const { computeGiftResults, applyPayoutGifts } = require('./giftLedger');

const round2 = n => Math.round(((Number(n) || 0) + Number.EPSILON) * 100) / 100;

function allocate(amount, ids, weightFn) {
  const weights = ids.map(id => Math.max(0, Number(weightFn(id)) || 0));
  const totalW = weights.reduce((s, w) => s + w, 0);
  let shares;
  if (totalW <= 0) {
    const each = round2(amount / ids.length);
    shares = ids.map(() => each);
  } else {
    shares = weights.map(w => round2(amount * w / totalW));
  }
  const allocated = shares.reduce((s, v) => s + v, 0);
  const drift = round2(amount - allocated);
  if (drift !== 0 && shares.length) {
    let bi = 0;
    for (let i = 1; i < shares.length; i++) if (shares[i] > shares[bi]) bi = i;
    shares[bi] = round2(shares[bi] + drift);
  }
  return shares;
}

// Apply ordered chase rounds to starting balances. `equityWeights` is { id: totalEquity } and is
// used only to weight the profit share. Returns post-chase balances, per-member deposits, and a
// per-round summary for the UI's chase log.
// `equityWeights` ({ id: totalEquity }) weights the profit share only. Omitting it on a round that
// HAS recipients silently even-splits the profit; it defaults to {} purely so a legacy three-arg
// call on a recipient-less round still behaves. computePostHunt always passes it.
function applyChases(startBalances = {}, chases = [], order = null, equityWeights = {}) {
  const balances = { ...startBalances };
  const depositTotals = {};
  const rounds = [];
  const ids = order || Object.keys(startBalances);
  for (const id of ids) if (!(id in balances)) balances[id] = 0;

  const sorted = [...chases].sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
  for (const rnd of sorted) {
    const parts = Array.isArray(rnd.participants) ? rnd.participants : [];
    const pids = parts.map(p => p.id).filter(id => id in balances);
    if (!pids.length) continue;
    const depOf = {};
    for (const p of parts) depOf[p.id] = Math.max(0, Number(p.deposit) || 0);
    // Snapshot every stake BEFORE writing any balance — stakes are read off `balances`, so
    // assigning as we go would corrupt every stake computed after the first write.
    const stakes = {};
    for (const id of pids) stakes[id] = round2((balances[id] || 0) + (depOf[id] || 0));
    const stakeOf = id => stakes[id] || 0;
    const bankroll = pids.reduce((s, id) => round2(s + stakeOf(id)), 0);
    if (bankroll <= 0) continue;
    const endBalance = Math.max(0, Number(rnd.endBalance) || 0);
    const recips = (Array.isArray(rnd.recipients) ? rnd.recipients : []).filter(id => id in balances);
    const profit = round2(endBalance - bankroll);
    const shared = recips.length > 0 && profit > 0;

    if (shared) {
      // Stakes come back off the top; the surplus goes to the recipients by equity share.
      pids.forEach(id => { balances[id] = stakeOf(id); });
      // Weighted by equity share. If EVERY recipient has zero equity, `allocate` falls back to an
      // even split — deliberate: the profit has to land somewhere and dropping it would break
      // conservation. Pinned by the "all-zero-equity recipients" golden case.
      const shares = allocate(profit, recips, id => equityWeights[id] || 0);
      recips.forEach((id, i) => { balances[id] = round2((balances[id] || 0) + shares[i]); });
    } else {
      // No recipients, or nothing left to share: split the end balance among the chasers.
      // `split:'equal'` is honoured ONLY on a round with no recipients — a losing round always
      // settles in proportion to what each chaser risked.
      const weightFn = (!recips.length && rnd.split === 'equal') ? () => 1 : stakeOf;
      const shares = allocate(endBalance, pids, weightFn);
      pids.forEach((id, i) => { balances[id] = shares[i]; });
    }
    pids.forEach(id => { depositTotals[id] = round2((depositTotals[id] || 0) + (depOf[id] || 0)); });
    rounds.push({ id: rnd.id, bankroll, endBalance, profit, recipients: recips.slice(), shared });
  }
  return { balances, depositTotals, rounds };
}

function computePostHunt({ equity = [], gifts = [], chases = [], totalWon = 0 }) {
  const g = computeGiftResults({ equity, gifts, totalWon });
  const order = g.order;
  const base = {};
  const weights = {};
  for (const id of order) {
    base[id] = g.members[id].basePayout;
    weights[id] = g.members[id].totalEquity;
  }
  const { balances, depositTotals, rounds } = applyChases(base, chases, order, weights);
  const members = {};
  for (const id of order) {
    const m = g.members[id];
    members[id] = { ...m, natural: m.basePayout, postChase: balances[id], finalPayout: balances[id], depositTotal: depositTotals[id] || 0 };
  }
  applyPayoutGifts(members, order, gifts);
  for (const id of order) {
    const m = members[id];
    m.plNet = round2(m.finalPayout - m.selfInvested - m.newMoneyGiven - m.depositTotal);
  }
  return { pot: g.pot, multiplier: g.multiplier, order, rounds, members };
}

module.exports = { applyChases, computePostHunt };
