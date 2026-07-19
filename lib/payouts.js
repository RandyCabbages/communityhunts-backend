/* ── Payout tracking wire-format contract ──
   hunt.payouts = { [memberId]: { status, amount, at, by, note } }
   An ABSENT key means Pending (unresolved). Only 'paid' / 'notpaid' are persisted.
   Client input is untrusted: keep known keys only, coerce types, clamp the note. */

const NOTE_MAX = 280;
const ID_MAX = 64;
const STATUSES = new Set(['paid', 'notpaid']);

function sanitizePayouts(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out = {};
  for (const [id, v] of Object.entries(raw)) {
    if (typeof id !== 'string' || !id || id.length > ID_MAX) continue;
    if (!v || typeof v !== 'object' || Array.isArray(v)) continue;
    if (!STATUSES.has(v.status)) continue;
    const amount = Number(v.amount);
    const at = Number(v.at);
    out[id] = {
      status: v.status,
      amount: Number.isFinite(amount) ? amount : 0,
      at: Number.isFinite(at) ? at : 0,
      by: typeof v.by === 'string' ? v.by.slice(0, ID_MAX) : '',
      note: typeof v.note === 'string' ? v.note.slice(0, NOTE_MAX) : '',
    };
  }
  return out;
}

module.exports = { sanitizePayouts, NOTE_MAX };
