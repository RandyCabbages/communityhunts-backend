/* ── Cross-hunt payout ledger — queries + slice projection ──
   Two directions over hunt_history:
     owed     — hunts the caller HOSTED   → who they still owe
     received — hunts the caller JOINED   → what they were paid

   The snapshot is the WHOLE hunt. We deliberately project a narrow slice: the
   ledger fold needs equity/gifts/bonuses/vault/payouts and nothing else, and the
   raw snapshot carries editor lists and call queues the client has no business
   receiving. Outstanding amounts are folded on the FRONTEND (giftLedger.js) —
   never duplicate that money math here. */

// The two shared hunts archive under a fixed host key instead of a real user id.
// A host_user_id equality check alone would make them permanently unresolvable.
const MOD_HUNT_KEYS = new Set(['__mod_hunt__', '__affiliate_hunt__', '__vip_hunt__']);

function projectSlice(row) {
  const s = row.snapshot || {};
  return {
    huntKey: row.hunt_key,
    endedAt: row.ended_at,
    currency: row.currency || 'USD',
    host: { id: s.user?.id ?? row.host_user_id ?? null, name: s.user?.displayName || '' },
    equity: Array.isArray(s.equity) ? s.equity : [],
    gifts: Array.isArray(s.gifts) ? s.gifts : [],
    // Native shapes so the frontend can call totalWonOf(slice) directly.
    bonuses: Array.isArray(s.bonuses) ? s.bonuses.map(b => ({ win: b?.win ?? null })) : [],
    vault: Array.isArray(s.vault) ? s.vault.map(v => ({ amount: v?.amount ?? 0 })) : [],
    payouts: (s.payouts && typeof s.payouts === 'object' && !Array.isArray(s.payouts)) ? s.payouts : {},
  };
}

// Who may resolve a payout on this hunt. Normal hunts: the host. Shared mod/affiliate
// hunts: any mod, because host_user_id is a fixed key, not a person.
function canResolveHunt({ hostUserId, callerId, isMod }) {
  const host = String(hostUserId || '');
  if (MOD_HUNT_KEYS.has(host)) return !!isMod;
  return !!host && host === String(callerId || '');
}

// ── SQL. Both are covered by existing indexes:
//   hunt_history_tenant_ended        (tenant_id, ended_at)
//   hunt_participants_tenant_user    (tenant_id, user_id)
const OWED_SQL = `
  SELECT hunt_key, ended_at, currency, host_user_id, snapshot
    FROM hunt_history
   WHERE tenant_id = $1 AND host_user_id = ANY($2)
   ORDER BY ended_at DESC`;

const RECEIVED_SQL = `
  SELECT h.hunt_key, h.ended_at, h.currency, h.host_user_id, h.snapshot
    FROM hunt_history h
    JOIN hunt_participants p ON p.hunt_key = h.hunt_key
   WHERE p.tenant_id = $1 AND p.user_id = $2 AND p.role = 'member'
   ORDER BY h.ended_at DESC`;

// hostKeys: the caller's own id, plus the shared-hunt keys when they're a mod.
function hostKeysFor(callerId, isMod) {
  return isMod ? [String(callerId), ...MOD_HUNT_KEYS] : [String(callerId)];
}

function makeLedgerQuery(pgPool) {
  async function owed(tenantId, callerId, isMod) {
    if (!pgPool) return [];
    const r = await pgPool.query(OWED_SQL, [tenantId, hostKeysFor(callerId, isMod)]);
    return r.rows.map(projectSlice);
  }
  async function received(tenantId, callerId) {
    if (!pgPool) return [];
    const r = await pgPool.query(RECEIVED_SQL, [tenantId, String(callerId)]);
    return r.rows.map(projectSlice);
  }
  async function findRow(tenantId, huntKey) {
    if (!pgPool) return null;
    const r = await pgPool.query(
      'SELECT hunt_key, host_user_id, snapshot FROM hunt_history WHERE hunt_key=$1 AND tenant_id=$2',
      [huntKey, tenantId]);
    return r.rows[0] || null;
  }
  async function writePayouts(tenantId, huntKey, payouts) {
    if (!pgPool) return;
    await pgPool.query(
      `UPDATE hunt_history SET snapshot = jsonb_set(snapshot, '{payouts}', $3::jsonb, true)
        WHERE hunt_key=$1 AND tenant_id=$2`,
      [huntKey, tenantId, JSON.stringify(payouts)]);
  }
  return { owed, received, findRow, writePayouts };
}

module.exports = { makeLedgerQuery, projectSlice, canResolveHunt, hostKeysFor, MOD_HUNT_KEYS };
