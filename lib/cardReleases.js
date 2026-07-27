// Card release overrides — admin-controlled live/hidden state for custom equity cards.
// Postgres-backed (hunts_kv key 'card_releases') with a JSON file fallback, mirroring
// lib/slotLists.js.
//
// Stored as a map { [cardId]: boolean }, the AUTHORITATIVE override on top of the frontend
// catalog's `hidden` default. `hidden: true` in the catalog is a card's INITIAL state (it ships
// invisible); `hidden` absent/false means it ships live. An entry here overrides that default in
// EITHER direction: { id: true } forces a hidden card live, { id: false } force-hides a card that
// would otherwise ship live. An id with no entry just falls back to its catalog default.
//
// Both directions LATCH: an id's override changes only via an explicit setReleased(id, live),
// never as a side effect of anything else — in particular, a card request moving off 'done' must
// NOT change its release override.
//
// Ids are opaque strings here — membership validation against ITEM_TIERS happens at the route,
// which is the layer that knows the item allowlist. A stale id (card since deleted) is inert:
// it simply never matches an item.
//
// Deliberately uncapped: every cap option silently drops someone's override, which is a worse
// failure than an unbounded map of ~40 short entries.
//
// A legacy persisted array (the pre-map whitelist shape) migrates to { id: true } on load — see
// normalize().
//
// DI: initCardReleases({ pgPool }).

const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'card_releases.json');

// Accepts either the legacy array shape (['card_cook'] = those ids force-live) or the current
// map shape ({id: boolean}) and always returns a map. Anything else → {}.
function normalize(value) {
  if (Array.isArray(value)) {
    const m = {};
    for (const id of value) m[String(id)] = true;
    return m;
  }
  if (value && typeof value === 'object') return { ...value };
  return {};
}

const { makeKvStore } = require('./kvStore');
// Shared clobber guard: no PG write until a boot read has SUCCEEDED. See lib/kvStore.js.
const kv = makeKvStore('card_releases', '[releases]');

let pgPool = null;
let overrides = {}; // { [cardId]: boolean } — explicit admin live-state, overrides the catalog default

async function initCardReleases(deps) {
  pgPool = (deps && deps.pgPool) || null;
  overrides = {};
  kv.attach(pgPool);
  if (pgPool) {
    const { value } = await kv.load();
    if (value) {
      overrides = normalize(value);
      console.log(`[releases] Loaded ${Object.keys(overrides).length} card overrides from Postgres`);
      return;
    }
  }
  try {
    if (fs.existsSync(FILE)) {
      overrides = normalize(JSON.parse(fs.readFileSync(FILE, 'utf8')));
      console.log(`[releases] Loaded ${Object.keys(overrides).length} card overrides from file`);
    }
  } catch (e) { console.error('[releases] File load failed:', e.message); }
}

function persist() {
  kv.persist(overrides);
  try { fs.writeFileSync(FILE, JSON.stringify(overrides), 'utf8'); } catch (e) {}
}

// Returns the whole override map { [cardId]: boolean }. Callers echo it straight back to clients.
function listReleased() { return overrides; }

// Records the admin's explicit live-state for a card. Both directions LATCH — an id leaves the
// map only if the same admin later sets the opposite; nothing else touches it. A `false` entry is
// meaningful: it hides a card that ships WITHOUT `hidden` (its catalog default is live).
function setReleased(itemId, live) {
  const id = String(itemId);
  const next = !!live;
  if (overrides[id] !== next) { overrides[id] = next; persist(); }
  return overrides;
}

module.exports = { initCardReleases, listReleased, setReleased };
