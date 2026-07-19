# Role Flair Badges — Design

**Date:** 2026-07-18
**Repos:** `communityhunts-backend` (data + endpoint + admin API) and `communityhunts-frontend` (context + component + render sites)
**Status:** Approved design, pre-implementation

## Goal

Show a small, role/status-driven **flair badge** next to a user's name wherever names render.
This is distinct from the existing **cosmetic card flair** (`FlairName`, purchased skins) — these
badges are *assigned by status*, not bought. Four badge types:

| Badge | Label · icon | Who | Source of truth | Scope |
|---|---|---|---|---|
| **Owner** | `◆ Owner` (gold) | Kyle + Goofer | `PLATFORM_OWNER_IDS` / `isPlatformOwnerId()` in `lib/tenants.js` (Kyle `135203806676779008`, Goofer `168055630916091904`) | Global |
| **The King** | `★ The King` (gold) | The **actual streamer** of a community | tenant `hostDiscordId` | Per-tenant (Bean is King only in `/bean`) |
| **Staff** | `⚡ Staff` (violet) | Community mods | `tenant_roles` role=`community_mod` (exposed as `tenant.modIds`) | Per-tenant |
| **Supporter** | `♥ Supporter` (pink) | Donors, marked manually | **new** `supporters` table | Global |

**Precedence — a user gets exactly ONE badge (highest wins):** Owner → The King → Staff → Supporter.

**Icons are placeholders and easily swapped — NO crown on any badge** (👑 stays Bean's personal
streamer icon; the King badge uses `★`, not a crown). One hue per badge: gold (Owner + King),
violet (Staff), pink (Supporter). Owner and King share gold, distinguished by icon + label.

**Visual treatment — "Bold solid pill" (chosen).** Each badge is a filled, saturated pill: solid
badge-colour background, label in a dark same-family text colour, ~9.5px mono uppercase, `2.5px 8px`
padding, `6px` radius — noticeably louder than the current faint `HOST` tag (which was rejected as
too subtle). Sits inline next to the name, where the `HOST` tag renders today.

### "The King" replaces the `HOST` tag — streamer only
Today `EquityRow.js` shows a `HOST` pill for `e.id === 'creator_auto'`. New rule:
- The King (`★ The King`, gold solid pill) shows **only for the tenant's real streamer** — i.e. a row
  whose Discord ID equals the tenant `hostDiscordId`. In Bean's own hunt that's Bean.
- A **non-streamer** running a VIP/affiliate hunt (a hunt owner whose Discord ID ≠ `hostDiscordId`)
  keeps the existing neutral `HOST` label — they are the hunt host, not the King.
- Implementation note: `creator_auto` / `bean_auto` are synthetic IDs that won't match `hostDiscordId`
  directly. Resolve King on those rows by comparing the **hunt owner's real Discord ID** to
  `hostDiscordId`; if equal, the `creator_auto`/streamer row renders The King, else it stays `HOST`.
  Real-ID render sites (hub, dropdown) resolve King straight from the roster's `king` field.

### Out of scope / explicit non-goals
- No payment automation. Supporters are set by hand in an admin UI after a donation.
- **Non-owner platform admins and tenant admins get NO badge.** Staff comes only from the
  `community_mod` role. (Revisit later if generic admins should show Staff.)
- Cosmetic card flair (`FlairName`) is untouched — badges render *beside* it, not through it.

## Architecture

Lookup is **by Discord ID**, resolved client-side against a small roster the backend serves. This is
what makes "everywhere names render" tractable: any render site with a Discord ID can show a badge
with one component, instead of every backend serializer having to stamp flags onto user objects.

```
Backend                                   Frontend
─────────                                 ─────────
supporters table  ─┐                      BadgeProvider (fetches /api/badges,
lib/supporters.js  ├─ GET /api/badges ──▶   refetch on tenant-slug change)
tenant.modIds      │  (tenant-aware via        │
tenant.hostDiscordId  resolveTenant)           ├─ useBadges().badgeFor(id) ─▶ pickBadge()
PLATFORM_OWNER_IDS ─┘                          └─ <UserBadge userId slug /> pill
```

## Backend

### 1. `supporters` table + `lib/supporters.js`
Mirror `lib/admins.js` exactly (DI pattern, in-memory `Set` cache, safe no-op with no DB):
```sql
CREATE TABLE IF NOT EXISTS supporters (
  discord_id TEXT PRIMARY KEY,
  added_by   TEXT,
  added_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```
Exports: `initSupporters(deps)`, `reloadSupporterCache()`, `isSupporter(id)`, `getSupporterIds()`,
`listSupporters()`, `addSupporter(id, addedBy)`, `removeSupporter(id)`.
Wire `initSupporters({ pgPool })` into server startup next to `initAdmins(...)`.

### 2. Admin management API (in `routes/admin.routes.js`)
Mirror the existing `/api/admin/platform-admins` trio, gated `requireAuth, requirePlatformAdmin`,
using an injected `supporters` module:
- `GET    /api/admin/supporters`          → `listSupporters()` (optionally enriched with Discord
  username, same as the platform-admins list does)
- `POST   /api/admin/supporters` `{ discordId }` → `addSupporter(discordId, req.user.id)`
- `DELETE /api/admin/supporters/:id`      → `removeSupporter(id)`

### 3. Public roster endpoint `GET /api/badges`
Public (no auth), runs through the existing `resolveTenant` middleware so `req.tenant` is set.
Served entirely from in-memory caches (owners const, supporters cache, `tenant.modIds`,
`tenant.hostDiscordId`) — **no per-request DB hit**.
```json
{
  "owners":     ["135203806676779008", "168055630916091904"],
  "king":       "110983319176384512",
  "mods":       ["…"],
  "supporters": ["…"]
}
```
`owners` + `supporters` are global; `king` + `mods` are the active tenant's.

**Privacy note (deliberate):** this publicly exposes the owner/supporter/mod Discord ID lists. That
is acceptable — the badges are displayed publicly anyway and Discord IDs are not secrets. Recorded
here so it's a conscious choice, not an accident.

## Frontend (`src/badges/`)

### 1. `roles.js` — pure precedence (gets `roles.test.js`)
```
pickBadge({ isOwner, isKing, isStaff, isSupporter }) → 'owner' | 'king' | 'staff' | 'supporter' | null
```
Pure module → unit tested per repo rule (pure logic gets a `.test.js`; components do not).

### 2. `BadgeContext.js` — `BadgeProvider` + `useBadges()`
- `BadgeProvider` fetches `/api/badges` once and on tenant-slug change; holds
  `{ owners:Set, king:string|null, mods:Set, supporters:Set }`.
- `useBadges().badgeFor(discordId)` computes the flags for an ID and returns `pickBadge(...)`.
- Wraps the app in `App.js` (inside routing so the slug is available).

### 3. `UserBadge.js` — presentational pill
- Props `{ userId, slug }`. Renders nothing when `badgeFor` returns `null` (covers `creator_auto`,
  `bean_auto`, anonymous rows — no real Discord ID → no badge).
- **Bold solid pill** treatment: solid badge-colour bg, dark same-family text, ~9.5px mono uppercase,
  `2.5px 8px` / `6px` radius. Tokens via `useTheme()` (gold = `G.gold`, violet = accent, pink = new
  token). Louder than the `HOST` tag it sits beside.
- Labels/icons: `◆ Owner` · `★ The King` · `⚡ Staff` · `♥ Supporter` (no crown; icons swappable).
- The King path also handles the `creator_auto`/streamer row relabel (see backend section) — pass the
  hunt owner's real Discord ID so `UserBadge` can compare it to the tenant `king`.

### 4. Render-site integration
Drop `<UserBadge userId={id} slug={slug} />` beside `FlairName`:
- **Equity rows** — `src/hunt/columns/EquityRow.js` / `EquityCard.js`. The King **replaces** the
  `HOST` pill for the streamer row (per the King-scope rule above); other members get their badge
  inline next to `FlairName`.
- **Hub** name sites — `src/pages/Hub.js` + `src/pages/hub/*`.
- **Account dropdown** — `src/pages/home/UserDropdown.js` (the user's own badge).

Adding it to any future name site is a one-liner because lookup is by Discord ID.

## Testing / verification
- Backend: `lib/supporters.js` follows `lib/admins.js` (already covered by that pattern); add/remove
  round-trip and `/api/badges` shape verified manually against the dev DB.
- Frontend: `src/badges/roles.test.js` covers precedence. `CI=true npm run build` must compile.
  Manual: mark a test Discord ID as supporter, confirm the pill renders in the equity list and hub.
- Never push to `main` — branch + Vercel preview per repo workflow.

## Rollout
1. Backend: table + `lib/supporters.js` + admin API + `/api/badges`. Deploy (badge endpoint is
   additive; no behavior change until the frontend consumes it).
2. Frontend: `src/badges/*` + `BadgeProvider` + render sites, on a branch → preview → merge.
3. Mark supporters via the admin panel as donations come in.
