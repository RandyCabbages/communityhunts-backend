# Shop Request → DM the Requester (manual, templated)

**Date:** 2026-07-14
**Repos:** `communityhunts-backend` (ships first), `communityhunts-frontend` (ships after)
**Status:** Approved design — ready to plan

## Problem

When a custom-card commission ("Shop Request") is worked, admins want to notify the
requester over Discord — e.g. "your card is assigned, we're now awaiting payment to
proceed." Today the only Discord traffic for a request goes to a **channel** (the
doorbell embed in `routes/cardRequests.routes.js`); nothing reaches the requester
directly. The goal is to start automating these canned responses.

## Decision summary (from brainstorming)

- **Manual send, not auto-fire.** A per-request "DM requester" button — admin chooses
  when to send. No coupling to status transitions (avoids DMs firing on incidental edits;
  avoids accidental spam). This was chosen over full per-status automation.
- **Editable prefill.** Admin picks a canned template → it loads **prefilled and
  editable** in a text box → tweaks price/details → sends. Price is never hardcoded
  (commissions are "starting at $25"; the $25 RB tip is a default in the template text).
- **Four seed templates:** Awaiting payment · Payment received / starting · Card ready /
  delivered · Need more info.
- **Reuse the community bot.** DMs are sent with `getPlatformBotToken()` (the same
  platform/community bot that posts the doorbell embed). **No new bot, no new env var.**
- **Best-effort.** A DM failure never blocks anything; the outcome is surfaced inline in
  the admin panel so an admin can follow up manually.

## Hard constraint (Discord platform rule)

A bot can only DM a user who **shares a server with the bot** AND has not disabled
"Allow direct messages from server members." So:

- Requester is in the CommunityHunts Discord → DM lands (true for most community members).
- Requester left the server / blocks member DMs → Discord returns `403 Cannot send
  messages to this user`, and the DM silently fails.

Therefore the feature is best-effort and the panel shows a `✓ sent` / `✗ failed` marker.
Sending DMs needs **no privileged intent** (bots may always send DMs to eligible users);
only receiving DM content would, and we don't receive.

## Architecture

Two deployables. Backend ships and is verified live on Railway **before** the frontend
merges (the frontend calls the new endpoint). Standard backend-first order for this repo.

### Backend — `communityhunts-backend`

**New route** in `routes/cardRequests.routes.js`:

```text
POST /api/admin/card-requests/:id/dm      (requireAuth, requirePlatformAdmin)
  body: { message: string }               // final edited text, composed on the frontend
  → 200 { ok: boolean, error?: string, request: <updated request> }
  → 400 invalid/empty/too-long message
  → 404 request not found
```

Handler flow:

1. Look up the request by `:id` (404 if missing).
2. Validate `message`: must be a non-empty string, `≤ 2000` chars (trim first).
3. Resolve the token via `getPlatformBotToken()` (already injected into this router's
   deps). If empty → `200 { ok:false, error:'Discord bot not configured' }`.
4. **Open the DM channel:** `POST https://discord.com/api/v10/users/@me/channels`
   with `Authorization: Bot <token>`, body `{ recipient_id: r.userId }`. Parse `{ id }`.
5. **Send the message:** `POST https://discord.com/api/v10/channels/<dmChannelId>/messages`
   with body `{ content: message }`. Sent as **plain text** (a DM reads more personal than
   an embed). The frontend template already appends a `— CommunityHunts.gg` sign-off.
6. On any Discord non-2xx (esp. `403`): treat as a delivery failure, not a server error →
   `200 { ok:false, error:'Couldn't DM — they may have DMs disabled or left the server' }`.
7. Record the outcome via `recordDm(...)` (below) and return the updated request so the
   frontend can refresh the row.

**When `recordDm` is called:** only for attempts that reach Discord — the success path
(step 5) and a Discord delivery failure (step 6), i.e. any outcome with a real `ok`
true/false from Discord. The pre-flight exits do **not** write to `dmLog`: `400`
(invalid message) and `404` (not found) return plainly, and the "no bot configured" case
returns `{ ok:false, ... }` **without** recording (it's an env misconfiguration affecting
every request, not this one's delivery history).

**New helper** in `lib/cardRequests.js`:

```text
recordDm(id, { template, ok, error }) → updated request | null
```

Appends `{ at: ISO, template, ok, error? }` to a `dmLog` array on the request (create it
if absent; cap to the **last 10** entries), sets `r.lastDmAt = at`, `persist()`, returns
the request. Purely additive bookkeeping — does **not** touch `status` / `adminNotes` /
`updatedAt` (mirrors the existing `setDiscordMessage` helper). Export it.

**Fields added to a request object** (additive; old rows without them are valid):

- `dmLog?: Array<{ at: string, template: string, ok: boolean, error?: string }>` (≤10)
- `lastDmAt?: string`

**No `server.js` change.** The route lives in the already-mounted `cardRequests.routes`
router, which already receives `getPlatformBotToken` and `cardRequests` in its deps.

### Frontend — `communityhunts-frontend`

Respects File Discipline (new UI → new file; `AdminShopRequests.js` stays thin).

- **`src/admin/shopRequestDmTemplates.js`** (new) — the four templates as `(r) => string`
  builders. Each prefills from the request: `displayName`, `cardName`, assignee label
  (via `SHOP_ASSIGNEES` in `src/auth/roles.js`), `rainbetUsername`, and a default
  `$25 RB tip`. Exported as an ordered list `[{ key, label, build }]` so the `<select>`
  and the prefill share one source.
- **`src/admin/ShopRequestDm.js`** (new) — the control component: a template `<select>`
  → on pick, prefill an editable `<textarea>` → **Send DM** button (disabled while
  sending / when empty) → a status line derived from the request's last `dmLog` entry
  (`✓ DM sent · <relative time>` in green / `✗ DM failed: <error>` in red). Props:
  `{ r, C, onSent(updatedRequest) }`. Tokens via the passed `C` (from `useTheme()`),
  matching the existing `RequestCard` styling.
- **`src/admin/adminApi.js`** — add
  `sendCardRequestDm(id, message) => apiFetch('/api/admin/card-requests/<id>/dm', { method:'POST', body: JSON.stringify({ message }) })`.
- **`src/admin/AdminShopRequests.js`** — `RequestCard` renders `<ShopRequestDm r={r}
  C={C} onSent={u => setRows(rs => rs.map(x => x.id === u.id ? u : x))} />` (same
  row-replacement pattern already used by `setStatus` / `saveNotes`).

### The four templates (all editable after load)

Exact copy is tunable during implementation; intent below.

1. **Awaiting payment** — "Hi {name}! Your custom card *{cardName}* is assigned to
   {assignee}. To get started, send a **$25 tip on Rainbet**. Once it lands we'll begin 🎨
   — CommunityHunts.gg"
2. **Payment received / starting** — "Got your tip 🙏 — starting on *{cardName}* now.
   I'll update you when it's ready. — CommunityHunts.gg"
3. **Card ready / delivered** — "Your card *{cardName}* is done and ready to equip! 🎉
   — CommunityHunts.gg"
4. **Need more info** — "Quick one on your *{cardName}* request — could you share a bit
   more detail or a reference image so we can nail it? — CommunityHunts.gg"

`{cardName}` falls back to "your card" when the request has no `cardName`; `{assignee}`
falls back to "our team" when unassigned.

## Data flow

Admin opens Shop Requests → picks a request → selects **Awaiting payment** → textarea
prefills the template → edits price/wording → clicks **Send DM** →
`POST /api/admin/card-requests/:id/dm { message }` → backend opens the DM channel with the
community bot, posts the text, calls `recordDm` → returns `{ ok, error, request }` →
`RequestCard` replaces the row; the status line shows `✓ DM sent · just now` (or
`✗ DM failed: …`).

## Error handling

| Case | Result |
| --- | --- |
| Empty / >2000-char message | `400` before any Discord call |
| Request id not found | `404` |
| No bot token configured | `200 { ok:false, error:'Discord bot not configured' }` |
| Discord `403` (DMs off / not in server) | `200 { ok:false, error:'Couldn't DM — they may have DMs disabled or left the server' }` |
| Other Discord non-2xx / network | `200 { ok:false, error:'Discord error — try again' }`, logged server-side |

In every failure case, `status` / `adminNotes` are untouched and the admin can retry or
follow up by hand. `dmLog` records failures too (so the panel shows the last attempt).

## Testing

- **Backend** (`lib/cardRequests.test.js`, `node --test lib/`):
  - `recordDm` appends an entry, caps `dmLog` at 10, stamps `lastDmAt`, leaves
    `status`/`adminNotes` untouched.
  - Route-level with a stubbed `fetch` (same pattern as `routes/misc.routes.test.js`):
    a successful send makes exactly two Discord calls in order (open channel → post
    message) and records `ok:true`; a `403` on the send records `ok:false` and returns
    `200 { ok:false }`; an empty message returns `400` and makes **zero** Discord calls.
- **Frontend** (no test suite in repo): `CI=true npm run build` must print "Compiled
  successfully"; verify on a branch **preview URL**; manual self-DM (an owner is in the
  CommunityHunts server) confirms delivery end-to-end.

## Out of scope (YAGNI)

- Auto-firing DMs on status change / any state machine.
- Rich embeds for the DM (plain text is friendlier and simpler here).
- Backend-stored or admin-editable template management (templates are frontend constants).
- New env vars or a separate bot.
- Per-request DM rate-limiting (only two trusted platform owners hold the gate; revisit
  if that changes).

## Rollout

1. Backend: implement + `node --test lib/`, push, confirm live on Railway.
2. Frontend: implement on a branch, `CI=true npm run build`, verify on the Vercel preview
   with a real self-DM, then merge to `main`.
