# Custom Card Requests ("Shop Requests") Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the DM-only custom-card commission flow with an in-site request form on the Shop that stores requests server-side and surfaces them in a platform-admin "Shop Requests" tab with a status workflow.

**Architecture:** Clone of the announcements/slot-lists pattern — a `hunts_kv`-backed lib module (`lib/cardRequests.js`) + dependency-injected router (`routes/cardRequests.routes.js`) on the backend; a request modal on the Shop page + an admin tab on the frontend. New requests fire a best-effort Discord embed via the existing business tickets bot.

**Tech Stack:** Node/Express (no build step), node:test, Postgres `hunts_kv`, React (CRA), react-router v6.

**Spec:** `docs/superpowers/specs/2026-07-13-card-requests-design.md` (backend repo).

## Global Constraints

- Two separate repos: backend work in `communityhunts-backend/`, frontend work in `communityhunts-frontend/` (the wrapper dir is NOT a git repo — run git only inside the app dirs).
- **Backend merges/deploys FIRST** — the Shop button must never ship before its endpoint.
- Work on feature branches: backend `feat/card-requests`, frontend `feat/shop-requests`. `git pull --ff-only` before branching. Never push to `main` directly.
- **No `Co-Authored-By` or Claude attribution in commits or PR bodies.**
- Frontend gate: `CI=true npm run build` must print "Compiled successfully" before any push (Vercel fails on warnings).
- Backend tests: `node --test lib/` must pass.
- Frontend file discipline: new UI piece = new file; Shop pages use `C` from `src/pages/home/palette` (NOT `useTheme()` — Shop is on the home palette split); admin pages use `useTheme()`.
- Status enum (exact strings everywhere): `new`, `awaiting_tip`, `in_progress`, `done`, `declined`. Open statuses = `new`, `awaiting_tip`, `in_progress`.
- Field caps (exact): idea ≤2000, cardName ≤80, rainbetUsername ≤80, adminNotes ≤2000, refLinks ≤5 entries × ≤300 chars, http(s) only.

---

### Task 1: Backend lib — `lib/cardRequests.js` (TDD)

**Files:**
- Create: `communityhunts-backend/lib/cardRequests.js`
- Test: `communityhunts-backend/lib/cardRequests.test.js`
- Modify: `communityhunts-backend/.gitignore` (add fallback file)

**Interfaces:**
- Consumes: nothing (self-contained; `initCardRequests({ pgPool })` is called by server.js in Task 2).
- Produces (Task 2 relies on these exact names):
  - `initCardRequests(deps)` → Promise
  - `listRequests()` → array, newest first
  - `openCountFor(userId)` → number of requests by that user in an open status
  - `validateInput(body)` → error string | null
  - `validateUpdate(patch)` → error string | null
  - `createRequest(body, sessionUser)` → request object
  - `updateRequest(id, patch)` → request | null
  - `deleteRequest(id)` → boolean
  - `STATUSES` → the 5-value array

- [ ] **Step 1: Create feature branch**

```bash
cd communityhunts-backend
git pull --ff-only
git checkout -b feat/card-requests
```

- [ ] **Step 2: Write the failing tests**

Create `lib/cardRequests.test.js`:

```js
const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const cardRequests = require('./cardRequests');

// With no pgPool configured the module persists to card_requests.json in the
// backend root (file fallback). Remove it after the run so tests leave no artifact.
after(() => {
  try { fs.unlinkSync(path.join(__dirname, '..', 'card_requests.json')); } catch {}
});

const USER = { id: '168055630916091904', displayName: 'Goofer', avatar: 'https://cdn.discordapp.com/a.png' };

test('validateInput rejects a missing idea', () => {
  assert.strictEqual(cardRequests.validateInput({}), 'Tell us your card idea');
  assert.strictEqual(cardRequests.validateInput({ idea: '   ' }), 'Tell us your card idea');
});

test('validateInput rejects an oversized idea', () => {
  assert.match(cardRequests.validateInput({ idea: 'x'.repeat(2001) }), /too long/i);
});

test('validateInput accepts a well-formed body', () => {
  assert.strictEqual(
    cardRequests.validateInput({ idea: 'A card with my dog on it', cardName: 'Doge', refLinks: ['https://i.imgur.com/x.png'], rainbetUsername: 'goof' }),
    null
  );
});

test('validateUpdate rejects an unknown status and oversized notes', () => {
  assert.strictEqual(cardRequests.validateUpdate({ status: 'archived' }), 'Invalid status');
  assert.match(cardRequests.validateUpdate({ adminNotes: 'x'.repeat(2001) }), /too long/i);
  assert.strictEqual(cardRequests.validateUpdate({ status: 'awaiting_tip', adminNotes: 'tip requested 7/13' }), null);
});

test('createRequest sanitizes links: drops non-http(s), caps at 5', () => {
  const r = cardRequests.createRequest({
    idea: 'Link test',
    refLinks: ['https://a.com/1', 'javascript:alert(1)', 'ftp://b.com', 'http://c.com/2',
               'https://d.com/3', 'https://e.com/4', 'https://f.com/5', 'https://g.com/6'],
  }, USER);
  assert.deepStrictEqual(r.refLinks, ['https://a.com/1', 'http://c.com/2', 'https://d.com/3', 'https://e.com/4', 'https://f.com/5']);
  cardRequests.deleteRequest(r.id);
});

test('createRequest snapshots the session user and defaults', () => {
  const r = cardRequests.createRequest({ idea: 'Snapshot test' }, USER);
  assert.strictEqual(r.userId, USER.id);
  assert.strictEqual(r.displayName, 'Goofer');
  assert.strictEqual(r.avatar, USER.avatar);
  assert.strictEqual(r.status, 'new');
  assert.strictEqual(r.adminNotes, '');
  assert.ok(r.id && r.createdAt && r.updatedAt);
  cardRequests.deleteRequest(r.id);
});

test('openCountFor counts only open statuses', () => {
  const a = cardRequests.createRequest({ idea: 'one' }, USER);
  const b = cardRequests.createRequest({ idea: 'two' }, USER);
  const c = cardRequests.createRequest({ idea: 'three' }, USER);
  assert.strictEqual(cardRequests.openCountFor(USER.id), 3);
  cardRequests.updateRequest(b.id, { status: 'done' });
  cardRequests.updateRequest(c.id, { status: 'declined' });
  assert.strictEqual(cardRequests.openCountFor(USER.id), 1);
  assert.strictEqual(cardRequests.openCountFor('999'), 0);
  [a, b, c].forEach(r => cardRequests.deleteRequest(r.id));
});

test('create → list → update → delete round trip', () => {
  const r = cardRequests.createRequest({ idea: 'Round trip', cardName: 'RT' }, USER);
  assert.ok(cardRequests.listRequests().some(x => x.id === r.id), 'appears in list');

  const updated = cardRequests.updateRequest(r.id, { status: 'awaiting_tip', adminNotes: 'approved, DMed for tip' });
  assert.strictEqual(updated.status, 'awaiting_tip');
  assert.strictEqual(updated.adminNotes, 'approved, DMed for tip');
  assert.strictEqual(updated.idea, 'Round trip', 'user content untouched');

  assert.strictEqual(cardRequests.updateRequest('cr_nope', { status: 'done' }), null, 'unknown id → null');
  assert.strictEqual(cardRequests.deleteRequest(r.id), true);
  assert.strictEqual(cardRequests.deleteRequest(r.id), false, 'second delete is a no-op');
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `node --test lib/cardRequests.test.js`
Expected: FAIL — `Cannot find module './cardRequests'`

- [ ] **Step 4: Write the implementation**

Create `lib/cardRequests.js`:

```js
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

const STATUSES = ['new', 'awaiting_tip', 'in_progress', 'done', 'declined'];
const OPEN_STATUSES = new Set(['new', 'awaiting_tip', 'in_progress']);

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
  r.updatedAt = new Date().toISOString();
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
  deleteRequest,
  STATUSES,
};
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test lib/cardRequests.test.js`
Expected: all tests PASS. Then run the full suite: `node --test lib/` — everything still green.

- [ ] **Step 6: Add the fallback file to .gitignore**

In `.gitignore`, under the `# auto-generated data / cache (never commit)` block, add:

```text
card_requests.json
```

- [ ] **Step 7: Commit**

```bash
git add lib/cardRequests.js lib/cardRequests.test.js .gitignore
git commit -m "feat: card requests store (hunts_kv-backed lib + tests)"
```

---

### Task 2: Backend routes + mount — `routes/cardRequests.routes.js`

**Files:**
- Create: `communityhunts-backend/routes/cardRequests.routes.js`
- Modify: `communityhunts-backend/server.js` (mount after the slotLists block, ~line 378)
- Modify: `communityhunts-backend/.env.example` (document the optional channel var)

**Interfaces:**
- Consumes: `lib/cardRequests.js` exports (Task 1); `requireAuth`, `requirePlatformAdmin` from the server.js auth destructure (already in scope at the mount site).
- Produces (Tasks 3–4 rely on these exact endpoints):
  - `POST /api/card-requests` — auth'd; body `{idea, cardName?, refLinks?, rainbetUsername?}` → `{ok:true, discord}` | 400 | 429
  - `GET /api/admin/card-requests` — platform admin → `{requests: [...]}` newest-first
  - `PUT /api/admin/card-requests/:id` — platform admin; body `{status?, adminNotes?}` → updated request | 400 | 404
  - `DELETE /api/admin/card-requests/:id` — platform admin → `{ok:true}` | 404

- [ ] **Step 1: Write the router**

Create `routes/cardRequests.routes.js`:

```js
// Custom card commission requests ("Shop Requests").
//   POST   /api/card-requests            — any signed-in user submits an idea (rate-limited)
//   GET    /api/admin/card-requests      — platform admin: full list, newest first
//   PUT    /api/admin/card-requests/:id  — platform admin: status / adminNotes only
//   DELETE /api/admin/card-requests/:id  — platform admin
// On submit, a best-effort Discord embed goes to the business server (the doorbell);
// the request is already saved — a Discord failure never fails the request.

const express = require('express');

const MAX_OPEN_PER_USER = 2;
const EMBED_COLOR = 0xa78bfa; // community accent (violet)

// Discord embed caps mirror routes/misc.routes.js: title ≤256, description ≤4096
// (3900 for margin), field value ≤1024.
function buildRequestEmbed(r) {
  const fields = [
    { name: 'From', value: `${r.displayName} (${r.userId})`.slice(0, 1024), inline: false },
  ];
  if (r.cardName) fields.push({ name: 'Card name', value: r.cardName.slice(0, 1024), inline: true });
  if (r.rainbetUsername) fields.push({ name: 'Rainbet', value: r.rainbetUsername.slice(0, 1024), inline: true });
  if (r.refLinks.length) fields.push({ name: 'References', value: r.refLinks.join('\n').slice(0, 1024), inline: false });
  return {
    title: '🎨 Custom Card Request',
    description: r.idea.slice(0, 3900),
    color: EMBED_COLOR,
    fields,
    timestamp: r.createdAt,
    footer: { text: 'CommunityHunts — Shop Requests' },
  };
}

module.exports = function cardRequestsRoutes(deps) {
  const { requireAuth, requirePlatformAdmin, cardRequests, ticketsBotToken, channelId } = deps;
  const router = express.Router();
  const ipHits = new Map(); // per-IP submit timestamps (same throttle pattern as /api/tickets)

  router.post('/api/card-requests', requireAuth, async (req, res) => {
    // Per-IP throttle: 5 submits per 10 minutes.
    const ip = req.ip || 'unknown';
    const now = Date.now();
    const recent = (ipHits.get(ip) || []).filter(t => now - t < 10 * 60 * 1000);
    if (recent.length >= 5) return res.status(429).json({ error: 'Too many requests — please try again in a few minutes' });

    // Per-user cap on open requests (new / awaiting_tip / in_progress).
    if (cardRequests.openCountFor(req.user.id) >= MAX_OPEN_PER_USER)
      return res.status(429).json({ error: "You already have open card requests — we'll DM you about those first" });

    const err = cardRequests.validateInput(req.body);
    if (err) return res.status(400).json({ error: err });

    recent.push(now);
    ipHits.set(ip, recent);
    const r = cardRequests.createRequest(req.body, req.user);

    // Best-effort Discord doorbell (announcements pattern: saved first, failure only logged).
    let discord = 'skipped';
    if (ticketsBotToken && channelId) {
      try {
        const resp = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
          method: 'POST',
          headers: { Authorization: `Bot ${ticketsBotToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ embeds: [buildRequestEmbed(r)] }),
        });
        if (!resp.ok) throw new Error(`Discord returned ${resp.status}`);
        discord = 'posted';
        console.log(`[cardreq] request ${r.id} posted to Discord`);
      } catch (e) {
        discord = 'failed';
        console.error('[cardreq] Discord notify failed:', e.message);
      }
    }
    res.json({ ok: true, discord });
  });

  router.get('/api/admin/card-requests', requireAuth, requirePlatformAdmin, (req, res) => {
    res.json({ requests: cardRequests.listRequests() });
  });

  router.put('/api/admin/card-requests/:id', requireAuth, requirePlatformAdmin, (req, res) => {
    const err = cardRequests.validateUpdate(req.body);
    if (err) return res.status(400).json({ error: err });
    const r = cardRequests.updateRequest(String(req.params.id), req.body);
    if (!r) return res.status(404).json({ error: 'Request not found' });
    res.json(r);
  });

  router.delete('/api/admin/card-requests/:id', requireAuth, requirePlatformAdmin, (req, res) => {
    if (!cardRequests.deleteRequest(String(req.params.id))) return res.status(404).json({ error: 'Request not found' });
    res.json({ ok: true });
  });

  return router;
};
```

- [ ] **Step 2: Mount it in server.js**

In `server.js`, directly AFTER the slot-lists block (ends ~line 378 with `}));`), add:

```js
// Custom card commission requests ("Shop Requests") — signed-in submit, owner-only review.
// Discord doorbell uses the business tickets bot; dedicated channel env falls back to the
// tickets channel so it works with zero new Railway config.
const cardRequests = require('./lib/cardRequests');
cardRequests.initCardRequests({ pgPool }).catch(e => console.error('[cardreq] init error:', e.message));
app.use(require('./routes/cardRequests.routes')({
  requireAuth, requirePlatformAdmin, cardRequests,
  ticketsBotToken: process.env.DISCORD_TICKETS_BOT_TOKEN,
  channelId: process.env.DISCORD_SHOP_REQUESTS_CHANNEL_ID || process.env.DISCORD_TICKETS_CHANNEL_ID,
}));
```

(`requireAuth` and `requirePlatformAdmin` are already destructured from `auth` at the top of server.js — nothing to import.)

- [ ] **Step 3: Document the env var**

In `.env.example`, next to the existing `DISCORD_TICKETS_CHANNEL_ID` / `DISCORD_SUGGESTIONS_CHANNEL_ID` lines, add:

```text
# Optional: dedicated channel for custom-card commission requests.
# Falls back to DISCORD_TICKETS_CHANNEL_ID when unset.
DISCORD_SHOP_REQUESTS_CHANNEL_ID=
```

- [ ] **Step 4: Syntax + test + boot check**

```bash
node --check routes/cardRequests.routes.js
node --check server.js
node --test lib/
```

Expected: both checks silent, all lib tests pass.

Boot smoke (dummy Discord creds trick — backend boots without real secrets; use a free port):

```powershell
$env:PORT='3101'; $env:DISCORD_CLIENT_ID='x'; $env:DISCORD_CLIENT_SECRET='x'; $env:SESSION_SECRET='x'; node server.js
```

Expected in the log: no crash, `[cardreq] Loaded 0 card requests from file` (or Postgres if DATABASE_URL is set). An unauthenticated smoke from a second shell must 401:

```powershell
curl.exe -s -X POST http://localhost:3101/api/card-requests -H "Content-Type: application/json" -d '{\"idea\":\"test\"}'
```

Expected: an auth error (401/403 JSON), NOT a 404 — proves the route is mounted. Stop the server after.

- [ ] **Step 5: Commit**

```bash
git add routes/cardRequests.routes.js server.js .env.example
git commit -m "feat: card request routes + Discord doorbell (Shop Requests)"
```

---

### Task 3: Frontend submit flow — Shop button + RequestCardModal

**Files:**
- Create: `communityhunts-frontend/src/pages/shop/RequestCardModal.js`
- Modify: `communityhunts-frontend/src/cosmetics/catalog.js:35` (card_custom desc copy)
- Modify: `communityhunts-frontend/src/pages/shop/CosmeticGrid.js` (props + action button)
- Modify: `communityhunts-frontend/src/pages/Shop.js` (modal state + gridProps)

**Interfaces:**
- Consumes: `POST /api/card-requests` (Task 2) via `apiFetch` from `src/api.js` (throws `Error(message)` on non-2xx — server error strings surface as `e.message`).
- Produces: `CosmeticGrid` gains an optional `onRequest` prop (function, called on the Request button click); `RequestCardModal` takes `{ onClose }`.

- [ ] **Step 1: Create feature branch**

```bash
cd communityhunts-frontend
git pull --ff-only
git checkout -b feat/shop-requests
```

- [ ] **Step 2: Update the Custom Card copy**

In `src/cosmetics/catalog.js` line 35, replace the desc (it currently says "Commissioned on request via Discord DM · $25 via RB tip 🌈"):

```js
  { id: 'card_custom',   cat: 'card', name: 'Custom Card',  price: 0,   desc: 'Your card, your style — designed however you want it. $25 via RB tip — hit "Request yours" to get started 🌈', onRequest: true },
```

- [ ] **Step 3: Add the Request button to CosmeticGrid**

In `src/pages/shop/CosmeticGrid.js`:

3a. Add `onRequest` to the CosmeticGrid props destructure (line 13-15):

```js
export default function CosmeticGrid({
  items, cosmetics, canEquip, userTier, userId, isMod, purchasing, canPurchase, onEquip, onBuy, onPreview, onRequest,
}) {
```

3b. Pass it to the top-level `ItemCard` (the non-variant branch, after `onPreview={() => onPreview(item)}`):

```js
          onRequest={onRequest}
```

(Do NOT thread it through `VariantCard` — variant groups are exclusive cards, never `onRequest`.)

3c. Add `onRequest` to the ItemCard props destructure (line 70-71):

```js
function ItemCard({ item, isActive, accessible, accessLabel, purchasing, canPurchase, onEquip, onBuy, onPreview, onRequest,
  variants, equippedVariantId, onSelectVariant, groupActive }) {
```

3d. In the action area, replace the showcase-null branch (line 189):

```js
        ) : item.exclusiveUserId || item.onRequest || item.modOnly ? null /* exclusive / made-to-order / mod-only: showcase only, no Buy/Plan action */ : canPurchase ? (
```

with:

```js
        ) : item.onRequest && onRequest ? (
          <button onClick={onRequest} style={{
            height: 30, padding: '0 14px', borderRadius: 8, fontSize: 12, fontWeight: 600, fontFamily: C.display,
            background: `linear-gradient(135deg,${C.v400},${C.v700})`,
            border: 'none', color: '#fff', cursor: 'pointer',
          }}>
            Request yours →
          </button>
        ) : item.exclusiveUserId || item.onRequest || item.modOnly ? null /* exclusive / mod-only: showcase only, no Buy/Plan action */ : canPurchase ? (
```

- [ ] **Step 4: Write RequestCardModal**

Create `src/pages/shop/RequestCardModal.js`:

```js
import { useState } from 'react';
import { C } from '../home/palette';
import { apiFetch } from '../../api';

// Commission-request form for the Custom Card ("Shop Requests" flow). Shop.js
// renders it when the Custom Card tile's "Request yours" button is clicked; the
// Shop page already requires a session, so the submitter is always signed in.
// Server is the source of truth for validation/caps — errors surface verbatim.
const MAX_LINKS = 5;

export default function RequestCardModal({ onClose }) {
  const [idea, setIdea] = useState('');
  const [cardName, setCardName] = useState('');
  const [rainbet, setRainbet] = useState('');
  const [links, setLinks] = useState(['']);
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState('');

  const setLink = (i, v) => setLinks(ls => ls.map((l, j) => (j === i ? v : l)));

  const submit = async () => {
    if (!idea.trim() || sending) return;
    setError('');
    setSending(true);
    try {
      await apiFetch('/api/card-requests', {
        method: 'POST',
        body: JSON.stringify({
          idea: idea.trim(),
          cardName: cardName.trim(),
          rainbetUsername: rainbet.trim(),
          refLinks: links.map(l => l.trim()).filter(Boolean),
        }),
      });
      setSent(true);
    } catch (e) {
      setError(e.message || 'Something went wrong — please try again');
    }
    setSending(false);
  };

  const label = { display: 'block', fontSize: 12, fontWeight: 700, color: C.t2, letterSpacing: '.03em', margin: '0 0 6px' };
  const input = {
    width: '100%', height: 38, padding: '0 12px', boxSizing: 'border-box',
    background: 'rgba(255,255,255,.05)', border: '1px solid rgba(255,255,255,.12)',
    borderRadius: 8, color: C.t1, fontSize: 13, outline: 'none',
  };

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 10000, background: 'rgba(0,0,0,.65)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16,
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          width: '100%', maxWidth: 460, maxHeight: '90vh', overflowY: 'auto',
          background: C.card, border: '1px solid rgba(255,255,255,.1)', borderRadius: 16, padding: 24,
        }}
      >
        {sent ? (
          <div style={{ textAlign: 'center', padding: '16px 0' }}>
            <div style={{ fontSize: 34, marginBottom: 10 }}>🎨</div>
            <div style={{ fontFamily: C.display, fontWeight: 700, fontSize: 18, color: C.t1, marginBottom: 8 }}>Request received!</div>
            <p style={{ fontSize: 13, lineHeight: 1.6, color: C.muted, margin: '0 0 18px' }}>
              We'll DM you on Discord to talk through the design and the $25 RB tip. No tip needed until we approve the idea.
            </p>
            <button onClick={onClose} style={{
              height: 36, padding: '0 22px', borderRadius: 8, fontSize: 13, fontWeight: 600, fontFamily: C.display,
              background: `linear-gradient(135deg,${C.v400},${C.v700})`, border: 'none', color: '#fff', cursor: 'pointer',
            }}>
              Done
            </button>
          </div>
        ) : (
          <>
            <div style={{ fontFamily: C.display, fontWeight: 700, fontSize: 18, color: C.t1, marginBottom: 4 }}>
              Request your custom card
            </div>
            <p style={{ fontSize: 12.5, lineHeight: 1.5, color: C.muted, margin: '0 0 18px' }}>
              Tell us what you want and we'll DM you on Discord. The $25 RB tip only happens after we approve the idea.
            </p>

            <div style={{ marginBottom: 14 }}>
              <label style={label}>YOUR IDEA *</label>
              <textarea
                value={idea} onChange={e => setIdea(e.target.value)} maxLength={2000} rows={4}
                placeholder="Theme, colors, characters, vibe — the more detail the better…"
                style={{ ...input, height: 'auto', padding: 10, resize: 'vertical', fontFamily: 'inherit' }}
              />
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 14 }}>
              <div>
                <label style={label}>CARD NAME (OPTIONAL)</label>
                <input style={input} value={cardName} onChange={e => setCardName(e.target.value)} maxLength={80} placeholder="e.g. Night Shift" />
              </div>
              <div>
                <label style={label}>RAINBET USERNAME (OPTIONAL)</label>
                <input style={input} value={rainbet} onChange={e => setRainbet(e.target.value)} maxLength={80} placeholder="For the tip later" />
              </div>
            </div>

            <div style={{ marginBottom: 18 }}>
              <label style={label}>REFERENCE LINKS (OPTIONAL, UP TO {MAX_LINKS})</label>
              {links.map((l, i) => (
                <input
                  key={i} style={{ ...input, marginBottom: 6 }} value={l}
                  onChange={e => setLink(i, e.target.value)} maxLength={300} placeholder="https://…"
                />
              ))}
              {links.length < MAX_LINKS && (
                <button onClick={() => setLinks(ls => [...ls, ''])} style={{
                  height: 28, padding: '0 10px', borderRadius: 6, fontSize: 12, fontWeight: 600,
                  background: 'rgba(255,255,255,.05)', border: '1px solid rgba(255,255,255,.12)',
                  color: C.t2, cursor: 'pointer',
                }}>
                  + Add another link
                </button>
              )}
            </div>

            {error && <div style={{ fontSize: 13, color: '#ff6b6b', fontWeight: 600, marginBottom: 12 }}>{error}</div>}

            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button onClick={onClose} style={{
                height: 36, padding: '0 16px', borderRadius: 8, fontSize: 13, fontWeight: 600, fontFamily: C.display,
                background: 'transparent', border: '1px solid rgba(255,255,255,.14)', color: C.t2, cursor: 'pointer',
              }}>
                Cancel
              </button>
              <button onClick={submit} disabled={!idea.trim() || sending} style={{
                height: 36, padding: '0 20px', borderRadius: 8, fontSize: 13, fontWeight: 600, fontFamily: C.display,
                background: `linear-gradient(135deg,${C.v400},${C.v700})`, border: 'none', color: '#fff',
                cursor: !idea.trim() || sending ? 'default' : 'pointer', opacity: !idea.trim() || sending ? 0.6 : 1,
              }}>
                {sending ? 'Sending…' : 'Send request'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 5: Wire it into Shop.js**

5a. Add the import (with the other `./shop/` imports):

```js
import RequestCardModal from './shop/RequestCardModal';
```

5b. Add state (next to the other useState calls, ~line 27):

```js
  const [requestOpen, setRequestOpen] = useState(false);
```

5c. Add the handler to `gridProps` (line 180-184):

```js
            const gridProps = {
              cosmetics, canEquip, userTier, userId: user.id, isMod: isCommunityMod(user),
              purchasing, canPurchase,
              onEquip: handleEquip, onBuy: handleBuy, onPreview: handlePreview,
              onRequest: () => setRequestOpen(true),
            };
```

5d. Render the modal (directly after the toast block, inside ShopLayout):

```js
        {requestOpen && <RequestCardModal onClose={() => setRequestOpen(false)} />}
```

- [ ] **Step 6: Build gate**

```bash
CI=true npm run build
```

Expected: "Compiled successfully".

- [ ] **Step 7: Commit**

```bash
git add src/cosmetics/catalog.js src/pages/shop/CosmeticGrid.js src/pages/shop/RequestCardModal.js src/pages/Shop.js
git commit -m "feat: custom card request form on the Shop (replaces DM-only flow)"
```

---

### Task 4: Frontend admin surface — Shop Requests tab

**Files:**
- Create: `communityhunts-frontend/src/admin/AdminShopRequests.js`
- Modify: `communityhunts-frontend/src/admin/adminApi.js` (3 calls)
- Modify: `communityhunts-frontend/src/admin/AdminLayout.js` (tab, `platformOnly: true`)
- Modify: `communityhunts-frontend/src/App.js` (route under BOTH admin mounts)

**Interfaces:**
- Consumes: `GET/PUT/DELETE /api/admin/card-requests` (Task 2). GET returns `{requests: [...]}`; PUT takes `{status?, adminNotes?}` and returns the updated request.
- Produces: route path `shop-requests` under `/admin` and `/:slug/admin`.

- [ ] **Step 1: Add the admin API calls**

In `src/admin/adminApi.js`, after the socials block:

```js
// Shop Requests (custom card commissions — platform admin only).
export const getCardRequests = () => apiFetch('/api/admin/card-requests');
export const updateCardRequest = (id, patch) =>
  apiFetch(`/api/admin/card-requests/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(patch) });
export const deleteCardRequest = (id) =>
  apiFetch(`/api/admin/card-requests/${encodeURIComponent(id)}`, { method: 'DELETE' });
```

- [ ] **Step 2: Write the admin page**

Create `src/admin/AdminShopRequests.js`:

```js
import { useState, useEffect } from 'react';
import { useOutletContext } from 'react-router-dom';
import { useTheme } from '../theme/ThemeContext';
import { getCardRequests, updateCardRequest, deleteCardRequest } from './adminApi';

// Platform-admin review queue for custom card commissions submitted from the Shop
// ("Request yours" on the Custom Card tile). Statuses mirror the backend enum;
// user content is read-only here — only status and internal notes are editable.
const STATUS_META = {
  new:          { label: 'New',          color: '#a78bfa' },
  awaiting_tip: { label: 'Awaiting tip', color: '#fbbf24' },
  in_progress:  { label: 'In progress',  color: '#22d3ee' },
  done:         { label: 'Done',         color: '#4ade80' },
  declined:     { label: 'Declined',     color: '#ff6b6b' },
};
const STATUSES = Object.keys(STATUS_META);

export default function AdminShopRequests() {
  const C = useTheme();
  const { user } = useOutletContext() || {};
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    getCardRequests()
      .then(r => setRows((r && r.requests) || []))
      .catch(e => setError(e.message || 'Failed to load requests'))
      .finally(() => setLoading(false));
  }, []);

  const setStatus = (id, status) => {
    updateCardRequest(id, { status })
      .then(updated => setRows(rs => rs.map(r => (r.id === id ? updated : r))))
      .catch(e => setError(e.message || 'Failed to update'));
  };

  const saveNotes = (id, adminNotes) => {
    updateCardRequest(id, { adminNotes })
      .then(updated => setRows(rs => rs.map(r => (r.id === id ? updated : r))))
      .catch(e => setError(e.message || 'Failed to save notes'));
  };

  const remove = (id) => {
    if (!window.confirm('Delete this request? This cannot be undone.')) return;
    deleteCardRequest(id)
      .then(() => setRows(rs => rs.filter(r => r.id !== id)))
      .catch(e => setError(e.message || 'Failed to delete'));
  };

  if (user && !user.isPlatformAdmin) return <div style={{ color: C.t3, fontFamily: C.body }}>Platform owners only.</div>;

  return (
    <div style={{ maxWidth: 760, fontFamily: C.body }}>
      <div style={{ fontFamily: C.display, fontWeight: 800, fontSize: 20, color: C.t1, marginBottom: 4 }}>Shop Requests</div>
      <div style={{ color: C.t3, fontSize: 13, marginBottom: 20 }}>
        Custom card commissions from the Shop. Flow: approve the idea → DM them for the $25 RB tip
        (Awaiting tip) → tip lands (In progress) → card ships (Done).
      </div>

      {error && <div style={{ color: C.red, fontSize: 13, fontWeight: 600, marginBottom: 12 }}>{error}</div>}
      {loading ? (
        <div style={{ color: C.t3, fontSize: 13 }}>Loading…</div>
      ) : rows.length === 0 ? (
        <div style={{ color: C.t4, fontSize: 13 }}>No requests yet.</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {rows.map(r => <RequestCard key={r.id} r={r} C={C} onStatus={setStatus} onNotes={saveNotes} onDelete={remove} />)}
        </div>
      )}
    </div>
  );
}

function RequestCard({ r, C, onStatus, onNotes, onDelete }) {
  const [notes, setNotes] = useState(r.adminNotes || '');
  const meta = STATUS_META[r.status] || STATUS_META.new;
  const notesDirty = notes !== (r.adminNotes || '');

  return (
    <div style={{ background: C.sur, border: `1px solid ${C.bdr}`, borderRadius: C.rCard, padding: 16 }}>
      {/* Header: requester identity + status controls */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10, flexWrap: 'wrap' }}>
        {r.avatar ? <img src={r.avatar} alt="" style={{ width: 30, height: 30, borderRadius: '50%' }} />
                  : <span style={{ width: 30, height: 30, borderRadius: '50%', background: C.bdr, display: 'inline-block' }} />}
        <span style={{ minWidth: 0 }}>
          <span style={{ display: 'block', color: C.t1, fontSize: 13, fontWeight: 700 }}>{r.displayName}</span>
          <span style={{ display: 'block', color: C.t4, fontFamily: C.mono || C.body, fontSize: 11 }}>{r.userId}</span>
        </span>
        <span style={{ color: C.t4, fontSize: 11 }}>{new Date(r.createdAt).toLocaleDateString()}</span>
        <div style={{ flex: 1 }} />
        <span style={{ fontSize: 10, fontWeight: 800, letterSpacing: '.04em', padding: '3px 9px', borderRadius: 999, background: `${meta.color}22`, border: `1px solid ${meta.color}55`, color: meta.color, whiteSpace: 'nowrap' }}>
          {meta.label.toUpperCase()}
        </span>
        <select value={r.status} onChange={e => onStatus(r.id, e.target.value)}
          style={{ height: 30, background: C.sur, color: C.t1, border: `1px solid ${C.bdr}`, borderRadius: C.rCtl, fontFamily: C.body, fontSize: 12, padding: '0 8px' }}>
          {STATUSES.map(s => <option key={s} value={s}>{STATUS_META[s].label}</option>)}
        </select>
      </div>

      {/* Request content (read-only) */}
      {r.cardName && <div style={{ fontSize: 13, color: C.t2, marginBottom: 6 }}><b>Card name:</b> {r.cardName}</div>}
      <div style={{ fontSize: 13, color: C.t1, lineHeight: 1.5, whiteSpace: 'pre-wrap', marginBottom: 8 }}>{r.idea}</div>
      {r.rainbetUsername && <div style={{ fontSize: 12, color: C.t3, marginBottom: 6 }}>Rainbet: <span style={{ color: C.t2 }}>{r.rainbetUsername}</span></div>}
      {r.refLinks && r.refLinks.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2, marginBottom: 8 }}>
          {r.refLinks.map((l, i) => (
            <a key={i} href={l} target="_blank" rel="noopener noreferrer" style={{ fontSize: 12, color: C.accent || C.gold, wordBreak: 'break-all' }}>{l}</a>
          ))}
        </div>
      )}

      {/* Internal notes + delete */}
      <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start', marginTop: 10 }}>
        <textarea value={notes} onChange={e => setNotes(e.target.value)} maxLength={2000} rows={2}
          placeholder="Internal notes (tip received, design links, …)"
          style={{ flex: 1, padding: 8, background: C.bg, border: `1px solid ${C.bdr}`, borderRadius: C.rCtl, color: C.t1, fontFamily: C.body, fontSize: 12, resize: 'vertical', boxSizing: 'border-box' }} />
        <button onClick={() => onNotes(r.id, notes)} disabled={!notesDirty}
          style={{ height: 30, padding: '0 12px', background: notesDirty ? (C.accent || C.gold) : C.bdr, border: 'none', borderRadius: C.rCtl, color: notesDirty ? C.bg : C.t3, fontFamily: C.body, fontWeight: 700, fontSize: 12, cursor: notesDirty ? 'pointer' : 'default' }}>
          Save
        </button>
        <button onClick={() => onDelete(r.id)}
          style={{ height: 30, padding: '0 12px', background: 'transparent', border: `1px solid ${C.red}`, borderRadius: C.rCtl, color: C.red, fontFamily: C.body, fontSize: 12, cursor: 'pointer' }}>
          Delete
        </button>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Add the tab to AdminLayout**

In `src/admin/AdminLayout.js`, in the `tabs` array (after the Announcements entry):

```js
    { to: `${base}/shop-requests`, label: 'Shop Requests', platformOnly: true },
```

- [ ] **Step 4: Add the routes in App.js**

4a. Import (with the other admin imports, ~line 43):

```js
import AdminShopRequests from './admin/AdminShopRequests';
```

4b. Under the bare `/admin` mount (near `<Route path="socials" element={<AdminSocials />} />`, ~line 178):

```js
          <Route path="shop-requests" element={<AdminShopRequests />} />
```

4c. Under the `/:slug/admin` mount (same sibling position, ~line 213):

```js
            <Route path="shop-requests" element={<AdminShopRequests />} />
```

- [ ] **Step 5: Build gate**

```bash
CI=true npm run build
```

Expected: "Compiled successfully".

- [ ] **Step 6: Commit**

```bash
git add src/admin/AdminShopRequests.js src/admin/adminApi.js src/admin/AdminLayout.js src/App.js
git commit -m "feat: Shop Requests admin tab (custom card commission queue)"
```

---

### Task 5: End-to-end verification + ship

**Files:** none (verification + git only)

**Interfaces:**
- Consumes: everything above.
- Produces: two open PRs; backend merges first.

- [ ] **Step 1: Backend local E2E**

From `communityhunts-backend/` on `feat/card-requests`, boot with dummy creds (`$env:PORT='3101'; $env:DISCORD_CLIENT_ID='x'; $env:DISCORD_CLIENT_SECRET='x'; $env:SESSION_SECRET='x'; node server.js`). Verify:
- Boot log shows `[cardreq] Loaded 0 card requests` and no crash.
- `POST /api/card-requests` without a session → 401/403 (not 404).
- `GET /api/admin/card-requests` without a session → 401/403 (not 404).
- `node --test lib/` all green.

- [ ] **Step 2: Push branches, open PRs**

```bash
# backend
cd communityhunts-backend
git push -u origin feat/card-requests
gh pr create --title "Custom card requests: store, routes + Discord doorbell (Shop Requests)" --body "Adds the backend half of the Shop Requests flow: hunts_kv-backed lib/cardRequests.js (+ node:test suite), POST /api/card-requests (auth'd, per-IP throttle + 2-open-per-user cap), platform-admin GET/PUT/DELETE under /api/admin/card-requests, and a best-effort Discord embed via the business tickets bot (DISCORD_SHOP_REQUESTS_CHANNEL_ID, falls back to the tickets channel). Spec: docs/superpowers/specs/2026-07-13-card-requests-design.md. Tested: node --test lib/ green; local boot verifies mount + auth gates. Merge BEFORE the frontend PR."

# frontend
cd ../communityhunts-frontend
git push -u origin feat/shop-requests
gh pr create --title "Shop Requests: custom card request form + admin tab" --body "Adds the frontend half of the Shop Requests flow: 'Request yours' button on the Custom Card tile + RequestCardModal (idea, card name, up to 5 reference links, Rainbet username), and a platform-admin Shop Requests tab (status dropdown: New / Awaiting tip / In progress / Done / Declined, internal notes, delete). Replaces the DM-only commission flow. Depends on the backend card-requests PR — MERGE THAT FIRST. CI build green; verified on branch preview."
```

No Claude attribution in either body (repo rule).

- [ ] **Step 3: Vercel preview verification (frontend PR)**

On the branch preview URL (backend not merged yet, so submit returns 404 — that's expected until backend merges; UI-only checks first):
- Shop → Cards → Custom Card tile shows "Request yours →" and the new copy.
- Modal opens, idea required (Send disabled when empty), + Add another link caps at 5, Cancel closes.
- Admin → Shop Requests tab visible to platform admins only (check with View-as-VIP or a non-platform account: tab hidden).

- [ ] **Step 4: Merge backend PR → Railway deploys → full E2E on preview**

After Railway finishes (~1-3 min; sessions reset — log in again):
- Submit a real request from the frontend preview URL → success state appears.
- Discord: embed lands in the tickets channel (or the dedicated channel if the env is set).
- Admin → Shop Requests: request listed with your identity; change status to Awaiting tip; save a note; refresh — both persisted.
- Submit 2 more requests → the 3rd open request is rejected with the "already have open card requests" message.

- [ ] **Step 5: Merge frontend PR**

Merge to `main` (Vercel deploys). Verify the merge-base after merging (merge races have dropped commits in this repo before):

```bash
git checkout main && git pull --ff-only
git log --oneline -5   # both feature commits present
```

- [ ] **Step 6: Production smoke**

On communityhunts.gg: Custom Card tile → modal → submit a real request → check /admin/shop-requests + Discord → delete the test request from the admin tab.

---

## Self-review notes

- Spec coverage: data model (Task 1), guard order throttle→cap→validate (Task 2 — spec listed throttle first; the plan validates after the cap check, matching the spec's order), Discord fallback env (Task 2), catalog copy + grid button + modal (Task 3), admin tab platformOnly + both mounts (Task 4), deploy order + E2E (Task 5). Out-of-scope items untouched.
- Type consistency: `{requests: [...]}` GET shape used in Task 2 and Task 4; `validateUpdate`/`openCountFor` names match between Tasks 1–2; status enum strings identical in lib, router, and STATUS_META.
