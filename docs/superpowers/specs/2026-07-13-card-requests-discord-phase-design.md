# Discord Posting Consolidation — Tickets Fix + Shop Requests Community-Bot & Phase Embed — Design

**Date:** 2026-07-13
**Status:** Approved
**Repo:** communityhunts-backend (backend-only — no frontend change)
**Follows:** `2026-07-13-card-requests-design.md` (the shipped Shop Requests feature)

## Problem

There is exactly **one** real Discord bot, `DISCORD_BOT_TOKEN`, living in the single
communityhunts.gg server (which serves as both the community and business Discord). Announcements
post through it successfully. But two other features were wired to a **`DISCORD_TICKETS_BOT_TOKEN`
"business bot" that does not exist** — its Railway value is a stale/invalid token Discord rejects
(401):

1. **`/api/tickets`** (bug / suggestion / community-request form) — posts via
   `DISCORD_TICKETS_BOT_TOKEN`. Worse than best-effort: on a Discord non-2xx it returns **500 to
   the user**, so the ticket form is actively broken for submitters.
2. **`/api/card-requests`** (Shop Requests doorbell) — posts via `DISCORD_TICKETS_BOT_TOKEN` too;
   best-effort, so it fails silently (the 401 we saw). Also, the notification is static — it never
   reflects where the request is in the workflow.

## Goal

Consolidate **all** Discord posting onto the single real bot (`DISCORD_BOT_TOKEN`) and retire
`DISCORD_TICKETS_BOT_TOKEN` — one token var = one source of truth (a duplicated token is what
rotted and caused this). Then, for Shop Requests, make the notification track the request's phase.

Both parts are backend-only.

## Guiding decision

- **One bot token, `DISCORD_BOT_TOKEN`, everywhere.** Retire `DISCORD_TICKETS_BOT_TOKEN`.
- Channel routing is unchanged: tickets → `DISCORD_TICKETS_CHANNEL_ID`, suggestions →
  `DISCORD_SUGGESTIONS_CHANNEL_ID`, shop requests → `DISCORD_SHOP_REQUESTS_CHANNEL_ID`.
- **Op prerequisite (user-side):** the one bot must be able to post in all three channels
  (View + Send + Embed Links); grant it on any that are private. Already done for shop-requests.

## Railway env

- **No new vars, nothing to set.** `DISCORD_BOT_TOKEN` and the three channel IDs already exist.
- `DISCORD_TICKETS_BOT_TOKEN` becomes unused — safe to delete whenever (no code reads it after this).

---

## Part A — Tickets fix (`/api/tickets`)

### `routes/misc.routes.js`

- Swap the token source: `const BOT_TOKEN = (process.env.DISCORD_BOT_TOKEN || '').trim();`
  (replacing the `DISCORD_TICKETS_BOT_TOKEN` read on line 17). Rename the local
  `TICKETS_BOT_TOKEN` → `BOT_TOKEN` and update its two uses (the `!BOT_TOKEN` guard and the
  `Authorization: 'Bot ' + BOT_TOKEN` header).
- Fix the now-wrong comment (lines 13–16): it currently says the ticket bot is a *business* bot
  "distinct from `DISCORD_BOT_TOKEN`." Replace with: one shared community bot posts tickets +
  suggestions; channels split by type.
- Channel routing, rate limiting, embed formatting, and the type→channel split are unchanged.

No behavior change for the user beyond "it now actually posts." Tickets remain one-shot (no phase
tracking — that's Shop-Requests-only).

---

## Part B — Shop Requests: community bot + phase-based live embed

### B1. Switch to the community bot

Mirror the announcements mechanism:

- Token: `(req.tenant && req.tenant.discordBotToken) || envBotToken`, where
  `envBotToken = process.env.DISCORD_BOT_TOKEN`. Resolved per-request inside the handlers.
- Channel: `DISCORD_SHOP_REQUESTS_CHANNEL_ID` (already set; bot has access). The old fallback to
  `DISCORD_TICKETS_CHANNEL_ID` is **removed** — unset channel → posting skipped
  (`discord: 'skipped'`), request still saves.

### B2. Capture the message id on post

Two new optional fields on the request object, set only after a successful post:

- `discordMessageId: string` — id Discord returns for the posted message.
- `discordChannelId: string` — the channel it was posted to (stored so a later edit targets the
  right channel even if the env var changes).

Both persist with the request (existing `persist()`). Pre-existing requests simply lack them.

### B3. Edit the embed on status change

Phase → styling map (colors mirror the frontend admin `STATUS_META`, so Discord and the panel
match):

| Status         | Emoji | Color (hex) |
|----------------|-------|-------------|
| `new`          | 🆕    | `#a78bfa`   |
| `awaiting_tip` | 💰    | `#fbbf24`   |
| `in_progress`  | 🔨    | `#22d3ee`   |
| `done`         | ✅    | `#4ade80`   |
| `declined`     | ❌    | `#ff6b6b`   |

Title becomes `{emoji} Custom Card Request`. On `PUT /api/admin/card-requests/:id`, after
`updateRequest` succeeds and if the request has a stored `discordMessageId` and a resolvable bot
token, best-effort `PATCH
https://discord.com/api/v10/channels/{discordChannelId}/messages/{discordMessageId}` with
`{ embeds: [buildRequestEmbed(updated)] }`. Idempotent — rebuilds the full embed from current
state each time. No message id (post failed/skipped or a pre-switch request) → skip silently.

### Backend changes (Part B)

- **`lib/cardRequests.js`:** add `setDiscordMessage(id, { messageId, channelId })` — sets the two
  fields, `persist()`s, returns the request or null; does **not** stamp `updatedAt` (bookkeeping,
  not a status change). `updateRequest` is unchanged (only touches `status`/`adminNotes`, so the
  Discord fields survive status edits).
- **`routes/cardRequests.routes.js`:**
  - DI: replace `ticketsBotToken` with `envBotToken` (`process.env.DISCORD_BOT_TOKEN`); `channelId`
    keeps only the shop-requests var (no tickets fallback). Resolve the per-request token as above.
  - `PHASE_META`: module-level `status → { emoji, color }` per the table.
  - `buildRequestEmbed(r)`: derive title emoji + color from `PHASE_META[r.status]` (unknown status
    → `new` styling). Body unchanged, rebuilt from `r`.
  - POST: on a successful post, read the created message's `id` from the Discord response and call
    `setDiscordMessage(r.id, { messageId, channelId })`.
  - PUT: best-effort embed PATCH as described in B3.

### `server.js` mount (Part B)

```js
app.use(require('./routes/cardRequests.routes')({
  requireAuth, requirePlatformAdmin, cardRequests,
  envBotToken: (process.env.DISCORD_BOT_TOKEN || '').trim(),
  channelId: (process.env.DISCORD_SHOP_REQUESTS_CHANNEL_ID || '').trim(),
}));
```

(The `ticketsBotToken` plumbing + its comment are removed.)

---

## Error handling (both parts)

- **Tickets:** still returns 500 on a genuine Discord failure (its existing contract — the
  submitter should know it didn't send). With a valid token that path stops triggering.
- **Shop requests:** best-effort throughout — the request save and the admin status update are the
  source of truth; any Discord post/edit failure only logs, never fails the API call.

## `.env.example`

- Mark `DISCORD_TICKETS_BOT_TOKEN` deprecated/removed; note tickets **and** shop requests now post
  via the shared `DISCORD_BOT_TOKEN` bot. `DISCORD_SHOP_REQUESTS_CHANNEL_ID` served by that same bot.

## Testing & verification

- **Unit (`lib/cardRequests.test.js`):** `setDiscordMessage` stores both ids; a subsequent
  `updateRequest({status})` preserves them (status/notes edit must not drop the Discord fields).
- **Manual E2E after deploy:**
  1. Submit a **ticket** (bug/suggestion) → posts to the correct channel, no 500.
  2. Submit a **card request** → embed posts titled `🆕 Custom Card Request`, violet bar.
  3. Move the request through statuses in Admin → Shop Requests → the same message's title emoji +
     color update live (💰 amber → 🔨 cyan → ✅ green, or ❌ red).
  4. Both the request row/panel and the ticket response behave regardless of Discord outcome.
- Backend: `node --check` the touched files; `node --test lib/*.test.js` green (Node 24 needs the
  glob form).

## Out of scope

- Per-tenant tickets / shop-requests channels (env-level channel, same limitation announcements has).
- Editing messages for card requests created before this ships (no stored message id).
- Threaded replies / reactions / requester DMs on status change.
- Phase tracking for tickets (one-shot by nature).
