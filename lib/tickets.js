// Bug-tickets / feature-suggestions store. Submitted (publicly) from a community hub via
// POST /api/tickets; platform admins triage them through a status flow
// (new → in_progress → resolved → closed) in the admin hub. Postgres-backed
// (hunts_kv key 'tickets') with a JSON file fallback, mirroring lib/cardRequests.js.
//
// DI: initTickets({ pgPool }).

const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'tickets.json');
const MAX_TICKETS = 500; // stored-ticket cap (newest kept)
const MAX_ISSUE = 5000;
const MAX_NOTES = 2000;

const STATUSES = ['new', 'in_progress', 'resolved', 'closed'];

let pgPool = null;
let tickets = []; // newest first

async function initTickets(deps) {
  pgPool = (deps && deps.pgPool) || null;
  tickets = [];
  if (pgPool) {
    try {
      await pgPool.query(`
        CREATE TABLE IF NOT EXISTS hunts_kv (
          key TEXT PRIMARY KEY,
          value JSONB NOT NULL
        )
      `);
      const r = await pgPool.query("SELECT value FROM hunts_kv WHERE key='tickets'");
      if (r.rows[0]) {
        tickets = Array.isArray(r.rows[0].value) ? r.rows[0].value : [];
        console.log(`[tickets] Loaded ${tickets.length} tickets from Postgres`);
        return;
      }
    } catch (e) { console.error('[tickets] PG load failed:', e.message); }
  }
  try {
    if (fs.existsSync(FILE)) {
      tickets = JSON.parse(fs.readFileSync(FILE, 'utf8'));
      console.log(`[tickets] Loaded ${tickets.length} tickets from file`);
    }
  } catch (e) { console.error('[tickets] File load failed:', e.message); }
}

function persist() {
  if (pgPool) {
    pgPool.query(
      "INSERT INTO hunts_kv(key,value) VALUES('tickets',$1) ON CONFLICT(key) DO UPDATE SET value=$1",
      [JSON.stringify(tickets)]
    ).catch(e => console.error('[tickets] PG save failed:', e.message));
  }
  try { fs.writeFileSync(FILE, JSON.stringify(tickets), 'utf8'); } catch (e) {}
}

// Validate an admin PUT patch (status and/or adminNotes). Returns an error string or null.
function validateUpdate(patch) {
  if (!patch || typeof patch !== 'object') return 'Invalid payload';
  if (patch.status !== undefined && !STATUSES.includes(patch.status)) return 'Invalid status';
  if (patch.adminNotes !== undefined && (typeof patch.adminNotes !== 'string' || patch.adminNotes.length > MAX_NOTES)) return 'Notes too long';
  return null;
}

function uid() { return `tk_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`; }

function listTickets() { return tickets; }

// Create a ticket. `fields` = { type, issue, username, discordChannel }; sessionUser is the signed-in
// Discord user or null (the submit endpoint is public). Identity is snapshotted at submit so the
// admin view needs no enrichment. Content is immutable after submit (updateTicket never touches it).
function createTicket(fields, sessionUser) {
  const now = new Date().toISOString();
  const t = {
    id: uid(),
    createdAt: now,
    updatedAt: now,
    status: 'new',
    type: String(fields.type || 'Other'),
    issue: String(fields.issue || '').slice(0, MAX_ISSUE),
    username: String(fields.username || 'Anonymous'),
    userId: sessionUser ? String(sessionUser.id) : null,
    displayName: sessionUser ? String(sessionUser.displayName || sessionUser.username || 'Unknown') : null,
    avatar: (sessionUser && sessionUser.avatar) || null,
    discordChannel: fields.discordChannel || 'tickets',
    context: fields.context || null,
    adminNotes: '',
  };
  tickets.unshift(t);
  if (tickets.length > MAX_TICKETS) tickets.length = MAX_TICKETS;
  persist();
  return t;
}

function updateTicket(id, patch) {
  const t = tickets.find(x => x.id === id);
  if (!t) return null;
  if (patch.status !== undefined) t.status = patch.status;
  if (patch.adminNotes !== undefined) t.adminNotes = patch.adminNotes;
  t.updatedAt = new Date().toISOString();
  persist();
  return t;
}

// Attach the posted Discord message's ids so a later status change can PATCH that same message.
// Pure bookkeeping — does not touch status / adminNotes / updatedAt.
function setDiscordMessage(id, { messageId, channelId }) {
  const t = tickets.find(x => x.id === id);
  if (!t) return null;
  t.discordMessageId = messageId;
  t.discordChannelId = channelId;
  persist();
  return t;
}

function deleteTicket(id) {
  const i = tickets.findIndex(x => x.id === id);
  if (i === -1) return false;
  tickets.splice(i, 1);
  persist();
  return true;
}

module.exports = {
  initTickets,
  listTickets,
  validateUpdate,
  createTicket,
  updateTicket,
  setDiscordMessage,
  deleteTicket,
  STATUSES,
};
