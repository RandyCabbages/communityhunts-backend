// communityhunts-backend/lib/bans.js
// Banned users — Discord IDs blocked from the platform, managed entirely from the admin
// panel (no hardcoded IDs, no env seed). A ban is platform-wide: the banned user is refused
// on every tenant, across website, extension, API, and sockets.
// DI pattern (see lib/admins.js): no-ops safely with no DB.

// Full lockout copy shown to the banned user themselves.
const DEFAULT_BAN_MESSAGE =
  'You have been banned from communityhunts.gg for taking advantage of your community, please repay before you can continue.';
// Short reason surfaced to a hunt runner who adds a banned user.
const DEFAULT_BAN_REASON = 'scamming';

let pgPool = null;
let cache = new Map(); // discord_id -> { reason, message, bannedBy, bannedAt }

async function initBans(deps) {
  pgPool = deps.pgPool;
  if (!pgPool) { console.log('[bans] no DB — UI-managed ban list disabled'); return; }
  try {
    await pgPool.query(`
      CREATE TABLE IF NOT EXISTS banned_users (
        discord_id TEXT PRIMARY KEY,
        reason     TEXT,
        message    TEXT,
        banned_by  TEXT,
        banned_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
    await reloadBanCache();
    console.log(`[bans] loaded ${cache.size} banned user(s)`);
  } catch (e) {
    console.error('[bans] init failed:', e.message);
  }
}

async function reloadBanCache() {
  if (!pgPool) return;
  try {
    const r = await pgPool.query(
      'SELECT discord_id, reason, message, banned_by, banned_at FROM banned_users');
    cache = new Map(r.rows.map(row => [String(row.discord_id), {
      reason: row.reason, message: row.message,
      bannedBy: row.banned_by, bannedAt: row.banned_at,
    }]));
  } catch (e) {
    console.error('[bans] reload failed:', e.message);
  }
}

function isBanned(userId) { return !!userId && cache.has(String(userId)); }

// Full ban record for a banned id (or null). reason/message fall back to defaults so callers
// never have to special-case a ban that was stored without custom copy.
function getBan(userId) {
  if (!userId) return null;
  const b = cache.get(String(userId));
  if (!b) return null;
  return {
    reason: b.reason || DEFAULT_BAN_REASON,
    message: b.message || DEFAULT_BAN_MESSAGE,
    bannedBy: b.bannedBy,
    bannedAt: b.bannedAt,
  };
}

async function listBans() {
  if (!pgPool) return [];
  try {
    const r = await pgPool.query(
      'SELECT discord_id, reason, message, banned_by, banned_at FROM banned_users ORDER BY banned_at DESC');
    return r.rows.map(row => ({
      discordId: row.discord_id, reason: row.reason, message: row.message,
      bannedBy: row.banned_by, bannedAt: row.banned_at,
    }));
  } catch (e) { console.error('[bans] list failed:', e.message); return []; }
}

async function addBan(discordId, { reason, message, bannedBy } = {}) {
  if (!pgPool || !discordId) return;
  try {
    await pgPool.query(
      `INSERT INTO banned_users (discord_id, reason, message, banned_by)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (discord_id) DO UPDATE
         SET reason = EXCLUDED.reason, message = EXCLUDED.message, banned_by = EXCLUDED.banned_by`,
      [String(discordId), reason || DEFAULT_BAN_REASON, message || DEFAULT_BAN_MESSAGE,
       bannedBy ? String(bannedBy) : null]);
    await reloadBanCache();
  } catch (e) { console.error('[bans] add failed:', e.message); throw e; }
}

async function removeBan(discordId) {
  if (!pgPool || !discordId) return;
  try {
    await pgPool.query('DELETE FROM banned_users WHERE discord_id=$1', [String(discordId)]);
    await reloadBanCache();
  } catch (e) { console.error('[bans] remove failed:', e.message); throw e; }
}

module.exports = {
  initBans, reloadBanCache, isBanned, getBan, listBans, addBan, removeBan,
  DEFAULT_BAN_MESSAGE, DEFAULT_BAN_REASON,
};
