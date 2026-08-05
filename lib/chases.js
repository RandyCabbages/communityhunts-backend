/* ── Post-hunt chase wire-format contract ──
   hunt.chases = [{ id, createdAt, endBalance, participants: [{ id, deposit }] }], applied in
   createdAt order. Client input is untrusted: keep known keys only, coerce numbers, clamp ≥ 0,
   drop rounds/participants without a member id. Mirrors lib/payouts.js.

   A recorded chase round is SETTLED HISTORY. Marking a chaser paid out later must NOT rewrite the
   round — dropping a participant re-splits that round's end balance and silently changes everyone's
   payout (the "hit Paid → everyone's numbers moved" bug). Excluding paid members is a round-CREATION
   rule, enforced by the frontend round builder (PostHuntModal hides paid members from the picker);
   sanitize only cleans shape/types and never re-applies it to already-recorded rounds.

   `split` and `recipients` are OPTIONAL and are emitted only when they carry information, so a
   legacy round round-trips byte-identical. Both were previously absent from this rebuild, which
   meant `split:'equal'` never reached storage at all: the modal previewed the right numbers from
   local state and the stored round silently recalculated as by-stake on the next read. */

const ID_MAX = 64;
const RECIPIENTS_MAX = 200;
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
// `id in balances` in chaseLedger is true for inherited Object.prototype keys, and assigning to
// __proto__ on a plain object is a silent no-op — a round naming one as a recipient would drop the
// entire profit with no error. Real member ids are uid()-generated, Discord snowflakes, or the
// creator_auto/bean_auto literals, so none of these are reachable legitimately.
const UNSAFE_IDS = new Set(['__proto__', 'constructor', 'prototype']);
const clampId = (v) => {
  if (typeof v !== 'string') return '';
  const id = v.slice(0, ID_MAX);
  return UNSAFE_IDS.has(id) ? '' : id;
};

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
    // Recipients: who the round's profit is shared with. Deduped, empties dropped, length-capped.
    const seen = new Set();
    const recipients = [];
    for (const v of (Array.isArray(r.recipients) ? r.recipients : [])) {
      const rid = clampId(v);
      if (!rid || seen.has(rid)) continue;
      seen.add(rid);
      recipients.push(rid);
      if (recipients.length >= RECIPIENTS_MAX) break;
    }

    out.push({
      id,
      createdAt: Number.isFinite(Number(r.createdAt)) ? Number(r.createdAt) : Date.now(),
      endBalance: Math.max(0, num(r.endBalance)),
      ...(r.split === 'equal' ? { split: 'equal' } : {}),
      participants,
      ...(recipients.length ? { recipients } : {}),
    });
  }
  return out;
}

module.exports = { sanitizeChases };
