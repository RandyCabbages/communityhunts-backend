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

function applyChases(startBalances = {}, chases = [], order = null) {
  const balances = { ...startBalances };
  const depositTotals = {};
  const ids = order || Object.keys(startBalances);
  for (const id of ids) if (!(id in balances)) balances[id] = 0;

  const sorted = [...chases].sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
  for (const rnd of sorted) {
    const parts = Array.isArray(rnd.participants) ? rnd.participants : [];
    const pids = parts.map(p => p.id).filter(id => id in balances);
    if (!pids.length) continue;
    const depOf = {};
    for (const p of parts) depOf[p.id] = Math.max(0, Number(p.deposit) || 0);
    const stakeOf = id => round2((balances[id] || 0) + (depOf[id] || 0));
    const bankroll = pids.reduce((s, id) => round2(s + stakeOf(id)), 0);
    if (bankroll <= 0) continue;
    const endBalance = Math.max(0, Number(rnd.endBalance) || 0);
    // 'equal' → even split among participants; default → weighted by stake (current balance + deposit).
    const weightFn = rnd.split === 'equal' ? () => 1 : stakeOf;
    const shares = allocate(endBalance, pids, weightFn);
    pids.forEach((id, i) => {
      balances[id] = shares[i];
      depositTotals[id] = round2((depositTotals[id] || 0) + (depOf[id] || 0));
    });
  }
  return { balances, depositTotals };
}

function computePostHunt({ equity = [], gifts = [], chases = [], totalWon = 0 }) {
  const g = computeGiftResults({ equity, gifts, totalWon });
  const order = g.order;
  const base = {};
  for (const id of order) base[id] = g.members[id].basePayout;
  const { balances, depositTotals } = applyChases(base, chases, order);
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
  return { pot: g.pot, multiplier: g.multiplier, order, members };
}

module.exports = { applyChases, computePostHunt };
