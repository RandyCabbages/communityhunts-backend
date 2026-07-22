// User settings + known-users persistence (Postgres-backed, file fallback).
// Owns the user_settings + known_users tables, the file-fallback map, and the
// name-matching/lookup helpers used by the settings + admin-user routes.
// Extracted from server.js (de-slop refactor, 2026-06-20). Behavior unchanged.
//
// DI: initSettings({ pgPool, hunts }) — pgPool for persistence, hunts (the
// persistence-owned singleton, by reference) for the startup backfill loop.

const fs = require('fs');
const path = require('path');
const { isRealDiscordId } = require('./userIds');

let pgPool = null;
let hunts = null;

const SETTINGS_FILE = path.join(__dirname, '..', 'user_settings.json');
let userSettings = {};

// Hot in-memory identity sets for "Show me as anonymous". Kept in sync so the per-viewer
// redaction in hunts-core is an O(1) lookup on every hunt broadcast (no DB round-trip).
//   anonymousUsers — Discord IDs who opted in.
//   anonymousNames — the normalized current display names of those same users (from their
//     settings row's discordDisplayName/discordUsername). The name-match FALLBACK — display
//     redaction only, NEVER a permission/attribution signal (2026-07-18 security audit #2).
const anonymousUsers = new Set();
const anonymousNames = new Set();
const normAnonName = s => (s || '').toString().toLowerCase().replace(/\s+/g, ' ').trim();
function isAnonymousUser(userId) { return !!userId && anonymousUsers.has(String(userId)); }
function isAnonymousName(name) { const n = normAnonName(name); return !!n && anonymousNames.has(n); }
// Display-redaction predicate: mask if the row's bound Discord ID OR its display name belongs
// to an anonymous user. DISPLAY ONLY — never gate permissions or attribution on this.
function shouldMaskIdentity({ discordId, name } = {}) {
  return isAnonymousUser(discordId) || isAnonymousName(name);
}
function addAnonNames(row) {
  for (const cand of [row.discordDisplayName, row.discordUsername]) {
    const n = normAnonName(cand);
    if (n) anonymousNames.add(n);
  }
}
async function loadAnonymousUsers() {
  try {
    const rows = await allSettingsRows();
    anonymousUsers.clear();
    anonymousNames.clear();
    for (const r of rows) {
      if (!r.anonymous) continue;
      anonymousUsers.add(String(r.userId));
      addAnonNames(r);
    }
    console.log(`[settings] tracking ${anonymousUsers.size} anonymous user(s), ${anonymousNames.size} name(s)`);
  } catch (e) { console.error('[settings] loadAnonymousUsers failed:', e.message); }
}
// Test seam: deterministically seed the hot sets without a DB.
function __seedAnonForTest({ ids = [], names = [] } = {}) {
  anonymousUsers.clear(); anonymousNames.clear();
  ids.forEach(id => anonymousUsers.add(String(id)));
  names.forEach(n => { const v = normAnonName(n); if (v) anonymousNames.add(v); });
}

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
    // Site-wide alias directory: accumulates every distinct name seen per user (name history),
    // reverse-indexed by normalized alias for name→id lookups (banned-member warning + future).
    pgPool.query(`
      CREATE TABLE IF NOT EXISTS user_aliases (
        user_id    TEXT NOT NULL,
        alias_norm TEXT NOT NULL,
        alias      TEXT NOT NULL,
        source     TEXT,
        seen_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (user_id, alias_norm)
      )
    `).then(() => pgPool.query(
      `CREATE INDEX IF NOT EXISTS idx_user_aliases_norm ON user_aliases (alias_norm)`
    )).then(() => console.log('[user_aliases] Postgres table ready'))
      .catch(e => console.error('[user_aliases] init failed:', e.message));
  }

  // Load file fallback (used when there's no pgPool).
  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      userSettings = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
      console.log(`[settings] Loaded ${Object.keys(userSettings).length} users from file`);
    }
  } catch(e) { console.error('[settings] Failed to load user_settings.json:', e.message); }
}

// Normalize a human name for alias matching: lowercase, collapse internal whitespace, trim.
// Deliberately NOT the slot normalizer (which strips punctuation + trailing 's') — wrong for names.
// (Mirrors normAnonName; kept as its own exported name for the alias directory.)
function normalizeName(s) {
  return (s || '').toString().toLowerCase().replace(/\s+/g, ' ').trim();
}

// Append a name we've seen for a user into the alias directory. Accumulates; first-seen wins on
// conflict. Best-effort: no-op without pgPool or a blank name, never throws.
function recordAlias(userId, name, source) {
  if (!pgPool || !userId) return;
  const norm = normalizeName(name);
  if (!norm) return;
  pgPool.query(
    `INSERT INTO user_aliases (user_id, alias_norm, alias, source)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (user_id, alias_norm) DO NOTHING`,
    [String(userId), norm, String(name).trim(), source || null]
  ).catch(e => console.error('[user_aliases] record failed:', e.message));
}

// Reverse lookup: given raw names, return Map<rawName, Set<userId>> for names that have >=1 owner.
// Keyed by the ORIGINAL raw string the caller passed, so consumers need no normalizer of their own.
async function findAliasOwners(names) {
  const out = new Map();
  if (!pgPool || !Array.isArray(names) || !names.length) return out;
  const normToRaw = new Map(); // alias_norm -> [rawName,...]
  for (const raw of names) {
    const norm = normalizeName(raw);
    if (!norm) continue;
    if (!normToRaw.has(norm)) normToRaw.set(norm, []);
    normToRaw.get(norm).push(raw);
  }
  if (!normToRaw.size) return out;
  try {
    const r = await pgPool.query(
      `SELECT alias_norm, user_id FROM user_aliases WHERE alias_norm = ANY($1)`,
      [Array.from(normToRaw.keys())]
    );
    for (const row of r.rows) {
      for (const raw of (normToRaw.get(row.alias_norm) || [])) {
        if (!out.has(raw)) out.set(raw, new Set());
        out.get(raw).add(String(row.user_id));
      }
    }
  } catch (e) { console.error('[user_aliases] find failed:', e.message); }
  return out;
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
    // Also accumulate into the alias directory (name history for all users).
    recordAlias(user.id, user.displayName, 'login');
    if (user.username) recordAlias(user.id, user.username, 'login');
  }
}

// Read one known_users row. The admin on-behalf card-request flow proves a Discord id with this
// BEFORE writing anything: a hit means the person signed in with that id, which is proof enough
// on its own and saves a Discord API round-trip. Returns null when absent — the caller decides
// what a miss means (it is not an error).
async function getKnownUser(userId) {
  if (!pgPool) return null;
  try {
    const r = await pgPool.query(
      'SELECT user_id, display_name, username, avatar FROM known_users WHERE user_id=$1',
      [String(userId)]
    );
    const row = r.rows[0];
    if (!row) return null;
    return { id: row.user_id, displayName: row.display_name, username: row.username, avatar: row.avatar };
  } catch (e) {
    console.error('[known_users] get failed:', e.message);
    return null;
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
      // Synthetic `manual:<name>` rows carry a rainbetName + discordDisplayName, so the `dn`
      // check below cannot tell them from a real login and used to launder them into
      // known_users on every boot. Without this guard, anything an admin purges resurrects on
      // the next restart.
      if (!isRealDiscordId(row.user_id)) continue;
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
    // Hunt-owner ids are already snowflakes, so this changes nothing today — it keeps the two
    // loops symmetrical so a future non-Discord hunt owner can't reopen the hole.
    if (u?.id && u?.displayName && isRealDiscordId(u.id)) {
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
  // Keep the hot anonymous sets in sync on every write (both pg + file paths).
  if (data && data.anonymous) { anonymousUsers.add(String(userId)); addAnonNames(data); }
  else {
    anonymousUsers.delete(String(userId));
    for (const cand of [data && data.discordDisplayName, data && data.discordUsername]) {
      const n = normAnonName(cand); if (n) anonymousNames.delete(n);
    }
  }
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

// Remove a settings row entirely. Only ever called for unlinked (non-Discord) ids — the route
// enforces that; this helper does not, so callers must check isRealDiscordId first.
// Returns true if a row was actually removed.
async function deleteSettings(userId) {
  const uid = String(userId);
  anonymousUsers.delete(uid); // keep the hot set in sync, exactly as saveSettings does
  // We don't have the row's names here; a full rebuild is cheap and only runs on manual purge.
  loadAnonymousUsers().catch(() => {});
  if (pgPool) {
    try {
      const r = await pgPool.query('DELETE FROM user_settings WHERE user_id=$1', [uid]);
      return r.rowCount > 0;
    } catch (e) {
      console.error('[settings] pg deleteSettings error:', e.message);
      return false;
    }
  }
  // Fallback to file
  if (!(uid in userSettings)) return false;
  delete userSettings[uid];
  try { fs.writeFileSync(SETTINGS_FILE, JSON.stringify(userSettings), 'utf8'); } catch(e) {}
  return true;
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
  // Prefer real Discord-id rows over synthetic manual: rows so we keep identity attached to the
  // real account when both happen to exist.
  rows.sort((a, b) => {
    const aReal = isRealDiscordId(a.userId) ? 0 : 1;
    const bReal = isRealDiscordId(b.userId) ? 0 : 1;
    return aReal - bReal;
  });
  const match = rows.find(s => nameMatchesSettings(s, search, searchNoSp));
  return match ? match.userId : null;
}

module.exports = {
  initSettings,
  normalizeName,
  recordAlias,
  findAliasOwners,
  recordKnownUser,
  getKnownUser,
  backfillKnownUsers,
  startupBackfill,
  getSettings,
  saveSettings,
  deleteSettings,
  nameMatchesSettings,
  allSettingsRows,
  resolveUserIdByName,
  isAnonymousUser,
  isAnonymousName,
  shouldMaskIdentity,
  normAnonName,
  __seedAnonForTest,
  loadAnonymousUsers,
};
