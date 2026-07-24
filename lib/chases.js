/* ── Post-hunt chase wire-format contract ──
   hunt.chases = [{ id, createdAt, endBalance, participants: [{ id, deposit }] }], applied in
   createdAt order. Client input is untrusted: keep known keys only, coerce numbers, clamp ≥ 0,
   drop rounds/participants without a member id. Mirrors lib/payouts.js.

   A member marked paid out (payouts[id].status === 'paid') is officially out of the hunt and can
   never be a chaser — the frontend hides them from the round builder, and this drops them
   defensively even if a stale/crafted payload slips one in. */

const ID_MAX = 64;
let seq = 0;
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const clampId = (v) => (typeof v === 'string' ? v.slice(0, ID_MAX) : '');
const isPaid = (payouts, id) => !!(payouts && payouts[id] && payouts[id].status === 'paid');

function sanitizeChases(raw, payouts = {}) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const r of raw) {
    if (!r || typeof r !== 'object' || Array.isArray(r)) continue;
    const parts = Array.isArray(r.participants) ? r.participants : [];
    const participants = [];
    for (const p of parts) {
      if (!p || typeof p !== 'object') continue;
      const id = clampId(p.id);
      if (!id) continue;
      if (isPaid(payouts, id)) continue;
      participants.push({ id, deposit: Math.max(0, num(p.deposit)) });
    }
    if (!participants.length) continue;
    const id = clampId(r.id);
    if (!id) continue;
    out.push({
      id,
      createdAt: Number.isFinite(Number(r.createdAt)) ? Number(r.createdAt) : Date.now(),
      endBalance: Math.max(0, num(r.endBalance)),
      participants,
    });
  }
  return out;
}

module.exports = { sanitizeChases };
