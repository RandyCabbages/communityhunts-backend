// Subscription persistence (Postgres-backed). Owns the subscriptions table.
// Tier changes come from Stripe webhooks (lib/stripe.js) or admin console.

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

module.exports = {
  initSubscriptions,
  getSubscription, setSubscription, listSubscriptions,
};
