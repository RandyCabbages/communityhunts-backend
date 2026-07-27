// Supporter applications — a signed-in user states a donation amount + message; platform admins
// work them new → paid → granted → declined. Granting flips the supporters table (in the route).
// Postgres-backed (hunts_kv key 'supporter_applications') with a JSON-file fallback, mirroring
// lib/cardRequests.js. DI: initSupporterApplications({ pgPool }).

const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'supporter_applications.json');
const MAX = 1000;
const MAX_AMOUNT = 40;
const MAX_MESSAGE = 2000;

const STATUSES = ['new', 'paid', 'granted', 'declined'];
const OPEN_STATUSES = new Set(['new', 'paid']);

const { makeKvStore } = require('./kvStore');
// Shared clobber guard: no PG write until a boot read has SUCCEEDED. See lib/kvStore.js.
const kv = makeKvStore('supporter_applications', '[supapp]');

let pgPool = null;
let apps = []; // newest first

async function initSupporterApplications(deps) {
  pgPool = (deps && deps.pgPool) || null;
  kv.attach(pgPool);
  if (pgPool) {
    const { value } = await kv.load();
    if (value) { apps = Array.isArray(value) ? value : []; console.log(`[supapp] Loaded ${apps.length} from Postgres`); return; }
  }
  try { if (fs.existsSync(FILE)) { apps = JSON.parse(fs.readFileSync(FILE, 'utf8')); console.log(`[supapp] Loaded ${apps.length} from file`); } }
  catch (e) { console.error('[supapp] File load failed:', e.message); }
}

function persist() {
  kv.persist(apps);
  try { fs.writeFileSync(FILE, JSON.stringify(apps), 'utf8'); } catch (e) {}
}

function validateInput(body) {
  if (!body || typeof body !== 'object') return 'Invalid payload';
  const amount = typeof body.amount === 'string' ? body.amount.trim() : (typeof body.amount === 'number' ? String(body.amount) : '');
  if (!amount) return 'Enter a donation amount';
  if (amount.length > MAX_AMOUNT) return 'Amount too long';
  if (body.message !== undefined && (typeof body.message !== 'string' || body.message.length > MAX_MESSAGE)) return `Message too long (max ${MAX_MESSAGE} characters)`;
  return null;
}

function validateUpdate(patch) {
  if (!patch || typeof patch !== 'object') return 'Invalid payload';
  if (patch.status !== undefined && !STATUSES.includes(patch.status)) return 'Invalid status';
  if (patch.adminNotes !== undefined && (typeof patch.adminNotes !== 'string' || patch.adminNotes.length > MAX_MESSAGE)) return 'Notes too long';
  return null;
}

function uid() { return `sa_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`; }
function listApplications() { return apps; }
function getApplication(id) { return apps.find(x => x.id === id) || null; }
function openCountFor(userId) { const id = String(userId); return apps.filter(a => a.userId === id && OPEN_STATUSES.has(a.status)).length; }

function createApplication(body, sessionUser) {
  const now = new Date().toISOString();
  const amount = typeof body.amount === 'string' ? body.amount.trim() : String(body.amount);
  const a = {
    id: uid(), createdAt: now, updatedAt: now, status: 'new',
    userId: String(sessionUser.id),
    displayName: String(sessionUser.displayName || sessionUser.username || 'Unknown'),
    avatar: sessionUser.avatar || null,
    amount,
    message: (body.message || '').trim(),
    adminNotes: '',
  };
  apps.unshift(a);
  if (apps.length > MAX) apps.length = MAX;
  persist();
  return a;
}

function updateApplication(id, patch) {
  const a = apps.find(x => x.id === id);
  if (!a) return null;
  if (patch.status !== undefined) a.status = patch.status;
  if (patch.adminNotes !== undefined) a.adminNotes = patch.adminNotes;
  a.updatedAt = new Date().toISOString();
  persist();
  return a;
}

function setDiscordMessage(id, { messageId, channelId }) {
  const a = apps.find(x => x.id === id);
  if (!a) return null;
  a.discordMessageId = messageId; a.discordChannelId = channelId;
  persist();
  return a;
}

function deleteApplication(id) {
  const i = apps.findIndex(x => x.id === id);
  if (i === -1) return false;
  apps.splice(i, 1); persist();
  return true;
}

module.exports = {
  initSupporterApplications, validateInput, validateUpdate, openCountFor,
  createApplication, updateApplication, getApplication, setDiscordMessage,
  listApplications, deleteApplication, STATUSES,
};
