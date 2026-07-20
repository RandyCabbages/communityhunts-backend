# Supporter Perks & Acquisition — Backend Plan (Plan 1 of 2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the backend half of the Supporter feature — a shared "privilege" gate, the supporter perks it enforces (no call limit, free cosmetics catalog, supporter-only cosmetics, priority-ticket marker), a public supporters roster for the Wall of Supporters, and a tracked Supporter Applications system that posts to the shop-requests Discord channel.

**Architecture:** All additive. A tiny `lib/privilege.js` centralizes "is this request's user owner/king/mod/supporter." Existing enforcement sites (`calls.routes.js`, `settings.routes.js`, `misc.routes.js`) gain a supporter/privilege branch mirroring the mod branch already there. Supporter Applications clone the proven `lib/cardRequests.js` + `routes/cardRequests.routes.js` pattern (hunts_kv store + best-effort Discord embed + admin status flow), reusing the same `DISCORD_SHOP_REQUESTS_CHANNEL_ID` and platform bot.

**Tech Stack:** Node.js/Express, Postgres (`pg`) via `hunts_kv`, `node:test` for pure-logic tests. No new dependencies.

## Global Constraints

- **Backend deploys first** — every change here is additive and invisible until the frontend (Plan 2) consumes it. Safe to merge to `main` (Railway auto-deploys) once verified.
- **Work on a branch, never push straight to `main`** to test — but `main` IS production here, so merge only after `npm run dev` boots clean and the manual curls pass.
- **Gate on Discord ID, never display name** (repo rule).
- **No `Co-Authored-By` trailers** on commits.
- **Pure-logic modules get a `node:test` `.test.js`; route wiring is verified manually** (curl + boot), matching the repo convention.
- Supporters + Owners are **global**; King + Mods are **tenant-scoped** (resolve via `req.tenant`) — same as `/api/badges`.
- `reqIsMod(req)` already folds in platform admins (see `server.js` comment ~L344) — do not also check admin separately where `reqIsMod` is used.

---

### Task 1: `lib/privilege.js` — the shared privilege gate

**Files:**
- Create: `lib/privilege.js`
- Test: `lib/privilege.test.js`
- Modify: `server.js` (construct it after `supporters` + role helpers exist; ~after L362)

**Interfaces:**
- Consumes: `reqIsMod(req)` (folds admin), `supporters.isSupporter(userId)` (from `lib/supporters.js`), `req.tenant.hostDiscordId`, `req.user.id`.
- Produces: `makePrivilege({ reqIsMod, supporters }) → { isPrivileged(req): boolean }`. `isPrivileged` is `false` for a request with no `req.user`.

- [ ] **Step 1: Write the failing test**

Create `lib/privilege.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert');
const makePrivilege = require('./privilege');

function build({ mod = false, supporter = false } = {}) {
  return makePrivilege({
    reqIsMod: () => mod,
    supporters: { isSupporter: (id) => supporter && id === 'u1' },
  });
}

test('no user → not privileged', () => {
  const { isPrivileged } = build();
  assert.equal(isPrivileged({}), false);
});

test('mod (folds admin) → privileged', () => {
  const { isPrivileged } = build({ mod: true });
  assert.equal(isPrivileged({ user: { id: 'u1' } }), true);
});

test('supporter → privileged', () => {
  const { isPrivileged } = build({ supporter: true });
  assert.equal(isPrivileged({ user: { id: 'u1' } }), true);
});

test('tenant host (king) → privileged', () => {
  const { isPrivileged } = build();
  assert.equal(isPrivileged({ user: { id: 'k1' }, tenant: { hostDiscordId: 'k1' } }), true);
});

test('plain signed-in user → not privileged', () => {
  const { isPrivileged } = build();
  assert.equal(isPrivileged({ user: { id: 'nobody' }, tenant: { hostDiscordId: 'k1' } }), false);
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `node --test lib/privilege.test.js`
Expected: FAIL — `Cannot find module './privilege'`.

- [ ] **Step 3: Write the implementation**

Create `lib/privilege.js`:

```js
// Shared "is this request's user privileged" gate. Privilege = Owner/Admin OR King (tenant host)
// OR Mod OR Supporter — the same ladder the badge roster uses. reqIsMod already folds in platform
// admins, so it covers Owner+Mod. Supporters + Owners are global; King + Mod are tenant-scoped
// (resolved from req.tenant). DI so it stays trivially unit-testable with no DB.
module.exports = function makePrivilege({ reqIsMod, supporters }) {
  function isPrivileged(req) {
    if (!req || !req.user) return false;
    if (typeof reqIsMod === 'function' && reqIsMod(req)) return true; // owner/admin + mod
    if (supporters && supporters.isSupporter(req.user.id)) return true; // supporter (global)
    const hostId = req.tenant && req.tenant.hostDiscordId; // king (tenant host)
    if (hostId && String(hostId) === String(req.user.id)) return true;
    return false;
  }
  return { isPrivileged };
};
```

- [ ] **Step 4: Run it to confirm it passes**

Run: `node --test lib/privilege.test.js`
Expected: PASS (5 tests).

- [ ] **Step 5: Wire into `server.js`**

`supporters` is required at L287 and `reqIsMod` is available by L362. Add after L362 (after the block that exports role helpers), before the routers that need it:

```js
// Shared privilege gate (owner/king/mod/supporter) — see lib/privilege.js. Used by call-limit,
// ticket-priority, and cosmetics enforcement below.
const { isPrivileged } = require('./lib/privilege')({ reqIsMod, supporters });
```

- [ ] **Step 6: Boot check + commit**

Run: `npm run dev` — expect a clean boot (no `privilege` errors), then Ctrl-C.

```bash
git add lib/privilege.js lib/privilege.test.js server.js
git commit -m "feat(privilege): shared owner/king/mod/supporter gate"
```

---

### Task 2: No call limit for privileged users (`calls.routes.js`)

**Files:**
- Modify: `routes/calls.routes.js` (deps L18–19; `addCallToHunt` signature L30 + limit check L43; call sites L73, L88)
- Modify: `server.js` (calls router mount ~L507 — add `isPrivileged` dep)

**Interfaces:**
- Consumes: `isPrivileged(req)` from Task 1.
- Produces: privileged callers skip the per-person `callLimit` cap; the rolling-mode gate is UNCHANGED.

- [ ] **Step 1: Add `isPrivileged` to the calls router deps**

In `routes/calls.routes.js`, the deps destructure (around L18) currently lists `requireAuth, canEditHunt, isEquityMember, reqCanAdminHunt, …`. Add `isPrivileged`:

```js
  const { hunts, io, persistHunts,
    requireAuth, canEditHunt, isEquityMember, reqCanAdminHunt, isPrivileged,
    normalizeSlot, nameOf, publicHuntView, emitHubUpdate, emitHuntUpdate, uid, rejectBadHuntInput,
    auditLog } = deps;
```

- [ ] **Step 2: Add a `limitExempt` param to `addCallToHunt`**

Change the signature (L30) and the limit check (L43). The rolling-mode block (L34, gated on `!isEditor`) stays as-is — privilege does NOT bypass hunt phase, only the per-person cap:

```js
  // `isEditor` controls the rolling-mode + callLimit exemptions (owners/admins bypass them).
  // `limitExempt` additionally waives ONLY the per-person callLimit (privileged: supporter/king/mod),
  // without granting the rolling-mode edit bypass.
  function addCallToHunt(hunt, user, slot, isEditor, source, limitExempt) {
```

And the per-person limit check:

```js
    // Per-person limit (not applied to editors/admins, or limit-exempt privileged callers)
    const callerName = nameOf(user);
    if (hunt.callLimit > 0 && !isEditor && !limitExempt) {
```

- [ ] **Step 3: Pass privilege at both call sites**

Equity-member endpoint (L73):

```js
    const isEditor = canEditHunt(req, req.params.userId);
    const result = addCallToHunt(hunt, req.user, req.body.slot, isEditor, undefined, isPrivileged(req));
```

Public-link endpoint (L88):

```js
    const isEditor = canEditHunt(req, req.params.userId);
    const result = addCallToHunt(hunt, req.user, req.body.slot, isEditor, 'public', isPrivileged(req));
```

- [ ] **Step 4: Inject `isPrivileged` into the mount in `server.js`**

At the calls router mount (~L507), add `isPrivileged` to the deps object:

```js
app.use(require('./routes/calls.routes')({
  hunts, io, persistHunts,
  requireAuth, canEditHunt, isEquityMember, reqCanAdminHunt, isPrivileged,
  normalizeSlot, nameOf, publicHuntView, emitHubUpdate, emitHuntUpdate, uid, rejectBadHuntInput,
  auditLog,
}));
```

- [ ] **Step 5: Boot check + commit**

Run: `npm run dev` — clean boot, Ctrl-C. (Behavior change is only observable end-to-end; the frontend limit UI mirror ships in Plan 2. A privileged Discord ID adding past a hunt's `callLimit` no longer 400s "You've reached the limit".)

```bash
git add routes/calls.routes.js server.js
git commit -m "feat(calls): privileged users bypass the per-person call limit"
```

---

### Task 3: Supporter-only cosmetics + free catalog for supporters

**Files:**
- Modify: `routes/cosmetics.routes.js` (add 3 items to `ITEM_TIERS`; add + export `SUPPORTER_ONLY_ITEMS`)
- Modify: `routes/settings.routes.js` (import `SUPPORTER_ONLY_ITEMS`; add supporter/king branch in the equip loop L86–117; add `supporters` dep)
- Modify: `server.js` (settings router mount ~L665 — add `supporters` dep)

**Interfaces:**
- Consumes: `supporters.isSupporter(userId)`, `req.tenant.hostDiscordId`.
- Produces: three new equippable ids `theme_patron` / `effect_patron` / `bg_patron`, equippable only by supporters/king/admin; supporters/king get the whole catalog free (mirrors the existing mod grant).

> These IDs must match the frontend catalog in Plan 2. Backend ships first, so the ids are defined here.

- [ ] **Step 1: Add the three ids to `ITEM_TIERS`**

In `routes/cosmetics.routes.js`, in the `ITEM_TIERS` map, add under the theme / effect / background groups (tier `'free'` so grant/validate passes; the real gate is `SUPPORTER_ONLY_ITEMS` on the equip path):

```js
  theme_midnight:'free', theme_patron:'free',
```
```js
  effect_confetti:'free', effect_patron:'free', effect_flash:'basic', effect_shake:'basic', effect_sparkles:'basic',
```
```js
  bg_stars:'free', bg_patron:'free', bg_particles:'basic', bg_embers:'basic',
```

- [ ] **Step 2: Add + export `SUPPORTER_ONLY_ITEMS`**

Right after the `MOD_ONLY_ITEMS` definition (~L46) in `routes/cosmetics.routes.js`:

```js
// Supporter-only cosmetics — equippable only by supporters (global), the tenant King, or platform
// admins. Tier above is 'free' so grant/validate passes; the real gate is on the equip path in
// settings.routes.js (where reqIsMod/supporters/req.tenant are available), mirroring MOD_ONLY_ITEMS.
// MUST stay in sync with the frontend catalog's `supporterOnly` items (Plan 2).
const SUPPORTER_ONLY_ITEMS = new Set(['theme_patron', 'effect_patron', 'bg_patron']);
```

And add to the bottom exports block (~L254):

```js
module.exports.SUPPORTER_ONLY_ITEMS = SUPPORTER_ONLY_ITEMS;
```

- [ ] **Step 3: Import it + `supporters` in `settings.routes.js`**

Change the import (L18):

```js
const { isItemAccessible, ITEM_TIERS, MOD_ONLY_ITEMS, EXCLUSIVE_ITEMS, SUPPORTER_ONLY_ITEMS } = require('./cosmetics.routes');
```

Add `supporters` to the deps destructure (L23):

```js
  const { settings, pgPool, memberships, isPlatformAdmin, reqIsMod, reqIsVipHost, reqHasFullExtension, requireAuth, requireAdmin, requirePlatformAdmin, io, subscriptions, featureGrants, hunts, archive, statsStore, refreshGuildRoles, auditLog, supporters } = deps;
```

- [ ] **Step 4: Add the supporter/king branch to the equip loop**

In the cosmetics equip loop (L86–117), after `const priv = isPlatformAdmin(req.user) || reqIsMod(req);` (L101) add:

```js
      // Supporters (global) + the tenant King get the whole catalog free too (like mods), and are
      // the ONLY non-admins who may equip SUPPORTER_ONLY_ITEMS. Does NOT widen the modOnly/exclusive
      // gates (those stay `priv`-only), so a supporter can't wear card_mod or someone's commission.
      const isSup = !!(supporters && supporters.isSupporter(req.user.id));
      const isKing = !!(req.tenant && req.tenant.hostDiscordId && String(req.tenant.hostDiscordId) === String(req.user.id));
      const freeAll = priv || isSup || isKing;
```

Add the supporter-only gate right after the mod-only gate (after L106):

```js
        // Supporter-only items: only supporters / King / admins may equip.
        if (itemId && SUPPORTER_ONLY_ITEMS && SUPPORTER_ONLY_ITEMS.has(itemId) && !priv && !isSup && !isKing) continue;
```

Change the final accessibility gate (L115) from `priv` to `freeAll`:

```js
        if (itemId && (freeAll ? !(itemId in ITEM_TIERS) : !isItemAccessible(itemId, userTier, owned))) continue;
```

- [ ] **Step 5: Inject `supporters` into the settings mount in `server.js`**

At the settings router mount (~L665), add `supporters` to the deps object:

```js
app.use(require('./routes/settings.routes')({
  settings, pgPool, memberships, isPlatformAdmin, reqIsMod, reqIsVipHost, reqHasFullExtension, requireAuth, requireAdmin, requirePlatformAdmin, io, subscriptions, featureGrants,
  hunts, archive, statsStore, refreshGuildRoles, auditLog, supporters,
}));
```

- [ ] **Step 6: Boot check + commit**

Run: `npm run dev` — clean boot, Ctrl-C.

```bash
git add routes/cosmetics.routes.js routes/settings.routes.js server.js
git commit -m "feat(cosmetics): supporter-only items + free catalog for supporters/king"
```

---

### Task 4: Priority-ticket marker (`misc.routes.js`)

**Files:**
- Modify: `routes/misc.routes.js` (deps L31; `/api/tickets` embed build ~L116)
- Modify: `server.js` (misc router mount L662 — add `isPrivileged`)

**Interfaces:**
- Consumes: `isPrivileged(req)` from Task 1.
- Produces: a `💜 Supporter` marker on the ticket embed when a privileged user files it. Anonymous/plain tickets are unchanged.

- [ ] **Step 1: Add `isPrivileged` to the misc router deps**

In `routes/misc.routes.js` (L31):

```js
  const { hunts, archive, tickets, getPlatformBotToken, statsStore, isPrivileged } = deps;
```

- [ ] **Step 2: Mark the embed when the submitter is privileged**

In the `/api/tickets` handler, where the `embed` object is built (~L116), add a Supporter field when privileged. Insert immediately after the embed object is constructed (before it's sent):

```js
        if (typeof isPrivileged === 'function' && isPrivileged(req)) {
          embed.title = `💜 ${embed.title}`;
          (embed.fields = embed.fields || []).push({ name: 'Priority', value: '💜 Supporter', inline: true });
        }
```

(If `embed.title` doesn't exist in the current shape, add the field push only — check the actual embed object at L116 and adapt; the field push is the load-bearing part.)

- [ ] **Step 3: Inject `isPrivileged` into the mount in `server.js` (L662)**

```js
app.use(require('./routes/misc.routes')({ hunts, archive, tickets, getPlatformBotToken: tenants.getPlatformBotToken, statsStore, isPrivileged }));
```

- [ ] **Step 4: Boot check + commit**

Run: `npm run dev` — clean boot, Ctrl-C.

```bash
git add routes/misc.routes.js server.js
git commit -m "feat(tickets): flag privileged submitters with a Supporter marker"
```

---

### Task 5: Public supporters roster (Wall of Supporters)

**Files:**
- Modify: `routes/integrations.routes.js` (add `GET /api/supporters/public`; it already receives `supporters` for `/api/badges` — add `getKnownUser` to its deps)
- Modify: `server.js` (integrations router mount — add `getKnownUser: settings.getKnownUser`)

**Interfaces:**
- Consumes: `supporters.listSupporters()` (returns `[{ discordId, addedBy, addedAt }]`), `getKnownUser(id)` (from `lib/settings.js`, async, returns `{ id, displayName, avatar }` or null).
- Produces: `GET /api/supporters/public` → `{ supporters: [{ discordId, displayName, avatar }] }`, public (no auth), best-effort enrichment (unknown → `displayName = null`).

- [ ] **Step 1: Confirm the integrations mount already injects `supporters`**

Read `routes/integrations.routes.js` deps + its `server.js` mount. `/api/badges` uses `supporters.getSupporterIds()`, so `supporters` is already a dep. Add `getKnownUser` to both the destructure and the mount.

- [ ] **Step 2: Add the endpoint**

In `routes/integrations.routes.js`, near the `/api/badges` route, add:

```js
  // Public supporters roster for the Wall of Supporters on /support-us. Enriched with display
  // name + avatar from the known_users directory (best-effort; unknown ids still list by id).
  // No secrets — supporter status is already public via the flair badge.
  router.get('/api/supporters/public', async (req, res) => {
    let rows = [];
    try { rows = await supporters.listSupporters(); } catch (e) { rows = []; }
    const out = await Promise.all(rows.map(async (r) => {
      let known = null;
      try { known = getKnownUser ? await getKnownUser(r.discordId) : null; } catch (e) {}
      return {
        discordId: String(r.discordId),
        displayName: known && known.displayName ? String(known.displayName) : null,
        avatar: known && known.avatar ? String(known.avatar) : null,
      };
    }));
    res.json({ supporters: out });
  });
```

- [ ] **Step 3: Add `getKnownUser` to the deps + mount**

Destructure it in `routes/integrations.routes.js`, and in `server.js` add `getKnownUser: settings.getKnownUser` to the integrations router mount's deps object.

- [ ] **Step 4: Boot + curl + commit**

Run: `npm run dev`, then:
Run: `curl -s http://localhost:3001/api/supporters/public`
Expected: `{"supporters":[...]}` (empty array if no supporters in the local DB; a marked id lists with `displayName`/`avatar` if in `known_users`). Ctrl-C.

```bash
git add routes/integrations.routes.js server.js
git commit -m "feat(supporters): public roster endpoint for the Wall of Supporters"
```

---

### Task 6: `lib/supporterApplications.js` — the tracked store

**Files:**
- Create: `lib/supporterApplications.js`
- Test: `lib/supporterApplications.test.js`

**Interfaces:**
- Consumes: `initSupporterApplications({ pgPool })` (hunts_kv key `supporter_applications`, JSON-file fallback `supporter_applications.json`).
- Produces: `validateInput(body)`, `openCountFor(userId)`, `createApplication(body, sessionUser)`, `listApplications()`, `updateApplication(id, patch)`, `getApplication(id)`, `setDiscordMessage(id, {messageId, channelId})`, `deleteApplication(id)`, `STATUSES`. Record shape: `{ id, createdAt, updatedAt, status, userId, displayName, avatar, amount, message, adminNotes, discordMessageId?, discordChannelId? }`. `STATUSES = ['new','paid','granted','declined']`; `OPEN = {new, paid}`.

- [ ] **Step 1: Write the failing test**

Create `lib/supporterApplications.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert');
const lib = require('./supporterApplications');

test('validateInput requires an amount', () => {
  assert.equal(lib.validateInput({ amount: '', message: 'hi' }), 'Enter a donation amount');
  assert.equal(lib.validateInput({ amount: '$25' }), null);
});

test('validateInput caps message length', () => {
  assert.equal(lib.validateInput({ amount: '10', message: 'x'.repeat(2001) }), 'Message too long (max 2000 characters)');
});

test('createApplication snapshots the user and defaults to new', () => {
  const r = lib.createApplication({ amount: '25', message: 'love it' }, { id: 'u1', displayName: 'Kyle', avatar: 'a.png' });
  assert.equal(r.status, 'new');
  assert.equal(r.userId, 'u1');
  assert.equal(r.displayName, 'Kyle');
  assert.equal(r.amount, '25');
  assert.equal(r.message, 'love it');
  assert.ok(r.id.startsWith('sa_'));
});

test('openCountFor counts only open statuses', () => {
  const r = lib.createApplication({ amount: '5' }, { id: 'u2' });
  assert.equal(lib.openCountFor('u2'), 1);
  lib.updateApplication(r.id, { status: 'declined' });
  assert.equal(lib.openCountFor('u2'), 0);
});

test('validateUpdate rejects a bad status', () => {
  assert.equal(lib.validateUpdate({ status: 'bogus' }), 'Invalid status');
  assert.equal(lib.validateUpdate({ status: 'granted' }), null);
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `node --test lib/supporterApplications.test.js`
Expected: FAIL — `Cannot find module './supporterApplications'`.

- [ ] **Step 3: Write the implementation**

Create `lib/supporterApplications.js` (trimmed clone of `lib/cardRequests.js` — no assignee/on-behalf/refLinks/DM log):

```js
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

let pgPool = null;
let apps = []; // newest first

async function initSupporterApplications(deps) {
  pgPool = (deps && deps.pgPool) || null;
  if (pgPool) {
    try {
      await pgPool.query(`CREATE TABLE IF NOT EXISTS hunts_kv (key TEXT PRIMARY KEY, value JSONB NOT NULL)`);
      const r = await pgPool.query("SELECT value FROM hunts_kv WHERE key='supporter_applications'");
      if (r.rows[0]) { apps = Array.isArray(r.rows[0].value) ? r.rows[0].value : []; console.log(`[supapp] Loaded ${apps.length} from Postgres`); return; }
    } catch (e) { console.error('[supapp] PG load failed:', e.message); }
  }
  try { if (fs.existsSync(FILE)) { apps = JSON.parse(fs.readFileSync(FILE, 'utf8')); console.log(`[supapp] Loaded ${apps.length} from file`); } }
  catch (e) { console.error('[supapp] File load failed:', e.message); }
}

function persist() {
  if (pgPool) {
    pgPool.query("INSERT INTO hunts_kv(key,value) VALUES('supporter_applications',$1) ON CONFLICT(key) DO UPDATE SET value=$1", [JSON.stringify(apps)])
      .catch(e => console.error('[supapp] PG save failed:', e.message));
  }
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
```

- [ ] **Step 4: Run it to confirm it passes**

Run: `node --test lib/supporterApplications.test.js`
Expected: PASS (5 tests).

> Note: the tests share module state (no DB in test → `persist()` writes a local `supporter_applications.json`; that's fine and matches how `cardRequests` behaves). Delete the stray file after: `rm -f supporter_applications.json`.

- [ ] **Step 5: Commit**

```bash
git add lib/supporterApplications.js lib/supporterApplications.test.js
git commit -m "feat(supapp): supporter-applications tracked store"
```

---

### Task 7: `routes/supporterApplications.routes.js` — submit + admin flow + grant

**Files:**
- Create: `routes/supporterApplications.routes.js`
- Modify: `server.js` (require + init + mount, next to the cardRequests block ~L471–487)

**Interfaces:**
- Consumes: `requireAuth`, `requirePlatformAdmin`, `supporterApplications` (Task 6), `getPlatformBotToken`, `channelId` (`DISCORD_SHOP_REQUESTS_CHANNEL_ID`), `supporters` (for grant → `addSupporter`).
- Produces routes:
  - `POST   /api/supporter-applications` (auth) — submit `{ amount, message }`.
  - `GET    /api/admin/supporter-applications` (platform admin) — list.
  - `PUT    /api/admin/supporter-applications/:id` (platform admin) — `{ status?, adminNotes? }`; on `granted` calls `supporters.addSupporter(userId, adminId)`.
  - `DELETE /api/admin/supporter-applications/:id` (platform admin).

- [ ] **Step 1: Write the route module**

Create `routes/supporterApplications.routes.js` (clone of `routes/cardRequests.routes.js`, minus on-behalf/DM):

```js
// Supporter applications ("Support Us" apply flow).
//   POST   /api/supporter-applications            — any signed-in user applies with a donation amount
//   GET    /api/admin/supporter-applications      — platform admin: full list, newest first
//   PUT    /api/admin/supporter-applications/:id  — platform admin: status / adminNotes (granting adds the supporter)
//   DELETE /api/admin/supporter-applications/:id  — platform admin
// On submit, a best-effort Discord embed goes to the shop-requests channel (the doorbell). The
// application is saved first — a Discord failure never fails the request (announcements pattern).

const express = require('express');

const MAX_OPEN_PER_USER = 2;

const PHASE_META = {
  new:      { emoji: '💜', color: 0xa78bfa },
  paid:     { emoji: '💰', color: 0xfbbf24 },
  granted:  { emoji: '✅', color: 0x4ade80 },
  declined: { emoji: '❌', color: 0xff6b6b },
};

function buildEmbed(a) {
  const phase = PHASE_META[a.status] || PHASE_META.new;
  const fields = [
    { name: 'From', value: `${a.displayName} (${a.userId})`.slice(0, 1024), inline: false },
    { name: 'Amount', value: String(a.amount || '—').slice(0, 1024), inline: true },
  ];
  return {
    title: `${phase.emoji} Supporter Application`,
    description: (a.message || '(no message)').slice(0, 3900),
    color: phase.color,
    fields,
    timestamp: a.createdAt,
    footer: { text: 'CommunityHunts — Supporter Applications' },
  };
}

module.exports = function supporterApplicationsRoutes(deps) {
  const { requireAuth, requirePlatformAdmin, supporterApplications, getPlatformBotToken, channelId, supporters } = deps;
  const router = express.Router();
  const ipHits = new Map();

  async function postDoorbell(a) {
    const botToken = getPlatformBotToken();
    if (!botToken || !channelId) return 'skipped';
    try {
      const resp = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
        method: 'POST',
        headers: { Authorization: `Bot ${botToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ embeds: [buildEmbed(a)] }),
      });
      if (!resp.ok) throw new Error(`Discord returned ${resp.status}`);
      const msg = await resp.json().catch(() => null);
      if (msg && msg.id) supporterApplications.setDiscordMessage(a.id, { messageId: String(msg.id), channelId: String(channelId) });
      return 'posted';
    } catch (e) { console.error('[supapp] Discord notify failed:', e.message); return 'failed'; }
  }

  async function patchDoorbell(a) {
    const botToken = getPlatformBotToken();
    if (!a.discordMessageId || !a.discordChannelId || !botToken) return;
    try {
      const resp = await fetch(`https://discord.com/api/v10/channels/${a.discordChannelId}/messages/${a.discordMessageId}`, {
        method: 'PATCH',
        headers: { Authorization: `Bot ${botToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ embeds: [buildEmbed(a)] }),
      });
      if (!resp.ok) throw new Error(`Discord returned ${resp.status}`);
    } catch (e) { console.error('[supapp] Discord embed update failed:', e.message); }
  }

  router.post('/api/supporter-applications', requireAuth, async (req, res) => {
    const ip = req.ip || 'unknown';
    const now = Date.now();
    const recent = (ipHits.get(ip) || []).filter(t => now - t < 10 * 60 * 1000);
    if (recent.length >= 5) return res.status(429).json({ error: 'Too many requests — please try again in a few minutes' });
    if (supporterApplications.openCountFor(req.user.id) >= MAX_OPEN_PER_USER)
      return res.status(429).json({ error: "You already have an open application — we'll be in touch about that one first" });

    const err = supporterApplications.validateInput(req.body);
    if (err) return res.status(400).json({ error: err });

    recent.push(now); ipHits.set(ip, recent);
    const a = supporterApplications.createApplication(req.body, req.user);
    const discord = await postDoorbell(a);
    res.json({ ok: true, discord });
  });

  router.get('/api/admin/supporter-applications', requireAuth, requirePlatformAdmin, (req, res) => {
    res.json({ applications: supporterApplications.listApplications() });
  });

  router.put('/api/admin/supporter-applications/:id', requireAuth, requirePlatformAdmin, async (req, res) => {
    const err = supporterApplications.validateUpdate(req.body);
    if (err) return res.status(400).json({ error: err });
    const a = supporterApplications.updateApplication(String(req.params.id), req.body);
    if (!a) return res.status(404).json({ error: 'Application not found' });

    // Granting flips the supporters table so the flair + all perks turn on. Best-effort; a DB hiccup
    // is logged, not surfaced as a failed status change (the admin can re-grant).
    if (req.body.status === 'granted' && supporters) {
      try { await supporters.addSupporter(a.userId, req.user.id); }
      catch (e) { console.error('[supapp] addSupporter on grant failed:', e.message); }
    }
    res.json(a);
    patchDoorbell(a); // fire after responding
  });

  router.delete('/api/admin/supporter-applications/:id', requireAuth, requirePlatformAdmin, (req, res) => {
    if (!supporterApplications.deleteApplication(String(req.params.id))) return res.status(404).json({ error: 'Application not found' });
    res.json({ ok: true });
  });

  return router;
};
```

- [ ] **Step 2: Wire into `server.js`**

Right after the cardRequests mount block (~L487), add:

```js
// Supporter applications ("Support Us" apply flow) — signed-in submit, owner-only review. Posts to
// the same shop-requests channel as Shop Requests; granting adds the user to the supporters table.
const supporterApplications = require('./lib/supporterApplications');
supporterApplications.initSupporterApplications({ pgPool }).catch(e => console.error('[supapp] init error:', e.message));
app.use(require('./routes/supporterApplications.routes')({
  requireAuth, requirePlatformAdmin, supporterApplications,
  getPlatformBotToken: tenants.getPlatformBotToken,
  channelId: (process.env.DISCORD_SHOP_REQUESTS_CHANNEL_ID || '').trim(),
  supporters,
}));
```

- [ ] **Step 3: Boot + curl + commit**

Run: `npm run dev`, then (unauthenticated call should be rejected by `requireAuth`, proving the route is mounted):
Run: `curl -s -o /dev/null -w "%{http_code}\n" -X POST http://localhost:3001/api/supporter-applications`
Expected: `401` (or the repo's unauth status) — NOT `404`. Ctrl-C.

```bash
git add routes/supporterApplications.routes.js server.js
git commit -m "feat(supapp): submit + admin review routes, grant adds supporter"
```

---

## Self-Review

**Spec coverage (backend items):**
- Privilege ladder helper → Task 1. ✓
- No call limit → Task 2. ✓
- Free cosmetics catalog + supporter-only items + `ITEM_TIERS`/`SUPPORTER_ONLY_ITEMS` cross-repo allowlist → Task 3. ✓
- Priority tickets → Task 4. ✓
- Wall of Supporters data → Task 5. ✓
- Tracked applications (lib + routes + Discord embed + grant→addSupporter) → Tasks 6–7. ✓
- Payouts-first ordering, call-queue priority, name glow, ribbon, `/support-us` page, catalog UI, admin panel → **Plan 2 (frontend)**, deliberately not here.

**Placeholder scan:** Task 4 Step 2 hedges on the exact embed shape — the implementer must read `misc.routes.js` L116 and adapt; the field-push is specified as the load-bearing action. No other placeholders.

**Type consistency:** `isPrivileged(req)` signature identical across Tasks 1/2/4. `SUPPORTER_ONLY_ITEMS` (Set) exported in Task 3 Step 2 and imported in Step 3. Application record shape + `STATUSES` consistent between Task 6 (lib) and Task 7 (routes/embed). The three cosmetic ids (`theme_patron`/`effect_patron`/`bg_patron`) match between Task 3 and the Plan 2 catalog.

## Rollout

1. Branch `feat/supporter-perks-backend` off `main`. Implement Tasks 1–7.
2. `npm run dev` boots clean; all `node --test` pass; the two curls behave as specified.
3. Merge to `main` (Railway auto-deploys). All additive — no visible change until Plan 2 (frontend) ships.
4. Then execute Plan 2.
