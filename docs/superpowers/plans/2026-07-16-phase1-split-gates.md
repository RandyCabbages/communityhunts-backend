# Phase 1 — Split Tenant-Admin from Mod Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Introduce a `requireTenantAdmin` gate (platform-owner OR this-tenant's admin, but NOT a mod) and use it to stop mods reaching sensitive routes — tightening the tenant Discord config (bot-token secret) and moving the global-write user routes to platform-only.

**Architecture:** Add two functions to `lib/auth.js` (`reqIsTenantAdmin` predicate + `requireTenantAdmin` middleware), thread the middleware through `server.js` into `admin.routes`, then flip individual route gates. `reqIsAdmin` is deliberately left unchanged — mods keep their existing read/console visibility; only the sensitive routes get the stricter gate.

**Tech Stack:** Node.js + Express (DI routers), `node:test` + `node:assert`.

## Global Constraints

- **Source spec:** `docs/superpowers/specs/2026-07-16-multi-tenant-platform-admin-design.md` (§4.1, §4.3, §10 Phase 1). Depends on Phase 0 (merged, PR #60). **Blocks Phase 3.**
- **Key design decision (resolves a spec ambiguity):** §10 says "drop the `reqIsMod` fold-in from `reqIsAdmin`", but §4.1's code and the live `auth.js:183-189` deliberately KEEP it ("additive only — never removes access"). Dropping it would strip mods' legitimate visibility to hunts/overview/socials. **This plan keeps `reqIsAdmin` as-is and adds a stricter `requireTenantAdmin` for the sensitive routes.** That is the correct, minimal reading.
- **Auth gates on Discord ID, never display name.** `isPlatformAdmin` = `ADMIN_IDS` env ∪ `platform_admins` DB ∪ hardcoded `PLATFORM_OWNER_IDS` (Goofer `168055630916091904`, Kyle `135203806676779008`).
- **Breaking for Bean's 5 seeded mods:** after this, a Bean mod can no longer read/write the tenant Discord config or the 5 global user-write routes. In practice these are owner tools mods don't use — but notify before deploy.
- **Tests:** `node --test <file>` (never the dir form). Route suites use the `app.listen(0)` + stub-deps pattern; middleware can be tested directly with a fake req/res/next.
- **No build step** — boot is the compile check. Boot with `GITHUB_PAT= PORT=<fresh> node -r dotenv/config server.js` (confirm no `GITHUB_PAT`; `.env` has `DATABASE_PUBLIC_URL`, not `DATABASE_URL`, so it boots in-memory — fine for wiring).
- **Shared `main` auto-deploys.** `git pull --ff-only` before branching/merging; never `git add -A`; no Claude authorship trailers.

---

## File Structure

| File | Responsibility | Change |
| --- | --- | --- |
| `lib/auth.js` | auth predicates + gate middlewares | Add `reqIsTenantAdmin` + `requireTenantAdmin`; export both |
| `lib/auth.test.js` | **new** — focused predicate test | Task 1 test |
| `server.js` | composition root | Destructure the two new gates; inject `requireTenantAdmin` into `admin.routes` |
| `routes/admin.routes.js` | admin routes | `discord-config` GET+PUT: `requireAdmin` → `requireTenantAdmin`; add dep |
| `routes/admin.routes.test.js` | existing (Phase 0) | +discord-config gate test |
| `routes/settings.routes.js` | user + admin user-mgmt | 5 global-write routes: `requireAdmin` → `requirePlatformAdmin` |
| `routes/settings.routes.test.js` | existing (Phase 0) | +global-write gate test |

**Out of scope (deferred, documented):** `GET /api/admin/users[/:userId]` and `DELETE /api/admin/users/:userId` stay `requireAdmin` — they are the per-tenant-scoping work in Phase 6, not a platform re-gate. The `apiKeys.routes.js` `requireOwnerOrPlatform` local copy is left as-is (equivalent to the new shared helper; dedup is a low-value future cleanup).

---

### Task 1: Add `reqIsTenantAdmin` + `requireTenantAdmin` to `lib/auth.js`

**Why:** The codebase has no "this tenant's admin, but not a mod" gate. The only correct implementation is the local `requireOwnerOrPlatform` in `apiKeys.routes.js:11-15`. Promote it into `lib/auth.js` so sensitive routes can share it.

**Files:**
- Modify: `lib/auth.js` (add after `reqIsMod`/`reqIsAdmin` ~line 189; export ~line 246)
- Test: `lib/auth.test.js` (create)

**Interfaces:**
- Consumes: `isPlatformAdmin(user)` (auth.js:55), `tenants.isTenantAdmin(user, tenant)` (injected via `initAuth`).
- Produces: `reqIsTenantAdmin(req) -> bool` and `requireTenantAdmin(req,res,next)`, both exported.

- [ ] **Step 1: Write the failing test**

Create `lib/auth.test.js`:

```js
// requireTenantAdmin = platform owner OR this-tenant's admin, but NOT a mod. Unlike reqIsAdmin,
// it does not fold in reqIsMod. Middleware tested directly with a fake req/res/next.
const { test } = require('node:test');
const assert = require('node:assert');
const auth = require('./auth');

// Minimal DI: no env admins; owner + tenant-admin resolved via stubbed tenants.
auth.initAuth({
  ADMIN_IDS: [], VIP_IDS: [], SESSION_SECRET: 'x', MULTI_TENANT: true,
  tenants: {
    isPlatformOwnerId: (id) => id === 'OWNER',
    isTenantAdmin: (u, t) => !!(u && t && (t.adminIds || []).includes(u.id)),
    isTenantMod:   (u, t) => !!(u && t && (t.modIds   || []).includes(u.id)),
    BEAN_TENANT: {},
  },
  admins: { isDbAdmin: () => false },
  hunts: {}, recordKnownUser() {},
});

function run(req) {
  let status = 200, ended = false, called = false;
  const res = { status(c) { status = c; return this; }, json() { ended = true; return this; } };
  auth.requireTenantAdmin(req, res, () => { called = true; });
  return { status, ended, called };
}

const TENANT = { adminIds: ['A1'], modIds: ['M1'] };

test('tenant admin passes', () => {
  const r = run({ user: { id: 'A1' }, tenant: TENANT });
  assert.strictEqual(r.called, true);
});

test('platform owner passes', () => {
  const r = run({ user: { id: 'OWNER' }, tenant: TENANT });
  assert.strictEqual(r.called, true);
});

test('a mod is REJECTED (403) — this is the point', () => {
  const r = run({ user: { id: 'M1' }, tenant: TENANT });
  assert.strictEqual(r.called, false);
  assert.strictEqual(r.status, 403);
});

test('a random user is rejected (403)', () => {
  const r = run({ user: { id: 'nobody' }, tenant: TENANT });
  assert.strictEqual(r.status, 403);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test lib/auth.test.js`
Expected: FAIL — `auth.requireTenantAdmin` is `undefined` (not exported yet), so the call throws.

- [ ] **Step 3: Add the predicate + middleware**

In `lib/auth.js`, immediately after `reqIsAdmin` (ends at line 189), add:

```js
// Tenant admin = platform owner OR this tenant's admin (tenant_roles role=admin). Deliberately does
// NOT fold in reqIsMod — this is the stricter gate for sensitive per-tenant config and owner tools,
// where a mod must not pass. Resolves against req.tenant unconditionally (always set by resolveTenant),
// mirroring the promoted reference impl from routes/apiKeys.routes.js.
function reqIsTenantAdmin(req) {
  if (isPlatformAdmin(req.user)) return true;
  return tenants.isTenantAdmin(req.user, req.tenant);
}
```

Then, after `requirePlatformAdmin` (ends at line 195), add:

```js
function requireTenantAdmin(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
  if (!reqIsTenantAdmin(req)) return res.status(403).json({ error: 'Tenant admin only' });
  next();
}
```

In the `module.exports` block (line 246), add both to the gate line:

```js
  requireAuth, reqIsAdmin, reqIsVipHost, requireAdmin, requirePlatformAdmin,
  reqIsMod, requireMod, reqIsTenantAdmin, requireTenantAdmin,
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test lib/auth.test.js`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/auth.js lib/auth.test.js
git commit -m "feat: add reqIsTenantAdmin + requireTenantAdmin gate (owner or tenant admin, not mod)"
```

---

### Task 2: Re-gate `discord-config` to `requireTenantAdmin`

**Why:** `GET/PUT /api/admin/discord-config` (`admin.routes.js:231,235`) are `requireAuth, requireAdmin`. `requireAdmin` folds in `reqIsMod`, so a mod passes — and `getTenantDiscordConfig` returns the tenant **bot token in cleartext**. Tighten to `requireTenantAdmin`.

**Files:**
- Modify: `routes/admin.routes.js:30` (deps) and `:231,:235` (gates)
- Modify: `server.js:146-149` (destructure) and `:587-588` (inject dep)
- Test: `routes/admin.routes.test.js` (add a case)

**Interfaces:**
- Consumes: `requireTenantAdmin` from Task 1 (via deps).
- Produces: no new exports.

- [ ] **Step 1: Write the failing test**

Append to `routes/admin.routes.test.js` (reuse the existing `express`/`node:test` imports at the top of that file — do not re-import). Add a self-contained app builder + test:

```js
test('discord-config is gated on requireTenantAdmin, not requireAdmin (mods rejected)', async () => {
  const app = express();
  app.use((req, res, next) => { req.user = { id: 'mod1' }; req.tenant = { id: 'bean', displayName: 'Bean' }; next(); });
  const pass = (req, res, next) => next();
  const denyTenantAdmin = (req, res, next) => res.status(403).json({ error: 'tenant admin only' });
  app.use(adminRoutes({
    requireAuth: pass, requireAdmin: pass, requirePlatformAdmin: pass, requireTenantAdmin: denyTenantAdmin,
    getAllHunts: () => [], getArchivedHunts: () => [], getGotInLog: () => [], getHuntsFullExport: () => [], getHuntStats: () => ({}),
    pgPool: null, admins: {}, ADMIN_IDS: [], statsStore: {},
    tenants: { getTenantDiscordConfig: () => ({ botToken: 'SECRET' }), BEAN_TENANT: { id: 'bean' } },
    hunts: {}, archive: [], archiveHunt() {}, unarchiveHunt() {}, persistArchive() {},
    emitHubUpdate() {}, publicHuntView: h => h, emitHuntUpdate() {}, io: { emit() {} }, uid: () => 'x', cleanupStaleHunts() {},
    subscriptions: {},
  }));
  const server = await new Promise(r => { const s = app.listen(0, () => r(s)); });
  try {
    const r = await fetch(`http://127.0.0.1:${server.address().port}/api/admin/discord-config`);
    assert.strictEqual(r.status, 403); // requireTenantAdmin denies; requireAdmin (pass) would have 200'd
  } finally {
    await new Promise(res => server.close(res));
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test routes/admin.routes.test.js`
Expected: the new test FAILS — the route still uses `requireAdmin` (stubbed pass), so it returns 200, not 403. (The two Phase 0 tests still pass.)

- [ ] **Step 3: Add the dep and flip the gate**

In `routes/admin.routes.js`, add `requireTenantAdmin` to the deps destructure (line 30):

```js
    requireAuth, requireAdmin, requirePlatformAdmin, requireTenantAdmin,
```

Change both discord-config gates (`:231`, `:235`) from `requireAdmin` to `requireTenantAdmin`:

```js
  router.get('/api/admin/discord-config', requireAuth, requireTenantAdmin, (req, res) => {
```
```js
  router.put('/api/admin/discord-config', requireAuth, requireTenantAdmin, async (req, res) => {
```

- [ ] **Step 4: Wire the dep through `server.js`**

In `server.js`, add the two new gates to the destructure from `auth` (lines 146-147):

```js
  requireAuth, reqIsAdmin, reqIsVipHost, requireAdmin, requirePlatformAdmin,
  reqIsMod, requireMod, reqIsTenantAdmin, requireTenantAdmin,
```

In the `admin.routes` mount (line 588), inject it:

```js
  requireAuth, requireAdmin, requirePlatformAdmin, requireTenantAdmin,
```

- [ ] **Step 5: Run test to verify it passes**

Run: `node --test routes/admin.routes.test.js`
Expected: PASS (3 tests — 2 Phase 0 + the new one).

- [ ] **Step 6: Commit**

```bash
git add routes/admin.routes.js routes/admin.routes.test.js server.js
git commit -m "fix: gate tenant discord-config on requireTenantAdmin (mods can no longer read the bot token)"
```

---

### Task 3: Re-gate the 5 global-write settings routes to `requirePlatformAdmin`

**Why:** These write **global** tables (`user_settings`, `feature_grants`) with no tenant scope, but are gated `requireAdmin` — so any tenant admin/mod can set another user's payout handle (`rainbetName`), preferred slots, feature grants, or cosmetics platform-wide. They must be platform-owner-only until per-tenant scoping (Phase 6). `requirePlatformAdmin` is already injected into `settings.routes` (Phase 0).

**Files:**
- Modify: `routes/settings.routes.js:210, 388, 413, 461, 500`
- Test: `routes/settings.routes.test.js` (add a case)

**Interfaces:**
- Consumes: `requirePlatformAdmin` (already in `settings.routes` deps since Phase 0).
- Produces: no new exports.

- [ ] **Step 1: Write the failing test**

Append to `routes/settings.routes.test.js` (reuse existing imports). This asserts a non-platform tenant admin is rejected from `set-user-field` — representative of all five:

```js
test('set-user-field is platform-only now (tenant admin rejected)', async () => {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.user = { id: 'tenantadmin' }; req.tenant = { id: 'bean' }; next(); });
  const pass = (req, res, next) => next();
  const denyPlatform = (req, res, next) => res.status(403).json({ error: 'platform only' });
  app.use(settingsRoutes({
    settings: { getSettings: async () => ({}), saveSettings: async () => {}, deleteSettings: async () => {}, resolveUserIdByName: async () => null },
    pgPool: null, memberships: {},
    isPlatformAdmin: () => false,
    reqIsMod: () => false, reqIsVipHost: () => false, reqHasFullExtension: async () => false,
    requireAuth: pass, requireAdmin: pass, requirePlatformAdmin: denyPlatform,
    io: { emit() {} }, subscriptions: {}, featureGrants: {},
    hunts: {}, archive: [], statsStore: {}, refreshGuildRoles: async () => null,
  }));
  const server = await new Promise(r => { const s = app.listen(0, () => r(s)); });
  try {
    const r = await fetch(`http://127.0.0.1:${server.address().port}/api/admin/set-user-field`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ userId: 'x', field: 'rainbetName', value: 'y' }),
    });
    assert.strictEqual(r.status, 403); // requirePlatformAdmin denies; requireAdmin (pass) would have proceeded
  } finally {
    await new Promise(res => server.close(res));
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test routes/settings.routes.test.js`
Expected: the new test FAILS — `set-user-field` still uses `requireAdmin` (stubbed pass), so it does not 403.

- [ ] **Step 3: Flip the five gates**

In `routes/settings.routes.js`, change `requireAdmin` → `requirePlatformAdmin` on these five routes (keep any existing `requireAuth,` prefix exactly as-is):

- `:210` `router.post('/api/admin/set-rainbet-name', requirePlatformAdmin, ...`
- `:388` `router.post('/api/admin/users/:userId/grants', requireAuth, requirePlatformAdmin, ...`
- `:413` `router.post('/api/admin/users/:userId/cosmetics', requireAuth, requirePlatformAdmin, ...`
- `:461` `router.post('/api/admin/set-user-field', requirePlatformAdmin, ...`
- `:500` `router.post('/api/admin/set-preferred-slots', requirePlatformAdmin, ...`

Do **not** change `:237`/`:287`/`:359` (the `users` list/profile/delete routes) — those are Phase 6.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test routes/settings.routes.test.js`
Expected: PASS (3 tests — 2 Phase 0 + the new one).

- [ ] **Step 5: Confirm exactly the five routes changed, none extra**

Run: `grep -n "requireAdmin\b" routes/settings.routes.js`
Expected: matches only remain on `:237`, `:287`, `:359` (the `users` list/profile/delete — intentionally left). The five write routes no longer show `requireAdmin`.

- [ ] **Step 6: Commit**

```bash
git add routes/settings.routes.js routes/settings.routes.test.js
git commit -m "fix: gate global-write user routes on platform admin (rainbetName/grants/cosmetics/slots)"
```

---

### Task 4: Full-suite + boot verification

**Files:** none (verification only).

- [ ] **Step 1: Run the changed + adjacent suites**

Run: `node --test lib/auth.test.js routes/admin.routes.test.js routes/settings.routes.test.js routes/hunts.routes.test.js`
Expected: all pass.

- [ ] **Step 2: Run existing regression suites**

Run: `node --test lib/tenants.test.js lib/apiKeys.test.js routes/adminTickets.routes.test.js routes/cardRequests.routes.test.js routes/misc.routes.test.js`
Expected: all pass.

- [ ] **Step 3: Boot the server (compile check)**

Run: `GITHUB_PAT= PORT=3198 node -r dotenv/config server.js` in the background, then `curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:3198/api/health` (expect `200`), then stop the process and free the port. A bad `auth` destructure or `admin.routes` mount throws at boot.

- [ ] **Step 4: Confirm the branch diff is exactly the intended files**

Run: `git diff --stat main`
Expected: `lib/auth.js`, `lib/auth.test.js`, `server.js`, `routes/admin.routes.js`, `routes/admin.routes.test.js`, `routes/settings.routes.js`, `routes/settings.routes.test.js`, and this plan doc. No `package-lock.json`, no `hunts_archive.json`.

---

## Self-Review

**Spec coverage (§10 Phase 1 row):**
- `requireTenantAdmin` in `lib/auth.js` → Task 1 ✅ (promotes `apiKeys.routes.js:11-15`)
- "drop reqIsMod fold-in" → **intentionally NOT done** — resolved against §4.1's code + the live comment; documented in Global Constraints. Mods keep read visibility; sensitive routes get the stricter gate instead. ✅
- re-gate the (remaining 5 of 6) settings routes to platform → Task 3 ✅ (grandfather was Phase 0)
- tighten discord-config → Task 2 ✅

**Placeholder scan:** none — every step has concrete code/commands.

**Type/name consistency:** `reqIsTenantAdmin(req)` / `requireTenantAdmin(req,res,next)` names match across auth.js definition, export, server.js destructure, admin.routes deps, and all tests; `requirePlatformAdmin` matches the Phase 0 dep already in `settings.routes`.

**Blast-radius check:** `reqIsAdmin`/`requireAdmin` untouched → every currently-`requireAdmin` route not listed here behaves identically (hunts mutations, overview, hunt-stats, socials, users list). Only `discord-config` (→ tenant admin) and the 5 global writes (→ platform) change. Bean mods lose exactly those; documented as the breaking change.
