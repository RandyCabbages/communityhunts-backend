# Multi-Tenant Platform & Two-Level Admin — Design

**Date:** 2026-07-16
**Owners:** Goofer (`168055630916091904`) + Cabbage/Kyle (`135203806676779008`)
**Status:** Design approved section-by-section; ready for phase plans.
**Spans:** `communityhunts-backend` + `communityhunts-frontend` (backend-first throughout).

> This is a **program spec**, not a single plan. It defines phases that are each
> independently shippable and independently revertable. Each phase gets its own
> `writing-plans` implementation plan. `main` auto-deploys to production in both
> web apps and a second collaborator also pushes to it — every phase must leave
> `main` green on its own.

---

## 1. Problem & Goal

CommunityHunts.gg was built with **Bean as the driving force**, and the code encodes
Bean as *both the platform and the only tenant*. To sell hubs to other streamers we
must "de-Bean" the platform — teach the system that Bean is the **first customer**,
not the default — and split the admin into two levels:

- **`/admin` — platform overseer:** site-wide controls + a grid of community cards.
  Click a card to manage that community. Owners only (Goofer + Cabbage).
- **`/:slug/admin` — community console:** everything scoped to one tenant. The
  streamer (tenant admin) and their mods live here.

Goal: **keep adding tools**, and let some communities get **bespoke tools** that
appear only in their own console — without an N-theme design tax or a per-tenant
fork of shared code.

### The second tenant is hypothetical (for now)
There is no imminent tenant #2 — the intent is to be **ready to pitch**. This
demotes the biggest migration (`id` ≠ `slug`, §7.1) out of the critical path: it
must land *before a churned slug is resold*, not *before the pitch*. Cabbage's
create/delete-community flow is the literal pitch surface and **needs review** (§4.6).

---

## 2. Core Findings (verified in code)

These reframe the work and are the reason the phases are ordered as they are.

### 2.1 There is ONE admin, mounted twice
`AdminLayout` + its 14 child routes are declared **byte-identically twice** in
`src/App.js` (`179-194` platform, `219-234` community). The "two different-looking
admins" differ **only by route nesting**: `/:slug/admin` sits under `TenantLayout`,
whose inner `<ThemeProvider>` applies `makeKitchenTheme()` for bean; `/admin`
inherits the root violet provider. Nothing in `src/admin/` references "kitchen" —
every page reads `useTheme()`. So neutral-chrome admin is a ~3-line theme change,
not a rewrite.

### 2.2 `/admin` already silently means Bean
Tenant context is implicit: `api.js` `currentSlug()` parses `window.location`, and
`admin` is `RESERVED`, so `/admin` sends **no `X-Tenant-Slug`** → backend
`resolveTenant` defaults to `BEAN_TENANT`. `/admin/hunts` shows Bean's hunts,
unlabelled. This is fixed **architecturally** in §5: re-scope Overview/Users/Hunts to
`community` so no route under `/admin` *can* mean Bean.

### 2.3 SECURITY: a tenant admin/mod has platform-global write access
Root cause: `reqIsAdmin` folds `reqIsMod` in unconditionally (`lib/auth.js:185-189`),
and six `settings.routes.js` routes gated `requireAdmin` **ignore `req.tenant`**. The
day tenant #2 exists, their admin can:
- `POST /api/admin/grandfather-full-extension` → grant `full_extension` to **every
  row in `known_users`** (irreversible; destroys the paid extension product).
- `GET /api/admin/users` → enumerate all platform users + `rainbetName`.
- `POST /api/admin/set-user-field` → overwrite **any** user's `rainbetName` (payout handle).
- `.../grants`, `.../cosmetics`, `set-preferred-slots` → global writes.

Survivable *today* only because `POST /api/admin/mods` is `requirePlatformAdmin`
(mod role isn't self-service). **Moving mod management to the community console —
which this project does — arms this.** Hence Phase 0 before everything.

Two more, independent of the console work:
- `GET /api/hunts/:userId/archived/:archivedAt` (`hunts.routes.js:57-62`): no
  `inTenant`, skips `publicHuntView` → leaks raw snapshot incl. `equity[].discordId`.
  Fix = `inTenant` + `publicHuntView`. **Do NOT add `requireAuth`** — this route feeds
  the public `WatchHunt` page (anonymous past-hunt viewing); the leak is the raw spread,
  not the missing auth, and the sibling `GET /api/hunts/:userId` is deliberately
  anonymous-viewable + stripped the same way.
- `requireAdminOrKey` (`admin.routes.js:55-60`): `GOTIN_EXPORT_KEY` bypasses auth **and**
  tenant checks while trusting the client `X-Tenant-Slug` → any tenant's full export.

### 2.4 The tenant-scoped half is well-built — leave it alone
`inTenant()` guards **every** hunt mutation without exception; `publicHuntView` is
disciplined (one miss, above); `apiKeys.routes.js:11-15` (`requireOwnerOrPlatform`) gets
the admin/mod distinction **exactly right** — it is the reference to promote into
`lib/auth.js`. ~20 admin files already read `useTheme()` with zero local tokens.

### 2.5 "VIP" is not a community indicator
Two disjoint systems share the word: `tenant_roles role='vip'` (seeded only from the
`VIP_IDS` env at boot — no admin UI, no Discord sync, Bean-only) and `user.isDiscordVip`
(per-session guild flag, absent for any tenant without Discord wired). VIP is a *host*
tier (above `affiliate`, the actual membership role). And from `/shop` (reserved slug),
`req.tenant` resolves to **Bean**, so any tenant flag read at submit time is *wrong*,
not merely absent. Card-request community must be **transported explicitly** (§6.2),
never inferred.

### 2.6 `deleteTenant` leaves orphans — confirmed in prod
The deleted `testing` community left **4 `community_members` rows** (cleaned 2026-07-16).
`deleteTenant` purges `tenant_roles` + `tenant_api_keys` but not `community_members`,
`hunts`, `hunt_history`, `hunt_participants`, `user_hunt_stats`. Combined with `id===slug`
reuse, a resold slug inherits the prior community's data. Fix in §4.6.

---

## 3. Identity & Membership Model (the mental model)

Two populations, currently conflated — separating them answers most design questions:

| Population | Scope | Backed by | Managed in |
| --- | --- | --- | --- |
| **Platform users** | global (one Discord login = one account, whole site) | `known_users` | platform admin |
| **Community members** | per-tenant (affiliated with one community) | `community_members` | that community's admin |

**Login is global; membership is per-community; access to a community gates loading
its hub.** This is already where the code points — `reconcileMembership`
(`auth.routes.js:28-41`) writes a `community_members` row when a user's Discord
affiliate/VIP/mod role qualifies them for the tenant whose page they're on
("membership == role"). The plumbing exists; it's half-wired and unsurfaced.

**Membership must be populated from three OR'd sources** so a brand-new community
isn't empty before its Discord is wired:
1. Discord affiliate-role sync (exists for Bean),
2. self-join from Settings (exists),
3. **implicit: anyone who ran a hunt in that tenant** (derivable from the `tenantId`
   already stamped on hunts / `hunt_history`).

Homepage already filters community cards by membership for non-admins
(`UserDropdown.js:15-27`) and shows all to owners — so "load the hub if you have
access" is built; it just needs membership to be trustworthy (source 3 is the gap).

---

## 4. Authorization & Scope Split

### 4.1 Three levels, not two
| Level | Who | Gate | Console |
| --- | --- | --- | --- |
| Platform | Goofer + Cabbage | `requirePlatformAdmin` | `/admin` |
| Community admin | the streamer | `requireTenantAdmin` **(new)** | `/:slug/admin` |
| Community mod | their mods | `requireMod` | `/:slug/admin` (subset) |

Today `requireAdmin` collapses admin+mod. The fix (Phase 1): promote the correct
logic from `apiKeys.routes.js:11-15` into `lib/auth.js`, and **stop folding
`reqIsMod` into `reqIsAdmin`**:

```js
function reqIsTenantAdmin(req) { return isPlatformAdmin(req.user) || tenants.isTenantAdmin(req.user, req.tenant); }
function reqIsMod(req)         { return isPlatformAdmin(req.user) || tenants.isTenantMod(req.user, req.tenant); }
function reqIsAdmin(req)       { return reqIsTenantAdmin(req) || reqIsMod(req); } // read-only console VISIBILITY only
```
Ladder: `isPlatformAdmin` ⊃ `reqIsTenantAdmin` ⊃ `reqIsMod` ⊃ member.
"Platform admin acting **on** tenant X" needs no new mechanism — `isPlatformAdmin`
short-circuits every predicate. **Add an audit log** when
`isPlatformAdmin(req.user) && !isTenantAdmin(req.user, req.tenant)` — acting on a
customer's data should be recorded before there are customers to answer to.

### 4.2 Structural gate for platform routes
Mount platform capabilities under a distinct prefix with a **router-level** gate, so
a mis-gated route is unrepresentable (this is exactly how
`grandfather-full-extension` went wrong):
```js
const platform = express.Router();
platform.use(requireAuth, requirePlatformAdmin);
app.use('/api/platform', platform);
```
Keep old paths as aliases for one release; delete after the frontend migrates.

### 4.3 Capability → level map
11 of 22 are already correct. Corrections below.

**Platform:** Tickets ✅, Shop/Card Requests ✅, Cosmetics + card release ✅, Card
Tuner (FE-only, no route), Subscriptions ✅, Platform Admins ✅, Create/Delete
Community ✅-gate/§4.6-sweep, Announcements (global patch notes) ✅, + community grid
(new), + cross-tenant rollup (new).

**Community:** Overview ✅, Hunts + force-end/delete/reopen ✅, Hunt history + currency
retag ✅, Socials ✅, Discord config (⚠ tighten to `requireTenantAdmin` — a mod can
currently read the bot token in cleartext), Developer API keys ✅, Users (**members**,
§4.4), Mods (§4.5).

**Inverted today — must fix:**
- **Mods** — writes are `requirePlatformAdmin` → a streamer can't manage their own
  mods. Re-gate to `requireTenantAdmin`, **strictly after Phase 0** (before it, this
  hands strangers the §2.3 table). Drop the hardcoded `'bean'` seat-cap exemption
  into `tenant_features` once §8 lands.
- **Slot Lists** — §4.7.
- **Users / grants / cosmetics writes** — the §2.3 vulnerability.

**Gap:** no route to manage a community's **own admins** (only the `createTenant`
seed). Community admin needs an "add co-owner" affordance.

### 4.4 Community Users = members
Same tab component, two data sources by scope: platform = full `known_users`;
community = that tenant's members (§3). Degrades gracefully — a community with no
Discord wired shows its hunt-activity members (source 3) until it connects.

### 4.5 Mods — community-managed (after Phase 0)
Re-gate `POST/DELETE /api/admin/mods` to `requireTenantAdmin`. Seat caps already
work.

### 4.6 Create/Delete Community — the pitch surface, needs hardening
Two must-fixes:
1. **Finish `deleteTenant`'s sweep** — add `community_members`, `hunts` (blob filter),
   `hunt_history`, `hunt_participants`, `user_hunt_stats`. One statement per table.
   Shippable immediately, decoupled from everything (§2.6). *(The one-off `testing`
   orphans are already cleaned.)*
2. **`id` ≠ `slug`** (§7.1) — deferred to its own phase, but it's the root of the
   reuse/rename hazard the sweep only half-addresses.
Review Cabbage's `AdminCreateCommunity` + `createTenant` end-to-end as part of the
platform phase.

### 4.7 Slot Lists — an ownership axis, not a re-gate
Goofer's framing ("presets people create that could be shared") means slot lists have
an owner scope: `platform` (global curated presets — today), `community` (a hub's own
lists), `user` (personal, shareable — later). Add `ownerScope` + `ownerId` to the
record; **build platform + community now, design-for `user` but don't build it** (YAGNI).

---

## 5. Console Architecture (frontend)

### 5.1 One layout, one registry, two generated route trees
Kill the duplicated blocks. A declarative registry is the single source; both the
sidebar and the route table derive from it.

```js
// each tool entry
{ id, path, index?, label, icon,
  scope: 'platform' | 'community' | 'both',   // STRUCTURAL — static, drives route generation
  component,                                   // lazy() for bespoke/heavy tools
  visible: (ctx) => boolean }                  // RUNTIME — this operator, this tenant, now
```
`scope` and `visible` are deliberately separate: `scope` is known at import (which
tree a tool *can* appear in); `visible` needs runtime data (plan, enabled-tools,
platform-admin). Conflating them forces either a hidden-but-reachable route or a
route table that can't be built until data loads.

`ctx = { scope, slug, user, tenant, tenantPlan, enabledTools, loading }`.
Predicates are pure combinators (`always`, `platformAdmin`, `planAtLeast`,
`toolEnabled`, `onlyTenant`, `all`, `any`) → unit-tested in `tools.test.js`.

```jsx
// App.js collapses to two call sites, one source:
<Route path="/admin" element={<AdminLayout scope="platform" .../>}>{adminRoutes('platform')}</Route>
<Route path="admin"  element={<AdminLayout scope="community" .../>}>{adminRoutes('community')}</Route>
```

### 5.2 Close the reachability gap
`adminRoutes(scope)` generates a `<Route>` per in-scope tool wrapped in `ToolGate`,
plus a trailing `path="*"` that keeps you inside admin chrome. `ToolGate` evaluates
the **same `visible` predicate** at render: fails → "Not available for this
community", never a doomed request. This **deletes the four hand-rolled guards** and
**closes the two unguarded pages** that currently eat a 403. The registry is UI only
— the backend still enforces (say so in the file header).

### 5.3 Explicit tenant context
`AdminScopeContext` + `useAdminScope()`. `AdminLayout` reads the implicit tenant
**once at the boundary** and republishes it explicitly — **not** by merging outlet
contexts (that re-creates the same implicit coupling and diverges by route). Pages
migrate `useOutletContext()` + `useParams()` → `useAdminScope()`.

`api.js` gains an **optional explicit** `tenant` arg (backward-compatible):
`apiFetch(path, { tenant })` — `tenant: null` = platform scope, `'foo'` = that tenant,
omitted = today's `currentSlug()` behavior (correct for the tenant-facing app). Only
`adminApi.js` becomes explicit; don't rip out `currentSlug()` globally.

### 5.4 Neutral chrome + identity as data
`AdminLayout` re-wraps a **fresh module-level neutral `<ThemeProvider>`** (reject
hoisting out of `TenantLayout` — loses its config fetch/gate/not-found; reject
variant-aware theming — reintroduces the N-theme tax). `makeTheme()` with no cfg ==
today's `/admin`, so `/admin` is byte-identical and `/bean/admin` converges onto it
(losing kitchen — intended).

Community identity is **data, never a token**: a `ManagingBanner` (community scope
only) reads `useAdminScope().tenant` for accent + name; "← All communities" → `/admin`.
Rule: *identity is a value in the banner + grid card, never a theme token.* One
`TenantSwitcher` replaces the 3 duplicated `<select>`s. **No logo field exists** —
banner ships as accent swatch + initial; a real `branding.logo` is later work.

### 5.5 Add `isPlatformAdmin` to `roles.js`
Twelve raw `user.isPlatformAdmin` reads across nine files is the inline-flag pattern
`roles.js` exists to prevent. Wrap it (one line) so `applyViewAs` has a single place
to strip it (`viewAs.js` currently leaves it intact).

---

## 6. Shop & Card Requests

### 6.1 Open the shop to anonymous visitors
The `shop` grant removal (2026-07) opened browsing to every *logged-in* user but left
a hard login wall at `Shop.js:20-24`. Pricing (`/shop/memberships`) and Extension
already render for anonymous visitors and only redirect at purchase — **cosmetics is
the lone holdout** and already has the correct purchase-time redirect sitting dead at
`Shop.js:93-97`.
- **Backend first:** open `GET /api/cosmetics/releases` to anonymous (currently
  `requireAuth`; the FE gate was its stated justification — circular). Else anonymous
  visitors see the catalog with zero released cards (`Shop.js:42` swallows the failure).
- **Frontend:** remove the mount redirect + `if (!user) return null`; null-safe the
  `user.id` reads; keep the `handleBuy` redirect.
- `isPurchaseEligible` is independent and **stays** the real purchase gate.
- Fix `PurchaseGate.js:29` (stale post-wipe membership logic, now inconsistent with
  `purchase.js`).

### 6.2 Attach card requests to a community (attribution)
Purpose is **attribution** ("this came from TrashGuy's hub"), not ownership — cards
stay global/equippable anywhere; the cosmetics catalog needs **no change**.
Because `/shop` is reserved, the community must be **transported, not inferred** (§2.5):
1. **Transport** — add an explicit community selector to `RequestCardModal`, sent in
   the POST body (default to best guess, user-correctable, honest-empty when unknown).
2. **Record** — nullable `tenantSlug` in `createRequest`; readers null-safe (existing
   rows lack it).
3. **Surface** — `buildRequestEmbed` (Discord doorbell), `ShopRequestTile` /
   `ShopRequestModal`, optional group-by-community axis in `shopRequestGroups.js`
   (pure + tested → cheap).
**Trap:** `req.tenant` is populated but defaults to Bean here — wiring it in would
stamp *every* request `'bean'`. Use the transported value; fallback explicit `null`.

---

## 7. Deferred to their own projects

### 7.1 `id` ≠ `slug`
UUID `id` + mutable unique `slug`. Keep `id='bean'` (a string PK; `modHuntKey`
special-cases `'bean'` for the live OBS URL — load-bearing). New tenants get UUIDs.
Backfill: real (multiple tenant-keyed tables + the hunts blob). Unblocks slug
rename/resale. Deferred because tenant #2 is hypothetical — must precede **reselling
a churned slug**, not the pitch.

### 7.2 One-hunt-per-user rekey
`hunts[userId]` allows only **one hunt per user platform-wide**;
`/api/my-hunt/start` 409s with no tenant predicate and **archives the user's
other-community hunt**. Overlapping audiences are the target market, so this is a real
bug. **Phase A now:** name the other community in the 409, kill the cross-tenant
archive write. **Phase B (this project):** rekey to `(tenantId, userId)` — spine
refactor (persistence, sockets, share tokens, overlays, janitor); scope separately.

### 7.3 Per-hub announcements
Global patch notes stay platform-only. New feature: a community admin posts
announcements scoped to their own hub (separate per-tenant key, shown only on that
hub). Net-new, follows the console.

---

## 8. Per-Tenant Tool Entitlements

For "some communities get bespoke/extra tools." A **`tenant_features` grant/deny
table** composed with the plan ladder — **not** `branding` JSONB (publicly served via
`/api/tenant-config`, unqueryable, untyped), **not** an `enabled_tools` allowlist
(replaces the ladder → every plan upgrade becomes a per-tenant migration).

```sql
CREATE TABLE tenant_features (
  tenant_id TEXT NOT NULL, feature_key TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('grant','deny')),
  granted_by TEXT, expires_at TIMESTAMPTZ, note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (tenant_id, feature_key));
CREATE INDEX tenant_features_key ON tenant_features (feature_key);
```
Cache in the tenant object like `adminIds`/`modIds` (one extra query in `reloadCache`).
Read path — **precedence deny > grant > plan**:
```js
function tenantCanUse(name, tenant, individualTier) {
  const feat = FEATURES[name];
  if (!feat) return false;                        // FAIL CLOSED (was return true)
  const o = tenant?.featureOverrides?.[name];
  if (o === 'deny')  return false;
  if (o === 'grant') return true;
  return canUse(name, individualTier, tenant?.plan); // unchanged ladder
}
```
`canUse` stays pure (all callers + `features.test.js` unchanged); `tenantCanUse` wraps
it. **Flip fail-open → fail-closed in the same PR that adds the table** (dynamic
feature keys make fail-open silently unlock features for everyone); add a `console.warn`
on unknown keys. Ship with the FE mirror in lockstep. Also fix `normalizePlan` →
`'pro'` fallback (a typo'd/absent plan silently grants Pro).

**Entitlement sources stay distinct (document in the module header):** plan (tenant) +
individual sub (user) already stack; `feature_grants` is per-**user** (comp,
`full_extension` only) — a different axis from `tenant_features` (per-**tenant**);
don't merge them.

---

## 9. Bespoke Per-Community Tools (frontend)

When Bean gets a tool no other community has:
```
src/tenants/
  index.js            // the ONE place slug → bespoke tools is mapped
  bean/index.js       // BEAN_TOOLS: [{ ..., component: lazy(() => import('./KitchenAdmin')),
                      //               visible: onlyTenant('bean') }]
```
`TOOLS = [...PLATFORM_TOOLS, ...COMMUNITY_TOOLS, ...TENANT_TOOLS]`. Adding one touches
a new folder + one line in `src/tenants/index.js` — **zero shared files**. `lazy()` +
the `<Suspense>` in `ToolGate` code-split it → other tenants never fetch the chunk.

**The rule (the inversion of today's `isKitchenTenant.js` = `slug === 'bean'` in shared
`src/theme/`):** *a tenant's slug may be named only inside `src/tenants/<slug>/`.*
Shared components never branch on tenant. Enforce in `tools.test.js` (assert every
tenant-predicated tool resolves to a `src/tenants/` module; grep no slug literals
outside those folders). Mirror on the backend: a bespoke `/api/admin/kitchen/*` router
gated on `req.tenant.slug`, not a branch in a shared route.

`enabledTools` (generic per-tenant flag) provisions **shared** tools per tenant;
`src/tenants/<slug>/` holds **bespoke** code. Never blur them — a flag can't ship code.

---

## 10. Phasing (each independently shippable; backend-first)

| Phase | What | Type | Gates next? |
| --- | --- | --- | --- |
| **0 — Security hotfixes** | re-gate `grandfather-full-extension` → `requirePlatformAdmin` (thread the dep into `settings.routes`); fix archived-hunt read (`inTenant` + `publicHuntView`, NOT `requireAuth`); kill `requireAdminOrKey` (xlsx → `requireAuth,requireAdmin`) | BE, no FE, no migration | **blocks Phase 3** |
| **1 — Split gates** | `requireTenantAdmin` in `lib/auth.js`; drop `reqIsMod` fold-in; re-gate the 6 settings routes to platform; tighten discord-config | BE (⚠ breaking for Bean's 5 seeded mods — notify) | blocks 3 |
| **2 — Shop opens** | releases route anonymous; null-safe `Shop.js`; fix `PurchaseGate.js` | BE→FE, user-visible | independent |
| **3 — Mods → community** | re-gate `/api/admin/mods` to `requireTenantAdmin` | BE | after 0+1 |
| **4 — Console refactor** | registry → ToolGate → neutral theme → banner → one `TenantSwitcher`; `isPlatformAdmin` in `roles.js` | FE, mostly refactor | touches App.js |
| **5 — `/admin` = grid** | `PlatformOverview` (stats + community cards); new `GET /api/platform/communities`; re-scope Overview/Users/Hunts to community | BE→FE, the payoff; kills §2.2 | touches App.js |
| **6 — Membership hardening** | 3-source population incl. hunt-activity; community Users tab; **tenant-scope `/api/known-users`** (moved from Phase 0 — safe only once membership incl. hunt participants is complete, else it shrinks Bean's live equity/invite autocomplete) | BE→FE | — |
| **7 — Card-request attribution** | selector + `tenantSlug` + embed/tile/group | FE→BE | after 2 |
| **8 — `tenant_features`** | table + `tenantCanUse` + fail-closed flip + FE mirror; `normalizePlan` fallback fix | BE→FE, no backfill | enables 9 |
| **9 — Slot Lists ownership** | `ownerScope`/`ownerId`; platform + community | BE→FE | — |
| **10 — Create/Delete hardening** | finish `deleteTenant` sweep; review `createTenant` flow | BE | — |
| **Deferred** | `id`≠`slug` (§7.1); one-hunt rekey Phase B (§7.2); per-hub announcements (§7.3) | own specs | — |

**Merge-race note:** Phases 4 & 5 touch `App.js` (the #1 conflict surface with
Cabbage). Land as small fast PRs; verify merge-base after merging; never `git add -A`.

**Deploy note:** every backend deploy clears in-memory sessions (everyone logs out) —
expected.

---

## 11. Explicit Non-Goals

- Per-tenant cosmetics catalog / community-owned cards (attribution ≠ ownership, §6.2).
- Full per-tenant theming of the admin console (neutral-chrome is the decided direction).
- Ripping `currentSlug()` out of the tenant-facing app (§5.3) — it's correct there.
- User-scoped shareable slot lists (design-for, don't build — §4.7).
- Horizontal scaling / `hunts_kv` blob rewrite (noted as a ceiling, out of scope).
