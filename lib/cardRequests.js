// Custom equity-card commission requests ("Shop Requests" in the admin hub).
// Any signed-in user submits an idea; platform admins work it through a status
// flow (new → awaiting_tip → in_progress → done | declined). Postgres-backed
// (hunts_kv key 'card_requests') with a JSON file fallback, mirroring
// lib/slotLists.js / lib/announcements.js.
//
// DI: initCardRequests({ pgPool }).

const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'card_requests.json');
const MAX_REQUESTS = 500; // stored-request cap (newest kept)
const MAX_IDEA = 2000;
const MAX_SHORT = 80; // cardName / rainbetUsername
const MAX_NOTES = 2000;
const MAX_LINKS = 5;
const MAX_LINK_LEN = 300;
const MAX_DM_LOG = 10; // per-request DM history cap (newest kept)

const STATUSES = ['new', 'awaiting_tip', 'in_progress', 'done', 'declined'];
const OPEN_STATUSES = new Set(['new', 'awaiting_tip', 'in_progress']);

// Who a request can be assigned to — the two platform owners, by Discord ID (never display
// name; ids are stable). `assignee` is a tracking LABEL, not an auth gate: access to assign is
// the requirePlatformAdmin route gate, which both owners already pass. null = unassigned.
// Add a third owner here (one line) if the platform ever gains one.
const ASSIGNEES = [
  { id: '135203806676779008', label: 'Cabbage' }, // Kyle / PLATFORM_OWNER_IDS
  { id: '168055630916091904', label: 'Goofer' },  // Goofer / ADMIN_IDS
];
const ASSIGNEE_IDS = new Set(ASSIGNEES.map(a => a.id));

let pgPool = null;
let requests = []; // newest first

async function initCardRequests(deps) {
  pgPool = (deps && deps.pgPool) || null;
  if (pgPool) {
    try {
      await pgPool.query(`
        CREATE TABLE IF NOT EXISTS hunts_kv (
          key TEXT PRIMARY KEY,
          value JSONB NOT NULL
        )
      `);
      const r = await pgPool.query("SELECT value FROM hunts_kv WHERE key='card_requests'");
      if (r.rows[0]) {
        requests = Array.isArray(r.rows[0].value) ? r.rows[0].value : [];
        console.log(`[cardreq] Loaded ${requests.length} card requests from Postgres`);
        return;
      }
    } catch (e) { console.error('[cardreq] PG load failed:', e.message); }
  }
  try {
    if (fs.existsSync(FILE)) {
      requests = JSON.parse(fs.readFileSync(FILE, 'utf8'));
      console.log(`[cardreq] Loaded ${requests.length} card requests from file`);
    }
  } catch (e) { console.error('[cardreq] File load failed:', e.message); }
}

function persist() {
  if (pgPool) {
    pgPool.query(
      "INSERT INTO hunts_kv(key,value) VALUES('card_requests',$1) ON CONFLICT(key) DO UPDATE SET value=$1",
      [JSON.stringify(requests)]
    ).catch(e => console.error('[cardreq] PG save failed:', e.message));
  }
  try { fs.writeFileSync(FILE, JSON.stringify(requests), 'utf8'); } catch (e) {}
}

// Validate a submit body. Returns an error string or null.
function validateInput(body) {
  if (!body || typeof body !== 'object') return 'Invalid payload';
  if (typeof body.idea !== 'string' || !body.idea.trim()) return 'Tell us your card idea';
  if (body.idea.length > MAX_IDEA) return `Idea too long (max ${MAX_IDEA} characters)`;
  if (body.cardName !== undefined && (typeof body.cardName !== 'string' || body.cardName.length > MAX_SHORT)) return 'Card name too long';
  if (body.rainbetUsername !== undefined && (typeof body.rainbetUsername !== 'string' || body.rainbetUsername.length > MAX_SHORT)) return 'Rainbet username too long';
  if (body.refLinks !== undefined && !Array.isArray(body.refLinks)) return 'Invalid reference links';
  return null;
}

// Validate an admin PUT patch (status and/or adminNotes). Returns an error string or null.
function validateUpdate(patch) {
  if (!patch || typeof patch !== 'object') return 'Invalid payload';
  if (patch.status !== undefined && !STATUSES.includes(patch.status)) return 'Invalid status';
  if (patch.adminNotes !== undefined && (typeof patch.adminNotes !== 'string' || patch.adminNotes.length > MAX_NOTES)) return 'Notes too long';
  // assignee: null clears it; otherwise it must be a known platform-owner id.
  if (patch.assignee !== undefined && patch.assignee !== null && !ASSIGNEE_IDS.has(patch.assignee)) return 'Invalid assignee';
  return null;
}

// Keep only http(s) links, trimmed and capped — mirrors the socials sanitizer in lib/tenants.
function cleanLinks(refLinks) {
  return (Array.isArray(refLinks) ? refLinks : [])
    .map(l => String(l || '').trim())
    .filter(l => /^https?:\/\//i.test(l) && l.length <= MAX_LINK_LEN)
    .slice(0, MAX_LINKS);
}

function uid() { return `cr_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`; }

function listRequests() { return requests; }

function openCountFor(userId) {
  const id = String(userId);
  return requests.filter(r => r.userId === id && OPEN_STATUSES.has(r.status)).length;
}

function createRequest(body, sessionUser) {
  const now = new Date().toISOString();
  const r = {
    id: uid(),
    createdAt: now,
    updatedAt: now,
    status: 'new',
    assignee: null, // platform-owner Discord id once claimed; null = unassigned
    // Requester identity — snapshotted at submit so the admin view needs no enrichment.
    userId: String(sessionUser.id),
    displayName: String(sessionUser.displayName || sessionUser.username || 'Unknown'),
    avatar: sessionUser.avatar || null,
    // User content — immutable after submit (updateRequest never touches these).
    idea: body.idea.trim(),
    cardName: (body.cardName || '').trim(),
    refLinks: cleanLinks(body.refLinks),
    rainbetUsername: (body.rainbetUsername || '').trim(),
    adminNotes: '',
  };
  requests.unshift(r);
  if (requests.length > MAX_REQUESTS) requests.length = MAX_REQUESTS;
  persist();
  return r;
}

function updateRequest(id, patch) {
  const r = requests.find(x => x.id === id);
  if (!r) return null;
  if (patch.status !== undefined) r.status = patch.status;
  if (patch.adminNotes !== undefined) r.adminNotes = patch.adminNotes;
  if (patch.assignee !== undefined) r.assignee = patch.assignee;
  r.updatedAt = new Date().toISOString();
  persist();
  return r;
}

// Attach the posted Discord message's ids so a later status change can PATCH that same message.
// Pure bookkeeping — does not touch status / adminNotes / updatedAt.
function setDiscordMessage(id, { messageId, channelId }) {
  const r = requests.find(x => x.id === id);
  if (!r) return null;
  r.discordMessageId = messageId;
  r.discordChannelId = channelId;
  persist();
  return r;
}

// Read a single request by id (no mutation). Used by the DM route to read userId before sending.
function getRequest(id) {
  return requests.find(x => x.id === id) || null;
}

// Append a best-effort DM outcome to the request's capped dmLog + stamp lastDmAt. Pure
// bookkeeping — never touches status / adminNotes / updatedAt (mirrors setDiscordMessage).
function recordDm(id, { template, ok, error, message, by } = {}) {
  const r = requests.find(x => x.id === id);
  if (!r) return null;
  if (!Array.isArray(r.dmLog)) r.dmLog = [];
  const at = new Date().toISOString();
  const entry = { at, template: String(template || ''), ok: !!ok };
  if (error) entry.error = String(error).slice(0, 300);
  if (message) entry.message = String(message).slice(0, 2000);
  if (by && by.id) entry.by = { id: String(by.id), name: String(by.name || '') };
  r.dmLog.push(entry);
  if (r.dmLog.length > MAX_DM_LOG) r.dmLog = r.dmLog.slice(-MAX_DM_LOG);
  r.lastDmAt = at;
  persist();
  return r;
}

function deleteRequest(id) {
  const i = requests.findIndex(x => x.id === id);
  if (i === -1) return false;
  requests.splice(i, 1);
  persist();
  return true;
}

module.exports = {
  initCardRequests,
  listRequests,
  openCountFor,
  validateInput,
  validateUpdate,
  createRequest,
  updateRequest,
  setDiscordMessage,
  getRequest,
  recordDm,
  deleteRequest,
  STATUSES,
  ASSIGNEES,
};
