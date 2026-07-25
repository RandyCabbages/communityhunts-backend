// communityhunts-backend/lib/featureGrants.js
// Per-user feature grants — Discord IDs granted access to a gated feature (e.g. 'full_extension').
// Mirrors lib/admins.js: DB table + in-memory cache, DI-safe (no-ops with no DB).
let pgPool = null;
// feature_key -> Map<discord_id, granted_by>. granted_by is kept (not just membership) because
// it is the ONLY thing separating a paying $5/mo Stripe subscriber ('stripe-sub') from a free
// admin comp — both are one row in this table. lib/features.js reports them as distinct sources.
let cache = new Map();

async function initFeatureGrants(deps) {
  pgPool = deps.pgPool;
  cache = new Map();
  if (!pgPool) { console.log('[grants] no DB — feature grants disabled'); return; }
  try {
    await pgPool.query(`
      CREATE TABLE IF NOT EXISTS feature_grants (
        discord_id  TEXT NOT NULL,
        feature_key TEXT NOT NULL,
        granted_by  TEXT,
        granted_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (discord_id, feature_key)
      )`);
    await reloadGrantCache();
    console.log(`[grants] loaded grants for ${cache.size} feature(s)`);
  } catch (e) { console.error('[grants] init failed:', e.message); }
}

async function reloadGrantCache() {
  if (!pgPool) return;
  try {
    const r = await pgPool.query('SELECT discord_id, feature_key, granted_by FROM feature_grants');
    const next = new Map();
    for (const row of r.rows) {
      const key = String(row.feature_key);
      if (!next.has(key)) next.set(key, new Map());
      next.get(key).set(String(row.discord_id), row.granted_by == null ? null : String(row.granted_by));
    }
    cache = next;
  } catch (e) { console.error('[grants] reload failed:', e.message); }
}

function hasGrant(userId, key) {
  return !!(userId && cache.get(key)?.has(String(userId)));
}
// Who granted it — 'stripe-sub' for a paid subscription, an admin's Discord id or 'grandfather'
// otherwise. null when there is no grant OR the row predates granted_by being recorded.
function grantedBy(userId, key) {
  if (!userId) return null;
  return cache.get(key)?.get(String(userId)) ?? null;
}
function getGrantsForUser(userId) {
  if (!userId) return [];
  const id = String(userId);
  return [...cache.entries()].filter(([, byUser]) => byUser.has(id)).map(([key]) => key);
}
async function listGrants(key) {
  if (!pgPool) return [];
  try {
    const r = await pgPool.query(
      'SELECT discord_id, granted_by, granted_at FROM feature_grants WHERE feature_key=$1 ORDER BY granted_at ASC', [key]);
    return r.rows.map(row => ({ discordId: row.discord_id, grantedBy: row.granted_by, grantedAt: row.granted_at }));
  } catch (e) { console.error('[grants] list failed:', e.message); return []; }
}
async function addGrant(userId, key, grantedBy) {
  if (!pgPool || !userId || !key) return;
  try {
    await pgPool.query(
      `INSERT INTO feature_grants (discord_id, feature_key, granted_by) VALUES ($1,$2,$3)
       ON CONFLICT (discord_id, feature_key) DO NOTHING`,
      [String(userId), String(key), grantedBy ? String(grantedBy) : null]);
    await reloadGrantCache();
  } catch (e) { console.error('[grants] add failed:', e.message); throw e; }
}
async function removeGrant(userId, key) {
  if (!pgPool || !userId || !key) return;
  try {
    await pgPool.query('DELETE FROM feature_grants WHERE discord_id=$1 AND feature_key=$2', [String(userId), String(key)]);
    await reloadGrantCache();
  } catch (e) { console.error('[grants] remove failed:', e.message); throw e; }
}

// One-time grandfather backfill: grant `key` to every known user so a later
// entitlement gate doesn't cut existing users off. Idempotent (ON CONFLICT).
// Returns how many new rows were inserted.
async function grandfatherGrant(key, grantedBy) {
  if (!pgPool || !key) return 0;
  try {
    const r = await pgPool.query(
      `INSERT INTO feature_grants (discord_id, feature_key, granted_by)
       SELECT user_id, $1, $2 FROM known_users
       ON CONFLICT (discord_id, feature_key) DO NOTHING`,
      [String(key), grantedBy ? String(grantedBy) : 'grandfather']);
    await reloadGrantCache();
    return r.rowCount || 0;
  } catch (e) { console.error('[grants] grandfather failed:', e.message); throw e; }
}

module.exports = {
  initFeatureGrants, reloadGrantCache, hasGrant, grantedBy, getGrantsForUser,
  listGrants, addGrant, removeGrant, grandfatherGrant,
};
