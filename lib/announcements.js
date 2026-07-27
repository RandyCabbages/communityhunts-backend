// Platform-wide announcements ("patch notes") — visitor-facing update notes,
// published by platform owners only. Postgres-backed (hunts_kv key
// 'announcements') with a JSON file fallback, mirroring lib/settings.js.
//
// DI: initAnnouncements({ pgPool }).

const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'announcements.json');
const MAX_ANNOUNCEMENTS = 20;
const MAX_PAYLOAD_BYTES = 20 * 1024;

const { makeKvStore } = require('./kvStore');
// Shared clobber guard: no PG write until a boot read has SUCCEEDED. See lib/kvStore.js.
const kv = makeKvStore('announcements', '[announce]');

let pgPool = null;
let announcements = []; // newest first

async function initAnnouncements(deps) {
  pgPool = deps.pgPool || null;
  kv.attach(pgPool);
  if (pgPool) {
    const { value } = await kv.load();
    if (value) {
      announcements = Array.isArray(value) ? value : [];
      console.log(`[announce] Loaded ${announcements.length} announcements from Postgres`);
      return;
    }
  }
  try {
    if (fs.existsSync(FILE)) {
      announcements = JSON.parse(fs.readFileSync(FILE, 'utf8'));
      console.log(`[announce] Loaded ${announcements.length} announcements from file`);
    }
  } catch (e) { console.error('[announce] File load failed:', e.message); }
}

function persist() {
  kv.persist(announcements);
  try { fs.writeFileSync(FILE, JSON.stringify(announcements), 'utf8'); } catch (e) {}
}

// Validate a {title, date?, sections} request body. Returns an error string or null.
function validateInput(body) {
  if (!body || typeof body !== 'object') return 'Invalid payload';
  if (typeof body.title !== 'string' || !body.title.trim()) return 'Title required';
  if (body.title.length > 120) return 'Title too long';
  if (body.date !== undefined && (typeof body.date !== 'string' || isNaN(Date.parse(body.date)))) return 'Invalid date';
  if (!Array.isArray(body.sections) || body.sections.length === 0) return 'At least one section required';
  for (const s of body.sections) {
    if (!s || typeof s !== 'object') return 'Invalid section';
    if (typeof s.heading !== 'string' || !s.heading.trim()) return 'Section heading required';
    if (!Array.isArray(s.items) || s.items.length === 0) return 'Each section needs at least one item';
    if (s.items.some(it => typeof it !== 'string' || !it.trim())) return 'Section items must be non-empty text';
  }
  if (JSON.stringify(body).length > MAX_PAYLOAD_BYTES) return 'Announcement too large';
  return null;
}

function uid() { return `a_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`; }

function listAnnouncements() { return announcements.slice(0, MAX_ANNOUNCEMENTS); }

function createAnnouncement({ title, date, sections }, createdBy) {
  const a = {
    id: uid(),
    title: title.trim(),
    date: date || new Date().toISOString().slice(0, 10),
    sections: sections.map(s => ({ heading: s.heading.trim(), items: s.items.map(i => i.trim()) })),
    createdBy: String(createdBy),
    updatedAt: new Date().toISOString(),
  };
  announcements.unshift(a);
  if (announcements.length > MAX_ANNOUNCEMENTS) announcements.length = MAX_ANNOUNCEMENTS;
  persist();
  return a;
}

function updateAnnouncement(id, { title, date, sections }) {
  const a = announcements.find(x => x.id === id);
  if (!a) return null;
  a.title = title.trim();
  if (date) a.date = date;
  a.sections = sections.map(s => ({ heading: s.heading.trim(), items: s.items.map(i => i.trim()) }));
  a.updatedAt = new Date().toISOString();
  persist();
  return a;
}

function deleteAnnouncement(id) {
  const i = announcements.findIndex(x => x.id === id);
  if (i === -1) return false;
  announcements.splice(i, 1);
  persist();
  return true;
}

module.exports = {
  initAnnouncements,
  listAnnouncements,
  createAnnouncement,
  updateAnnouncement,
  deleteAnnouncement,
  validateInput,
};
