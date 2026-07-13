# Custom Card Requests ("Shop Requests") — Design

**Date:** 2026-07-13
**Status:** Approved
**Repos:** communityhunts-backend + communityhunts-frontend (backend merges/deploys first)

## Problem

Custom equity cards ($25 commission via Rainbet tip) are currently requested entirely over
Discord DMs: the idea, reference images, follow-up questions, and tip coordination all live in
DM history. The Shop's "Custom Card" tile (`card_custom`, `onRequest: true`) is a dead-end
showcase — its description tells people to DM.

## Goal

An in-site request flow: visitors submit their card idea through a form on the Shop; requests
are stored server-side and surface in the admin hub under a **Shop Requests** tab with a status
workflow. Discord DMs remain the channel for design discussion and tip coordination — but the
request itself, with all its info, lives in the panel.

## Locked decisions

1. **Tip timing:** request first, tip on approval. Submitting is free; owners approve and then
   ask for the $25 tip (status `awaiting_tip`). No wasted tips on declined ideas.
2. **Reference images:** links only (http/s URLs). No file uploads — the Railway disk is
   ephemeral, so uploads would need new persistent storage. v1 does not build that.
3. **Notification:** new requests post a best-effort Discord embed to the business server
   (doorbell) AND are stored (source of truth). A Discord failure never loses a request.
4. **Requester visibility:** submit-only. Confirmation message on submit ("we'll DM you on
   Discord"); no My Requests view in v1. Follow-up happens in DMs as today.
5. **Who reviews:** platform admins only (`requirePlatformAdmin`) — cards are built by the
   platform owners; tenant admins have no role here.
6. **Architecture:** clone the announcements/slot-lists pattern — `hunts_kv`-backed lib module
   + dependency-injected router + admin tab. Third feature on this shape; proven.

## Data model

One `hunts_kv` key `'card_requests'` holding an array (same persistence pattern as
`'announcements'` / `'slot_lists'`). Request object:

```js
{
  id: string,             // unique id (same scheme the announcements lib uses)
  createdAt: string,      // ISO timestamp at submit
  updatedAt: string,      // ISO timestamp of last admin edit
  status: string,         // 'new' | 'awaiting_tip' | 'in_progress' | 'done' | 'declined'
  // requester identity — snapshotted from the session at submit (no later enrichment needed)
  userId: string,         // Discord ID
  displayName: string,
  avatar: string|null,
  // request content (user-provided, immutable after submit)
  idea: string,           // required, ≤2000 chars
  cardName: string,       // optional, ≤80 chars — their name suggestion for the card
  refLinks: string[],     // ≤5 entries, each http(s) URL ≤300 chars (server drops invalid)
  rainbetUsername: string, // optional, ≤80 chars — saves a DM roundtrip at tip time
  // owner-side
  adminNotes: string,     // optional, ≤2000 chars — internal, admin-editable
}
```

**Status flow:** `new` → `awaiting_tip` (idea approved, tip requested via DM) →
`in_progress` (tip received, card being built) → `done` | `declined` (any state may jump to
`declined`). Statuses are a flat enum — no transition enforcement server-side; the dropdown is
the workflow.

## Backend

### `lib/cardRequests.js` (new)

Clone of the announcements lib structure: loads/persists the `'card_requests'` kv key,
exposes `listRequests()`, `createRequest(input, sessionUser)`, `updateRequest(id, patch)`,
`deleteRequest(id)`, `validateInput(body)`, and `openCountFor(userId)` (count of requests in
`new`/`awaiting_tip`/`in_progress`). Server-side sanitation in `validateInput`/create:

- `idea` required, trimmed, non-empty, ≤2000.
- `cardName`, `rainbetUsername` optional, trimmed, ≤80.
- `refLinks`: keep only entries matching `/^https?:\/\//i`, each ≤300, max 5 (silently drop
  the rest — mirrors the socials sanitizer).

Unit tests in `lib/cardRequests.test.js` (node:test, like sibling libs): validation caps,
link sanitation, open-count logic, status enum on update.

### `routes/cardRequests.routes.js` (new, DI router mounted from server.js)

```text
POST   /api/card-requests            requireAuth
GET    /api/admin/card-requests      requireAuth + requirePlatformAdmin
PUT    /api/admin/card-requests/:id  requireAuth + requirePlatformAdmin
DELETE /api/admin/card-requests/:id  requireAuth + requirePlatformAdmin
```

**POST** (submit):
- Guards, in order: auth (middleware) → per-IP throttle (5 per 10 min, same Map pattern as
  tickets) → per-user cap: reject with 429 if the user already has **2 open** requests
  (`new`/`awaiting_tip`/`in_progress`) — "You already have open requests; we'll DM you."
- Validate + sanitize via the lib; snapshot `{userId, displayName, avatar}` from `req.user`.
- Save first, then best-effort Discord embed (announcements pattern: failure logs + flips a
  `discord: 'posted'|'failed'|'skipped'` field in the response, never fails the request).
- Response: `{ ok: true, discord }` — the requester gets no request object back (no status view).

**PUT** (admin): accepts only `{ status, adminNotes }` — user content is immutable. `status`
must be one of the five enum values; stamps `updatedAt`. 404 on unknown id.

**GET** (admin): full list, newest-first.
**DELETE** (admin): remove by id; 404 on unknown id.

### Discord embed

Reuses the business tickets bot (`DISCORD_TICKETS_BOT_TOKEN`). Channel resolution:
`DISCORD_SHOP_REQUESTS_CHANNEL_ID` env if set, else fall back to
`DISCORD_TICKETS_CHANNEL_ID` — works day one with zero Railway config changes.

Embed: title `🎨 Custom Card Request`, description = idea (≤3900), fields: From
(displayName + Discord ID), Card name (if given), Rainbet (if given), References (links,
newline-joined, ≤1024). Same field caps/margins as `misc.routes.js` tickets.

### Env

- `DISCORD_SHOP_REQUESTS_CHANNEL_ID` — optional; documented in `.env.example`.

## Frontend

### Shop entry point

- `src/cosmetics/catalog.js` — update `card_custom` desc copy: no longer "via Discord DM";
  new copy points at the request button (still mentions $25 via RB tip).
- `src/pages/shop/CosmeticGrid.js` — the `onRequest` branch currently renders `null` for the
  action; render a **"Request yours →"** button instead. Logged in → opens the modal;
  logged out → sends to Discord OAuth with `returnTo=/shop` (same pattern as other Shop CTAs).
- `src/pages/shop/RequestCardModal.js` (new file — file discipline: new UI piece = new file).
  Fields: idea (textarea, required), card name (optional), reference links (up to 5 inputs,
  add-row style), Rainbet username (optional). Client mirrors server caps. Submit →
  `POST /api/card-requests` → success state: "Got it — we'll DM you on Discord to talk it
  through." Error states: 429 messages shown as-is; generic failure otherwise.
  Styling via `useTheme()` tokens only.

### Admin tab

- `src/admin/AdminShopRequests.js` (new): list newest-first. Each row/card shows requester
  (avatar, displayName, Discord ID — snapshot fields), createdAt, idea, cardName,
  clickable refLinks (target=_blank, rel=noopener), rainbetUsername, status dropdown
  (5 states, saves on change via PUT), adminNotes textarea with an explicit Save, and Delete
  (with confirm). Status is also the list's visual grouping cue (badge color per status).
- `src/admin/adminApi.js` — `getCardRequests()`, `updateCardRequest(id, patch)`,
  `deleteCardRequest(id)`.
- `src/admin/AdminLayout.js` — new tab: path `shop-requests`, label "Shop Requests",
  `platformOnly: true`.
- `src/App.js` — `shop-requests` route under BOTH admin mounts (`/admin` and `/:slug/admin`),
  like every other admin page.

## Error handling summary

- Discord down → request still saved; embed marked failed in logs; user unaffected.
- Postgres/kv write failure → 500 to the submitter with a retry message (same behavior as
  announcements writes).
- Oversized/invalid fields → 400 with a field-specific message.
- Spam → per-IP 429 + per-user open-request cap 429.

## Testing & verification

- Backend: `node --test lib/` covers the new lib; boot locally (dummy Discord creds, port
  trick) and exercise POST/GET/PUT/DELETE with PS-curl JSON.
- Frontend: `CI=true npm run build` must print "Compiled successfully"; verify on a Vercel
  branch preview (submit a request end-to-end against prod backend once deployed, check the
  admin tab, status changes, Discord embed).
- Deploy order: **backend first** (routes must exist before the Shop button ships).

## Out of scope (v1)

- Image uploads (needs persistent storage).
- My Requests / requester-facing status view.
- Automated tip verification against Rainbet.
- Auto-DM to the requester on status change.
