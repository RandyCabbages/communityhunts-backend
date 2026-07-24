/* ── Post-hunt chase wire-format contract ──
   hunt.chases = [{ id, createdAt, endBalance, participants: [{ id, deposit }] }], applied in
   createdAt order. Client input is untrusted: keep known keys only, coerce numbers, clamp ≥ 0,
   drop rounds/participants without a member id. Mirrors lib/payouts.js.

   A recorded chase round is SETTLED HISTORY. Marking a chaser paid out later must NOT rewrite the
   round — dropping a participant re-splits that round's end balance and silently changes everyone's
   payout (the "hit Paid → everyone's numbers moved" bug). Excluding paid members is a round-CREATION
   rule, enforced by the frontend round builder (PostHuntModal hides paid members from the picker);
   sanitize only cleans shape/types and never re-applies it to already-recorded rounds. */

const ID_MAX = 64;
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const clampId = (v) => (typeof v === 'string' ? v.slice(0, ID_MAX) : '');

function sanitizeChases(raw) {
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
