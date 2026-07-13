# Admin Tickets/Suggestions Management — Design

**Date:** 2026-07-13
**Status:** Approved (design)

## Problem

`POST /api/tickets` ([routes/misc.routes.js](../../../routes/misc.routes.js)) is fire-and-forget:
it posts a Discord embed and stores nothing. There is no admin visibility, no status, no history —
a Discord hiccup loses the ticket entirely (it returns 500). We want a clean owner-only admin panel
to triage bugs and feature suggestions, while keeping the Discord doorbell.

## Approach

Clone the shipped **Shop Requests / Card Requests** architecture (persist to `hunts_kv`, DI admin
router, admin tab, `PHASE_META` live-embed edit). Add persistence to the existing ticket endpoint
and an admin management surface. Tickets are **platform-level** — they post to communityhunts.gg's
own channels via the platform bot (`getPlatformBotToken()`), never `req.tenant`.

## Locked Decisions

1. **Statuses:** `new → in_progress → resolved → closed`. `new` on submit; `resolved` = fixed/shipped;
   `closed` = dismissed / won't-do. One vocabulary for bugs and suggestions.
2. **Admin surface:** ONE "Tickets" tab with a type filter (All / Bug / Feature Request / Other).
3. **Discord failure:** best-effort — persist first, then try Discord; a failure is logged but the
   submit still returns `{ ok:true, discord:'failed' }`. No more 500-on-Discord-failure.
4. **Live embed:** capture the posted message id; on status change PATCH the embed (phase emoji + color).
5. **Submitter identity:** capture `userId` / `displayName` / `avatar` when logged in; else `'Anonymous'`,
   `userId:null`. (Ticket submit is public — no auth required.)
6. **Retention:** cap 500 newest (mirrors card requests).
7. **Admin notes:** internal-only, v1. No user-facing reply.

## Data Model — `lib/tickets.js` (hunts_kv key `'tickets'`)

```js
{
  id,                 // 'tk_<base36ts>_<rand>'
  createdAt, updatedAt,
  status,             // 'new' | 'in_progress' | 'resolved' | 'closed'
  type,               // 'Bug' | 'Feature Request' | 'Other' (as submitted; free-string, capped)
  issue,              // the message (≤5000, immutable after submit)
  username,           // display string as submitted (≤120)
  userId,             // Discord id when logged in, else null
  displayName,        // when logged in, else null
  avatar,             // when logged in, else null
  discordChannel,     // 'tickets' | 'suggestions' (which channel it went to)
  discordMessageId,   // set post-hoc for PATCH-on-status (undefined if post failed/skipped)
  discordChannelId,
  adminNotes,         // internal, admin-editable
}
```

Functions mirror `lib/cardRequests.js` exactly (Postgres `hunts_kv` + JSON file fallback):
`initTickets({pgPool})`, `persist()`, `listTickets()`, `validateUpdate(patch)`,
`createTicket(body, sessionUser|null)`, `updateTicket(id, patch)`,
`setDiscordMessage(id, {messageId, channelId})`, `deleteTicket(id)`, `STATUSES`.

- `createTicket` takes the ticket fields + an optional session user (the endpoint is public). It
  unshifts newest-first and truncates to 500.
- `validateUpdate` accepts `status` (must be in `STATUSES`) and/or `adminNotes` (string ≤2000).
- File fallback path: `tickets.json` (gitignored like `card_requests.json`).

## Backend Routing

### `POST /api/tickets` — modified in `routes/misc.routes.js` (stays public + rate-limited)

New dependency: `tickets` injected via deps. Flow becomes:
1. Validate length caps + per-IP throttle (unchanged).
2. Resolve type → channel (`Feature Request` → suggestions, else tickets) (unchanged).
3. **Persist first:** `tickets.createTicket({ type, issue, username, discordChannel }, req.user || null)`.
4. **Best-effort Discord:** if `getPlatformBotToken()` + channel id present, POST the embed; on success
   capture `msg.id` → `tickets.setDiscordMessage(...)`. On any failure, log and continue.
5. Always return `{ ok:true, id, discord:'posted'|'failed'|'skipped' }` (200). **Never 500 on Discord.**

The embed keeps the current type icon/color logic, adds a phase indicator consistent with `PHASE_META`.

### New `routes/adminTickets.routes.js` (DI router, `requirePlatformAdmin`)

- `GET    /api/admin/tickets`      → `{ tickets: listTickets() }`
- `PUT    /api/admin/tickets/:id`  → `validateUpdate` then `updateTicket`; best-effort PATCH the
  Discord embed (rebuild from record, new phase emoji + color) — fire after responding, skip if no
  stored message id. Mirrors `cardRequests.routes.js` PUT.
- `DELETE /api/admin/tickets/:id`  → `deleteTicket`; 404 if missing.

`PHASE_META` (title emoji + embed color, mirrors frontend `STATUS_META`):
```
new         🆕  #a78bfa
in_progress 🔨  #22d3ee
resolved    ✅  #4ade80
closed      🚫  #ff6b6b
```
The type icon (🎫 bug/other, 💡 feature) stays in the embed title alongside the phase emoji.

### `server.js` wiring

- `const tickets = require('./lib/tickets'); tickets.initTickets({ pgPool }).catch(...)`.
- Inject `tickets` into the existing `misc.routes` mount deps.
- Mount `adminTickets.routes` with `{ requireAuth, requirePlatformAdmin, tickets, getPlatformBotToken }`.

## Frontend

- **`src/admin/AdminTickets.js`** — clone `AdminShopRequests.js`. `STATUS_META` for the 4 statuses;
  type-filter chips (All / Bug / Feature Request / Other) filtering the list client-side; per-card
  status `<select>`, adminNotes textarea + Save, Delete; submitter identity (avatar + name + id, or
  "Anonymous"); read-only `type` badge + `issue` body. `useTheme()`, gated `user?.isPlatformAdmin`.
- **`src/admin/adminApi.js`** — `getTickets` / `updateTicket` / `deleteTicket`
  (`/api/admin/tickets(/:id)`).
- **`src/admin/AdminLayout.js`** — add `{ to: `${base}/tickets`, label: 'Tickets', platformOnly: true }`.
- **`src/App.js`** — `import AdminTickets`; add `<Route path="tickets" element={<AdminTickets />} />`
  under BOTH admin mounts (`/admin` and `/:slug/admin`).
- **`src/pages/hub/TicketModal.js`** — payload unchanged. Only soften the error branch: submit now
  succeeds even when Discord is down, so a caught error is a real network/server failure — keep the
  alert but it will rarely fire.

## Testing

**Backend (`node:test`, run `node --test lib/*.test.js routes/*.test.js`):**
- Extend `routes/misc.routes.test.js`: ticket persists to the injected store; **best-effort** — a
  Discord 401 (stubbed) still returns 200 with the ticket stored; message id captured on success.
- New `routes/adminTickets.routes.test.js`: list returns stored tickets; PUT updates status +
  fires an embed PATCH when a message id exists; DELETE removes; non-admin → 403 (via requireAuth/
  requirePlatformAdmin stubs).
- New `lib/tickets.test.js`: create → list newest-first; 500-cap; `validateUpdate` rejects bad
  status; `setDiscordMessage` attaches ids without touching status/updatedAt.

**Frontend:** no test suite; `CI=true npm run build` must print "Compiled successfully".

## Ship Order

Backend PR first (Railway deploys, API live) → frontend PR (Vercel). Separate repos, no Claude
attribution. No new env vars — reuses `DISCORD_TICKETS_CHANNEL_ID` / `DISCORD_SUGGESTIONS_CHANNEL_ID`.

## Out of Scope

- Pre-feature tickets (never stored) — admin list starts empty, fills going forward. Expected.
- User-facing replies / ticket threads. Internal notes only.
- Per-tenant tickets — tickets remain platform-level (communityhunts.gg's own Discord + admin).
