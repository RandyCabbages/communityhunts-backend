// The set of name→account decisions a platform admin has ALREADY confirmed, held in memory so a
// hunt save can consult it for free.
//
// WHY IT IS A CACHE AND NOT A QUERY: this is read from the hunt save path, which a single active
// host hits roughly every 500ms. A round-trip to Postgres there would put the database on the
// hottest write path in the app for a table that changes a few times a week.
//
// WHY IT IS SEPARATE FROM lib/settings.findAliasOwners: that reads the WHOLE alias directory,
// which is mostly login-sourced — names nobody has vetted. Auto-linking off that would be exactly
// the platform-wide guessing lib/identityLink.js refuses to do. This holds only rows written by
// the Tier 2 apply (`source = 'admin-link'`), i.e. a human already said yes to this person.
//
// Keyed with identityLink's normName, NOT settings.normalizeName. The two disagree on whitespace
// ("big cabbage" vs "bigcabbage") and the review queue groups rows with the former, so keying on
// anything else would auto-link a different set of rows than the operator was shown.

const { normName } = require('./identityLink');
const { isRealDiscordId } = require('./userIds');

const ADMIN_LINK_SOURCE = 'admin-link';

let pgPool = null;
let byNorm = new Map();   // normName -> Set(discordId)

function add(name, discordId) {
  const k = normName(name);
  if (!k || !isRealDiscordId(discordId)) return;
  if (!byNorm.has(k)) byNorm.set(k, new Set());
  byNorm.get(k).add(String(discordId));
}

// Load every confirmed decision. Safe to call repeatedly; builds into a NEW map and swaps, so a
// concurrent resolve() never sees a half-populated index.
async function refresh() {
  if (!pgPool) return 0;
  try {
    const r = await pgPool.query(
      `SELECT alias, user_id FROM user_aliases WHERE source = $1`, [ADMIN_LINK_SOURCE]
    );
    const next = new Map();
    for (const row of r.rows) {
      const k = normName(row.alias);
      if (!k || !isRealDiscordId(row.user_id)) continue;
      if (!next.has(k)) next.set(k, new Set());
      next.get(k).add(String(row.user_id));
    }
    byNorm = next;
    return byNorm.size;
  } catch (e) {
    // A failed load leaves the previous index in place: worst case we link nothing new, which is
    // the same as the behavior before this existed. Never fail a save over it.
    console.error('[confirmed_aliases] load failed:', e.message);
    return byNorm.size;
  }
}

function initConfirmedAliases(pool) {
  pgPool = pool || null;
  return refresh();
}

// Record a decision locally the moment it is applied, so the very next save already honours it
// without waiting for a reload.
function remember(name, discordId) { add(name, discordId); }

// Drop a decision — called when an operator unlinks a name. Without this, unlink would clear the
// rows and the next save would immediately put the id back, making the undo a no-op.
function forget(name, discordId) {
  const k = normName(name);
  if (!k) return;
  const set = byNorm.get(k);
  if (!set) return;
  set.delete(String(discordId));
  if (!set.size) byNorm.delete(k);
}

// The single id confirmed for this name, or null. Null for unknown AND for a name two different
// accounts were confirmed under — an ambiguous name is exactly what must never be guessed.
function resolve(name) {
  const k = normName(name);
  if (!k) return null;
  const set = byNorm.get(k);
  return set && set.size === 1 ? [...set][0] : null;
}

const size = () => byNorm.size;

// Test seam: rebuild the index from plain data with no database.
function _seed(entries) {
  byNorm = new Map();
  for (const [name, id] of entries || []) add(name, id);
}

module.exports = {
  initConfirmedAliases, refresh, remember, forget, resolve, size, _seed, ADMIN_LINK_SOURCE,
};
