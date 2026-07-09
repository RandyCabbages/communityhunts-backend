# VIP Extension Download Gating Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a tenant's VIP roles (VIP host, mod, Discord-guild VIP) unlock the Full extension for free instead of hitting the $5/mo gate.

**Architecture:** Add one shared entitlement helper `reqHasFullExtension(req)` in `server.js` that OR's the tenant VIP roles onto the existing `hasFullExtension` check. Inject it into two routers: the entitlement route (which the extension + download page read) and the subscribe route (so a VIP is never charged). Frontend needs no change — it renders whatever `fullAccess` the backend returns.

**Tech Stack:** Node.js + Express (no build step, no test suite). Verification is by local server boot + code inspection; full role behavior is confirmed on a Railway/preview deploy with real accounts.

## Global Constraints

- **Auth gates on Discord ID / resolved role helpers, NEVER on display name.** Use `reqIsVipHost(req)` / `reqIsMod(req)` — do not read display names. (CLAUDE.md "VIP / Admin Logic — DO NOT BREAK")
- **No test framework exists.** Do not add one. "Verify" steps mean: boot the server locally and confirm no crash + inspect the code path. Do not invent `jest`/`mocha` tasks.
- **This backend is its own git repo** at `communityhunts-backend/`. Run all git commands from inside that directory. Do NOT use `git add -A` — add only the named files (parallel sessions share the worktree).
- **`npm install` after every pull**; `npm start` ignores `.env`. To boot locally for a smoke test, dummy Discord creds + an alt port are required (see Task 1 verify step).
- Do not commit auto-generated files (`hunts_data.json`, `slots_cache.json`).

---

### Task 1: Shared `reqHasFullExtension` helper in server.js

**Files:**
- Modify: `communityhunts-backend/server.js` (define helper after line 294, before the route mounts at line 488)

**Interfaces:**
- Consumes: `features.hasFullExtension(userId, tenantPlan)` (required at `server.js:254` as `const features = require('./lib/features')`); `reqIsVipHost(req)` and `reqIsMod(req)` (in scope, used at `server.js:300`).
- Produces: `async function reqHasFullExtension(req) => Promise<boolean>` — used by Tasks 2 and 3.

- [ ] **Step 1: Add the helper**

In `communityhunts-backend/server.js`, immediately after the `huntsCore` destructure block that ends at line 294 (and before the auth-routes mount at line 298), insert:

```js
// Full (Rainbet) extension entitlement, request-scoped. A tenant's VIP roles (VIP host,
// mod, Discord-guild VIP) unlock it for free; otherwise fall back to the plan-ladder / grant
// check in features.hasFullExtension. Injected into the entitlement route (gates the download
// page view AND the extension's in-app Rainbet features) and the subscribe route (so a VIP is
// never charged). reqIsAdmin is folded into both reqIsVipHost and reqIsMod.
async function reqHasFullExtension(req) {
  if (!req.user) return false;
  const isTenantVip = reqIsVipHost(req) || reqIsMod(req) || !!req.user.isDiscordVip;
  return isTenantVip || await features.hasFullExtension(req.user.id, req.tenant?.plan);
}
```

- [ ] **Step 2: Verify the server still boots**

From `communityhunts-backend/`:

```bash
npm install
PORT=3101 DISCORD_CLIENT_ID=x DISCORD_CLIENT_SECRET=x DISCORD_CALLBACK_URL=http://localhost:3101/auth/discord/callback SESSION_SECRET=x node server.js
```

Expected: server logs its startup lines and listens on 3101 with **no `ReferenceError`** (would mean `reqIsVipHost`/`reqIsMod`/`features` aren't in scope at the insertion point). Ctrl-C to stop. If it crashes with a scope error, move the helper definition lower (it must be after line 300 where `reqIsVipHost` is used) but still above line 488.

- [ ] **Step 3: Commit**

```bash
git add server.js
git commit -m "feat: add reqHasFullExtension request-scoped entitlement helper"
```

---

### Task 2: Entitlement route uses the helper

**Files:**
- Modify: `communityhunts-backend/server.js:488-491` (add `reqHasFullExtension` to `settings.routes` deps)
- Modify: `communityhunts-backend/routes/settings.routes.js:21` (destructure) and `:115-118` (route body)

**Interfaces:**
- Consumes: `reqHasFullExtension` (from Task 1).
- Produces: `GET /api/extension/entitlement` now returns `fullAccess:true` for tenant VIPs/mods/guild-VIPs in addition to the existing plan/grant holders.

- [ ] **Step 1: Pass the helper into the router**

In `communityhunts-backend/server.js`, update the `settings.routes` mount (lines 488-491) to add `reqHasFullExtension`:

```js
app.use(require('./routes/settings.routes')({
  settings, pgPool, memberships, isPlatformAdmin, reqIsMod, reqHasFullExtension, requireAuth, requireAdmin, io, subscriptions, featureGrants,
  hunts, archive,
}));
```

- [ ] **Step 2: Destructure it in the router**

In `communityhunts-backend/routes/settings.routes.js`, line 21, add `reqHasFullExtension` to the deps destructure:

```js
  const { settings, pgPool, memberships, isPlatformAdmin, reqIsMod, reqHasFullExtension, requireAuth, requireAdmin, io, subscriptions, featureGrants, hunts, archive } = deps;
```

- [ ] **Step 3: Replace the entitlement route body**

In `communityhunts-backend/routes/settings.routes.js`, replace lines 115-118. The `hasFullExtension` import there is no longer used by this route — confirm nothing else in the file references it (grep below); if unused, leave its import/require as-is only if other routes use it, otherwise it can stay harmlessly. New body:

```js
  // GET /api/extension/entitlement — does the caller have Full (Rainbet) extension access?
  // The self-distributed Full extension calls this on load to gate its Rainbet features.
  // Tenant VIPs/mods/guild-VIPs get it free (see reqHasFullExtension in server.js). CORS
  // already allows chrome-extension:// / moz-extension:// origins.
  router.get('/api/extension/entitlement', requireAuth, async (req, res) => {
    res.json({ fullAccess: await reqHasFullExtension(req) });
  });
```

- [ ] **Step 4: Check whether `hasFullExtension` is still referenced in this file**

Run from `communityhunts-backend/`:

```bash
grep -n "hasFullExtension" routes/settings.routes.js
```

Expected: the only remaining hits are inside a comment or gone entirely. If a now-unused `hasFullExtension` was destructured from deps at the top of the file, remove it from that destructure to avoid a dangling reference. (The `grandfather-full-extension` route at :123 uses `featureGrants.grandfatherGrant`, not `hasFullExtension`, so it is unaffected.)

- [ ] **Step 5: Verify boot**

```bash
PORT=3101 DISCORD_CLIENT_ID=x DISCORD_CLIENT_SECRET=x DISCORD_CALLBACK_URL=http://localhost:3101/auth/discord/callback SESSION_SECRET=x node server.js
```

Expected: boots clean, no `reqHasFullExtension is not a function` (would mean the dep wasn't wired). Ctrl-C.

- [ ] **Step 6: Commit**

```bash
git add server.js routes/settings.routes.js
git commit -m "feat: grant Full extension entitlement to tenant VIPs, mods, guild VIPs"
```

---

### Task 3: Checkout hardening — don't charge an entitled user

**Files:**
- Modify: `communityhunts-backend/server.js:497-499` (add `reqHasFullExtension` to `cosmetics.routes` deps)
- Modify: `communityhunts-backend/routes/cosmetics.routes.js:94` (destructure) and `:139-156` (subscribe route)

**Interfaces:**
- Consumes: `reqHasFullExtension` (from Task 1).
- Produces: `POST /api/extension/subscribe` returns `{ alreadyEntitled: true }` (HTTP 200, no Stripe session) when the caller already has Full access.

- [ ] **Step 1: Pass the helper into the cosmetics router**

In `communityhunts-backend/server.js`, update the `cosmeticsRoutes` construction (lines 497-499):

```js
const cosmeticsRouter = require('./routes/cosmetics.routes')({
  requireAuth, settings, stripeLib, subscriptions, FRONTEND_URL, isAdmin, reqHasFullExtension,
});
```

- [ ] **Step 2: Destructure it in the router**

In `communityhunts-backend/routes/cosmetics.routes.js`, line 94:

```js
  const { requireAuth, settings, stripeLib, subscriptions, FRONTEND_URL, isAdmin, reqHasFullExtension } = deps;
```

- [ ] **Step 3: Short-circuit the subscribe route**

In `communityhunts-backend/routes/cosmetics.routes.js`, inside `POST /api/extension/subscribe` (starts line 139), add the guard immediately after the two config checks and BEFORE the `isPurchaseEligible` check (currently line 143):

```js
      if (!process.env.STRIPE_PRICE_EXT_FULL) return res.status(503).json({ error: 'Extension subscription not configured yet' });
      // Already entitled (VIP/mod/guild-VIP/plan/grant) → never create a paid sub for it.
      if (await reqHasFullExtension(req)) return res.json({ alreadyEntitled: true });
      if (!(await isPurchaseEligible(req.user, subscriptions, isAdmin))) return res.status(403).json({ error: NOT_ELIGIBLE_MSG });
```

- [ ] **Step 4: Verify boot**

```bash
PORT=3101 DISCORD_CLIENT_ID=x DISCORD_CLIENT_SECRET=x DISCORD_CALLBACK_URL=http://localhost:3101/auth/discord/callback SESSION_SECRET=x node server.js
```

Expected: boots clean. Ctrl-C.

- [ ] **Step 5: Commit**

```bash
git add server.js routes/cosmetics.routes.js
git commit -m "feat: skip $5 extension checkout for already-entitled users"
```

---

### Task 4 (OPTIONAL): Frontend guard for the `alreadyEntitled` response

Only matters if a VIP reaches the Subscribe button via a stale page (they normally never see it, because `fullAccess:true` renders the download guide instead). Skip unless you want the belt-and-suspenders UX.

**Files:**
- Modify: `communityhunts-frontend/src/pages/shop/ShopExtension.js` (the `handleBuy` function, ~lines 28-42)

**Interfaces:**
- Consumes: `POST /api/extension/subscribe` may now return `{ alreadyEntitled: true }` with no `url`.

- [ ] **Step 1: Guard the redirect**

In `handleBuy`, where it currently redirects to the returned `url`, replace the redirect with:

```js
      if (data && data.url) {
        window.location.href = data.url;
      } else if (data && data.alreadyEntitled) {
        // VIP/already-entitled — re-fetch entitlement so the download guide renders.
        window.location.reload();
      }
```

Keep the existing error handling. Match the surrounding code's fetch/error style exactly.

- [ ] **Step 2: Build to verify no syntax error**

From `communityhunts-frontend/`:

```bash
npm run build
```

Expected: build succeeds (CRA fails the build on lint errors — a stray unused var or hook mistake will show here).

- [ ] **Step 3: Commit (frontend repo)**

```bash
git add src/pages/shop/ShopExtension.js
git commit -m "fix: handle alreadyEntitled response on extension subscribe"
```

---

## Post-implementation verification (on deploy)

After the backend commits are pushed and Railway redeploys, confirm with real accounts (session-based auth makes this impractical to curl locally):

- **Tenant VIP host** logs in → `/shop/extension` shows the download guide, not the $5 gate.
- **Tenant mod** → download guide.
- **Discord-guild VIP** (not in `tenant_roles`) → download guide.
- **Plain member** (no roles, no sub) → still sees the $5 gate.
- **Existing paid sub / Ultimate / Enterprise / admin grant** → still download guide (no regression).
- **VIP** who somehow POSTs `/api/extension/subscribe` → `{ alreadyEntitled: true }`, no Stripe redirect, no charge.

## Self-review notes

- Spec coverage: shared helper (Task 1) ✓, entitlement route (Task 2) ✓, checkout hardening (Task 3) ✓, optional FE guard (Task 4) ✓, out-of-scope `.zip` note carried as a non-task ✓.
- No display-name gating introduced; only `reqIsVipHost`/`reqIsMod`/`isDiscordVip`.
- Helper name `reqHasFullExtension` used identically in Tasks 1-3.
