// communityhunts-backend/lib/supporters.js
// Supporters — Discord IDs manually marked as donors via the admin UI. Powers the
// "Supporter" flair badge (global, all tenants). DI pattern (see lib/admins.js):
// no-ops safely with no DB.

let pgPool = null;
let cache = new Set(); // discord_id strings

async function initSupporters(deps) {
  pgPool = deps.pgPool || null;
  if (!pgPool) { console.log('[supporters] no DB — UI-managed supporters disabled'); return; }
  try {
    await pgPool.query(`
      CREATE TABLE IF NOT EXISTS supporters (
        discord_id TEXT PRIMARY KEY,
        added_by   TEXT,
        added_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
    await reloadSupporterCache();
    console.log(`[supporters] loaded ${cache.size} supporter(s)`);
  } catch (e) {
    console.error('[supporters] init failed:', e.message);
  }
}

async function reloadSupporterCache() {
  if (!pgPool) return;
  try {
    const r = await pgPool.query('SELECT discord_id FROM supporters');
    cache = new Set(r.rows.map(row => String(row.discord_id)));
  } catch (e) {
    console.error('[supporters] reload failed:', e.message);
  }
}

function isSupporter(userId) { return !!userId && cache.has(String(userId)); }
function getSupporterIds() { return [...cache]; }

async function listSupporters() {
  if (!pgPool) return [];
  try {
    const r = await pgPool.query(
      'SELECT discord_id, added_by, added_at FROM supporters ORDER BY added_at ASC');
    return r.rows.map(row => ({ discordId: row.discord_id, addedBy: row.added_by, addedAt: row.added_at }));
  } catch (e) { console.error('[supporters] list failed:', e.message); return []; }
}

async function addSupporter(discordId, addedBy) {
  if (!pgPool || !discordId) return;
  try {
    await pgPool.query(
      `INSERT INTO supporters (discord_id, added_by) VALUES ($1, $2)
       ON CONFLICT (discord_id) DO NOTHING`,
      [String(discordId), addedBy ? String(addedBy) : null]);
    await reloadSupporterCache();
  } catch (e) { console.error('[supporters] add failed:', e.message); throw e; }
}

async function removeSupporter(discordId) {
  if (!pgPool || !discordId) return;
  try {
    await pgPool.query('DELETE FROM supporters WHERE discord_id=$1', [String(discordId)]);
    await reloadSupporterCache();
  } catch (e) { console.error('[supporters] remove failed:', e.message); throw e; }
}

module.exports = {
  initSupporters, reloadSupporterCache, isSupporter, getSupporterIds,
  listSupporters, addSupporter, removeSupporter,
};
