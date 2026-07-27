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
const MAX_DM_LOG = 40; // per-request DM thread cap (newest kept) — carries BOTH directions now

const STATUSES = ['new', 'awaiting_tip', 'in_progress', 'done', 'declined'];
const OPEN_STATUSES = new Set(['new', 'awaiting_tip', 'in_progress']);

// Discord snowflake shape check — see lib/userIds.js. Shape only: that the id EXISTS is proven at
// the route (known_users, else the Discord API), because a well-formed typo is still a typo.
const { isRealDiscordId } = require('./userIds');

// Who a request can be assigned to — the two platform owners, by Discord ID (never display
// name; ids are stable). `assignee` is a tracking LABEL, not an auth gate: access to assign is
// the requirePlatformAdmin route gate, which both owners already pass. null = unassigned.
// Add a third owner here (one line) if the platform ever gains one.
const ASSIGNEES = [
  { id: '135203806676779008', label: 'Cabbage' }, // Kyle / PLATFORM_OWNER_IDS
  { id: '168055630916091904', label: 'Goofer' },  // Goofer / ADMIN_IDS
];
const ASSIGNEE_IDS = new Set(ASSIGNEES.map(a => a.id));

const { makeKvStore } = require('./kvStore');
// Shared clobber guard: no PG write until a boot read has SUCCEEDED. See lib/kvStore.js.
const kv = makeKvStore('card_requests', '[cardreq]');

let pgPool = null;
let requests = []; // newest first

async function initCardRequests(deps) {
  pgPool = (deps && deps.pgPool) || null;
  kv.attach(pgPool);
  if (pgPool) {
    const { value } = await kv.load();
    if (value) {
      requests = Array.isArray(value) ? value : [];
      console.log(`[cardreq] Loaded ${requests.length} card requests from Postgres`);
      return;
    }
  }
  try {
    if (fs.existsSync(FILE)) {
      requests = JSON.parse(fs.readFileSync(FILE, 'utf8'));
      console.log(`[cardreq] Loaded ${requests.length} card requests from file`);
    }
  } catch (e) { console.error('[cardreq] File load failed:', e.message); }
}

function persist() {
  kv.persist(requests);
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

// Validate an admin on-behalf create body: a requester Discord id, then the normal submit rules.
// Returns an error string or null.
function validateAdminCreate(body) {
  if (!body || typeof body !== 'object') return 'Invalid payload';
  // The typeof-string check is load-bearing and must stay ahead of the shape check: a snowflake
  // sent as a JSON *number* exceeds 2^53 and has already lost precision by the time it parses, so
  // accepting it would silently corrupt the id. isRealDiscordId coerces via String(), so it can't
  // catch that on its own.
  if (typeof body.userId !== 'string' || !isRealDiscordId(body.userId)) return 'A valid Discord ID is required';
  return validateInput(body);
}

// Validate an admin PUT patch (status and/or adminNotes). Returns an error string or null.
function validateUpdate(patch) {
  if (!patch || typeof patch !== 'object') return 'Invalid payload';
  if (patch.status !== undefined && !STATUSES.includes(patch.status)) return 'Invalid status';
  if (patch.adminNotes !== undefined && (typeof patch.adminNotes !== 'string' || patch.adminNotes.length > MAX_NOTES)) return 'Notes too long';
  // assignee: null clears it; otherwise it must be a known platform-owner id.
  if (patch.assignee !== undefined && patch.assignee !== null && !ASSIGNEE_IDS.has(patch.assignee)) return 'Invalid assignee';
  // itemId links the request to the catalog card it produced, so the admin UI can release that
  // card when the request is marked done. null clears it. Membership in ITEM_TIERS is checked at
  // the route — the lib can't import it without a routes→lib cycle.
  if (patch.itemId !== undefined && patch.itemId !== null && typeof patch.itemId !== 'string') return 'Invalid item';
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

function createRequest(body, sessionUser, opts) {
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
    // Who FILED it: null when the user submitted from the Shop themselves, { id, name } when a
    // platform admin filed it on their behalf (a DM'd request). Never changes who the requester is
    // — userId/displayName/avatar above stay the requester, which is what the DM button and the
    // card's exclusiveUserId key off.
    createdBy: (opts && opts.createdBy) || null,
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
  if (patch.itemId !== undefined) r.itemId = patch.itemId;
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
// `messageId` is the id Discord assigned our send; it seeds the poller's read cursor.
function recordDm(id, { template, ok, error, message, by, messageId } = {}) {
  const r = requests.find(x => x.id === id);
  if (!r) return null;
  if (!Array.isArray(r.dmLog)) r.dmLog = [];
  const at = new Date().toISOString();
  const entry = { at, dir: 'out', template: String(template || ''), ok: !!ok };
  if (error) entry.error = String(error).slice(0, 300);
  if (message) entry.message = String(message).slice(0, 2000);
  if (by && by.id) entry.by = { id: String(by.id), name: String(by.name || '') };
  if (messageId) entry.messageId = String(messageId);
  r.dmLog.push(entry);
  if (r.dmLog.length > MAX_DM_LOG) r.dmLog = r.dmLog.slice(-MAX_DM_LOG);
  r.lastDmAt = at;
  persist();
  return r;
}

// Attach the requester's DM channel + the read cursor used by lib/dmPoller.js. Both fields are
// optional so the poller can advance the watermark without restating the channel. Pure
// bookkeeping — never touches status / adminNotes / updatedAt.
function setDmChannel(id, { channelId, watermark } = {}) {
  const r = requests.find(x => x.id === id);
  if (!r) return null;
  if (channelId) r.dmChannelId = String(channelId);
  if (watermark) r.dmWatermark = String(watermark);
  persist();
  return r;
}

// Append an inbound DM from the requester to the same dmLog thread as our outbound sends, so the
// admin panel renders one conversation. Deduped on messageId: the poller can re-read a window
// after a failure, and that must never double-append. `at` is Discord's timestamp, not now —
// the thread must read in the order things were actually said. Pure bookkeeping.
function recordReply(id, { messageId, content, at } = {}) {
  const r = requests.find(x => x.id === id);
  if (!r) return null;
  if (!Array.isArray(r.dmLog)) r.dmLog = [];
  const mid = String(messageId || '');
  if (mid && r.dmLog.some(e => e.dir === 'in' && e.messageId === mid)) return r;
  const stamp = at || new Date().toISOString();
  const entry = { at: stamp, dir: 'in', message: String(content || '').slice(0, 2000) };
  if (mid) entry.messageId = mid;
  r.dmLog.push(entry);
  if (r.dmLog.length > MAX_DM_LOG) r.dmLog = r.dmLog.slice(-MAX_DM_LOG);
  r.lastReplyAt = stamp;
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
  validateAdminCreate,
  validateUpdate,
  createRequest,
  updateRequest,
  setDiscordMessage,
  getRequest,
  recordDm,
  setDmChannel,
  recordReply,
  deleteRequest,
  STATUSES,
  OPEN_STATUSES,
  ASSIGNEES,
};
