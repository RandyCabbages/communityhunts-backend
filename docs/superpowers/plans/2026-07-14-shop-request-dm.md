# Shop Request → DM the Requester Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a manual, templated "DM requester" control to the Shop Requests admin panel so a platform owner can Discord-DM a card-commission requester (e.g. "assigned — awaiting payment") with one click.

**Architecture:** A new best-effort backend route (`POST /api/admin/card-requests/:id/dm`) opens a DM channel with the community bot and posts a plain-text message, recording the outcome in a capped `dmLog` on the request. The frontend adds an editable-prefill template picker per request card. No new bot, no new env var, no `server.js` change.

**Tech Stack:** Node.js/Express + `node:test` (backend, Railway); React CRA (frontend, Vercel); Discord REST API v10.

**Spec:** [docs/superpowers/specs/2026-07-14-shop-request-dm-design.md](../specs/2026-07-14-shop-request-dm-design.md)

## Global Constraints

- **Two repos, backend-first.** Backend (`communityhunts-backend`, Railway) ships and is verified live **before** the frontend (`communityhunts-frontend`, Vercel) merges — the frontend calls the new endpoint.
- **No `Co-Authored-By` / Claude authorship trailers** in any commit or PR.
- **Backend tests:** `node --test lib/cardRequests.test.js routes/cardRequests.routes.test.js` must pass (Node 24 — pass explicit file paths, not a bare directory).
- **Frontend has no test suite.** The gate is `CI=true npm run build` printing "Compiled successfully" (Vercel turns warnings into errors), then manual verification on a **branch preview URL** — never push to `main` to test.
- **Auth gates on Discord ID, never display name.** The route reuses the existing `requirePlatformAdmin` gate; templates read the assignee **label** from `SHOP_ASSIGNEES` (ID-keyed) — do not gate on names.
- **File Discipline (frontend):** new UI → new file; tokens via the passed `C` (from `useTheme()`), never a local token object; keep `AdminShopRequests.js` thin.
- **Best-effort Discord:** a DM failure returns HTTP 200 with `{ ok:false }` and never blocks status/notes. Only bad input (400) / missing request (404) are error statuses.
- **DM message cap:** 2000 characters (matches `MAX_IDEA` / `MAX_NOTES`).
- **Bot token source:** `getPlatformBotToken()` only (the shared community bot) — already injected into the `cardRequests.routes` deps.

---

## Task 1: `getRequest` + `recordDm` helpers in `lib/cardRequests.js`

**Files:**
- Modify: `communityhunts-backend/lib/cardRequests.js`
- Test: `communityhunts-backend/lib/cardRequests.test.js`

**Interfaces:**
- Consumes: the module's existing `requests` array + `persist()`.
- Produces (Task 2 relies on these):
  - `getRequest(id: string) → request | null` — find by id, no mutation.
  - `recordDm(id: string, { template: string, ok: boolean, error?: string }) → request | null` — append a capped (`≤10`) entry `{ at, template, ok, error? }` to `request.dmLog`, set `request.lastDmAt = at`, `persist()`, return the request. Does **not** touch `status` / `adminNotes` / `updatedAt`.

- [ ] **Step 1: Write the failing tests**

Append to `communityhunts-backend/lib/cardRequests.test.js`:

```javascript
test('getRequest returns the request by id, or null', () => {
  const r = cardRequests.createRequest({ idea: 'find me' }, USER);
  assert.strictEqual(cardRequests.getRequest(r.id).id, r.id);
  assert.strictEqual(cardRequests.getRequest('cr_nope'), null);
  cardRequests.deleteRequest(r.id);
});

test('recordDm appends a capped log entry and stamps lastDmAt without touching status/notes', () => {
  const r = cardRequests.createRequest({ idea: 'dm me' }, USER);
  cardRequests.updateRequest(r.id, { status: 'awaiting_tip', adminNotes: 'keep me' });

  const after1 = cardRequests.recordDm(r.id, { template: 'awaiting_payment', ok: true });
  assert.strictEqual(after1.dmLog.length, 1);
  assert.strictEqual(after1.dmLog[0].template, 'awaiting_payment');
  assert.strictEqual(after1.dmLog[0].ok, true);
  assert.ok(after1.lastDmAt, 'lastDmAt stamped');
  assert.strictEqual(after1.status, 'awaiting_tip', 'status untouched');
  assert.strictEqual(after1.adminNotes, 'keep me', 'notes untouched');

  const after2 = cardRequests.recordDm(r.id, { template: 'awaiting_payment', ok: false, error: 'DMs disabled' });
  assert.strictEqual(after2.dmLog.length, 2);
  assert.strictEqual(after2.dmLog[1].ok, false);
  assert.strictEqual(after2.dmLog[1].error, 'DMs disabled');

  for (let i = 0; i < 12; i++) cardRequests.recordDm(r.id, { template: `t${i}`, ok: true });
  const capped = cardRequests.getRequest(r.id);
  assert.strictEqual(capped.dmLog.length, 10, 'capped at 10');
  assert.strictEqual(capped.dmLog[9].template, 't11', 'newest entry kept');

  assert.strictEqual(cardRequests.recordDm('cr_nope', { template: 'x', ok: true }), null, 'unknown id → null');
  cardRequests.deleteRequest(r.id);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd communityhunts-backend && node --test lib/cardRequests.test.js`
Expected: FAIL — `cardRequests.getRequest is not a function` / `cardRequests.recordDm is not a function`.

- [ ] **Step 3: Implement the helpers**

In `communityhunts-backend/lib/cardRequests.js`, add a constant near the other caps (after `const MAX_LINK_LEN = 300;`):

```javascript
const MAX_DM_LOG = 10; // per-request DM history cap (newest kept)
```

Add these two functions just after `setDiscordMessage` (before `deleteRequest`):

```javascript
// Read a single request by id (no mutation). Used by the DM route to read userId before sending.
function getRequest(id) {
  return requests.find(x => x.id === id) || null;
}

// Append a best-effort DM outcome to the request's capped dmLog + stamp lastDmAt. Pure
// bookkeeping — never touches status / adminNotes / updatedAt (mirrors setDiscordMessage).
function recordDm(id, { template, ok, error } = {}) {
  const r = requests.find(x => x.id === id);
  if (!r) return null;
  if (!Array.isArray(r.dmLog)) r.dmLog = [];
  const at = new Date().toISOString();
  const entry = { at, template: String(template || ''), ok: !!ok };
  if (error) entry.error = String(error).slice(0, 300);
  r.dmLog.push(entry);
  if (r.dmLog.length > MAX_DM_LOG) r.dmLog = r.dmLog.slice(-MAX_DM_LOG);
  r.lastDmAt = at;
  persist();
  return r;
}
```

Add both to the `module.exports` object (alongside `setDiscordMessage`):

```javascript
  setDiscordMessage,
  getRequest,
  recordDm,
  deleteRequest,
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd communityhunts-backend && node --test lib/cardRequests.test.js`
Expected: PASS (all tests, including the two new ones).

- [ ] **Step 5: Commit**

```bash
cd communityhunts-backend
git checkout -b feat/shop-request-dm   # skip if the branch already exists
git add lib/cardRequests.js lib/cardRequests.test.js
git commit -m "feat: getRequest + recordDm helpers for Shop Request DMs"
```

---

## Task 2: `POST /api/admin/card-requests/:id/dm` route + route test

**Files:**
- Modify: `communityhunts-backend/routes/cardRequests.routes.js`
- Test: `communityhunts-backend/routes/cardRequests.routes.test.js` (create)

**Interfaces:**
- Consumes: `cardRequests.getRequest` + `cardRequests.recordDm` (Task 1); injected `getPlatformBotToken()`; `requireAuth`, `requirePlatformAdmin` (already in deps).
- Produces: `POST /api/admin/card-requests/:id/dm` with body `{ message: string, template?: string }` →
  - `200 { ok: true, request }` on delivery
  - `200 { ok: false, error, request }` on a best-effort failure (no bot token, Discord 403/other)
  - `400 { error }` empty / >2000-char message
  - `404 { error }` unknown request id

- [ ] **Step 1: Write the failing route test**

Create `communityhunts-backend/routes/cardRequests.routes.test.js`:

```javascript
// POST /api/admin/card-requests/:id/dm — manual, best-effort DM to the requester.
// Two Discord calls per send: open the DM channel (POST /users/@me/channels) → post the message.
// A Discord failure is best-effort: HTTP 200 { ok:false }, the outcome recorded via recordDm.
const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert');
const express = require('express');

const cardRequestsRoutes = require('./cardRequests.routes');

// Stub global fetch: first call (open DM channel) returns a channel id; the message POST's
// result is configurable via `sendResponse`. Keep realFetch for the local test server.
const realFetch = global.fetch;
let discordCalls = [];
let sendResponse = { ok: true, status: 200 };
global.fetch = async (url, opts) => {
  const u = String(url);
  discordCalls.push({ url: u, opts });
  if (u.endsWith('/users/@me/channels')) {
    return { ok: true, status: 200, json: async () => ({ id: 'dm-1' }), text: async () => '' };
  }
  return { ok: sendResponse.ok, status: sendResponse.status, json: async () => ({ id: 'm-1' }), text: async () => '' };
};
after(() => { global.fetch = realFetch; });
beforeEach(() => { discordCalls = []; sendResponse = { ok: true, status: 200 }; });

// In-memory cardRequests stub exposing only what the DM route uses.
function fakeCardRequests(initial) {
  const list = initial.slice();
  return {
    _list: list,
    getRequest: (id) => list.find(x => x.id === id) || null,
    recordDm: (id, entry) => {
      const r = list.find(x => x.id === id);
      if (!r) return null;
      if (!Array.isArray(r.dmLog)) r.dmLog = [];
      r.dmLog.push({ at: 'stamped', ...entry });
      r.lastDmAt = 'stamped';
      return r;
    },
  };
}

function appWith({ requests = [], admin = true, platformToken = 'ptok' } = {}) {
  const app = express();
  app.use(express.json());
  const requireAuth = (req, res, next) => next();
  const requirePlatformAdmin = admin ? (req, res, next) => next() : (req, res, next) => res.status(403).json({ error: 'forbidden' });
  const cardRequests = fakeCardRequests(requests);
  app.use(cardRequestsRoutes({ requireAuth, requirePlatformAdmin, cardRequests, getPlatformBotToken: () => platformToken, channelId: '999' }));
  app._cardRequests = cardRequests;
  return app;
}

async function postDm(app, id, body) {
  const server = await new Promise(resolve => { const s = app.listen(0, () => resolve(s)); });
  try {
    const r = await realFetch(`http://127.0.0.1:${server.address().port}/api/admin/card-requests/${id}/dm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: r.status, body: await r.json().catch(() => null) };
  } finally {
    server.close();
  }
}

const REQ = { id: 'cr_1', userId: '168055630916091904', displayName: 'Goofer', cardName: 'Doge' };

test('a successful DM opens the channel then posts the message, and records ok:true', async () => {
  const app = appWith({ requests: [{ ...REQ }] });
  const r = await postDm(app, 'cr_1', { message: 'hello there', template: 'awaiting_payment' });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.ok, true);
  // Two Discord calls, in order.
  assert.strictEqual(discordCalls.length, 2);
  assert.match(discordCalls[0].url, /\/users\/@me\/channels$/);
  assert.strictEqual(JSON.parse(discordCalls[0].opts.body).recipient_id, REQ.userId);
  assert.match(discordCalls[1].url, /\/channels\/dm-1\/messages$/);
  assert.strictEqual(JSON.parse(discordCalls[1].opts.body).content, 'hello there');
  assert.strictEqual(discordCalls[1].opts.headers.Authorization, 'Bot ptok');
  // Outcome recorded on the request.
  const stored = app._cardRequests._list[0];
  assert.strictEqual(stored.dmLog.length, 1);
  assert.strictEqual(stored.dmLog[0].ok, true);
  assert.strictEqual(r.body.request.dmLog[0].ok, true);
});

test('a Discord 403 on the message post is best-effort: 200 { ok:false } + recorded failure', async () => {
  sendResponse = { ok: false, status: 403 };
  const app = appWith({ requests: [{ ...REQ }] });
  const r = await postDm(app, 'cr_1', { message: 'hi', template: 'awaiting_payment' });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.ok, false);
  assert.match(r.body.error, /DMs disabled|left the server/i);
  const stored = app._cardRequests._list[0];
  assert.strictEqual(stored.dmLog[0].ok, false);
});

test('an empty message → 400 and makes zero Discord calls', async () => {
  const app = appWith({ requests: [{ ...REQ }] });
  const r = await postDm(app, 'cr_1', { message: '   ' });
  assert.strictEqual(r.status, 400);
  assert.strictEqual(discordCalls.length, 0);
});

test('a message over 2000 chars → 400', async () => {
  const app = appWith({ requests: [{ ...REQ }] });
  const r = await postDm(app, 'cr_1', { message: 'x'.repeat(2001) });
  assert.strictEqual(r.status, 400);
  assert.strictEqual(discordCalls.length, 0);
});

test('an unknown request id → 404, zero Discord calls', async () => {
  const app = appWith({ requests: [] });
  const r = await postDm(app, 'cr_nope', { message: 'hi' });
  assert.strictEqual(r.status, 404);
  assert.strictEqual(discordCalls.length, 0);
});

test('no bot token → 200 { ok:false } "not configured", zero Discord calls', async () => {
  const app = appWith({ requests: [{ ...REQ }], platformToken: '' });
  const r = await postDm(app, 'cr_1', { message: 'hi' });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.ok, false);
  assert.match(r.body.error, /not configured/i);
  assert.strictEqual(discordCalls.length, 0);
});

test('a non-platform-admin is blocked (403)', async () => {
  const app = appWith({ requests: [{ ...REQ }], admin: false });
  const r = await postDm(app, 'cr_1', { message: 'hi' });
  assert.strictEqual(r.status, 403);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd communityhunts-backend && node --test routes/cardRequests.routes.test.js`
Expected: FAIL — the `POST .../dm` route 404s (route not defined), so the success/403/etc. assertions fail.

- [ ] **Step 3: Implement the route**

In `communityhunts-backend/routes/cardRequests.routes.js`, add a cap constant near the top (after `const MAX_OPEN_PER_USER = 2;`):

```javascript
const MAX_DM = 2000; // DM message cap — mirrors lib/cardRequests MAX_IDEA / MAX_NOTES
```

Add this handler inside `module.exports = function cardRequestsRoutes(deps) { ... }`, immediately **before** `return router;` (the deps `cardRequests`, `getPlatformBotToken`, `requireAuth`, `requirePlatformAdmin` are already destructured at the top of the function):

```javascript
  // Manual, best-effort DM to the requester (a canned/edited message composed on the frontend).
  // Two Discord calls: open the DM channel with the requester, then post the message. A Discord
  // failure never errors the request — it returns { ok:false } and records the attempt in dmLog.
  router.post('/api/admin/card-requests/:id/dm', requireAuth, requirePlatformAdmin, async (req, res) => {
    const message = typeof (req.body && req.body.message) === 'string' ? req.body.message.trim() : '';
    if (!message) return res.status(400).json({ error: 'Message required' });
    if (message.length > MAX_DM) return res.status(400).json({ error: `Message too long (max ${MAX_DM} characters)` });

    const r = cardRequests.getRequest(String(req.params.id));
    if (!r) return res.status(404).json({ error: 'Request not found' });

    const template = (req.body && req.body.template) || '';
    const botToken = getPlatformBotToken();
    if (!botToken) return res.json({ ok: false, error: 'Discord bot not configured', request: r });

    const CANT_DM = "Couldn't DM — they may have DMs disabled or left the server";
    try {
      // 1) Open (or reuse) the DM channel with the requester.
      const dmResp = await fetch('https://discord.com/api/v10/users/@me/channels', {
        method: 'POST',
        headers: { Authorization: `Bot ${botToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ recipient_id: r.userId }),
      });
      if (!dmResp.ok) throw new Error(`open DM channel → ${dmResp.status}`);
      const dm = await dmResp.json().catch(() => null);
      if (!dm || !dm.id) throw new Error('no DM channel id');

      // 2) Post the message as plain text.
      const msgResp = await fetch(`https://discord.com/api/v10/channels/${dm.id}/messages`, {
        method: 'POST',
        headers: { Authorization: `Bot ${botToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: message }),
      });
      if (!msgResp.ok) {
        const error = msgResp.status === 403 ? CANT_DM : 'Discord error — try again';
        const updated = cardRequests.recordDm(r.id, { template, ok: false, error });
        console.error(`[cardreq] DM to ${r.userId} failed: ${msgResp.status}`);
        return res.json({ ok: false, error, request: updated || r });
      }

      const updated = cardRequests.recordDm(r.id, { template, ok: true });
      console.log(`[cardreq] DM sent to ${r.userId} for request ${r.id}`);
      return res.json({ ok: true, request: updated || r });
    } catch (e) {
      console.error('[cardreq] DM error:', e.message);
      const updated = cardRequests.recordDm(r.id, { template, ok: false, error: CANT_DM });
      return res.json({ ok: false, error: CANT_DM, request: updated || r });
    }
  });
```

- [ ] **Step 4: Run the route test to verify it passes**

Run: `cd communityhunts-backend && node --test routes/cardRequests.routes.test.js`
Expected: PASS (all 7 tests).

- [ ] **Step 5: Commit**

```bash
cd communityhunts-backend
git add routes/cardRequests.routes.js routes/cardRequests.routes.test.js
git commit -m "feat: POST /api/admin/card-requests/:id/dm — best-effort DM to requester"
```

---

## Task 3: Backend — full suite, push, PR, verify on Railway

**Files:** none (integration/deploy gate).

- [ ] **Step 1: Run the full backend lib + route suites**

Run: `cd communityhunts-backend && node --test lib/cardRequests.test.js routes/cardRequests.routes.test.js`
Expected: PASS. (Optionally run the whole suite: `node --test lib/ routes/`.)

- [ ] **Step 2: Push the branch and open the PR**

```bash
cd communityhunts-backend
git pull --ff-only origin main   # reconcile before pushing (shared main)
git push -u origin feat/shop-request-dm
gh pr create --title "feat: manual DM-to-requester for Shop Requests" \
  --body "Adds POST /api/admin/card-requests/:id/dm (best-effort community-bot DM) + getRequest/recordDm helpers. No new env/bot; no server.js change. Backend-first — merge + verify on Railway before the frontend PR."
```

- [ ] **Step 3: Merge and verify live**

Merge the PR. Railway auto-deploys (~1–3 min). Confirm the new route is live (either from the frontend in Task 6, or a quick authenticated smoke test). The frontend PR (Tasks 4–6) must not merge until this is live.

---

## Task 4: Frontend — DM templates module

**Files:**
- Create: `communityhunts-frontend/src/admin/shopRequestDmTemplates.js`

**Interfaces:**
- Consumes: `SHOP_ASSIGNEES` from `src/auth/roles.js`.
- Produces (Tasks 5 relies on this): `DM_TEMPLATES: Array<{ key: string, label: string, build: (r) => string }>` — ordered list; `build(request)` returns editable prefilled text.

- [ ] **Step 1: Create the templates module**

Create `communityhunts-frontend/src/admin/shopRequestDmTemplates.js`:

```javascript
// Canned DM templates for the Shop Requests admin panel. Each `build(request)` returns
// editable prefilled text; the admin tweaks it before sending. The backend just posts the
// final string (no server-side template store). Assignee labels come from SHOP_ASSIGNEES
// (ID-keyed) — never gate/label on display name. Keep this list in sync with the spec copy.
import { SHOP_ASSIGNEES } from '../auth/roles';

const ASSIGNEE_LABEL = Object.fromEntries(SHOP_ASSIGNEES.map(a => [a.id, a.label]));

const cardOf = (r) => (r.cardName && r.cardName.trim()) || 'your card';
const whoOf = (r) => (r.assignee && ASSIGNEE_LABEL[r.assignee]) || 'our team';
const SIGN = '\n\n— CommunityHunts.gg';

export const DM_TEMPLATES = [
  {
    key: 'awaiting_payment',
    label: 'Awaiting payment',
    build: (r) =>
      `Hi ${r.displayName}! Your custom card "${cardOf(r)}" is assigned to ${whoOf(r)}. ` +
      `To get started, send a $25 tip on Rainbet. Once it lands we'll begin 🎨${SIGN}`,
  },
  {
    key: 'payment_received',
    label: 'Payment received / starting',
    build: (r) =>
      `Got your tip 🙏 — starting on "${cardOf(r)}" now. I'll update you when it's ready.${SIGN}`,
  },
  {
    key: 'card_ready',
    label: 'Card ready / delivered',
    build: (r) =>
      `Your card "${cardOf(r)}" is done and ready to equip! 🎉${SIGN}`,
  },
  {
    key: 'need_info',
    label: 'Need more info',
    build: (r) =>
      `Quick one on your "${cardOf(r)}" request — could you share a bit more detail or a ` +
      `reference image so we can nail it?${SIGN}`,
  },
];
```

- [ ] **Step 2: Verify it compiles**

Run: `cd communityhunts-frontend && CI=true npm run build`
Expected: "Compiled successfully" (the module is not yet imported anywhere, but must parse and lint clean).

- [ ] **Step 3: Commit**

```bash
cd communityhunts-frontend
git checkout -b feat/shop-request-dm   # skip if the branch already exists
git add src/admin/shopRequestDmTemplates.js
git commit -m "feat: Shop Request DM templates (editable prefills)"
```

---

## Task 5: Frontend — `sendCardRequestDm` API helper + `ShopRequestDm` component

**Files:**
- Modify: `communityhunts-frontend/src/admin/adminApi.js`
- Create: `communityhunts-frontend/src/admin/ShopRequestDm.js`

**Interfaces:**
- Consumes: `DM_TEMPLATES` (Task 4); `apiFetch` (throws on non-2xx, returns parsed JSON on 2xx); theme tokens via the passed `C` (`C.sur`, `C.bg`, `C.bdr`, `C.t1`, `C.t3`, `C.rCtl`, `C.body`, `C.accent`/`C.gold`, `C.green`, `C.red`).
- Produces (Task 6 relies on these):
  - `sendCardRequestDm(id, message, template) → Promise<{ ok, error?, request }>`
  - `<ShopRequestDm r={request} C={theme} onSent={(updatedRequest) => void} />`

- [ ] **Step 1: Add the API helper**

In `communityhunts-frontend/src/admin/adminApi.js`, add directly after the `deleteCardRequest` export (~line 87):

```javascript
// Send a Discord DM to the requester (manual, best-effort). Resolves { ok, error?, request }
// on HTTP 200 (delivery success OR a recorded delivery failure); rejects on 400/404.
export const sendCardRequestDm = (id, message, template) =>
  apiFetch(`/api/admin/card-requests/${encodeURIComponent(id)}/dm`,
    { method: 'POST', body: JSON.stringify({ message, template }) });
```

- [ ] **Step 2: Create the component**

Create `communityhunts-frontend/src/admin/ShopRequestDm.js`:

```javascript
import { useState } from 'react';
import { DM_TEMPLATES } from './shopRequestDmTemplates';
import { sendCardRequestDm } from './adminApi';

// Manual, best-effort "DM requester" control for a Shop Request card. Pick a template →
// it prefills an editable box → Send DM posts it via the community bot. Delivery is
// best-effort (Discord 403s when the user has DMs off / isn't in the server); the outcome
// shows below, read from the request's persisted dmLog (survives reloads).
export default function ShopRequestDm({ r, C, onSent }) {
  const [templateKey, setTemplateKey] = useState('');
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [err, setErr] = useState('');

  const pick = (key) => {
    setTemplateKey(key);
    setErr('');
    const tpl = DM_TEMPLATES.find(t => t.key === key);
    setText(tpl ? tpl.build(r) : '');
  };

  const send = async () => {
    const message = text.trim();
    if (!message) return;
    setSending(true);
    setErr('');
    try {
      const res = await sendCardRequestDm(r.id, message, templateKey);
      if (res && res.request) onSent(res.request);
      if (res && !res.ok) {
        setErr(res.error || 'DM failed');
      } else {
        setText('');
        setTemplateKey('');
      }
    } catch (e) {
      setErr(e.message || 'DM failed');
    } finally {
      setSending(false);
    }
  };

  const last = Array.isArray(r.dmLog) && r.dmLog.length ? r.dmLog[r.dmLog.length - 1] : null;
  const idle = sending || !text.trim();
  const selectStyle = { height: 30, background: C.sur, color: C.t1, border: `1px solid ${C.bdr}`, borderRadius: C.rCtl, fontFamily: C.body, fontSize: 12, padding: '0 8px' };

  return (
    <div style={{ marginTop: 10, borderTop: `1px solid ${C.bdr}`, paddingTop: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
        <span style={{ fontSize: 11, fontWeight: 700, color: C.t3, letterSpacing: '.04em' }}>DM REQUESTER</span>
        <select value={templateKey} onChange={e => pick(e.target.value)} title="Template" style={selectStyle}>
          <option value="">Choose a template…</option>
          {DM_TEMPLATES.map(t => <option key={t.key} value={t.key}>{t.label}</option>)}
        </select>
        {last && (
          <span style={{ fontSize: 11, color: last.ok ? C.green : C.red }}>
            {last.ok ? '✓ DM sent' : `✗ DM failed: ${last.error || 'unknown'}`} · {new Date(last.at).toLocaleString()}
          </span>
        )}
      </div>
      {templateKey && (
        <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
          <textarea value={text} onChange={e => setText(e.target.value)} maxLength={2000} rows={3}
            style={{ flex: 1, padding: 8, background: C.bg, border: `1px solid ${C.bdr}`, borderRadius: C.rCtl, color: C.t1, fontFamily: C.body, fontSize: 12, resize: 'vertical', boxSizing: 'border-box' }} />
          <button onClick={send} disabled={idle}
            style={{ height: 30, padding: '0 12px', background: idle ? C.bdr : (C.accent || C.gold), border: 'none', borderRadius: C.rCtl, color: idle ? C.t3 : C.bg, fontFamily: C.body, fontWeight: 700, fontSize: 12, cursor: idle ? 'default' : 'pointer', whiteSpace: 'nowrap' }}>
            {sending ? 'Sending…' : 'Send DM'}
          </button>
        </div>
      )}
      {err && <div style={{ color: C.red, fontSize: 11, marginTop: 6 }}>{err}</div>}
    </div>
  );
}
```

- [ ] **Step 3: Verify it compiles**

Run: `cd communityhunts-frontend && CI=true npm run build`
Expected: "Compiled successfully".

- [ ] **Step 4: Commit**

```bash
cd communityhunts-frontend
git add src/admin/adminApi.js src/admin/ShopRequestDm.js
git commit -m "feat: ShopRequestDm control + sendCardRequestDm API helper"
```

---

## Task 6: Frontend — wire into `AdminShopRequests`, build, preview-verify, PR

**Files:**
- Modify: `communityhunts-frontend/src/admin/AdminShopRequests.js`

**Interfaces:**
- Consumes: `<ShopRequestDm />` (Task 5). `RequestCard` already receives `r` + `C`; the parent already has `setRows`.

- [ ] **Step 1: Import the component**

In `communityhunts-frontend/src/admin/AdminShopRequests.js`, add to the imports (after the `adminApi` import line):

```javascript
import ShopRequestDm from './ShopRequestDm';
```

- [ ] **Step 2: Pass an `onSent` handler down to each card**

In the `AdminShopRequests` component, the `rows.map(...)` currently renders `<RequestCard ... />`. Add an `onDm` prop that replaces the row with the DM endpoint's returned request. Change the map (around line 79) to:

```javascript
          {rows.map(r => <RequestCard key={r.id} r={r} C={C} onStatus={setStatus} onAssign={setAssignee} onNotes={saveNotes} onDelete={remove} onDm={u => setRows(rs => rs.map(x => (x.id === u.id ? u : x)))} />)}
```

- [ ] **Step 3: Render `ShopRequestDm` inside `RequestCard`**

Update the `RequestCard` signature (line 86) to accept `onDm`:

```javascript
function RequestCard({ r, C, onStatus, onAssign, onNotes, onDelete, onDm }) {
```

Then render the control at the end of the card — insert it immediately after the "Internal notes + delete" `</div>` block and before the card's closing `</div>` (i.e. as the last child of the outer card div, after line 147's closing `</div>`):

```javascript
      <ShopRequestDm r={r} C={C} onSent={onDm} />
```

- [ ] **Step 4: Verify it compiles**

Run: `cd communityhunts-frontend && CI=true npm run build`
Expected: "Compiled successfully".

> Heads-up (from the frontend CLAUDE.md): CRA does **not** flag a missed prop on an extracted component — it's silently `undefined`. Confirm by hand that `onDm` is threaded from `AdminShopRequests` → `RequestCard` → `ShopRequestDm`'s `onSent`.

- [ ] **Step 5: Commit, push, open the PR**

```bash
cd communityhunts-frontend
git add src/admin/AdminShopRequests.js
git commit -m "feat: DM requester control on Shop Requests admin cards"
git pull --ff-only origin main
git push -u origin feat/shop-request-dm
gh pr create --title "feat: DM requester from Shop Requests" \
  --body "Adds a manual, editable-prefill 'DM requester' control to each Shop Request card (4 templates), calling the new best-effort backend DM endpoint. Requires the backend PR to be live first."
```

- [ ] **Step 6: Verify on the Vercel preview URL**

On the branch's preview deploy, as a platform owner: open the admin Shop Requests panel → pick a request → choose **Awaiting payment** → confirm the textarea prefills with the card name + assignee → **Send DM** → confirm the DM lands in your Discord (you're in the CommunityHunts server) and the card shows `✓ DM sent · <time>`. Then test a failure path if feasible (e.g. a request whose `userId` isn't in the server) and confirm `✗ DM failed: …` without breaking the card. Merge to `main` only after this passes.

---

## Self-Review (completed during planning)

- **Spec coverage:** manual send button (Tasks 5–6) · editable prefill (Task 4 `build` + Task 5 textarea) · 4 templates (Task 4) · best-effort route + `recordDm`/`dmLog` (Tasks 1–2) · error table incl. 400/404/no-token/403 (Task 2 tests) · plain-text DM (Task 2) · frontend-only templates (Task 4) · no new env/bot/`server.js` change (verified — deps already injected) · backend-first rollout (Tasks 3 → 6). All covered.
- **Type consistency:** `getRequest` / `recordDm` signatures identical in Task 1 (definition), Task 2 (route + fake), and Task 5 (unused there). `sendCardRequestDm(id, message, template)` matches the route body `{ message, template }`. `onSent`/`onDm` both take the updated `request`. `DM_TEMPLATES` item shape `{ key, label, build }` consistent across Tasks 4–5.
- **Placeholder scan:** none — every step has full code or exact commands.
