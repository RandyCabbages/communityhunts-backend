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
// The in-flight (or completed) hydration, captured so callers who MUST NOT run against empty sets
// can wait for it. See whenAnonymousReady below.
let anonReady = null;

// Resolves to { ok, count } and NEVER rejects.
//
// `ok` is the load's own verdict on whether it actually SAW the anonymity set: false means the
// database read failed and the empty file fallback was used, so the hot sets mask nobody. The
// server deliberately carries on regardless (degrade, don't wedge) — but a one-shot maintenance
// script must not: writing rollups from empty sets bakes real names into never-healing rows, and
// without this signal that failure exits 0 and looks like a success. See allSettingsRows.
async function hydrateAnonymousUsers() {
  // No pgPool at all is file-fallback mode, which is the designed behaviour, not a failure —
  // allSettingsRows only ever writes dbOk when it actually attempted a query.
  const status = { dbOk: true };
  try {
    const rows = await allSettingsRows(status);
    anonymousUsers.clear();
    anonymousNames.clear();
    for (const r of rows) {
      if (!r.anonymous) continue;
      anonymousUsers.add(String(r.userId));
      addAnonNames(r);
    }
    console.log(`[settings] tracking ${anonymousUsers.size} anonymous user(s), ${anonymousNames.size} name(s)`);
  } catch (e) {
    status.dbOk = false;
    console.error('[settings] loadAnonymousUsers failed:', e.message);
  }
  return { ok: status.dbOk !== false, count: anonymousUsers.size };
}

// Deliberately NOT async: the promise has to be captured SYNCHRONOUSLY at call time so a
// whenAnonymousReady() racing this call sees the load that is actually running.
function loadAnonymousUsers() {
  anonReady = hydrateAnonymousUsers();
  return anonReady;
}

// Resolves once the hot anonymous sets have been hydrated at least once.
//
// server.js can't await its init chain (CommonJS top level), so `server.listen()` starts serving
// while this load is still the last link of it. Anything that BAKES a masking decision into
// durable state has to wait — the per-user stats rollup now stores member NAMES, so a recompute
// served in that window would cache an anonymous member's real name (see lib/statsStore.js).
//
// Never rejects, and resolves immediately when the load was never started: a failed or absent
// hydration must degrade to today's behaviour, not wedge every stats read forever. Resolves to the
// same { ok, count } verdict loadAnonymousUsers does — `ok:false` for "never started" is honest,
// the sets are empty and unverified — so a caller that CAN refuse (the maintenance scripts) has
// the signal, while the server's gate simply awaits it and ignores the value.
function whenAnonymousReady() { return anonReady || Promise.resolve({ ok: false, count: 0 }); }
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
      .then(() => {
        // Indexes for the name lookup (settingsRowsMatchingName). All four are needed, not just
        // the two raw ones: the predicate ORs across all four expressions, and Postgres can only
        // use indexes for an OR when EVERY branch is indexable — otherwise it seq-scans anyway.
        //
        // text_pattern_ops is required for LIKE 'prefix%' to be index-usable under a non-C
        // collation. The expression text must match the query's EXACTLY (see NAME_EXPRS).
        //
        // No-op at today's 87 rows, where a seq scan is correctly cheaper. These are for the
        // growth case — this lookup is called on the order of a million times.
        const idx = NAME_EXPRS.map((e, i) =>
          pgPool.query(`CREATE INDEX IF NOT EXISTS idx_user_settings_name_${i} ON user_settings ((${e}) text_pattern_ops)`)
            .catch(err => console.error(`[settings] name index ${i} failed:`, err.message)));
        return Promise.all(idx).then(() => console.log('[settings] name-lookup indexes ready'));
      })
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

// Same reverse lookup as findAliasOwners, but whitespace-INSENSITIVE.
//
// WHY BOTH EXIST: alias_norm collapses runs of whitespace ("big  cabbage" -> "big cabbage"), while
// the identity review queue groups rows with identityLink's normName, which removes whitespace
// entirely ("bigcabbage"). Handing a group's representative name to the strict lookup therefore
// missed every account whose Discord name spaced differently from what the host typed, and those
// people were reported as "No matching account" when an account plainly existed.
//
// Stripping the spaces on both sides is the LOOSER direction on purpose: two accounts that differ
// only by spacing now collapse onto one name and surface as ambiguous, which Tier 2 refuses to
// offer. Loosening can therefore cost a proposal; it can never produce a wrong one.
async function findAliasOwnersLoose(names) {
  const out = new Map();
  if (!pgPool || !Array.isArray(names) || !names.length) return out;
  const squash = (s) => normalizeName(s).replace(/\s+/g, '');
  const keyToRaw = new Map(); // squashed -> [rawName,...]
  for (const raw of names) {
    const k = squash(raw);
    if (!k) continue;
    if (!keyToRaw.has(k)) keyToRaw.set(k, []);
    keyToRaw.get(k).push(raw);
  }
  if (!keyToRaw.size) return out;
  try {
    const r = await pgPool.query(
      `SELECT alias, user_id FROM user_aliases WHERE REPLACE(alias_norm, ' ', '') = ANY($1)`,
      [Array.from(keyToRaw.keys())]
    );
    for (const row of r.rows) {
      for (const raw of (keyToRaw.get(squash(row.alias)) || [])) {
        if (!out.has(raw)) out.set(raw, new Set());
        out.get(raw).add(String(row.user_id));
      }
    }
  } catch (e) { console.error('[user_aliases] loose find failed:', e.message); }
  return out;
}

// Forget one name for one user. Needed because an alias written by the Tier 2 apply is what makes
// that link replay onto future hunts — without deleting it, unlinking the name would clear today's
// rows and the next save would put the id straight back.
async function deleteAlias(userId, name) {
  if (!pgPool || !userId) return 0;
  const norm = normalizeName(name);
  if (!norm) return 0;
  try {
    const r = await pgPool.query(
      `DELETE FROM user_aliases WHERE user_id = $1 AND alias_norm = $2`, [String(userId), norm]
    );
    return r.rowCount || 0;
  } catch (e) { console.error('[user_aliases] delete failed:', e.message); return 0; }
}

// Records a user as known. Safe to call on every login.
// ── known_users write suppression ─────────────────────────────────────────────
// recordKnownUser runs from the Bearer fallback (lib/auth.js) on EVERY authenticated request, and
// the Bearer path is the normal one (sessions are in-memory and die on each deploy). The upsert
// unconditionally set last_seen = NOW(), so it produced a new row version + WAL record per request:
// 5,845,582 updates against 182 live rows, with 6,571 autovacuums on a 7-page table (measured
// 2026-07-27). Cost scaled with REQUEST volume, not user count, so it could never self-correct.
//
// Two layers, because neither alone is enough:
//   1. this in-process cache skips the round trip entirely when nothing changed recently;
//   2. the WHERE guard on the DO UPDATE (below) means a COLD cache — a second instance, or a
//      fresh deploy — still writes no row version when the data is identical.
const KNOWN_USER_TTL_MS = 15 * 60 * 1000;  // refresh last_seen at most this often
const KNOWN_USER_CACHE_MAX = 5000;         // bounded: identity is per-user, but ids are unbounded
const knownUserSeen = new Map();           // userId -> { sig, at } (insertion-ordered → FIFO evict)

function recordKnownUser(user) {
  if (!user?.id || !user?.displayName) return;
  if (pgPool) {
    // Skip the query outright when this instance already wrote exactly this identity recently.
    const sig = `${user.displayName}\x00${user.username || ''}\x00${user.avatar || ''}`;
    const seen = knownUserSeen.get(user.id);
    const now = Date.now();
    if (seen && seen.sig === sig && now - seen.at < KNOWN_USER_TTL_MS) return;
    if (knownUserSeen.size >= KNOWN_USER_CACHE_MAX) {
      const oldest = knownUserSeen.keys().next();
      if (!oldest.done) knownUserSeen.delete(oldest.value);
    }
    knownUserSeen.delete(user.id);              // re-insert so the key moves to the end
    knownUserSeen.set(user.id, { sig, at: now });

    pgPool.query(
      `INSERT INTO known_users (user_id, display_name, username, avatar, last_seen)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (user_id) DO UPDATE SET
         display_name = EXCLUDED.display_name,
         username = EXCLUDED.username,
         avatar = EXCLUDED.avatar,
         last_seen = NOW()
       WHERE known_users.display_name IS DISTINCT FROM EXCLUDED.display_name
          OR known_users.username     IS DISTINCT FROM EXCLUDED.username
          OR known_users.avatar       IS DISTINCT FROM EXCLUDED.avatar
          OR known_users.last_seen    <  NOW() - INTERVAL '15 minutes'`,
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

// Equipped cosmetic card id for MANY users in one query → Map(userId → cardId).
// One round trip, not one per user: the caller is the public share page (lib/shareCards.js),
// where a 15-member hunt would otherwise fire 15 getSettings() calls per anonymous page view.
// Ids that have no row, or a row with no equipped card, are simply absent from the Map.
async function cardsForUserIds(userIds) {
  const ids = [...new Set((userIds || []).map(String).filter(Boolean))];
  const out = new Map();
  if (!ids.length) return out;
  if (pgPool) {
    try {
      const r = await pgPool.query(
        `SELECT user_id, settings->'cosmetics'->>'card' AS card
           FROM user_settings WHERE user_id = ANY($1::text[])`, [ids]);
      for (const row of r.rows) if (row.card) out.set(String(row.user_id), row.card);
      return out;
    } catch (e) { console.error('[settings] cardsForUserIds pg error:', e.message); }
  }
  for (const id of ids) {
    const card = userSettings[id]?.cosmetics?.card;
    if (card) out.set(id, card);
  }
  return out;
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
//
// It swallows its own pg error and returns the fallback — which is EMPTY in any process that has
// no user_settings.json, i.e. every maintenance script. A caller that cannot tell "there are no
// anonymous users" from "the one SELECT that would have told me failed" will happily write real
// names into rollups and exit 0. Pass the optional `status` out-object to get that distinction:
// `status.dbOk` is set true/false only when a query was actually attempted, so callers that omit
// it (and the no-pgPool path) behave exactly as before.
async function allSettingsRows(status) {
  if (pgPool) {
    try {
      const r = await pgPool.query('SELECT user_id, settings FROM user_settings');
      if (status) status.dbOk = true;
      const rows = r.rows.map(row => ({ userId: row.user_id, ...row.settings }));
      if (rows.length) return rows;
    } catch(e) {
      if (status) status.dbOk = false;
      console.error('[settings] allSettingsRows pg error:', e.message);
    }
  }
  return Object.entries(userSettings).map(([uid, s]) => ({ userId: uid, ...s }));
}

// ── Name lookup: SQL narrows, JS decides ─────────────────────────────────────
// resolveUserIdByName used to pull EVERY user_settings row and filter in JS. Measured on the live
// database 2026-07-27: seq_scan = 1,796,471 with seq_tup_read = 132,706,276 against 87 live rows.
// Free at 87 rows and linear in user count — the one query in the app with no natural ceiling.
//
// The predicate below is deliberately a SUPERSET of nameMatchesSettings: it prefilters in SQL, and
// nameMatchesSettings still makes the final decision on whatever comes back. A prefilter that
// dropped a row JS would have matched is a SILENT false negative — an equity member stops
// resolving to their account — so the superset property is proven by test
// (settings.nameLookup.test.js), not assumed.
//
// Why the first 3 characters: JS matches on equality or on a stored name EXTENDING the typed one.
// In every such case the stored value (or its space-stripped form) shares the search's leading
// characters, so a short prefix is safe and selective. Space-stripped forms are matched too,
// because JS compares both `c` and `c` with whitespace removed.
const NAME_PREFIX_LEN = 3;
const likePrefix = (s) => s.slice(0, NAME_PREFIX_LEN);
// LIKE treats % and _ as wildcards; a name such as "100%Real" would otherwise match everything.
const escapeLike = (s) => s.replace(/([\\%_])/g, '\\$1');

// The four SQL expressions, in the exact text used by both the query and its indexes — an index on
// an expression is only usable when the query spells it identically.
const NAME_EXPRS = [
  `lower(btrim(settings->>'discordUsername'))`,
  `regexp_replace(lower(btrim(settings->>'discordUsername')), '\\s+', '', 'g')`,
  `lower(btrim(settings->>'discordDisplayName'))`,
  `regexp_replace(lower(btrim(settings->>'discordDisplayName')), '\\s+', '', 'g')`,
];

// JS mirror of the SQL predicate above. Exported so the superset property can be tested without a
// live Postgres; keep the two in lockstep.
function sqlPrefilterAccepts(s, search, searchNoSp) {
  const p1 = likePrefix(search), p2 = likePrefix(searchNoSp);
  for (const field of ['discordUsername', 'discordDisplayName']) {
    const raw = (s[field] || '').toLowerCase().trim();
    if (!raw) continue;
    for (const cand of [raw, raw.replace(/\s+/g, '')]) {
      if (cand.startsWith(p1) || cand.startsWith(p2)) return true;
    }
  }
  return false;
}

// Candidate rows for a name, prefiltered in SQL. Falls back to the in-memory file map (which is
// only populated when there is no pgPool) exactly as allSettingsRows does.
async function settingsRowsMatchingName(search, searchNoSp) {
  if (pgPool) {
    try {
      const where = NAME_EXPRS
        .map(e => `${e} LIKE $1 ESCAPE '\\' OR ${e} LIKE $2 ESCAPE '\\'`)
        .join(' OR ');
      const r = await pgPool.query(
        `SELECT user_id, settings FROM user_settings WHERE ${where}`,
        [`${escapeLike(likePrefix(search))}%`, `${escapeLike(likePrefix(searchNoSp))}%`]
      );
      return r.rows.map(row => ({ userId: row.user_id, ...row.settings }));
    } catch (e) { console.error('[settings] name lookup pg error:', e.message); }
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
  const rows = await settingsRowsMatchingName(search, searchNoSp);
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
  findAliasOwnersLoose,
  deleteAlias,
  recordKnownUser,
  getKnownUser,
  backfillKnownUsers,
  startupBackfill,
  getSettings,
  cardsForUserIds,
  saveSettings,
  deleteSettings,
  nameMatchesSettings,
  sqlPrefilterAccepts,
  allSettingsRows,
  resolveUserIdByName,
  isAnonymousUser,
  isAnonymousName,
  shouldMaskIdentity,
  normAnonName,
  __seedAnonForTest,
  loadAnonymousUsers,
  whenAnonymousReady,
};
