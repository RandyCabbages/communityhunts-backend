# Shop Request DM Replies — Read What Requesters Send Back

**Date:** 2026-07-25
**Repos:** `communityhunts-backend` (ships first), `communityhunts-frontend` (ships after)
**Status:** Approved design — ready to plan
**Builds on:** [2026-07-14-shop-request-dm-design.md](2026-07-14-shop-request-dm-design.md)

## Problem

The Shop Request DM feature (2026-07-14) is send-only. An admin picks a template, the
community bot DMs the requester, and the outcome lands in `dmLog`. When the requester
**replies** — especially to the "Need more info" template, whose entire purpose is to ask a
question — the reply goes nowhere anyone can read.

The backend talks to Discord over plain REST `fetch`. There is no gateway connection, no
`MESSAGE_CREATE` handler, no `discord.js` dependency. So the reply lands in the bot account's
DM inbox and nothing observes it. Nobody can read it by hand either: a bot token can't sign
into the Discord client, so there is no inbox to open. The reply is lost.

**Correction to the prior spec.** The 2026-07-14 design stated that receiving DM content
requires a privileged intent. That is wrong. Discord exempts DMs-with-the-app from the
`MESSAGE_CONTENT` privileged-intent gate, and reading a DM channel's history over REST needs
no intent at all — intents govern gateway events, and we use none. Receiving replies was ruled
out on a false constraint.

## Decision summary (from brainstorming)

- **Poll Discord REST on a background timer.** No gateway, no persistent WebSocket, no new
  dependency. Chosen over a gateway listener because a commission queue does not need
  real-time chat, and a long-lived socket adds reconnect/resume handling to a process that
  restarts on every deploy.
- **Notify by pinging the existing shop-requests channel.** Replies are announced where the
  doorbell embed already posts, using the same bot. Chosen over panel-only display: a reply you
  have to remember to go look for is barely better than no reply at all.
- **Poll open statuses only.** `new` / `awaiting_tip` / `in_progress` with a DM channel. A
  `done` or `declined` request stops being polled — the conversation is over.
- **One conversation, not two lists.** Replies append to the same `dmLog` with a direction
  flag, so the admin panel's History view becomes a real interleaved thread.
- **No new env var, no new bot.** Reuses `getPlatformBotToken()` and the shop-requests
  `channelId` already injected into the card-requests router.

## Architecture

Two deployables. Backend ships and is verified live on Railway **before** the frontend merges —
mandatory here, not just convention: the frontend reads `dir` and `lastReplyAt`, fields that do
not exist until the backend is live.

### Data model — `lib/cardRequests.js`

Three new fields on a request object. All additive; rows without them stay valid.

| Field | Meaning |
| --- | --- |
| `dmChannelId` | The DM channel with the requester. Stored once, on first send. |
| `dmWatermark` | Newest Discord message id already processed. Drives the `after=` cursor. |
| `lastReplyAt` | ISO timestamp of the newest inbound message. |

`MAX_DM_LOG` goes **10 → 40**, since the log now carries both directions of a conversation
rather than just outbound attempts.

`dmLog` entries gain `dir: 'out' | 'in'`. A legacy entry with no `dir` is treated as outbound.

**Two new helpers**, both pure bookkeeping that never touch `status` / `adminNotes` /
`updatedAt` (mirroring the existing `setDiscordMessage` contract):

```text
setDmChannel(id, { channelId, watermark })  → updated request | null
recordReply(id, { messageId, content, at }) → updated request | null
```

`recordReply` appends `{ at, dir:'in', message, messageId }`, stamps `lastReplyAt`, persists,
and **dedupes on `messageId`** — re-polling a window must never double-append the same Discord
message.

`recordDm` is extended to stamp `dir:'out'` and store the sent `messageId`.

`OPEN_STATUSES` must be added to `module.exports` — it exists in the module today but is not
exported, and the poller needs it to decide what to poll.

**The unread signal is derived, never stored.** `lastReplyAt > lastDmAt` means the requester
answered and is waiting on you. No mark-as-read state, no extra write path, nothing to get out
of sync.

### The poller — `lib/dmPoller.js` (new)

```text
startDmPolling({ cardRequests, getPlatformBotToken, channelId, intervalMs = 120000 })
```

Lives in its own file rather than folded into `lib/integrations.js` (a Twitch/Discord-import
module — an unrelated concern would make it a grab-bag) or `setInterval` at routes module scope
(untestable, and silently double-registers if the router is ever mounted twice).

The interval is `.unref()`'d so it never holds a test run or a maintenance script open. A
`running` flag prevents ticks stacking behind a slow Discord call.

Each tick, for every request where `OPEN_STATUSES.has(status)` and `dmLog` is non-empty:

1. **No `dmChannelId`** (a legacy row DM'd before this shipped) → open it via
   `POST /users/@me/channels` with `{ recipient_id: r.userId }`, which is idempotent and
   returns the existing channel. Store it.
2. `GET /channels/{dmChannelId}/messages?limit=50`, adding `&after={dmWatermark}` when set.
3. Keep only messages where `author.id === r.userId`. This single filter drops the bot's own
   sends without needing a bot-user-id lookup.
4. **Bootstrap case — no watermark yet:** additionally keep only messages whose `timestamp`
   is newer than `r.lastDmAt`. A legacy request then surfaces the reply actually being waited
   on, instead of replaying months of history into the notification channel. (`lastDmAt` is
   always present on a row with a non-empty `dmLog` — `recordDm` writes both — but if it is
   somehow missing, ingest nothing and just set the watermark, so a corrupt row can never
   flood the channel.)
5. Sort ascending by message id and `recordReply` each one.
6. **Advance `dmWatermark` to the newest id seen, even when every message was filtered out.**
   Otherwise the same window is refetched forever.

**Error handling:** on any non-2xx, log it, skip that request for this tick, do **not** advance
its watermark, and do **not** break the loop. One failing request never stops the others, and a
transient failure is retried on the next tick with the cursor intact.

**Rate limits** are a non-issue: a handful of open requests polled every two minutes is far
under Discord's global 50 req/s.

### Notification

After ingesting at least one reply for a request, post **one** embed to the shop-requests
`channelId` — one per request per tick, not one per message, so a requester sending three
messages in a row does not produce three pings.

Embed: title `💬 Reply from {displayName}`, description = the reply text (truncated to the
existing 3900-char embed margin), fields for card name and request id.

The poller builds its own small embed rather than importing `buildRequestEmbed` from
`routes/cardRequests.routes.js` — that would be a routes→lib cycle, and it is a different
embed anyway.

### Send path — `routes/cardRequests.routes.js`

Two changes inside the existing `POST /api/admin/card-requests/:id/dm` handler:

- Parse the send response body for its message id (currently discarded).
- Call `setDmChannel(r.id, { channelId: dm.id, watermark: msg.id })`.

**The watermark is set only when currently unset.** If a later send advanced it, a reply that
arrived between the last poll and that send would be skipped. Set-once, advanced-only-by-the-
poller closes that hole. The `author.id === r.userId` filter already prevents our own sends
from being ingested, so leaving the watermark behind our newest send is safe.

The `dm.id` value is currently opened and discarded at every send — persisting it is the single
change that makes the whole feature possible.

### Startup — `server.js`

One line after the card-requests init: `startDmPolling({ cardRequests, getPlatformBotToken,
channelId })`. `server.js` is the composition root; wiring a background poller is exactly its
job.

Shop requests are platform-level (`requirePlatformAdmin`, `getPlatformBotToken`), not
per-tenant, so a single poller covers everything. A deploy restarts it; the watermark is
persisted, so nothing is lost or re-ingested.

### Frontend — `communityhunts-frontend`

- **`src/admin/ShopRequestDm.js`** — `DmHistory` renders `dir`. Outbound keeps the current
  green/red left border keyed on `ok`; inbound gets an accent border and a `↩ {name} replied`
  label. A missing `dir` renders as outbound.
- The header line gains a `💬 Awaiting your reply` badge when `lastReplyAt > lastDmAt`.
- Tokens come from the passed `C` (the existing `C.accent || C.gold` fallback pattern in this
  file is kept).

**No frontend polling.** Deliberate: the Discord ping is the notification path, and the panel
is where you go to read and respond. A second poller watching the first one is the wrong shape.
A reply arriving while the panel is already open shows on the next page load.

## Data flow

Admin sends "Need more info" → backend opens the DM channel, posts, stores `dmChannelId` +
`dmWatermark` + a `dir:'out'` log entry → requester replies in Discord → within ~2 min the
poller reads the DM channel, filters to the requester's own messages, appends a `dir:'in'`
entry and stamps `lastReplyAt` → the bot posts a `💬 Reply from …` embed to the shop-requests
channel → the admin opens the panel, sees the `💬 Awaiting your reply` badge and the reply
inline in the thread, and answers with another templated DM.

## Error handling

| Case | Result |
| --- | --- |
| No bot token configured | Poller tick is a no-op; logged once per tick, nothing written |
| Request has no `dmChannelId` and channel-open fails | Skipped this tick, retried next |
| `GET messages` non-2xx | Logged, request skipped, watermark **not** advanced |
| Notification post fails | Replies are still recorded; only the ping is lost (logged) |
| Same message seen twice | `recordReply` dedupes on `messageId`, no double-append |
| Requester blocks the bot / leaves | Channel read 403s → skipped; existing history intact |

In every case `status` / `adminNotes` / `updatedAt` are untouched, matching the existing
bookkeeping-helper contract.

## Testing

**Backend** (`node --test lib/*.test.js` — note **not** `node --test lib/`, which is broken on
Node 24):

- `lib/cardRequests.test.js` — `recordReply` appends `dir:'in'`, dedupes on `messageId`, stamps
  `lastReplyAt`, and leaves `status`/`adminNotes`/`updatedAt` untouched; `dmLog` caps at 40;
  `recordDm` entries carry `dir:'out'` and the sent `messageId`; `setDmChannel` is a no-op on
  an unknown id.
- `lib/dmPoller.test.js` (new), with a stubbed `fetch` — filters out the bot's own messages;
  advances the watermark even when the filtered result is empty; posts exactly one channel
  notification per request per tick regardless of reply count; does **not** advance the
  watermark on a non-2xx; skips `done`/`declined` requests; bootstrap ingests only messages
  newer than `lastDmAt`.

**Frontend:** `CI=true npm run build` must print "Compiled successfully" (Vercel turns warnings
into errors). No component tests — `@testing-library/react` is not installed. Verified on a
branch preview URL.

**End-to-end:** an owner is in the CommunityHunts Discord, so a real self-DM and self-reply
confirms the full loop — send, reply, ping in the channel, thread in the panel.

## Out of scope (YAGNI)

- Gateway/WebSocket listener for real-time replies.
- Frontend polling of the admin panel.
- Mark-as-read state (the `lastReplyAt > lastDmAt` comparison is sufficient).
- Replying to a DM from Discord itself (replies are answered from the admin panel).
- Attachments/embeds in inbound messages — text content only; an image reply records its text
  (often empty) and the notification links nothing. Revisit if reference images arrive this way.
- Per-tenant DM polling (shop requests are platform-level).

## Rollout

1. Backend: implement, `node --test lib/*.test.js`, branch + PR, merge, confirm live on
   Railway. Time the deploy **outside a live hunt** — a restart clears OverDrop.
2. Verify end-to-end with a real self-DM reply against production.
3. Frontend: implement on a branch, `CI=true npm run build`, verify on the Vercel preview, then
   PR and merge to `main`.
