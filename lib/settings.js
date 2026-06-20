// User settings + known-users persistence (Postgres-backed, file fallback).
// Owns the user_settings + known_users tables, the file-fallback map, and the
// name-matching/lookup helpers used by the settings + admin-user routes.
// Extracted from server.js (de-slop refactor, 2026-06-20). Behavior unchanged.
//
// DI: initSettings({ pgPool, hunts }) — pgPool for persistence, hunts (the
// persistence-owned singleton, by reference) for the startup backfill loop.

const fs = require('fs');
const path = require('path');

let pgPool = null;
let hunts = null;

const SETTINGS_FILE = path.join(__dirname, '..', 'user_settings.json');
let userSettings = {};

function initSettings(deps) {
  pgPool = deps.pgPool || null;
  hunts = deps.hunts || {};

  if (pgPool) {
    pgPool.query(`
      CREATE TABLE IF NOT EXISTS user_settings (
        user_id TEXT PRIMARY KEY,
        settings JSONB NOT NULL DEFAULT '{}'
      )
    `).then(() => console.log('[settings] Postgres table ready'))
      .catch(e => console.error('[settings] Postgres init failed:', e.message));
    // Track everyone who's ever logged in, for equity name autocomplete
    pgPool.query(`
      CREATE TABLE IF NOT EXISTS known_users (
        user_id TEXT PRIMARY KEY,
        display_name TEXT NOT NULL,
        username TEXT,
        avatar TEXT,
        last_seen TIMESTAMP NOT NULL DEFAULT NOW()
      )
    `).then(() => console.log('[known_users] Postgres table ready'))
      .catch(e => console.error('[known_users] init failed:', e.message));
  }

  // Load file fallback (used when there's no pgPool).
  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      userSettings = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
      console.log(`[settings] Loaded ${Object.keys(userSettings).length} users from file`);
    }
  } catch(e) { console.error('[settings] Failed to load user_settings.json:', e.message); }
}

// Records a user as known. Safe to call on every login.
function recordKnownUser(user) {
  if (!user?.id || !user?.displayName) return;
  if (pgPool) {
    pgPool.query(
      `INSERT INTO known_users (user_id, display_name, username, avatar, last_seen)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (user_id) DO UPDATE SET
         display_name = EXCLUDED.display_name,
         username = EXCLUDED.username,
         avatar = EXCLUDED.avatar,
         last_seen = NOW()`,
      [user.id, user.displayName, user.username || null, user.avatar || null]
    ).catch(e => console.error('[known_users] insert failed:', e.message));
  }
}

// Backfill known_users from existing user_settings (and hunts) on startup.
// Without this, returning users wouldn't appear in equity autocomplete until they re-login.
async function backfillKnownUsers() {
  if (!pgPool) return;
  let inserted = 0;
  // From user_settings — settings JSON has discordDisplayName / discordUsername fields
  try {
    const r = await pgPool.query('SELECT user_id, settings FROM user_settings');
    for (const row of r.rows) {
      const s = row.settings || {};
      const dn = s.discordDisplayName || s.rainbetName;
      if (dn) {
        recordKnownUser({
          id: row.user_id,
          displayName: dn,
          username: s.discordUsername || null,
          avatar: s.discordAvatar || null,
        });
        inserted++;
      }
    }
  } catch(e) { console.error('[known_users] settings backfill failed:', e.message); }
  // From hunts (each hunt has a user object with displayName)
  for (const id in hunts) {
    const u = hunts[id]?.user;
    if (u?.id && u?.displayName) {
      recordKnownUser({ id: u.id, displayName: u.displayName, username: u.username, avatar: u.avatar });
      inserted++;
    }
  }
  console.log(`[known_users] backfill queued ${inserted} users`);
}
// Run backfill after hunts are loaded so the hunts loop sees data
function startupBackfill() { backfillKnownUsers().catch(e => console.error('[known_users] backfill error:', e.message)); }

async function getSettings(userId) {
  if (pgPool) {
    try {
      const r = await pgPool.query('SELECT settings FROM user_settings WHERE user_id=$1', [userId]);
      return r.rows[0]?.settings || { rainbetName: '', twitchName: '', preferredSlots: [] };
    } catch(e) { console.error('[settings] pg getSettings error:', e.message); }
  }
  return userSettings[userId] || { rainbetName: '', twitchName: '', preferredSlots: [] };
}

async function saveSettings(userId, data) {
  if (pgPool) {
    try {
      await pgPool.query(
        'INSERT INTO user_settings(user_id, settings) VALUES($1,$2) ON CONFLICT(user_id) DO UPDATE SET settings=$2',
        [userId, JSON.stringify(data)]
      );
      return;
    } catch(e) { console.error('[settings] pg saveSettings error:', e.message); }
  }
  // Fallback to file
  userSettings[userId] = data;
  try { fs.writeFileSync(SETTINGS_FILE, JSON.stringify(userSettings), 'utf8'); } catch(e) {}
}

// Does a settings row's name(s) match a typed search string?
// Matching rules (intentionally narrow to avoid false positives):
//   1. Exact match (case- and space-insensitive) on discordUsername or discordDisplayName.
//   2. A stored name that *starts with* the typed search — but ONLY when the typed string is
//      long enough (>= MIN_PREFIX_LEN) to be distinctive. This keeps "walker" -> "WalkerGames"
//      working while preventing short/typed fragments from latching onto unrelated users.
// The old code also matched when search.startsWith(storedName); that arm let any typed name
// beginning with a stored alias resolve to that user (notably the owner, who sorts first),
// auto-adding Cabbage as the equity person. That direction is removed.
const MIN_PREFIX_LEN = 4;
function nameMatchesSettings(s, search, searchNoSp) {
  const candidates = [
    (s.discordUsername    || '').toLowerCase().trim(),
    (s.discordDisplayName || '').toLowerCase().trim(),
  ].filter(Boolean);
  const noSp = candidates.map(c => c.replace(/\s+/g, ''));
  for (const c of candidates.concat(noSp)) {
    if (!c) continue;
    if (c === search || c === searchNoSp) return true;
    // Only a stored name extending the typed prefix — and only for distinctive prefixes.
    if (search.length >= MIN_PREFIX_LEN && (c.startsWith(search) || c.startsWith(searchNoSp))) return true;
  }
  return false;
}

// Return all settings rows ({userId, ...settings}) from pg, falling back to the file map.
// Used by the by-name lookup route and resolveUserIdByName so both search the same source.
async function allSettingsRows() {
  if (pgPool) {
    try {
      const r = await pgPool.query('SELECT user_id, settings FROM user_settings');
      const rows = r.rows.map(row => ({ userId: row.user_id, ...row.settings }));
      if (rows.length) return rows;
    } catch(e) { console.error('[settings] allSettingsRows pg error:', e.message); }
  }
  return Object.entries(userSettings).map(([uid, s]) => ({ userId: uid, ...s }));
}

// Resolve a member name (Discord username/displayName) to an existing settings userId.
// Returns null if no row matches — caller may fall back to a synthetic manual: id.
// Uses the same matching rules as GET /api/settings/by-name/:name.
async function resolveUserIdByName(name) {
  const search = (name || '').toLowerCase().trim();
  if (!search) return null;
  const searchNoSp = search.replace(/\s+/g, '');
  const rows = await allSettingsRows();
  // Prefer real Discord-id rows (17-19 digit ids) over synthetic manual: rows so we keep
  // identity attached to the real account when both happen to exist.
  rows.sort((a, b) => {
    const aReal = /^\d{17,19}$/.test(a.userId) ? 0 : 1;
    const bReal = /^\d{17,19}$/.test(b.userId) ? 0 : 1;
    return aReal - bReal;
  });
  const match = rows.find(s => nameMatchesSettings(s, search, searchNoSp));
  return match ? match.userId : null;
}

module.exports = {
  initSettings,
  recordKnownUser,
  backfillKnownUsers,
  startupBackfill,
  getSettings,
  saveSettings,
  nameMatchesSettings,
  allSettingsRows,
  resolveUserIdByName,
};
