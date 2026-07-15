# Full Extension Entitlement Source Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the admin "Full Extension" toggle honest — report a user's *effective* entitlement and *why*, and relabel the grant as the admin comp it actually is.

**Architecture:** One pure `computeFullExtension` in `lib/features.js` owns the six-way OR-list and returns `{access, sources}`. A `fullExtensionFor` wrapper fetches the two user-scoped inputs this module owns (sub tier, comp grant). Callers inject role flags: `reqHasFullExtension` passes the cached session flag (free), the admin route passes a live Discord lookup. One OR-list, two fetch strategies, no Discord call on the extension's hot path.

**Tech Stack:** Node.js + Express (backend, no build step, `node:test`), React CRA (frontend, no test suite).

**Spec:** `docs/superpowers/specs/2026-07-14-full-extension-entitlement-source-design.md`

## Global Constraints

- **Backend-first.** Backend PR merges and deploys before the frontend PR. The frontend reads `fullExtension` from the profile response; shipping it first shows an empty panel.
- **Entitlement behavior must not change.** `reqHasFullExtension` returns exactly what it returned before. This work is reporting-only.
- **`/api/extension/entitlement` must NOT gain a Discord API call.** The extension hits it on every load. Role flags stay injected by the caller.
- **Never coerce an undetermined Discord role to `false`.** Existing rule from `fetchGuildRoles`. Undetermined ≠ no access.
- **Source keys are a cross-repo sync constraint.** `FULL_EXT_SOURCES` (backend) ↔ `SOURCE_LABELS` (frontend) must use identical keys. Same class as `catalog.js` ↔ `ITEM_TIERS`.
- **Never gate on display name** — Discord ID only.
- **No `Co-Authored-By` or Claude attribution** in commits or PR bodies.
- Backend tests: capture output to a **file**, never pipe — piped exit codes have masked failures in this repo.
- Frontend: `CI=true npm run build` must print "Compiled successfully" before any push (Vercel turns warnings into errors).

**Working branch (backend):** `feat/full-extension-entitlement-source` — already exists, rebased on `origin/main`, spec committed.

---

## File Structure

**Backend** (`communityhunts-backend/`):

| File | Responsibility | Change |
| --- | --- | --- |
| `lib/features.js` | Owns feature gating. Gains the pure entitlement core + user-scoped wrapper; loses `hasFullExtension`. | Modify |
| `lib/features.test.js` | Table-driven coverage for the core + wrapper. First tests for this logic. | Create |
| `server.js` | Composition root. `reqHasFullExtension` delegates; settings router gains 2 deps. | Modify |
| `routes/settings.routes.js` | Admin profile route reports the target's entitlement. | Modify |

**Frontend** (`communityhunts-frontend/`):

| File | Responsibility | Change |
| --- | --- | --- |
| `src/admin/userProfile/AdminControls.js` | Status line + comp toggle. Stays ~110 lines, under the extract threshold. | Modify |
| `src/admin/UserProfile.js` | Passes `fullExtension` down; re-fetches after a grant toggle. | Modify |

---

## Task 1: Entitlement core + wrapper (backend)

**Files:**
- Modify: `communityhunts-backend/lib/features.js:30-35` (stale comment), `:66-78` (delete `hasFullExtension`), `:112` (exports)
- Test: `communityhunts-backend/lib/features.test.js` (create)

**Interfaces:**
- Consumes: `canUse(featureName, individualTier, tenantPlan)` — existing, unchanged. Module-level `subscriptions` / `featureGrants`, set by the existing `initFeatures(deps)`.
- Produces:
  - `FULL_EXT_SOURCES: string[]` — `['vip_host','community_mod','discord_vip','partner_plan','ultimate_sub','admin_comp']`, the report order.
  - `computeFullExtension({isVipHost, isCommunityMod, isDiscordVip, tenantPlan, subTier, hasComp}) → {access: boolean, sources: string[]}` — pure.
  - `fullExtensionFor(userId, {tenantPlan, isVipHost, isCommunityMod, isDiscordVip}) → Promise<{access, sources}>` — async, fetches `subTier` + `hasComp`.
  - `hasFullExtension` is **removed** from exports (Task 2 removes its only caller in the same PR).

- [ ] **Step 1: Write the failing tests**

Create `communityhunts-backend/lib/features.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert');
const features = require('./features');

// ── computeFullExtension (pure) ──────────────────────────────────────────────

test('computeFullExtension: no paths → no access', () => {
  const r = features.computeFullExtension({});
  assert.strictEqual(r.access, false);
  assert.deepStrictEqual(r.sources, []);
});

test('computeFullExtension: vip_host alone', () => {
  const r = features.computeFullExtension({ isVipHost: true });
  assert.strictEqual(r.access, true);
  assert.deepStrictEqual(r.sources, ['vip_host']);
});

test('computeFullExtension: community_mod alone', () => {
  const r = features.computeFullExtension({ isCommunityMod: true });
  assert.deepStrictEqual(r.sources, ['community_mod']);
});

test('computeFullExtension: discord_vip alone', () => {
  const r = features.computeFullExtension({ isDiscordVip: true });
  assert.deepStrictEqual(r.sources, ['discord_vip']);
});

// Ladder isolation: a Partner tenant with a free sub reports ONLY partner_plan.
test('computeFullExtension: partner community plan alone', () => {
  const r = features.computeFullExtension({ tenantPlan: 'partner', subTier: 'free' });
  assert.strictEqual(r.access, true);
  assert.deepStrictEqual(r.sources, ['partner_plan']);
});

// ...and the reverse: an Ultimate sub on a pro tenant reports ONLY ultimate_sub.
test('computeFullExtension: ultimate individual sub alone', () => {
  const r = features.computeFullExtension({ tenantPlan: 'pro', subTier: 'ultimate' });
  assert.strictEqual(r.access, true);
  assert.deepStrictEqual(r.sources, ['ultimate_sub']);
});

test('computeFullExtension: comp alone — the case where the toggle decides', () => {
  const r = features.computeFullExtension({ hasComp: true });
  assert.strictEqual(r.access, true);
  assert.deepStrictEqual(r.sources, ['admin_comp']);
});

test('computeFullExtension: overlapping paths all listed, in FULL_EXT_SOURCES order', () => {
  const r = features.computeFullExtension({
    isDiscordVip: true, tenantPlan: 'pro', subTier: 'ultimate', hasComp: true,
  });
  assert.strictEqual(r.access, true);
  assert.deepStrictEqual(r.sources, ['discord_vip', 'ultimate_sub', 'admin_comp']);
});

// The original bug, pinned: a VIP has access even with no comp granted.
test('computeFullExtension: VIP with no comp still has access', () => {
  const r = features.computeFullExtension({ isDiscordVip: true, hasComp: false });
  assert.strictEqual(r.access, true);
  assert.ok(!r.sources.includes('admin_comp'));
});

// ── fullExtensionFor (fetches subTier + hasComp) ─────────────────────────────

test('fullExtensionFor: no subscriptions dep → free tier, no throw', async () => {
  features.initFeatures({ subscriptions: null, featureGrants: null });
  const r = await features.fullExtensionFor('123', { tenantPlan: 'pro' });
  assert.strictEqual(r.access, false);
  assert.deepStrictEqual(r.sources, []);
});

test('fullExtensionFor: getSubscription rejects → fails closed to free', async () => {
  features.initFeatures({
    subscriptions: { getSubscription: async () => { throw new Error('db down'); } },
    featureGrants: null,
  });
  const r = await features.fullExtensionFor('123', { tenantPlan: 'pro' });
  assert.strictEqual(r.access, false);
  assert.deepStrictEqual(r.sources, []);
});

test('fullExtensionFor: comp grant surfaces admin_comp', async () => {
  features.initFeatures({
    subscriptions: { getSubscription: async () => ({ tier: 'free' }) },
    featureGrants: { hasGrant: (id, key) => id === '123' && key === 'full_extension' },
  });
  const r = await features.fullExtensionFor('123', { tenantPlan: 'pro' });
  assert.strictEqual(r.access, true);
  assert.deepStrictEqual(r.sources, ['admin_comp']);
});

test('fullExtensionFor: caller role flags pass through to the core', async () => {
  features.initFeatures({ subscriptions: null, featureGrants: null });
  const r = await features.fullExtensionFor('123', { tenantPlan: 'pro', isDiscordVip: true });
  assert.deepStrictEqual(r.sources, ['discord_vip']);
});

test('fullExtensionFor: sub tier is read from the subscriptions dep', async () => {
  features.initFeatures({
    subscriptions: { getSubscription: async () => ({ tier: 'ultimate' }) },
    featureGrants: null,
  });
  const r = await features.fullExtensionFor('123', { tenantPlan: 'free' });
  assert.deepStrictEqual(r.sources, ['ultimate_sub']);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

From `communityhunts-backend/`:

```bash
node --test lib/features.test.js > /tmp/fe-test.txt 2>&1; cat /tmp/fe-test.txt
```

On Windows PowerShell, write to the scratchpad instead of `/tmp` and `Get-Content` it. Do NOT pipe directly into another command — piped exit codes mask failures here.

Expected: FAIL — `TypeError: features.computeFullExtension is not a function`.

- [ ] **Step 3: Add the core + wrapper**

In `communityhunts-backend/lib/features.js`, replace the whole `hasFullExtension` block (lines 66-78, from the `// Full (Rainbet) extension entitlement` comment through its closing `}`) with:

```js
// Source keys for the Full (Rainbet) extension, in report order. The frontend's
// SOURCE_LABELS map (src/admin/userProfile/AdminControls.js) MUST use these exact keys —
// sync constraint, same class as catalog.js <-> ITEM_TIERS.
const FULL_EXT_SOURCES = ['vip_host', 'community_mod', 'discord_vip',
                          'partner_plan', 'ultimate_sub', 'admin_comp'];

// The single definition of who has the Full extension, and WHY. Pure — it fetches nothing,
// so each caller supplies role flags its own way: the extension's hot path passes the cached
// session flag (free), the admin panel passes a live Discord lookup. Callers must never both
// re-implement this OR-list; that drift is the bug this function exists to prevent.
function computeFullExtension({ isVipHost, isCommunityMod, isDiscordVip,
                                tenantPlan, subTier, hasComp } = {}) {
  const sources = [];
  if (isVipHost)      sources.push('vip_host');
  if (isCommunityMod) sources.push('community_mod');
  if (isDiscordVip)   sources.push('discord_vip');
  // Passing the neutral 'free' on the OPPOSITE ladder isolates which ladder granted it —
  // canUse alone folds both together and can't report which one fired.
  if (canUse('full_extension', 'free', tenantPlan)) sources.push('partner_plan');
  if (canUse('full_extension', subTier, 'free'))    sources.push('ultimate_sub');
  if (hasComp)        sources.push('admin_comp');
  return { access: sources.length > 0, sources };
}

// User-scoped entitlement. Fetches the two inputs this module owns (individual sub tier and
// the full_extension comp grant) and defers the decision to computeFullExtension. Role flags
// come from the caller. Fails closed to 'free' if the subscription lookup errors, matching
// userCanUse.
async function fullExtensionFor(userId, { tenantPlan, isVipHost, isCommunityMod, isDiscordVip } = {}) {
  let subTier = 'free';
  if (userId && subscriptions) {
    try { subTier = (await subscriptions.getSubscription(userId))?.tier || 'free'; } catch {}
  }
  return computeFullExtension({
    isVipHost, isCommunityMod, isDiscordVip, tenantPlan, subTier,
    hasComp: !!(featureGrants && featureGrants.hasGrant(userId, 'full_extension')),
  });
}
```

- [ ] **Step 4: Update the exports**

In `communityhunts-backend/lib/features.js`, replace line 112:

```js
module.exports = { canUse, userCanUse, initFeatures, requireTier, hasFullExtension, FEATURES };
```

with:

```js
module.exports = { canUse, userCanUse, initFeatures, requireTier,
  computeFullExtension, fullExtensionFor, FULL_EXT_SOURCES, FEATURES };
```

- [ ] **Step 5: Fix the stale comment that points at the deleted function**

In `communityhunts-backend/lib/features.js`, in the `full_extension` block of the `FEATURES` map (~line 30-35), replace:

```js
  // tier. See hasFullExtension for the composite check.
```

with:

```js
  // tier. See computeFullExtension for the composite check.
```

- [ ] **Step 6: Run the tests to verify they pass**

From `communityhunts-backend/`:

```bash
node --test lib/features.test.js > /tmp/fe-test.txt 2>&1; cat /tmp/fe-test.txt
```

Expected: `pass 14`, `fail 0` (9 `computeFullExtension` cases + 5 `fullExtensionFor` cases).

- [ ] **Step 7: Commit**

```bash
git add lib/features.js lib/features.test.js
git commit -m "feat: pure computeFullExtension core + fullExtensionFor wrapper

One definition of who has the Full extension and why, returning {access, sources}.
Pure so callers inject role flags: the extension hot path keeps its cached session
flag while the admin panel can pass a live lookup. Replaces hasFullExtension.

First test coverage for this entitlement logic."
```

Note: the repo is left temporarily broken between this task and Task 2 — `server.js` still calls the deleted `hasFullExtension`. Task 2 completes the swap; they ship in one PR. Do not push between them.

---

## Task 2: Rewire `reqHasFullExtension` (backend)

**Files:**
- Modify: `communityhunts-backend/server.js:310-319`

**Interfaces:**
- Consumes: `features.fullExtensionFor(userId, {tenantPlan, isVipHost, isCommunityMod, isDiscordVip})` from Task 1.
- Produces: `reqHasFullExtension(req) → Promise<boolean>` — **unchanged signature and behavior**. Consumers (`routes/settings.routes.js` entitlement route, `routes/cosmetics.routes.js` subscribe route) need no change.

- [ ] **Step 1: Replace the helper and its comment**

In `communityhunts-backend/server.js`, replace lines 310-319 (the comment block starting `// Full (Rainbet) extension entitlement, request-scoped.` through the closing `}` of `reqHasFullExtension`) with:

```js
// Full (Rainbet) extension entitlement, request-scoped. Thin wrapper over
// features.fullExtensionFor — the OR-list lives there and nowhere else. This passes the
// CACHED session guild flag (req.user.isDiscordVip), never a live Discord lookup: this path
// serves /api/extension/entitlement, which the extension calls on every load. The admin
// panel passes a live lookup instead. reqIsAdmin is folded into both reqIsVipHost and reqIsMod.
async function reqHasFullExtension(req) {
  if (!req.user) return false;
  return (await features.fullExtensionFor(req.user.id, {
    tenantPlan:     req.tenant?.plan,
    isVipHost:      reqIsVipHost(req),
    isCommunityMod: reqIsMod(req),
    isDiscordVip:   !!req.user.isDiscordVip,
  })).access;
}
```

- [ ] **Step 2: Verify the server boots (catches the deleted-export reference)**

From `communityhunts-backend/`, on a port that is free (3101 has been occupied by stray processes; use 3137 if so):

```bash
PORT=3137 DISCORD_CLIENT_ID=x DISCORD_CLIENT_SECRET=x \
DISCORD_CALLBACK_URL=http://localhost:3137/auth/discord/callback \
SESSION_SECRET=x node server.js
```

Expected: startup lines ending in `✅ Server on port 3137`, with **no** `TypeError: features.hasFullExtension is not a function`. Ctrl-C to stop.

- [ ] **Step 3: Run the full lib test suite for regressions**

```bash
node --test lib/features.test.js lib/featureGrants.test.js > /tmp/lib-test.txt 2>&1; cat /tmp/lib-test.txt
```

Expected: `fail 0`.

- [ ] **Step 4: Commit**

```bash
git add server.js
git commit -m "refactor: reqHasFullExtension delegates to fullExtensionFor

Same signature, same behavior, one OR-list. Keeps passing the cached session guild
flag so /api/extension/entitlement never gains a Discord API call."
```

---

## Task 3: Report the target user's entitlement (backend)

**Files:**
- Modify: `communityhunts-backend/routes/settings.routes.js:18` (import), `:21` (deps), `:278-308` (profile route)
- Modify: `communityhunts-backend/server.js:602-605` (settings router mount)

**Interfaces:**
- Consumes: `features.fullExtensionFor` (Task 1); `tenants.isTenantVip(user, tenant)` / `tenants.isTenantMod(user, tenant)` — both need only `user.id`, so `{id: userId}` is a valid target; `refreshGuildRoles(discordUserId, tenant) → Promise<{isAffiliate?, isDiscordVip?, isDiscordMod?}|null>` — uses the **bot token**, so it works for any target ID; returns `null` when undetermined OR when no guild is configured.
- Produces: `GET /api/admin/users/:userId` response gains
  `fullExtension: { access: boolean, sources: string[], discordVipUndetermined: boolean }`.
  Consumed by frontend Task 4. `featureGrants` on the same response is unchanged.

- [ ] **Step 1: Import the helper**

In `communityhunts-backend/routes/settings.routes.js`, replace line 18:

```js
const { userCanUse } = require('../lib/features');
```

with:

```js
const { userCanUse, fullExtensionFor } = require('../lib/features');
```

- [ ] **Step 2: Add the two new deps**

In `communityhunts-backend/routes/settings.routes.js`, replace line 21:

```js
  const { settings, pgPool, memberships, isPlatformAdmin, reqIsMod, reqHasFullExtension, requireAuth, requireAdmin, io, subscriptions, featureGrants, hunts, archive, statsStore } = deps;
```

with:

```js
  const { settings, pgPool, memberships, isPlatformAdmin, reqIsMod, reqHasFullExtension, requireAuth, requireAdmin, io, subscriptions, featureGrants, hunts, archive, statsStore, tenants, refreshGuildRoles } = deps;
```

- [ ] **Step 3: Pass them in from the composition root**

In `communityhunts-backend/server.js`, replace lines 602-605:

```js
app.use(require('./routes/settings.routes')({
  settings, pgPool, memberships, isPlatformAdmin, reqIsMod, reqHasFullExtension, requireAuth, requireAdmin, io, subscriptions, featureGrants,
  hunts, archive, statsStore,
}));
```

with:

```js
app.use(require('./routes/settings.routes')({
  settings, pgPool, memberships, isPlatformAdmin, reqIsMod, reqHasFullExtension, requireAuth, requireAdmin, io, subscriptions, featureGrants,
  hunts, archive, statsStore, tenants, refreshGuildRoles,
}));
```

- [ ] **Step 4: Compute + report the target's entitlement**

In `communityhunts-backend/routes/settings.routes.js`, inside `GET /api/admin/users/:userId`, insert after the `const communities = await memberships.getUserCommunities(userId);` line and before `res.json({`:

```js
      // Effective Full-extension entitlement for the TARGET user (not req.user). The grant is
      // only one of six OR'd paths, so the admin panel must report the computed result and its
      // sources — a bare grant toggle reads OFF for a VIP who already has access.
      // Live guild lookup (bot token, works for any target ID). refreshGuildRoles returns null
      // BOTH when the lookup fails AND when no guild is configured — only the former is
      // "undetermined"; conflating them would show a permanent spurious warning on tenants
      // without Discord.
      const tenant = req.tenant;
      const guildRoles = refreshGuildRoles ? await refreshGuildRoles(userId, tenant) : null;
      const guildConfigured = !!(tenant?.discordGuildId && tenant?.discordBotToken);
      const fullExtension = await fullExtensionFor(userId, {
        tenantPlan:     tenant?.plan,
        isVipHost:      tenants ? tenants.isTenantVip({ id: userId }, tenant) : false,
        isCommunityMod: tenants ? tenants.isTenantMod({ id: userId }, tenant) : false,
        isDiscordVip:   !!guildRoles?.isDiscordVip,
      });
```

Then add this key to the `res.json({...})` object, immediately after the `featureGrants:` line:

```js
        fullExtension: { ...fullExtension, discordVipUndetermined: guildConfigured && !guildRoles },
```

- [ ] **Step 5: Verify the server boots with the new deps**

```bash
PORT=3137 DISCORD_CLIENT_ID=x DISCORD_CLIENT_SECRET=x \
DISCORD_CALLBACK_URL=http://localhost:3137/auth/discord/callback \
SESSION_SECRET=x node server.js
```

Expected: `✅ Server on port 3137`, no `ReferenceError` / `TypeError`. Ctrl-C to stop.

The route itself needs a DB + an admin session to exercise, so it is verified on the Railway deploy (Task 4), not locally.

- [ ] **Step 6: Commit**

```bash
git add server.js routes/settings.routes.js
git commit -m "feat: report target user's Full extension entitlement + sources

GET /api/admin/users/:userId gains fullExtension {access, sources,
discordVipUndetermined}, computed for the TARGET user via a live guild lookup.
Threads tenants + refreshGuildRoles into the settings router."
```

---

## Task 4: Backend PR

**Files:** none (process task)

- [ ] **Step 1: Confirm the working tree is clean and only intended files changed**

```bash
git status --short
git --no-pager diff origin/main --stat
```

Expected: only `lib/features.js`, `lib/features.test.js`, `server.js`, `routes/settings.routes.js`, plus the already-committed spec doc. `hunts_archive.json` is untracked and NOT ours — never `git add -A`.

- [ ] **Step 2: Push**

```bash
git push -u origin feat/full-extension-entitlement-source
```

- [ ] **Step 3: Open the PR**

```bash
gh pr create --base main --head feat/full-extension-entitlement-source \
  --title "feat: report Full extension entitlement source in the admin panel" \
  --body-file <path to a written body file>
```

The body must state: the toggle reads OFF for VIPs who have access and revoking it does nothing; the six OR'd paths; that entitlement behavior is unchanged; that `/api/extension/entitlement` gains no Discord call; that `hasFullExtension` is deleted (single caller); and that the frontend companion merges after. No Claude attribution.

- [ ] **Step 4: Verify on Railway after merge**

After merge, Railway auto-deploys (~1-3 min; the restart logs everyone out — expected). Open an admin user profile for a known VIP and confirm the response includes `fullExtension.access: true` with `discord_vip` among `sources`.

---

## Task 5: Status line + comp toggle (frontend)

**Files:**
- Modify: `communityhunts-frontend/src/admin/userProfile/AdminControls.js:26-55`

**Interfaces:**
- Consumes: `fullExtension: {access: boolean, sources: string[], discordVipUndetermined: boolean}` — new prop, from Task 3's response. `grants: string[]` — existing prop, unchanged. `onGrant(feature, on)` — existing.
- Produces: no exports beyond the existing default `AdminControls`.

Branch from an up-to-date `main` **after the backend PR is merged**:

```bash
git checkout main && git pull --ff-only origin main
git checkout -b feat/full-extension-entitlement-source
```

- [ ] **Step 1: Add the label map + status component**

In `communityhunts-frontend/src/admin/userProfile/AdminControls.js`, insert after the `FeatureToggle` component's closing `}` (line 24) and before the `AdminControls` comment:

```js
// Backend source keys -> display labels. Keys MUST match FULL_EXT_SOURCES in the backend
// lib/features.js — sync constraint, same class as catalog.js <-> ITEM_TIERS.
// 'vip_host' covers tenant admins too: isTenantVip folds in isTenantAdmin, and the label
// mirrors what the real gate actually evaluates rather than inventing precision.
const SOURCE_LABELS = {
  vip_host: 'VIP host or admin',
  community_mod: 'Community mod',
  discord_vip: 'Discord VIP role',
  partner_plan: 'Partner community plan',
  ultimate_sub: 'Ultimate plan',
  admin_comp: 'admin comp',
};

// Read-only effective entitlement. Reported separately from the comp toggle below because the
// comp grant is only ONE of six OR'd paths — it can ADD access but never remove it, so a bare
// toggle reads OFF for a VIP who already has access.
function AccessStatus({ C, fullExtension }) {
  const fx = fullExtension || {};
  const sources = fx.sources || [];
  let tone = C.t4, text = '— No access', detail = '';
  if (fx.access) {
    tone = C.green || '#b6ff2e';
    text = '✅ Has access';
    detail = `via ${sources.map(s => SOURCE_LABELS[s] || s).join(', ')}`;
  } else if (fx.discordVipUndetermined) {
    tone = C.gold || '#fbbf24';
    text = '⚠ Couldn\'t verify';
    detail = 'Discord role lookup failed; other paths say no access.';
  }
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start',
      gap: 10, padding: '8px 12px', background: C.bg, border: `1px solid ${C.bdr}`, borderRadius: C.rCtl }}>
      <span style={{ color: C.t1, fontFamily: C.body, fontSize: 13 }}>Full Extension</span>
      <span style={{ textAlign: 'right' }}>
        <span style={{ color: tone, fontFamily: C.body, fontSize: 12, fontWeight: 700 }}>{text}</span>
        {detail && <span style={{ display: 'block', color: C.t4, fontFamily: C.body, fontSize: 11, marginTop: 2 }}>{detail}</span>}
      </span>
    </div>
  );
}
```

- [ ] **Step 2: Accept the new prop and derive the redundancy note**

In `communityhunts-frontend/src/admin/userProfile/AdminControls.js`, replace lines 26-33 (the comment through the `hasFullExt` line):

```js
// Admin-editable controls for a user: the Full Extension access toggle, and Rainbet/Twitch
// identity. Writes go through the parent's onField / onGrant handlers.
export default function AdminControls({ rainbet, twitch, grants, onField, onGrant }) {
  const C = useTheme();
  const [rb, setRb] = React.useState(rainbet);
  const [tw, setTw] = React.useState(twitch);
  const [saved, setSaved] = React.useState('');
  const hasFullExt = (grants || []).includes('full_extension');
```

with:

```js
// Admin-editable controls for a user: effective Full Extension access (read-only) + the admin
// comp that can grant it, and Rainbet/Twitch identity. Writes go through the parent's
// onField / onGrant handlers.
export default function AdminControls({ rainbet, twitch, grants, fullExtension, onField, onGrant }) {
  const C = useTheme();
  const [rb, setRb] = React.useState(rainbet);
  const [tw, setTw] = React.useState(twitch);
  const [saved, setSaved] = React.useState('');
  const hasFullExt = (grants || []).includes('full_extension');
  // Sources OTHER than the comp decide whether the comp is redundant. Empty => the comp is
  // what grants access, so no note (the toggle genuinely controls it there).
  const otherSources = ((fullExtension && fullExtension.sources) || []).filter(s => s !== 'admin_comp');
```

- [ ] **Step 3: Render the status line + relabeled comp toggle**

In `communityhunts-frontend/src/admin/userProfile/AdminControls.js`, replace the Feature Access block (lines 50-55 in the pre-edit file):

```js
      <div>
        <div style={{ ...label, marginBottom: 6 }}>Feature Access</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <FeatureToggle C={C} label="Full Extension" on={hasFullExt} onToggle={v => onGrant('full_extension', v)} />
        </div>
      </div>
```

with:

```js
      <div>
        <div style={{ ...label, marginBottom: 6 }}>Feature Access</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <AccessStatus C={C} fullExtension={fullExtension} />
          <FeatureToggle C={C} label="Admin comp" on={hasFullExt} onToggle={v => onGrant('full_extension', v)} />
          {otherSources.length > 0 && (
            <div style={{ color: C.t4, fontFamily: C.body, fontSize: 11, paddingLeft: 2 }}>
              Covered by {otherSources.map(s => SOURCE_LABELS[s] || s).join(', ')} — a comp would change nothing.
            </div>
          )}
        </div>
      </div>
```

- [ ] **Step 4: Verify the build**

From `communityhunts-frontend/`:

```bash
CI=true npm run build
```

Expected: `Compiled successfully.` — CRA does NOT flag a missed prop on an extracted component (it is silently `undefined`), so also confirm by eye that `AdminControls` is passed `fullExtension` in Task 6 before considering this done.

- [ ] **Step 5: Commit**

```bash
git add src/admin/userProfile/AdminControls.js
git commit -m "feat: show effective Full extension access + source in admin panel

The comp grant is one of six OR'd paths, so it can add access but never remove it.
Split the read-only effective status (with its sources) from the comp toggle, and
relabel the toggle as the comp it actually is."
```

---

## Task 6: Pass the prop + refresh after toggling (frontend)

**Files:**
- Modify: `communityhunts-frontend/src/admin/UserProfile.js:24-39` (handlers), `:53-54` (AdminControls call site)

**Interfaces:**
- Consumes: `u.fullExtension` from the `fetchUser` response (Task 3); `AdminControls`'s new `fullExtension` prop (Task 5).
- Produces: nothing new.

- [ ] **Step 1: Move `reload` above the handlers and re-fetch after a grant toggle**

In `communityhunts-frontend/src/admin/UserProfile.js`, replace lines 24-39 (from `const onField` through `const onDeleteHunt = ...`):

```js
  const onField = (field, value) => setUserField(userId, field, value)
    .then(() => setU(p => ({ ...p, [field]: value }))).catch(e => setErr(e.message));
  const onGrant = (feature, on) => setFeatureGrant(userId, feature, on)
    .then(r => setU(p => ({ ...p, featureGrants: r.featureGrants }))).catch(e => setErr(e.message));
  const onCosmetics = (body) => setUserCosmetics(userId, body)
    .then(r => setU(p => ({ ...p, cosmetics: r.cosmetics, cosmeticsOwned: r.cosmeticsOwned })))
    .catch(e => setErr(e.message));

  // Currency-correct / delete a past hunt in the durable stats store, then re-fetch the whole
  // profile — a correction/deletion recomputes every participant, so the tiles/records above
  // this user's rows can shift too.
  const reload = () => fetchUser(userId).then(setU).catch(e => setErr(e.message));
  const onCorrectHunt = (huntKey, currency, usdRate) =>
    correctHuntHistory(huntKey, currency, usdRate).then(reload).catch(e => setErr(e.message));
  const onDeleteHunt = (huntKey) =>
    deleteHuntHistory(huntKey).then(reload).catch(e => setErr(e.message));
```

with:

```js
  // Re-fetch the whole profile. Used wherever a write invalidates DERIVED fields, not just the
  // one being written: a hunt correction recomputes every participant, and a comp grant changes
  // the computed fullExtension {access, sources}. Recomputing those client-side would duplicate
  // the backend's entitlement rules and let them drift.
  const reload = () => fetchUser(userId).then(setU).catch(e => setErr(e.message));

  const onField = (field, value) => setUserField(userId, field, value)
    .then(() => setU(p => ({ ...p, [field]: value }))).catch(e => setErr(e.message));
  const onGrant = (feature, on) => setFeatureGrant(userId, feature, on)
    .then(reload).catch(e => setErr(e.message));
  const onCosmetics = (body) => setUserCosmetics(userId, body)
    .then(r => setU(p => ({ ...p, cosmetics: r.cosmetics, cosmeticsOwned: r.cosmeticsOwned })))
    .catch(e => setErr(e.message));

  const onCorrectHunt = (huntKey, currency, usdRate) =>
    correctHuntHistory(huntKey, currency, usdRate).then(reload).catch(e => setErr(e.message));
  const onDeleteHunt = (huntKey) =>
    deleteHuntHistory(huntKey).then(reload).catch(e => setErr(e.message));
```

- [ ] **Step 2: Pass the new prop**

In `communityhunts-frontend/src/admin/UserProfile.js`, replace lines 53-54:

```js
          <AdminControls userId={u.id} rainbet={u.rainbetName || ''}
            twitch={u.twitchName || ''} grants={u.featureGrants || []} onField={onField} onGrant={onGrant} />
```

with:

```js
          <AdminControls userId={u.id} rainbet={u.rainbetName || ''}
            twitch={u.twitchName || ''} grants={u.featureGrants || []}
            fullExtension={u.fullExtension} onField={onField} onGrant={onGrant} />
```

- [ ] **Step 3: Verify the build**

```bash
CI=true npm run build
```

Expected: `Compiled successfully.`

- [ ] **Step 4: Commit**

```bash
git add src/admin/UserProfile.js
git commit -m "feat: thread fullExtension into AdminControls, reload after comp toggle

A comp grant changes the computed access/sources, so re-fetch rather than patching
featureGrants alone — the status line would otherwise contradict the toggle you just
flipped."
```

---

## Task 7: Frontend PR + preview verification

**Files:** none (process task)

- [ ] **Step 1: Confirm only intended files changed**

```bash
git status --short
git --no-pager diff origin/main --stat
```

Expected: only `src/admin/userProfile/AdminControls.js` and `src/admin/UserProfile.js`.

- [ ] **Step 2: Push and open the PR**

```bash
git push -u origin feat/full-extension-entitlement-source
gh pr create --base main --head feat/full-extension-entitlement-source \
  --title "feat: show effective Full extension access + source in the admin panel" \
  --body-file <path to a written body file>
```

Body must state that it requires the merged backend PR, and that without it `fullExtension` is `undefined` and the line reads "— No access". No Claude attribution.

- [ ] **Step 3: Verify on the Vercel branch preview**

Do NOT test on `main` — it is the live site. Vercel builds a preview URL per branch.

On the preview, open `/admin` → a known **VIP** user's profile. Confirm:

1. The status line reads **✅ Has access** with **via Discord VIP role** (or whichever roles apply).
2. The **Admin comp** toggle reads **OFF** — this is the bug being fixed: access without a comp.
3. The redundancy note appears: *"Covered by … — a comp would change nothing."*
4. Toggle the comp **ON** → the profile re-fetches, `admin_comp` joins the sources, the note still shows the other paths.
5. Toggle it back **OFF** → status stays **✅ Has access** (the VIP path still covers them). This is the behavior the old toggle lied about.

Then open a **non-VIP, non-subscriber** profile. Confirm the line reads **— No access**, and that toggling the comp ON flips it to **✅ Has access — via admin comp** with **no** redundancy note.

- [ ] **Step 4: Merge after review**

Merge to `main` only once confirmed on the preview. `git pull --ff-only` first — `main` is shared and auto-deploys.

---

## Notes for the implementer

- **Both repos use the same branch name** (`feat/full-extension-entitlement-source`). They are different git repos with different owners; run every git command from inside the app subdirectory. The wrapper directory is not a git repo.
- **This is a shared worktree.** Parallel sessions land foreign commits on the checked-out branch. Audit `git log` before pushing; never `git add -A`.
- **`rainbet_slots.json` / `hunts_archive.json`** churn locally and are not yours. Leave them alone.
- **Backend has no build step**; `npm install` after every pull (it prunes undeclared dev deps).
