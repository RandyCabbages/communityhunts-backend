# VIP Extension Download Gating — Design

**Date:** 2026-07-09
**App:** communityhunts-backend (frontend unchanged except one optional edge guard)
**Status:** approved design, pending spec review

## Problem

The Full (Rainbet) browser extension download page shows one of two views based on a
backend entitlement check (`GET /api/extension/entitlement` → `fullAccess`):

- `fullAccess === false` → **$5/mo subscribe gate** (`SalesView`)
- `fullAccess === true` → **download button + install guide** (`ShopExtensionGuide`)

`fullAccess` today comes from `hasFullExtension(userId, tenantPlan)` = qualifying plan
ladder (Enterprise/Ultimate) **OR** a `full_extension` grant (the $5/mo Stripe sub or an
admin comp). A tenant's **VIPs get none of this** — they're prompted to pay $5 like anyone
else. Goal: a community's VIP roles unlock the extension for free.

## Scope decision: which roles unlock it

Tenant-scoped roles, resolved by the backend's authoritative per-tenant helpers:

| Role (intent) | Backend check |
|---|---|
| Tenant VIP host | `reqIsVipHost(req)` — `tenant_roles` role=vip (+ platform-admin short-circuit) |
| Tenant mod | `reqIsMod(req)` — tenant mod, resolves against `req.tenant` |
| Discord-guild VIP | `req.user.isDiscordVip` — guild VIP role flag |

`reqIsAdmin` is folded into both `reqIsVipHost` (platform-admin) and `reqIsMod`, so
admins/owner remain covered. Affiliates are **not** included (they can already buy; they
do not get it free).

`req.user.isDiscordVip` may be absent when the Discord guild fetch didn't populate it;
in that case the user falls back to `reqIsVipHost`/`reqIsMod`. Accepted — it only ever
grants access, never revokes.

## Why gate at the entitlement route

The extension itself calls `GET /api/extension/entitlement` on load to gate its in-app
Rainbet features (`settings.routes.js:113` comment). So adding VIP at this one route
unlocks **both** the download-page view **and** the extension runtime features — exactly
the intended VIP experience. One change, both surfaces.

Rejected alternatives:
- **Fold VIP into `hasFullExtension()`** — that fn is `(userId, tenantPlan)`, has no
  `req`/tenant-role context; VIP is req-scoped and can't reach it without threading `req`
  through every caller. More ripple, no benefit.
- **Frontend-only view switch** — client-trusted and wouldn't gate the extension runtime.

## Design

### 1. Shared entitlement helper (single source of truth)

Both the entitlement route and the checkout guard must agree on "does this request have
Full extension access". Define one helper in `server.js`, where `reqIsVipHost`,
`reqIsMod`, and `hasFullExtension` are all in scope, and inject it into both routers:

```js
// server.js — after reqIsVipHost / reqIsMod / hasFullExtension are available
async function reqHasFullExtension(req) {
  if (!req.user) return false;
  const isTenantVip = reqIsVipHost(req) || reqIsMod(req) || !!req.user.isDiscordVip;
  return isTenantVip || await hasFullExtension(req.user.id, req.tenant?.plan);
}
```

Pass `reqHasFullExtension` into:
- `initSettings(...)` deps (`server.js:489`)
- `cosmeticsRoutes(...)` deps (wherever it's constructed in `server.js`)

### 2. Entitlement route — use the helper

`routes/settings.routes.js`:
- Add `reqHasFullExtension` to the deps destructure (line 21).
- Replace the body of `GET /api/extension/entitlement` (lines 115-118):

```js
router.get('/api/extension/entitlement', requireAuth, async (req, res) => {
  res.json({ fullAccess: await reqHasFullExtension(req) });
});
```

### 3. Checkout hardening — don't charge an entitled user

`routes/cosmetics.routes.js`:
- Add `reqHasFullExtension` to the deps destructure (line 94).
- In `POST /api/extension/subscribe` (line 139), before the existing `isPurchaseEligible`
  check, short-circuit if already entitled:

```js
if (await reqHasFullExtension(req)) return res.json({ alreadyEntitled: true });
```

VIPs never see the Subscribe button, so this only fires on a stale/direct call — it
prevents a VIP from being charged $5 for something they get free.

### 4. Frontend

**No change required for the core feature** — `ShopExtension` renders whatever
`fullAccess` the backend returns; VIPs now get the download guide automatically.

**Optional edge guard** (only matters if someone reaches the Subscribe button via a stale
page): `handleBuy()` in `ShopExtension.js` currently redirects to `data.url`. Guard it so a
`{ alreadyEntitled: true }` response (no `url`) re-fetches entitlement / reloads instead of
redirecting to `undefined`:

```js
if (data.url) { window.location.href = data.url; }
else { /* alreadyEntitled — re-fetch entitlement so the guide renders */ }
```

Low priority; the button isn't shown to entitled users.

## Out of scope (flagged, not fixed)

The extension `.zip` at `/extension/*.zip` is served statically by Vercel and is publicly
downloadable by direct URL regardless of entitlement. This change gates the **UI view and
extension runtime**, not the file itself — identical to how paid subs work today. True
per-user file gating (signed URLs / a backend file endpoint) is a separate effort.

## Testing

- **VIP host** (tenant_roles vip): `/api/extension/entitlement` → `fullAccess:true`;
  download guide renders; no $5 gate.
- **Mod**: same as VIP host.
- **Discord-guild VIP** (isDiscordVip true, not in tenant_roles): `fullAccess:true`.
- **Plain member** (no roles, no sub): `fullAccess:false`; $5 gate still shows.
- **Existing paid sub / Enterprise / Ultimate / admin grant**: still `fullAccess:true` (no regression).
- **Owner / platform admin**: `fullAccess:true`.
- **VIP POSTs `/api/extension/subscribe`** (stale URL): `{ alreadyEntitled:true }`, no Stripe session, no charge.
- **Plain member POSTs subscribe**: unchanged — eligibility check runs, Stripe session created.

## Files touched

- `communityhunts-backend/server.js` — define `reqHasFullExtension`, inject into both routers.
- `communityhunts-backend/routes/settings.routes.js` — deps + entitlement route body.
- `communityhunts-backend/routes/cosmetics.routes.js` — deps + subscribe short-circuit.
- `communityhunts-frontend/src/pages/shop/ShopExtension.js` — *optional* `handleBuy` guard.
