// Subscription + premium tier + payment claims persistence (Postgres-backed).
// Owns the subscriptions and payment_claims tables. Admin-managed: no payment
// processor — admin manually verifies ETH/Rainbet payment and flips the tier.

let pgPool = null;

async function initSubscriptions(deps) {
  pgPool = deps.pgPool;
  if (!pgPool) { console.log('[subscriptions] no DB — subscriptions disabled'); return; }
  try {
    await pgPool.query(`
      CREATE TABLE IF NOT EXISTS subscriptions (
        user_id     TEXT PRIMARY KEY,
        tier        TEXT NOT NULL DEFAULT 'free' CHECK (tier IN ('free','basic','pro','ultimate')),
        activated_at TIMESTAMPTZ,
        expires_at  TIMESTAMPTZ,
        activated_by TEXT
      )`);
    await pgPool.query(`
      CREATE TABLE IF NOT EXISTS payment_claims (
        id           TEXT PRIMARY KEY,
        user_id      TEXT NOT NULL,
        requested_tier TEXT NOT NULL,
        method       TEXT NOT NULL CHECK (method IN ('eth','rainbet')),
        reference    TEXT NOT NULL,
        status       TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
        reject_reason TEXT,
        created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        resolved_at  TIMESTAMPTZ,
        resolved_by  TEXT
      )`);
    console.log('[subscriptions] Postgres tables ready');
  } catch (e) {
    console.error('[subscriptions] init failed:', e.message);
  }
}

// ── Subscription CRUD ───────────────────────────────────────────

async function getSubscription(userId) {
  if (!pgPool || !userId) return null;
  try {
    const { rows } = await pgPool.query(
      'SELECT tier, activated_at AS "activatedAt", expires_at AS "expiresAt" FROM subscriptions WHERE user_id=$1',
      [userId]);
    return rows[0] || null;
  } catch (e) { console.error('[subscriptions] get failed:', e.message); return null; }
}

async function setSubscription(userId, tier, expiresAt, activatedBy) {
  if (!pgPool || !userId) return;
  try {
    await pgPool.query(`
      INSERT INTO subscriptions (user_id, tier, activated_at, expires_at, activated_by)
      VALUES ($1, $2, NOW(), $3, $4)
      ON CONFLICT (user_id) DO UPDATE SET tier=$2, activated_at=NOW(), expires_at=$3, activated_by=$4`,
      [userId, tier, expiresAt || null, activatedBy || null]);
  } catch (e) { console.error('[subscriptions] set failed:', e.message); throw e; }
}

async function listSubscriptions() {
  if (!pgPool) return [];
  try {
    const { rows } = await pgPool.query(`
      SELECT s.user_id AS "userId", s.tier, s.activated_at AS "activatedAt", s.expires_at AS "expiresAt",
             k.display_name AS "displayName"
      FROM subscriptions s
      LEFT JOIN known_users k ON k.user_id = s.user_id
      WHERE s.tier != 'free'
      ORDER BY s.activated_at DESC`);
    return rows;
  } catch (e) { console.error('[subscriptions] list failed:', e.message); return []; }
}

// ── Payment Claims ──────────────────────────────────────────────

function claimId() {
  return 'pc_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

async function createPaymentClaim(userId, requestedTier, method, reference) {
  if (!pgPool) throw new Error('No database');
  const id = claimId();
  await pgPool.query(
    `INSERT INTO payment_claims (id, user_id, requested_tier, method, reference)
     VALUES ($1, $2, $3, $4, $5)`,
    [id, userId, requestedTier, method, reference]);
  return id;
}

async function listPaymentClaims() {
  if (!pgPool) return [];
  try {
    const { rows } = await pgPool.query(`
      SELECT c.id, c.user_id AS "userId", c.requested_tier AS "requestedTier",
             c.method, c.reference, c.status, c.reject_reason AS "rejectReason",
             c.created_at AS "createdAt",
             k.display_name AS "displayName"
      FROM payment_claims c
      LEFT JOIN known_users k ON k.user_id = c.user_id
      ORDER BY c.created_at DESC
      LIMIT 200`);
    return rows;
  } catch (e) { console.error('[subscriptions] listClaims failed:', e.message); return []; }
}

async function approvePaymentClaim(claimId, adminId) {
  if (!pgPool) throw new Error('No database');
  const { rows } = await pgPool.query('SELECT * FROM payment_claims WHERE id=$1', [claimId]);
  if (!rows[0]) throw new Error('Claim not found');
  const claim = rows[0];
  if (claim.status !== 'pending') throw new Error('Claim already resolved');
  await pgPool.query(
    `UPDATE payment_claims SET status='approved', resolved_at=NOW(), resolved_by=$1 WHERE id=$2`,
    [adminId, claimId]);
  await setSubscription(claim.user_id, claim.requested_tier, null, adminId);
  return claim;
}

async function rejectPaymentClaim(claimId, adminId, reason) {
  if (!pgPool) throw new Error('No database');
  await pgPool.query(
    `UPDATE payment_claims SET status='rejected', reject_reason=$1, resolved_at=NOW(), resolved_by=$2 WHERE id=$3`,
    [reason || '', adminId, claimId]);
}

// ── Premium tier (per-tenant, stored in user_settings JSONB) ────
// Premium tier piggybacks on the existing user_settings table's JSONB
// column rather than adding a new table — it's just one more field.

async function getPremiumTier(userId) {
  if (!pgPool || !userId) return 'none';
  try {
    const { rows } = await pgPool.query(
      "SELECT settings->>'premiumTier' AS tier FROM user_settings WHERE user_id=$1",
      [userId]);
    return rows[0]?.tier || 'none';
  } catch (e) { return 'none'; }
}

module.exports = {
  initSubscriptions,
  getSubscription, setSubscription, listSubscriptions,
  createPaymentClaim, listPaymentClaims, approvePaymentClaim, rejectPaymentClaim,
  getPremiumTier,
};
