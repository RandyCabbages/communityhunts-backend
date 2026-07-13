# Shop Requests Discord — Community-Bot Posting + Phase-Based Live Embed — Design

**Date:** 2026-07-13
**Status:** Approved
**Repo:** communityhunts-backend (backend-only — no frontend change)
**Follows:** `2026-07-13-card-requests-design.md` (the shipped Shop Requests feature)

## Problem

Two issues with the shipped Shop Requests Discord doorbell:

1. **Wrong bot.** It posts via `DISCORD_TICKETS_BOT_TOKEN` (a "business bot"). That bot does not
   actually exist — the token in Railway is a stale/invalid value, so Discord rejects it (401).
   There is exactly **one** real Discord bot (`DISCORD_BOT_TOKEN`), living in the single
   communityhunts.gg server that serves as both the community and business Discord. Announcements
   already post through this bot successfully. (The trim hotfix `433d7a3` treated a symptom; the
   token is invalid regardless of whitespace.)
2. **Static notification.** The embed is posted once and never reflects where the request is in
   the workflow. Owners want the message to update as the phase changes.

## Goal

- Post Shop Requests through the one real community bot, mirroring the announcements mechanism.
- When an admin changes a request's status, the bot **edits its own message** so a phase emoji and
  the embed color track the current phase.

Both are backend-only: the status change already flows through the existing
`PUT /api/admin/card-requests/:id`, so the edit hangs off that handler. No frontend change.

## Locked decisions

1. **Bot:** `(req.tenant?.discordBotToken) || process.env.DISCORD_BOT_TOKEN` — resolved per-request,
   identical to `routes/announcements.routes.js`.
2. **Channel:** `DISCORD_SHOP_REQUESTS_CHANNEL_ID` (already set in Railway; a channel in the one
   server; the community bot already has access). The old fallback to `DISCORD_TICKETS_CHANNEL_ID`
   is **removed** — unset channel → posting is skipped (`discord: 'skipped'`), request still saves.
3. **Phase display:** the bot PATCHes its own message; a leading emoji in the title and the embed
   color change per phase. Title is `{emoji} Custom Card Request`.
4. **Phase set** (colors mirror the frontend admin `STATUS_META` so Discord and the panel match):

   | Status         | Emoji | Color (hex) |
   |----------------|-------|-------------|
   | `new`          | 🆕    | `#a78bfa`   |
   | `awaiting_tip` | 💰    | `#fbbf24`   |
   | `in_progress`  | 🔨    | `#22d3ee`   |
   | `done`         | ✅    | `#4ade80`   |
   | `declined`     | ❌    | `#ff6b6b`   |

5. **Best-effort throughout:** the request save and the admin status update are the source of
   truth. Any Discord failure only logs — it never fails the API call. No stored message id
   (post failed/skipped, or a pre-switch request) → the edit is silently skipped.

## Data model change

Two new optional fields on the request object (set only after a successful post):

- `discordMessageId: string` — the id Discord returns for the posted message.
- `discordChannelId: string` — the channel it was posted to (stored so a later edit targets the
  right channel even if the env var changes).

Both persist with the request (existing `persist()` path). Pre-existing requests simply lack them.

## Backend changes

### `lib/cardRequests.js`

- Add `setDiscordMessage(id, { messageId, channelId })` → finds the request, sets
  `discordMessageId` / `discordChannelId`, stamps nothing else (not `updatedAt` — this is
  bookkeeping, not a status change), `persist()`s, returns the request or null.
- `updateRequest` is unchanged — it already only touches `status` / `adminNotes`, so the Discord
  fields survive status edits untouched.

### `routes/cardRequests.routes.js`

- **DI change:** replace `ticketsBotToken` with `envBotToken` (from `process.env.DISCORD_BOT_TOKEN`);
  `channelId` stays but drops the tickets fallback. Resolve the token per-request inside each
  handler: `const botToken = (req.tenant && req.tenant.discordBotToken) || envBotToken;`
- **`PHASE_META`:** module-level map of `status → { emoji, color }` per the table above.
- **`buildRequestEmbed(r)`:** derive title emoji + color from `PHASE_META[r.status]` (default to
  `new`'s styling for an unknown status). Body (idea / card name / rainbet / references / From)
  unchanged — rebuilt from `r` each call, so an edit reflects current data.
- **POST (submit):** after `createRequest`, on a successful post read the created message's `id`
  from the Discord response JSON and call `cardRequests.setDiscordMessage(r.id, { messageId, channelId })`.
  Store both. Post/parse failure → log, leave ids unset, `discord: 'failed'`.
- **PUT (status change):** after `updateRequest` succeeds, if the request has `discordMessageId`
  **and** a resolvable `botToken`, best-effort `PATCH
  https://discord.com/api/v10/channels/{discordChannelId}/messages/{discordMessageId}` with
  `{ embeds: [buildRequestEmbed(updated)] }`. Idempotent — always rebuilds the full embed from
  current state. Non-2xx or no message id → log/skip, never fail the PUT.

### `server.js` mount

```js
app.use(require('./routes/cardRequests.routes')({
  requireAuth, requirePlatformAdmin, cardRequests,
  envBotToken: (process.env.DISCORD_BOT_TOKEN || '').trim(),
  channelId: (process.env.DISCORD_SHOP_REQUESTS_CHANNEL_ID || '').trim(),
}));
```

(Trim retained as harmless belt-and-suspenders. The `ticketsBotToken` plumbing and its comment are removed.)

### `.env.example`

- Note that `DISCORD_SHOP_REQUESTS_CHANNEL_ID` is now served by the community `DISCORD_BOT_TOKEN`
  bot (same as announcements), not the tickets bot.

## Testing & verification

- **Unit (`lib/cardRequests.test.js`):** add a test that `setDiscordMessage` stores both ids and
  that a subsequent `updateRequest({status})` preserves them (status/notes edit must not drop the
  Discord fields).
- **Manual E2E (after deploy):**
  1. Submit a request → embed posts to the shop-requests channel titled `🆕 Custom Card Request`,
     violet bar.
  2. In Admin → Shop Requests, move it through statuses → the same message's title emoji + color
     update live (💰 amber → 🔨 cyan → ✅ green, or ❌ red).
  3. Confirm the request row + panel still work regardless of Discord outcome.
- Backend: `node --check` the touched files; `node --test lib/*.test.js` green (Node 24 needs the
  glob form).

## Out of scope

- `/api/tickets` (bug/suggestion form) uses the same dead `DISCORD_TICKETS_BOT_TOKEN` and is
  likely also broken — fix tracked separately, not here.
- Per-tenant shop-requests channels (env-level channel, same limitation announcements has).
- Editing messages for requests created before this ships (they have no stored message id).
- Threaded replies / reactions / DMs to the requester on status change.
