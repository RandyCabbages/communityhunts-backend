// Global curated slot lists ("pull these into the queue"). Owner-published,
// publicly readable. Postgres-backed (hunts_kv key 'slot_lists') with a JSON
// file fallback, mirroring lib/announcements.js.
//
// DI: initSlotLists({ pgPool }).

const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'slot_lists.json');
const MAX_LISTS = 50;
const MAX_SLOTS_PER_LIST = 100;
const MAX_PAYLOAD_BYTES = 60 * 1024;

let pgPool = null;
let lists = []; // newest first

async function initSlotLists(deps) {
  pgPool = (deps && deps.pgPool) || null;
  if (pgPool) {
    try {
      await pgPool.query(`
        CREATE TABLE IF NOT EXISTS hunts_kv (
          key TEXT PRIMARY KEY,
          value JSONB NOT NULL
        )
      `);
      const r = await pgPool.query("SELECT value FROM hunts_kv WHERE key='slot_lists'");
      if (r.rows[0]) {
        lists = Array.isArray(r.rows[0].value) ? r.rows[0].value : [];
        console.log(`[slotlists] Loaded ${lists.length} slot lists from Postgres`);
        return;
      }
    } catch (e) { console.error('[slotlists] PG load failed:', e.message); }
  }
  try {
    if (fs.existsSync(FILE)) {
      lists = JSON.parse(fs.readFileSync(FILE, 'utf8'));
      console.log(`[slotlists] Loaded ${lists.length} slot lists from file`);
    }
  } catch (e) { console.error('[slotlists] File load failed:', e.message); }
}

function persist() {
  if (pgPool) {
    pgPool.query(
      "INSERT INTO hunts_kv(key,value) VALUES('slot_lists',$1) ON CONFLICT(key) DO UPDATE SET value=$1",
      [JSON.stringify(lists)]
    ).catch(e => console.error('[slotlists] PG save failed:', e.message));
  }
  try { fs.writeFileSync(FILE, JSON.stringify(lists), 'utf8'); } catch (e) {}
}

// Validate a {name, description?, provider?, slots:[{name,...}]} body.
// Returns an error string or null.
function validateInput(body) {
  if (!body || typeof body !== 'object') return 'Invalid payload';
  if (typeof body.name !== 'string' || !body.name.trim()) return 'Name required';
  if (body.name.length > 120) return 'Name too long';
  if (body.description !== undefined && (typeof body.description !== 'string' || body.description.length > 300)) return 'Description too long';
  if (body.provider !== undefined && (typeof body.provider !== 'string' || body.provider.length > 60)) return 'Invalid provider';
  if (!Array.isArray(body.slots) || body.slots.length === 0) return 'At least one slot required';
  if (body.slots.length > MAX_SLOTS_PER_LIST) return `Too many slots (max ${MAX_SLOTS_PER_LIST})`;
  for (const s of body.slots) {
    if (!s || typeof s !== 'object') return 'Invalid slot';
    if (typeof s.name !== 'string' || !s.name.trim()) return 'Each slot needs a name';
  }
  if (JSON.stringify(body).length > MAX_PAYLOAD_BYTES) return 'List too large';
  return null;
}

// Keep only the recognized slot fields, coercing to strings/null.
function cleanSlot(s) {
  return {
    name: String(s.name).trim(),
    slug: s.slug != null ? String(s.slug) : null,
    provider: s.provider != null ? String(s.provider) : null,
    thumb: s.thumb != null ? String(s.thumb) : null,
    rainbetSlug: s.rainbetSlug != null ? String(s.rainbetSlug) : null,
  };
}

function uid() { return `sl_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`; }

function listSlotLists() { return lists.slice(0, MAX_LISTS); }

function createSlotList({ name, description, provider, slots }, createdBy) {
  const l = {
    id: uid(),
    name: name.trim(),
    description: (description || '').trim(),
    provider: (provider || '').trim(),
    slots: slots.map(cleanSlot),
    createdBy: String(createdBy),
    updatedAt: new Date().toISOString(),
  };
  lists.unshift(l);
  if (lists.length > MAX_LISTS) lists.length = MAX_LISTS;
  persist();
  return l;
}

function updateSlotList(id, { name, description, provider, slots }) {
  const l = lists.find(x => x.id === id);
  if (!l) return null;
  l.name = name.trim();
  l.description = (description || '').trim();
  l.provider = (provider || '').trim();
  l.slots = slots.map(cleanSlot);
  l.updatedAt = new Date().toISOString();
  persist();
  return l;
}

function deleteSlotList(id) {
  const i = lists.findIndex(x => x.id === id);
  if (i === -1) return false;
  lists.splice(i, 1);
  persist();
  return true;
}

module.exports = {
  initSlotLists,
  listSlotLists,
  createSlotList,
  updateSlotList,
  deleteSlotList,
  validateInput,
};
