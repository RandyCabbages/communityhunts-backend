# Phase 3 — Mods Managed by the Community Owner Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Let a community's own admin (the streamer) add and remove their mods, instead of requiring a platform owner — by moving the mod add/remove routes from `requirePlatformAdmin` to the `requireTenantAdmin` gate introduced in Phase 1.

**Architecture:** Two one-line gate flips in `routes/mods.routes.js`, one dep threaded through `server.js`, comment updates, and a focused test. `requireTenantAdmin` (owner OR this-tenant's admin, NOT a mod) already exists from Phase 1.

**Tech Stack:** Node.js + Express (DI routers), `node:test` + `node:assert`.

## Global Constraints

- **Source spec:** `docs/superpowers/specs/2026-07-16-multi-tenant-platform-admin-design.md` (§4.5, §10 Phase 3). **Depends on Phase 1** (`requireTenantAdmin` — PR #61). **Must merge AFTER #61.**
- **This branch is stacked on `feat/phase1-split-gates`.** Its PR base is that branch (clean diff). Once #61 merges to `main`, rebase onto `main` and retarget the PR base to `main`.
- **Why this is safe now (it wasn't before Phase 0/1):** this route grants the **mod** role only (a lower privilege), never admin — no self-escalation. And it was specifically gated behind Phase 0+1 because, pre-Phase-0, a self-service tenant admin/mod could reach platform-global writes; those are now closed.
- **Seat caps unchanged:** `tenants.modSeatCap(req.tenant)` still enforces the plan's mod-seat limit on add (`'bean'` exempt). A tenant admin adding mods hits their own plan cap — the intended paid-tier behavior.
- **Auth gates on Discord ID, never display name.** `requireTenantAdmin` = platform owner ∪ this tenant's `tenant_roles` admin.
- **Tests:** `node --test <file>`. Route suites use the `app.listen(0)` + stub-deps pattern.
- **No build step** — boot is the compile check. `GITHUB_PAT= PORT=<fresh> node -r dotenv/config server.js`, then curl `/api/health`.
- **Shared `main` auto-deploys.** Never `git add -A`; no Claude authorship trailers.

---

## File Structure

| File | Responsibility | Change |
| --- | --- | --- |
| `routes/mods.routes.js` | tenant-mod management | POST + DELETE: `requirePlatformAdmin` → `requireTenantAdmin`; add dep; update comments |
| `routes/mods.routes.test.js` | **new** — focused gate test | Task 1 test |
| `server.js` | composition root | Inject `requireTenantAdmin` into the `mods.routes` mount |

---

### Task 1: Re-gate mod add/remove to `requireTenantAdmin`

**Why:** `POST /api/admin/mods` and `DELETE /api/admin/mods/:id` (`mods.routes.js:43,66`) are `requirePlatformAdmin`, so a streamer can't manage their own mods — you have to do it for every community. Move them to `requireTenantAdmin` so the tenant's admin (or a platform owner) can, but a mod still can't. `GET /api/admin/mods` stays `requireAdmin` (admins + mods can view the roster).

**Files:**
- Modify: `routes/mods.routes.js:12` (dep), `:43` and `:66` (gates), and the header/inline comments
- Modify: `server.js` (the `mods.routes` mount — inject `requireTenantAdmin`)
- Test: `routes/mods.routes.test.js` (create)

**Interfaces:**
- Consumes: `requireTenantAdmin` (Phase 1, exported from `lib/auth.js`, already destructured in `server.js`).
- Produces: no new exports.

- [ ] **Step 1: Write the failing test**

Create `routes/mods.routes.test.js`:

```js
// Phase 3: a community's own admin (non-platform) can add/remove mods. Before, these were
// requirePlatformAdmin (owner-only); now requireTenantAdmin. A mod still cannot (requireTenantAdmin
// excludes mods — that gate's own test lives in lib/auth.test.js).
const { test } = require('node:test');
const assert = require('node:assert');
const express = require('express');
const modsRoutes = require('./mods.routes');

function appWith({ tenantAdmin }) {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.user = { id: 'u1' }; req.tenant = { id: 'bean', displayName: 'Bean' }; next(); });
  const pass = (req, res, next) => next();
  // Tenant admin passes requireTenantAdmin but NOT requirePlatformAdmin.
  const requireTenantAdmin = tenantAdmin ? pass : (req, res, next) => res.status(403).json({ error: 'tenant admin only' });
  const requirePlatformAdmin = (req, res, next) => res.status(403).json({ error: 'platform only' });
  app.use(modsRoutes({
    requireAuth: pass, requireAdmin: pass, requirePlatformAdmin, requireTenantAdmin,
    pgPool: null,
    tenants: {
      listTenantMods: async () => [],
      addTenantMod: async () => {},
      removeTenantMod: async () => {},
      isPlatformOwnerId: () => false,
      modSeatCap: () => Infinity,
    },
  }));
  return app;
}

async function call(app, method, pathname, body) {
  const server = await new Promise(r => { const s = app.listen(0, () => r(s)); });
  try {
    const r = await fetch(`http://127.0.0.1:${server.address().port}${pathname}`, {
      method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
    });
    return { status: r.status, body: await r.json().catch(() => null) };
  } finally {
    await new Promise(res => server.close(res));
  }
}

test('tenant admin can add a mod', async () => {
  const res = await call(appWith({ tenantAdmin: true }), 'POST', '/api/admin/mods', { discordId: '123456789' });
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(res.body, { ok: true });
});

test('tenant admin can remove a mod', async () => {
  const res = await call(appWith({ tenantAdmin: true }), 'DELETE', '/api/admin/mods/123456789');
  assert.strictEqual(res.status, 200);
});

test('a non-tenant-admin is rejected from adding a mod', async () => {
  const res = await call(appWith({ tenantAdmin: false }), 'POST', '/api/admin/mods', { discordId: '123456789' });
  assert.strictEqual(res.status, 403);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test routes/mods.routes.test.js`
Expected: FAIL — the routes still use `requirePlatformAdmin` (stubbed to 403), so the tenant-admin add/remove return 403, not 200.

- [ ] **Step 3: Add the dep and flip the two gates**

In `routes/mods.routes.js:12`, add `requireTenantAdmin` to the destructure:

```js
  const { requireAuth, requireAdmin, requirePlatformAdmin, requireTenantAdmin, tenants, pgPool } = deps;
```

Change the POST gate (`:43`) and DELETE gate (`:66`) from `requirePlatformAdmin` to `requireTenantAdmin`:

```js
  router.post('/api/admin/mods', requireAuth, requireTenantAdmin, async (req, res) => {
```
```js
  router.delete('/api/admin/mods/:id', requireAuth, requireTenantAdmin, async (req, res) => {
```

- [ ] **Step 4: Update the comments so they don't lie**

The header (lines 1-7) and the two inline comments (`:42` "Owner-only.", `:65` "Owner-only.") say mods are owner-assigned. Replace the header block (lines 1-7) with:

```js
// Tenant-mod management: per-community Mod role, DB-backed via tenant_roles (role='community_mod').
// Assigned by the community's own admin (tenant_roles role='admin') OR a platform owner — a mod
// cannot assign mods (requireTenantAdmin excludes mods). Seat caps by plan are enforced on add.
//
//   GET    /api/admin/mods       — list current tenant's mods (admin OR mod — requireAdmin covers both)
//   POST   /api/admin/mods       — add a mod to req.tenant (tenant admin or platform owner)
//   DELETE /api/admin/mods/:id   — remove a mod from req.tenant (tenant admin or platform owner)
```

Change the `:42` comment `// Add a mod to the current tenant. Owner-only.` to:

```js
  // Add a mod to the current tenant. Tenant admin (or platform owner) — not a mod.
```

Change the `:65` comment `// Remove a mod from the current tenant. Owner-only.` to:

```js
  // Remove a mod from the current tenant. Tenant admin (or platform owner) — not a mod.
```

- [ ] **Step 5: Inject the dep in `server.js`**

Find the `mods.routes` mount (search `mods.routes`). It currently passes `requireAuth, requireAdmin, requirePlatformAdmin, tenants, pgPool`. Add `requireTenantAdmin`:

```js
  requireAuth, requireAdmin, requirePlatformAdmin, requireTenantAdmin, tenants, pgPool,
```

(`requireTenantAdmin` is already destructured from `auth` in `server.js` as of Phase 1 — no other wiring needed.)

- [ ] **Step 6: Run test to verify it passes**

Run: `node --test routes/mods.routes.test.js`
Expected: PASS (3 tests).

- [ ] **Step 7: Commit**

```bash
git add routes/mods.routes.js routes/mods.routes.test.js server.js
git commit -m "feat: let community admins manage their own mods (requireTenantAdmin)"
```

---

### Task 2: Full-suite + boot verification

**Files:** none (verification only).

- [ ] **Step 1: Run changed + adjacent suites**

Run: `node --test routes/mods.routes.test.js lib/auth.test.js routes/admin.routes.test.js routes/settings.routes.test.js`
Expected: all pass.

- [ ] **Step 2: Run regression suites**

Run: `node --test lib/tenants.test.js routes/adminTickets.routes.test.js routes/cardRequests.routes.test.js routes/misc.routes.test.js`
Expected: all pass.

- [ ] **Step 3: Boot the server (compile check)**

Boot `GITHUB_PAT= PORT=3197 node -r dotenv/config server.js` in the background, curl `http://127.0.0.1:3197/api/health` (expect `200`), then stop the process and free the port.

- [ ] **Step 4: Confirm the branch diff vs the Phase 1 base**

Run: `git diff --stat feat/phase1-split-gates`
Expected: only `routes/mods.routes.js`, `routes/mods.routes.test.js`, `server.js`, and this plan doc. No `package-lock.json`, no `hunts_archive.json`.

---

## Self-Review

**Spec coverage (§10 Phase 3 row):** re-gate `/api/admin/mods` add+remove to `requireTenantAdmin` → Task 1 ✅. "After 0+1" honored (stacked on Phase 1, merges after #61). Seat-cap `'bean'` exemption via `tenant_features` is a Phase 8 item — not touched here (the existing `modSeatCap` behavior is unchanged).

**Placeholder scan:** none — every step has concrete code/commands.

**Type/name consistency:** `requireTenantAdmin` matches the Phase 1 export/`server.js` destructure; `modSeatCap`, `listTenantMods`, `addTenantMod`, `removeTenantMod`, `isPlatformOwnerId` match the live `tenants` API used in `mods.routes.js`.

**Blast radius:** only the mod add/remove gates change. `GET /api/admin/mods` (view) unchanged. No other route touched. Escalation-safe: grants the mod role only, never admin.
