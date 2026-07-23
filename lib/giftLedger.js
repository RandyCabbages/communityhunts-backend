/* ── Gift ledger — pure equity/payout math (CommonJS port). ──
   MUST stay behaviourally identical to communityhunts-frontend/src/hunt/giftLedger.js.
   Pinned by lib/__fixtures__/giftLedgerGolden.json (copied from the frontend). */

const round2 = n => Math.round(((Number(n) || 0) + Number.EPSILON) * 100) / 100;

// Allocate `amount` across recipientIds weighted by weightFn(id).
// Cent drift is assigned to the recipient with the largest share so Σ shares === amount.
function allocate(amount, recipientIds, weightFn) {
  const weights = recipientIds.map(id => Math.max(0, Number(weightFn(id)) || 0));
  const totalW = weights.reduce((s, w) => s + w, 0);
  let shares;
  if (totalW <= 0) {
    const each = round2(amount / recipientIds.length);
    shares = recipientIds.map(() => each);
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

// Payout gifts move realized dollars AFTER the multiplier. Extracted so the post-hunt chase
// layer can re-apply give-backs on top of post-chase balances. Mutates members[id].finalPayout.
function applyPayoutGifts(members, order, gifts = []) {
  const sorted = [...gifts]
    .filter(g => g.type === 'payout')
    .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
  for (const g of sorted) {
    const excl = new Set([g.funderId, ...((g.excludeIds) || [])]);
    const recips = order.filter(id => !excl.has(id) && members[id] && members[id].name);
    if (!recips.length || !(Number(g.amount) > 0)) continue;
    const weightFn = g.split === 'equal' ? () => 1 : id => members[id].totalEquity;
    const shares = allocate(Number(g.amount), recips, weightFn);
    recips.forEach((id, i) => { members[id].finalPayout = round2(members[id].finalPayout + shares[i]); });
    if (members[g.funderId]) members[g.funderId].finalPayout = round2(members[g.funderId].finalPayout - Number(g.amount));
  }
  return members;
}

function computeGiftResults({ equity = [], gifts = [], totalWon = 0 }) {
  const members = {};
  const order = [];
  for (const e of equity) {
    members[e.id] = {
      id: e.id, name: e.name || '',
      selfInvested: Number(e.amount) || 0,
      totalEquity: Number(e.amount) || 0,
      newMoneyGiven: 0,
      basePayout: 0, finalPayout: 0, plNet: 0,
    };
    order.push(e.id);
  }
  const sorted = [...gifts].sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));

  const recipientsFor = g => {
    const excl = new Set([g.funderId, ...((g.excludeIds) || [])]);
    return order.filter(id => !excl.has(id) && members[id].name);
  };
  const weightFor = g => (g.split === 'equal' ? () => 1 : id => members[id].totalEquity);

  // Pass 1 — equity gifts adjust total equity (rides the multiplier).
  for (const g of sorted) {
    if (g.type !== 'equity') continue;
    const recips = recipientsFor(g);
    if (!recips.length || !(Number(g.amount) > 0)) continue;
    const shares = allocate(Number(g.amount), recips, weightFor(g));
    recips.forEach((id, i) => { members[id].totalEquity = round2(members[id].totalEquity + shares[i]); });
    if (members[g.funderId]) {
      if (g.fromStake) members[g.funderId].totalEquity = round2(members[g.funderId].totalEquity - Number(g.amount));
      else members[g.funderId].newMoneyGiven = round2(members[g.funderId].newMoneyGiven + Number(g.amount));
    }
  }

  let pot = 0;
  for (const id of order) pot = round2(pot + members[id].totalEquity);
  const multiplier = pot > 0 ? totalWon / pot : 0;

  // Pass 2 — base payout from equity share, with cent-drift correction so Σ === totalWon.
  for (const id of order) {
    members[id].basePayout = pot > 0 ? round2(members[id].totalEquity / pot * totalWon) : 0;
  }
  let allocated = 0;
  for (const id of order) allocated = round2(allocated + members[id].basePayout);
  const drift = round2(totalWon - allocated);
  if (drift !== 0 && order.length) {
    let bid = order[0];
    for (const id of order) if (members[id].totalEquity > members[bid].totalEquity) bid = id;
    members[bid].basePayout = round2(members[bid].basePayout + drift);
  }
  for (const id of order) members[id].finalPayout = members[id].basePayout;

  // Pass 3 — payout gifts move realized dollars AFTER the multiplier.
  applyPayoutGifts(members, order, sorted);

  for (const id of order) {
    const m = members[id];
    m.plNet = round2(m.finalPayout - m.selfInvested - m.newMoneyGiven);
  }
  return { pot, multiplier, order, members };
}

module.exports = { computeGiftResults, applyPayoutGifts };
