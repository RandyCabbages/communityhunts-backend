// beanhunt-backend/lib/admins.js
// Platform admins — Discord IDs granted admin via the UI (in addition to the
// hardcoded owner and the env ADMIN_IDS). Platform admins are admin on ALL tenants.
// DI pattern (see lib/memberships.js): no-ops safely with no DB.

let pgPool = null;
let cache = new Set(); // discord_id strings

async function initAdmins(deps) {
  pgPool = deps.pgPool;
  if (!pgPool) { console.log('[admins] no DB — UI-managed platform admins disabled'); return; }
  try {
    await pgPool.query(`
      CREATE TABLE IF NOT EXISTS platform_admins (
        discord_id TEXT PRIMARY KEY,
        added_by   TEXT,
        added_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
    await reloadAdminCache();
    console.log(`[admins] loaded ${cache.size} DB platform admin(s)`);
  } catch (e) {
    console.error('[admins] init failed:', e.message);
  }
}

async function reloadAdminCache() {
  if (!pgPool) return;
  try {
    const r = await pgPool.query('SELECT discord_id FROM platform_admins');
    cache = new Set(r.rows.map(row => String(row.discord_id)));
  } catch (e) {
    console.error('[admins] reload failed:', e.message);
  }
}

function isDbAdmin(userId) { return !!userId && cache.has(String(userId)); }
function getDbAdminIds() { return [...cache]; }

async function listDbAdmins() {
  if (!pgPool) return [];
  try {
    const r = await pgPool.query(
      'SELECT discord_id, added_by, added_at FROM platform_admins ORDER BY added_at ASC');
    return r.rows.map(row => ({ discordId: row.discord_id, addedBy: row.added_by, addedAt: row.added_at }));
  } catch (e) { console.error('[admins] list failed:', e.message); return []; }
}

async function addDbAdmin(discordId, addedBy) {
  if (!pgPool || !discordId) return;
  try {
    await pgPool.query(
      `INSERT INTO platform_admins (discord_id, added_by) VALUES ($1, $2)
       ON CONFLICT (discord_id) DO NOTHING`,
      [String(discordId), addedBy ? String(addedBy) : null]);
    await reloadAdminCache();
  } catch (e) { console.error('[admins] add failed:', e.message); throw e; }
}

async function removeDbAdmin(discordId) {
  if (!pgPool || !discordId) return;
  try {
    await pgPool.query('DELETE FROM platform_admins WHERE discord_id=$1', [String(discordId)]);
    await reloadAdminCache();
  } catch (e) { console.error('[admins] remove failed:', e.message); throw e; }
}

module.exports = {
  initAdmins, reloadAdminCache, isDbAdmin, getDbAdminIds,
  listDbAdmins, addDbAdmin, removeDbAdmin,
};
