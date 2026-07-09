// communityhunts-backend/lib/featureGrants.js
// Per-user feature grants — Discord IDs granted access to a gated feature (e.g. 'shop').
// Mirrors lib/admins.js: DB table + in-memory cache, DI-safe (no-ops with no DB).
let pgPool = null;
let cache = new Map(); // feature_key -> Set<discord_id>

const SEED_GRANTS = [{ userId: '461011508713750540', key: 'shop' }]; // Jeter — migrated off hardcoded roles.js

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
    for (const g of SEED_GRANTS) {
      await pgPool.query(
        `INSERT INTO feature_grants (discord_id, feature_key, granted_by) VALUES ($1,$2,$3)
         ON CONFLICT (discord_id, feature_key) DO NOTHING`,
        [g.userId, g.key, 'seed']);
    }
    await reloadGrantCache();
    console.log(`[grants] loaded grants for ${cache.size} feature(s)`);
  } catch (e) { console.error('[grants] init failed:', e.message); }
}

async function reloadGrantCache() {
  if (!pgPool) return;
  try {
    const r = await pgPool.query('SELECT discord_id, feature_key FROM feature_grants');
    const next = new Map();
    for (const row of r.rows) {
      const key = String(row.feature_key);
      if (!next.has(key)) next.set(key, new Set());
      next.get(key).add(String(row.discord_id));
    }
    cache = next;
  } catch (e) { console.error('[grants] reload failed:', e.message); }
}

function hasGrant(userId, key) {
  return !!(userId && cache.get(key)?.has(String(userId)));
}
function getGrantsForUser(userId) {
  if (!userId) return [];
  const id = String(userId);
  return [...cache.entries()].filter(([, set]) => set.has(id)).map(([key]) => key);
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
  initFeatureGrants, reloadGrantCache, hasGrant, getGrantsForUser,
  listGrants, addGrant, removeGrant, grandfatherGrant, SEED_GRANTS,
};
