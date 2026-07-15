// Released card ids — which `hidden` catalog cards are live in the Shop. Postgres-backed
// (hunts_kv key 'card_releases') with a JSON file fallback, mirroring lib/slotLists.js.
//
// `hidden: true` in the frontend catalog is a card's INITIAL state (it ships invisible); an id
// in here overrides that → live. Release is a LATCH: an id leaves only via an explicit
// setReleased(id, false), never as a side effect of anything else — in particular, a card
// request moving off 'done' must NOT un-release its card.
//
// Ids are opaque strings here — membership validation against ITEM_TIERS happens at the route,
// which is the layer that knows the item allowlist. A stale id (card since deleted) is inert:
// it simply never matches an item.
//
// Deliberately uncapped: every cap option silently un-releases someone's live card, which is a
// worse failure than an unbounded list of ~40 short strings.
//
// DI: initCardReleases({ pgPool }).

const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'card_releases.json');

let pgPool = null;
let released = []; // item ids, insertion order

async function initCardReleases(deps) {
  pgPool = (deps && deps.pgPool) || null;
  released = [];
  if (pgPool) {
    try {
      await pgPool.query(`
        CREATE TABLE IF NOT EXISTS hunts_kv (
          key TEXT PRIMARY KEY,
          value JSONB NOT NULL
        )
      `);
      const r = await pgPool.query("SELECT value FROM hunts_kv WHERE key='card_releases'");
      if (r.rows[0]) {
        released = Array.isArray(r.rows[0].value) ? r.rows[0].value : [];
        console.log(`[releases] Loaded ${released.length} released cards from Postgres`);
        return;
      }
    } catch (e) { console.error('[releases] PG load failed:', e.message); }
  }
  try {
    if (fs.existsSync(FILE)) {
      released = JSON.parse(fs.readFileSync(FILE, 'utf8'));
      console.log(`[releases] Loaded ${released.length} released cards from file`);
    }
  } catch (e) { console.error('[releases] File load failed:', e.message); }
}

function persist() {
  if (pgPool) {
    pgPool.query(
      "INSERT INTO hunts_kv(key,value) VALUES('card_releases',$1) ON CONFLICT(key) DO UPDATE SET value=$1",
      [JSON.stringify(released)]
    ).catch(e => console.error('[releases] PG save failed:', e.message));
  }
  try { fs.writeFileSync(FILE, JSON.stringify(released), 'utf8'); } catch (e) {}
}

function listReleased() { return released; }

// Idempotent in both directions. Returns the full list so a caller can echo it straight back.
function setReleased(itemId, live) {
  const id = String(itemId);
  const at = released.indexOf(id);
  if (live && at === -1) { released.push(id); persist(); }
  else if (!live && at !== -1) { released.splice(at, 1); persist(); }
  return released;
}

module.exports = { initCardReleases, listReleased, setReleased };
