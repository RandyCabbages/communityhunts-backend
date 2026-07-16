# Phase 0 — Security Hotfixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close four pre-commercial authorization/data-exposure holes so no tenant admin/mod can touch platform-global state and no archived-hunt snapshot leaks raw Discord IDs — before the two-level admin console (which arms the worst of them) is built.

**Architecture:** Four independent edits to existing thin DI routers (`settings.routes.js`, `hunts.routes.js`, `admin.routes.js`, `auth.routes.js`) plus one dep-injection line in `server.js`. No new files besides tests. No schema change, no data migration, no frontend change. Each fix is its own commit and its own reviewable task.

**Tech Stack:** Node.js + Express (thin dependency-injected routers), `node:test` + `node:assert`, Postgres (`pg`), Railway deploy on push to `main`.

## Global Constraints

- **Source spec:** `docs/superpowers/specs/2026-07-16-multi-tenant-platform-admin-design.md` (§2.3, §10 Phase 0). This plan implements Phase 0 only.
- **Backend has NO build step** — pure Node. Verify by booting, not compiling.
- **Auth gates on Discord ID, never display name.** Platform owners: Cabbage/Kyle `135203806676779008` (hardcoded `PLATFORM_OWNER_IDS`), Goofer `168055630916091904` (`ADMIN_IDS` env).
- **Tests:** `node --test <file>` per memory — `node --test lib/` (dir form) is broken on node24; always name files. Route suites use the `app.listen(0)` ephemeral-port + stub-deps pattern (see `routes/adminTickets.routes.test.js`), and **must close the server** in a `finally` or the suite hangs.
- **DI routers register routes at construction but reference deps only inside handlers** — a focused test may stub only the deps its one route touches; leave the rest `undefined`/no-op.
- **Never `git add -A`** (parallel sessions share the worktree). Stage the exact files each task lists. There are unrelated dirty files (`package-lock.json`, `hunts_archive.json`) — do not stage them.
- **`git pull --ff-only` before starting** — `main` is shared and auto-deploys.
- Do **not** add Claude authorship trailers to commits.

---

## File Structure

| File | Responsibility | Change |
| --- | --- | --- |
| `routes/settings.routes.js` | user + admin user-mgmt routes | Fix 1: gate `grandfather-full-extension` on `requirePlatformAdmin` |
| `server.js` | composition root | Fix 1: inject `requirePlatformAdmin` into `settingsRoutes(...)` |
| `routes/settings.routes.test.js` | **new** — focused gate test | Fix 1 test |
| `routes/hunts.routes.js` | public + my-hunt routes | Fix 2: `inTenant` + `publicHuntView` on archived-snapshot route |
| `routes/hunts.routes.test.js` | **new** — focused test | Fix 2 test |
| `routes/admin.routes.js` | admin hunt/stats/export routes | Fix 3: delete `requireAdminOrKey`, gate xlsx on `requireAuth,requireAdmin` |
| `routes/admin.routes.test.js` | **new** — focused test | Fix 3 test |
| `routes/auth.routes.js` | auth + known-users + memberships | Fix 4: tenant-scope `/api/known-users` via `community_members` |
| `routes/auth.routes.test.js` | **new** — focused test | Fix 4 test |

Tasks are independent and may be implemented in any order, but the numbering reflects blast-radius priority (Task 1 is the company-ender).

---

### Task 1: Gate `grandfather-full-extension` on platform admin

**Why:** `POST /api/admin/grandfather-full-extension` is `requireAuth, requireAdmin`. `requireAdmin` passes for any **tenant** admin/mod (`reqIsAdmin` folds in `reqIsMod`), and the handler calls `featureGrants.grandfatherGrant('full_extension', …)` which backfills **every** `known_users` row — irreversibly destroying the paid extension product. It must be platform-owner-only.

**Files:**
- Modify: `routes/settings.routes.js:23` (destructure) and `:149` (gate)
- Modify: `server.js:631-634` (inject dep)
- Test: `routes/settings.routes.test.js` (create)

**Interfaces:**
- Consumes: `requirePlatformAdmin(req,res,next)` — already constructed in `server.js` and injected into `admin.routes`/`cosmetics.routes`; this task threads it into `settings.routes` too.
- Produces: no new exports.

- [ ] **Step 1: Write the failing test**

Create `routes/settings.routes.test.js`:

```js
// Focused gate test: POST /api/admin/grandfather-full-extension must require PLATFORM admin,
// not merely a tenant admin. Follows the app.listen(0) + stub-deps pattern.
const { test } = require('node:test');
const assert = require('node:assert');
const express = require('express');
const settingsRoutes = require('./settings.routes');

function appWith({ platformAdmin }) {
  const app = express();
  app.use(express.json());
  const pass = (req, res, next) => next();
  const requirePlatformAdmin = platformAdmin
    ? pass
    : (req, res, next) => res.status(403).json({ error: 'Platform admin only' });
  app.use(settingsRoutes({
    settings: { getSettings: async () => ({}), saveSettings: async () => {}, deleteSettings: async () => {}, resolveUserIdByName: async () => null },
    pgPool: null, memberships: {},
    isPlatformAdmin: () => platformAdmin,
    reqIsMod: () => false, reqIsVipHost: () => false, reqHasFullExtension: async () => false,
    requireAuth: pass, requireAdmin: pass, requirePlatformAdmin,
    io: { emit() {} }, subscriptions: {},
    featureGrants: { grandfatherGrant: async () => 7 },
    hunts: {}, archive: [], statsStore: {}, refreshGuildRoles: async () => null,
  }));
  return app;
}

async function req(app, method, pathname) {
  const server = await new Promise(r => { const s = app.listen(0, () => r(s)); });
  try {
    const r = await fetch(`http://127.0.0.1:${server.address().port}${pathname}`, {
      method, headers: { 'Content-Type': 'application/json' }, body: '{}',
    });
    return { status: r.status, body: await r.json().catch(() => null) };
  } finally {
    await new Promise(res => server.close(res));
  }
}

test('tenant admin (non-platform) is rejected', async () => {
  const res = await req(appWith({ platformAdmin: false }), 'POST', '/api/admin/grandfather-full-extension');
  assert.strictEqual(res.status, 403);
});

test('platform admin succeeds and backfills', async () => {
  const res = await req(appWith({ platformAdmin: true }), 'POST', '/api/admin/grandfather-full-extension');
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(res.body, { ok: true, granted: 7 });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test routes/settings.routes.test.js`
Expected: FAIL — the route is still gated `requireAuth, requireAdmin`, and `requirePlatformAdmin` is not yet destructured (it's `undefined`, so `app.use` throws or the non-platform case returns 200 instead of 403).

- [ ] **Step 3: Thread the dep and change the gate**

In `routes/settings.routes.js:23`, add `requirePlatformAdmin` to the destructure:

```js
  const { settings, pgPool, memberships, isPlatformAdmin, reqIsMod, reqIsVipHost, reqHasFullExtension, requireAuth, requireAdmin, requirePlatformAdmin, io, subscriptions, featureGrants, hunts, archive, statsStore, refreshGuildRoles } = deps;
```

At `routes/settings.routes.js:149`, change the gate:

```js
  router.post('/api/admin/grandfather-full-extension', requireAuth, requirePlatformAdmin, async (req, res) => {
```

In `server.js:631-634`, inject the dep at the mount site:

```js
app.use(require('./routes/settings.routes')({
  settings, pgPool, memberships, isPlatformAdmin, reqIsMod, reqIsVipHost, reqHasFullExtension, requireAuth, requireAdmin, requirePlatformAdmin, io, subscriptions, featureGrants,
  hunts, archive, statsStore, refreshGuildRoles,
}));
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test routes/settings.routes.test.js`
Expected: PASS (2 tests).

- [ ] **Step 5: Verify `requirePlatformAdmin` exists at the mount site**

Run: `node -e "const s=require('fs').readFileSync('server.js','utf8'); const i=s.indexOf('settings.routes'); console.log(/requirePlatformAdmin/.test(s.slice(0,i)) ? 'OK: defined before mount' : 'MISSING')"`
Expected: `OK: defined before mount` (it's constructed earlier and already passed to `cosmetics.routes` at `server.js:641`).

- [ ] **Step 6: Commit**

```bash
git add routes/settings.routes.js routes/settings.routes.test.js server.js
git commit -m "fix: gate grandfather-full-extension on platform admin, not tenant admin"
```

---

### Task 2: Stop the archived-hunt snapshot leak (tenant-scope + strip)

**Why:** `GET /api/hunts/:userId/archived/:archivedAt` spreads the raw archived hunt (`{...found}`) — leaking `equity[].discordId`, the editor list, and call-permission IDs — and has no tenant guard, so any slug returns any tenant's archived hunt. Fix = `inTenant` guard + `publicHuntView`. **Do NOT add `requireAuth`**: this route feeds the public `WatchHunt` page (`frontend WatchHunt.js:29`) for anonymous past-hunt viewing, exactly like its sibling `GET /api/hunts/:userId` (line 64), which is deliberately anonymous + stripped.

**Files:**
- Modify: `routes/hunts.routes.js:16` (import `inTenant`) and `:57-62` (route body)
- Test: `routes/hunts.routes.test.js` (create)

**Interfaces:**
- Consumes: `inTenant(hunt, tenantId)` from `lib/hunts-core` — returns `tenantOf(hunt) === (tenantId || 'bean')`, where `tenantOf(h)=h.tenantId||'bean'`. `publicHuntView(hunt, callerId)` from deps (already used at line 107).
- Produces: no new exports.

- [ ] **Step 1: Write the failing test**

Create `routes/hunts.routes.test.js`:

```js
// Archived-snapshot route must (a) 404 across tenants and (b) return a publicHuntView-stripped
// body, never the raw snapshot with equity discordIds. No requireAuth (public WatchHunt consumer).
const { test } = require('node:test');
const assert = require('node:assert');
const express = require('express');
const huntsRoutes = require('./hunts.routes');

const ARCHIVED = {
  user: { id: 'u1' }, archivedAt: '2026-07-01T00:00:00.000Z', tenantId: 'bean',
  equity: [{ name: 'Ann', discordId: 'SECRET_DISCORD_ID', amount: 5 }],
  invitedEditors: ['ed1'],
};

function appWith({ tenantId }) {
  const app = express();
  app.use((req, res, next) => { req.tenant = { id: tenantId }; req.user = null; next(); });
  app.use(huntsRoutes({
    requireAuth: (req, res, next) => next(),
    canEditHunt: () => false, isEquityMember: () => false, reqIsMod: () => false,
    hunts: {}, archive: [ARCHIVED],
    getPublicHunts: () => [], getArchivedHunts: () => [],
    emitHubUpdate() {}, emitHuntUpdate() {},
    // Stub strips discordId + editor list, marks that it ran.
    publicHuntView: (h) => ({ user: h.user, archivedAt: h.archivedAt, equity: (h.equity || []).map(e => ({ name: e.name, amount: e.amount })), _stripped: true }),
    uid: () => 'x', touch() {}, persistHunts() {}, archiveHunt() {}, unarchiveHunt() {},
    io: { emit() {} }, rejectBadHuntInput: () => null,
    resolveUserIdByName: async () => null, getCreatorLive: () => ({ isLive: false }), refreshCreatorsLive() {},
  }));
  return app;
}

async function get(app, pathname) {
  const server = await new Promise(r => { const s = app.listen(0, () => r(s)); });
  try {
    const r = await fetch(`http://127.0.0.1:${server.address().port}${pathname}`);
    return { status: r.status, body: await r.json().catch(() => null) };
  } finally {
    await new Promise(res => server.close(res));
  }
}

const PATH = '/api/hunts/u1/archived/' + encodeURIComponent('2026-07-01T00:00:00.000Z');

test('same tenant: returns stripped snapshot, no discordId', async () => {
  const res = await get(appWith({ tenantId: 'bean' }), PATH);
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body._stripped, true);
  assert.strictEqual(res.body.canEdit, false);
  assert.ok(!JSON.stringify(res.body).includes('SECRET_DISCORD_ID'));
  assert.ok(!JSON.stringify(res.body).includes('invitedEditors'));
});

test('other tenant: 404 (inTenant guard)', async () => {
  const res = await get(appWith({ tenantId: 'trashguy' }), PATH);
  assert.strictEqual(res.status, 404);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test routes/hunts.routes.test.js`
Expected: FAIL — the current route spreads `{...found}` (leaks `SECRET_DISCORD_ID`, no `_stripped`) and has no tenant guard (other-tenant returns 200, not 404).

- [ ] **Step 3: Import `inTenant` and rewrite the route**

At `routes/hunts.routes.js:16`, add `inTenant` to the existing `hunts-core` import:

```js
const { CURRENCIES, sanitizeBonusReplayUrls, huntHasContent, inTenant } = require('../lib/hunts-core');
```

Replace the route at `routes/hunts.routes.js:57-62`:

```js
  router.get('/api/hunts/:userId/archived/:archivedAt', (req, res) => {
    const { userId, archivedAt } = req.params;
    const found = archive.find(h => h.user?.id === userId && h.archivedAt === archivedAt);
    // Tenant-scoped + stripped: this is a PUBLIC route (WatchHunt), so serve the same
    // publicHuntView the live sibling does — never the raw snapshot (equity discordIds,
    // editor list). inTenant keeps one tenant's archive from being read via another's slug.
    if (!found || !inTenant(found, req.tenant?.id)) return res.status(404).json({ error: 'Archived hunt not found' });
    res.json({ ...publicHuntView(found, req.user?.id), canEdit: false, canAddCalls: false });
  });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test routes/hunts.routes.test.js`
Expected: PASS (2 tests).

- [ ] **Step 5: Confirm `inTenant` is a real export**

Run: `node -e "console.log(typeof require('./lib/hunts-core').inTenant)"`
Expected: `function`.

- [ ] **Step 6: Commit**

```bash
git add routes/hunts.routes.js routes/hunts.routes.test.js
git commit -m "fix: tenant-scope and strip archived-hunt snapshot (no raw discordIds)"
```

---

### Task 3: Remove the `GOTIN_EXPORT_KEY` auth+tenant bypass

**Why:** `requireAdminOrKey` (`admin.routes.js:55-60`) lets a static `GOTIN_EXPORT_KEY` (accepted from a header **or `?key=` query string**) skip auth **and** tenant checks, while the handler reads the client-supplied `X-Tenant-Slug` — so one env value plus a spoofed slug exports any tenant's full got-in log. Delete the bypass; gate the xlsx export like every other admin export (`requireAuth, requireAdmin`). Tradeoff (accepted per spec §2.3): the headless daily-export script loses its keyless path; a scoped replacement is out of Phase 0 scope.

**Files:**
- Modify: `routes/admin.routes.js:53-60` (delete function) and `:65` (change gate)
- Test: `routes/admin.routes.test.js` (create)

**Interfaces:**
- Consumes: existing `requireAuth`, `requireAdmin` from deps.
- Produces: no new exports. Removes the local `requireAdminOrKey`.

- [ ] **Step 1: Write the failing test**

Create `routes/admin.routes.test.js`:

```js
// The got-in xlsx export must NOT be reachable via GOTIN_EXPORT_KEY. With no admin session,
// even a correct ?key= must be rejected by requireAuth — the key path is gone.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const express = require('express');
const adminRoutes = require('./admin.routes');

before(() => { process.env.GOTIN_EXPORT_KEY = 'topsecret'; });
after(() => { delete process.env.GOTIN_EXPORT_KEY; });

function appNoAuth() {
  const app = express();
  app.use((req, res, next) => { req.user = null; req.tenant = { id: 'bean' }; next(); });
  const requireAuth = (req, res, next) => req.user ? next() : res.status(401).json({ error: 'auth' });
  const requireAdmin = (req, res, next) => res.status(403).json({ error: 'admin' });
  const requirePlatformAdmin = (req, res, next) => res.status(403).json({ error: 'platform' });
  app.use(adminRoutes({
    requireAuth, requireAdmin, requirePlatformAdmin,
    getAllHunts: () => [], getArchivedHunts: () => [], getGotInLog: () => [], getHuntsFullExport: () => [], getHuntStats: () => ({}),
    pgPool: null, admins: {}, tenants: {}, ADMIN_IDS: [], statsStore: {},
    hunts: {}, archive: [], archiveHunt() {}, unarchiveHunt() {}, persistArchive() {},
    emitHubUpdate() {}, publicHuntView: h => h, emitHuntUpdate() {}, io: { emit() {} }, uid: () => 'x', cleanupStaleHunts() {},
    subscriptions: {},
  }));
  return app;
}

async function get(app, pathname) {
  const server = await new Promise(r => { const s = app.listen(0, () => r(s)); });
  try {
    const r = await fetch(`http://127.0.0.1:${server.address().port}${pathname}`);
    return r.status;
  } finally {
    await new Promise(res => server.close(res));
  }
}

test('xlsx export with valid key but no session is rejected (401)', async () => {
  const status = await get(appNoAuth(), '/api/admin/gotin-log.xlsx?key=topsecret');
  assert.strictEqual(status, 401);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test routes/admin.routes.test.js`
Expected: FAIL — `requireAdminOrKey` accepts `?key=topsecret` and calls `next()`, so the request reaches the handler (status ≠ 401; likely 200 or 500 from the workbook builder).

- [ ] **Step 3: Delete the bypass and re-gate**

Delete `routes/admin.routes.js:53-60` entirely (the comment block + the `requireAdminOrKey` function):

```js
  // Allow either an admin session (in-app button) OR a matching GOTIN_EXPORT_KEY (headless daily
  // script — no Discord login). The key path stays read-only and is only wired to the export below.
  function requireAdminOrKey(req, res, next) {
    const KEY = process.env.GOTIN_EXPORT_KEY;
    const provided = req.headers['x-export-key'] || req.query.key;
    if (KEY && provided && provided === KEY) return next();
    return requireAuth(req, res, () => requireAdmin(req, res, next));
  }
```

At `routes/admin.routes.js:65`, change the gate from `requireAdminOrKey` to the standard pair:

```js
  router.get('/api/admin/gotin-log.xlsx', requireAuth, requireAdmin, async (req, res) => {
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test routes/admin.routes.test.js`
Expected: PASS (1 test).

- [ ] **Step 5: Confirm no other reference to the removed function**

Run: `grep -rn "requireAdminOrKey\|GOTIN_EXPORT_KEY\|x-export-key" routes/ server.js`
Expected: no matches (the function, the env read, and the header are all gone).

- [ ] **Step 6: Commit**

```bash
git add routes/admin.routes.js routes/admin.routes.test.js
git commit -m "fix: remove GOTIN_EXPORT_KEY auth+tenant bypass on got-in export"
```

---

### Task 4: Tenant-scope `/api/known-users`

**Why:** `GET /api/known-users` (`auth.routes.js:93-113`) returns the **500 most recent platform-wide** users to any logged-in user — every community's roster. It exists for equity-name autocomplete, which only needs the current tenant's members. Scope it by joining `community_members` on `req.tenant.id`.

**Files:**
- Modify: `routes/auth.routes.js:93-113` (the query)
- Test: `routes/auth.routes.test.js` (create)

**Interfaces:**
- Consumes: `pgPool` and `req.tenant.id` (set globally by `resolveTenant`). No new deps — `memberships`/`pgPool` already in scope.
- Produces: no new exports. Same response shape: `[{ id, displayName, avatar }]`.

- [ ] **Step 1: Write the failing test**

Create `routes/auth.routes.test.js`:

```js
// /api/known-users must scope to the current tenant's members. Assert the SQL joins
// community_members and is parameterized by req.tenant.id.
const { test } = require('node:test');
const assert = require('node:assert');
const express = require('express');
const authRoutes = require('./auth.routes');

function appWith({ tenantId, capture }) {
  const app = express();
  app.use((req, res, next) => { req.user = { id: 'caller' }; req.tenant = { id: tenantId }; next(); });
  const pgPool = {
    query: async (sql, params) => { capture.sql = sql; capture.params = params; return { rows: [{ id: '111', displayName: 'A', avatar: null }] }; },
  };
  app.use(authRoutes({
    requireAuth: (req, res, next) => next(),
    pgPool, memberships: { getUserCommunities: async () => [] },
    tenants: { getTenantBySlug: () => null },
    signToken: () => 't', passport: { authenticate: () => (req, res, next) => next() },
    FRONTEND_URL: '', settings: {}, subscriptions: {}, featureGrants: { getGrantsForUser: () => [] },
    reqIsAdmin: () => false, reqIsVipHost: () => false, reqIsMod: () => false,
    isPlatformAdmin: () => false, refreshGuildRoles: async () => null, guildFlags: () => ({}),
  }));
  return app;
}

async function get(app, pathname) {
  const server = await new Promise(r => { const s = app.listen(0, () => r(s)); });
  try {
    const r = await fetch(`http://127.0.0.1:${server.address().port}${pathname}`);
    return { status: r.status, body: await r.json().catch(() => null) };
  } finally {
    await new Promise(res => server.close(res));
  }
}

test('known-users query is tenant-scoped', async () => {
  const capture = {};
  const res = await get(appWith({ tenantId: 'trashguy', capture }), '/api/known-users');
  assert.strictEqual(res.status, 200);
  assert.match(capture.sql, /community_members/i);
  assert.deepStrictEqual(capture.params, ['trashguy']);
});
```

> **Note on stub breadth:** `authRoutes(deps)` destructures many deps but registers routes at construction; only `requireAuth`, `pgPool`, and `req.tenant` are exercised by this one route. If the factory references a dep not stubbed above **at construction time** (not inside a handler), add a no-op stub for it — do not change the production destructure to accommodate the test.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test routes/auth.routes.test.js`
Expected: FAIL — the current query selects from `known_users` with no `community_members` join and passes no params, so `capture.sql` won't match `/community_members/i` and `capture.params` is `undefined`.

- [ ] **Step 3: Tenant-scope the query**

Replace the `pgPool.query(...)` call inside `routes/auth.routes.js:101-107` so it joins `community_members` and filters by tenant:

```js
      const r = await pgPool.query(
        `SELECT ku.user_id AS id, ku.display_name AS "displayName", ku.avatar
         FROM known_users ku
         JOIN community_members cm ON cm.user_id = ku.user_id
         WHERE cm.tenant_id = $1 AND ku.user_id ~ '^[0-9]{17,20}$'
         ORDER BY ku.last_seen DESC
         LIMIT 500`,
        [req.tenant?.id || 'bean']
      );
```

Update the comment above the query (`auth.routes.js:96-100`) to note it is now tenant-scoped (members of `req.tenant`), keeping the synthetic-`manual:`-row filter rationale.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test routes/auth.routes.test.js`
Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
git add routes/auth.routes.js routes/auth.routes.test.js
git commit -m "fix: tenant-scope /api/known-users to current community members"
```

---

### Task 5: Full-suite + boot verification

**Why:** Confirm the four fixes didn't break existing suites and the server still boots (no build step means boot is the compile check).

**Files:** none (verification only).

- [ ] **Step 1: Run the four new suites together**

Run: `node --test routes/settings.routes.test.js routes/hunts.routes.test.js routes/admin.routes.test.js routes/auth.routes.test.js`
Expected: all pass.

- [ ] **Step 2: Run the existing route + lib suites that touch changed areas**

Run: `node --test routes/adminTickets.routes.test.js routes/cardRequests.routes.test.js routes/misc.routes.test.js lib/hunts-core.test.js lib/tenants.test.js`
Expected: all pass (unchanged behavior).

- [ ] **Step 3: Boot the server on a fresh port to catch load/wiring errors**

> Per memory: `npm start` ignores `.env`; nodemon is uninstalled. Boot directly. First confirm no `GITHUB_PAT` is set (`lib/rainbetSlotSync` pushes if it is).

Run: `GITHUB_PAT= PORT=3199 node -r dotenv/config server.js`
Expected: startup logs, no throw, `[pg]` line. Confirm it reached "listening"/prefetch, then stop it (Ctrl-C). If `settings.routes` or `admin.routes` had a bad destructure/mount, boot throws here.

- [ ] **Step 4: Confirm the branch diff is exactly the intended files**

Run: `git diff --stat main`
Expected: only `routes/settings.routes.js`, `routes/hunts.routes.js`, `routes/admin.routes.js`, `routes/auth.routes.js`, `server.js`, and the four new `*.routes.test.js` files (plus this plan/spec if committed on the same branch). No `package-lock.json`, no `hunts_archive.json`.

---

## Self-Review

**Spec coverage (§10 Phase 0 row):**
- re-gate `grandfather-full-extension` → Task 1 ✅
- fix archived-hunt read (`inTenant` + `publicHuntView`, not `requireAuth`) → Task 2 ✅ (matches corrected spec §2.3)
- kill `requireAdminOrKey` → Task 3 ✅
- tenant-scope `/api/known-users` → Task 4 ✅
- "no FE, no migration" → honored; all four are backend-only, no schema change ✅

**Placeholder scan:** none — every step has concrete code/commands and expected output.

**Type/name consistency:** `requirePlatformAdmin` (dep name matches `server.js` construction + `cosmetics.routes` usage); `inTenant(hunt, tenantId)` matches `lib/hunts-core` export; `publicHuntView(hunt, callerId)` matches existing line-107 usage; response shape `[{id,displayName,avatar}]` preserved in Task 4; test helper `get`/`req` + `appWith` mirror `adminTickets.routes.test.js`.

**Deviation from source spec (recorded):** Task 2 deliberately omits `requireAuth` — the spec was corrected in the same session (§2.3) after confirming `WatchHunt.js:29` is a public consumer. This is intentional, not a gap.
