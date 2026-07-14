# Shop Request DM — Message History + Assignee Tip Handle

**Date:** 2026-07-14
**Repos:** `communityhunts-backend` (ships first), `communityhunts-frontend` (ships after)
**Status:** Approved design — ready to plan
**Builds on:** [2026-07-14-shop-request-dm-design.md](2026-07-14-shop-request-dm-design.md) (the manual DM feature, already shipped: BE #49 + FE #191)

## Problem

Two follow-ups to the shipped manual-DM feature:

1. **Message history.** Today a request card shows only "sent on `<date>`" (the latest
   `dmLog` outcome). Admins want to see the **previous messages themselves** — text, when,
   who sent it, success/failure.
2. **Assignee tip handle in the template.** The *Awaiting payment* template says "send a
   $25 tip on Rainbet" but never names **who to tip**. It should name the **assigned
   person** (the card-maker who receives the tip), e.g. "tip **GooferBeans** $25 on
   Rainbet". That handle must come from the assignee's **profile**, not a hardcoded list.

These share the templates + assignee wiring, so they ship as one increment.

## Decisions (from brainstorming)

- **History UI:** a **collapsible** `▸ History (N)` list under the DM control (newest-first),
  not always-visible and not a modal.
- **Record sender:** yes — each `dmLog` entry stores **who sent it** (`by: {id, name}`).
- **Tip handle source:** the assignee's existing **`rainbetName`** profile field
  (`lib/settings.getSettings(id).rainbetName`). **No hardcoding.** If the request is
  unassigned or that owner hasn't set a handle, the line degrades to the generic
  "send a $25 tip on Rainbet" (still editable).
- **Wording (approved):** value-first, low-pressure, grateful — see template copy below.

## A. Assignee tip handle from profile

### Backend

`GET /api/admin/card-requests` currently returns `{ requests }`. Change it to also return a
small **`assignees`** array carrying each owner's live Rainbet handle:

```text
GET /api/admin/card-requests
  → { requests: [...],
      assignees: [ { id, label, rainbet }, ... ] }   // rainbet = getSettings(id).rainbetName || ''
```

- The router already knows the owners via `ASSIGNEES` (`lib/cardRequests.js`). For each, it
  resolves `rainbet` from `getSettings(a.id)` (a fixed 2-entry lookup per list load).
- Requires injecting **`getSettings`** into the `cardRequests.routes` deps
  (`server.js` passes `settings.getSettings`). The handler becomes `async`.
- `assignees[*].rainbet` is **computed at read time** (never persisted) so it always
  reflects the current profile value and survives assignee changes.

### Frontend

- `AdminShopRequests` reads `assignees` from the response and builds a
  `rainbetFor = { [id]: rainbet }` map held in state (alongside `rows`).
- It passes `assigneeRainbet={rainbetFor[r.assignee] || ''}` down to each request's
  `ShopRequestDm`.
- `ShopRequestDm` passes it into the template builder: `tpl.build(r, { assigneeRainbet })`.
- Because the handle is resolved from the map (keyed by `r.assignee`), it stays correct
  after an assignee change or a DM send — no per-request enrichment, no row-merge fragility.

### Template signature change

`DM_TEMPLATES[*].build` gains an optional second arg:
`build(r, ctx = {})` where `ctx.assigneeRainbet` is the resolved handle (or `''`). Only the
*Awaiting payment* template reads it; the others ignore `ctx`.

## B. Wording (Awaiting payment template)

```text
Great news — {assignee} is ready to make your card "{cardName}"! To lock it in, just
{tipClause} whenever you're ready and we'll get started. Thanks so much for the support 🎨
— CommunityHunts.gg
```

- `{assignee}` = the assignee label (`whoOf(r)`), or "our team" when unassigned.
- `{cardName}` = `cardOf(r)` ("your card" fallback).
- `{tipClause}` = `tip {assigneeRainbet} $25 on Rainbet` when a handle is present, else the
  generic `send a $25 tip on Rainbet`.

The other three templates (payment received, card ready, need info) are unchanged.

## C. Message history

### Backend

`recordDm` gains two more fields per entry:

```text
recordDm(id, { template, ok, error, message, by }) → request | null
  entry = { at, template, ok, error?, message, by }
    message : the exact text sent (already ≤2000 from the route's validation)
    by      : { id, name } of the sending admin (from req.user)
```

- Stored on **both** success and failure (so a failed attempt's text is visible too).
- `dmLog` stays capped at the **10 newest** entries (10 × ~2KB ≈ trivial in JSONB).
- The DM route (`POST /api/admin/card-requests/:id/dm`) passes `message` and
  `by: { id: req.user.id, name: req.user.displayName }` into both `recordDm` calls.

### Frontend

In `ShopRequestDm.js`:

- Keep the **latest-outcome line** (`✓ DM sent · <time>` / `✗ …`) visible when collapsed.
- Add a **`▸ History (N)`** toggle. Expanded, render a compact **newest-first** list; each row:
  - `✓`/`✗` · template label (resolved from `DM_TEMPLATES` key→label; unknown key → "Message") · `<time>` · `sent by {by.name}`
  - the **message text** below, indented; failures also show the error.
  - legacy entries with no `message` show *"(message not recorded)"*; missing `by` shows no sender.
- The list is a small in-file presentational sub-component (`DmHistory`), mirroring how
  `RequestCard` lives inside `AdminShopRequests.js` (same-feature, one file — codebase precedent).

## Data flow

Admin loads Shop Requests → backend returns `{ requests, assignees }` → frontend builds
`rainbetFor` → each card's DM control knows the assignee's handle. Admin picks *Awaiting
payment* → template prefills with `{assignee}` + `tip {handle} $25` → edits → **Send DM** →
route stores `{ …, message, by }` in `dmLog`, returns the updated request → row updates →
`▸ History (N)` now lists that message with text + "sent by".

## One-time setup (data, not code)

Set each owner's `rainbetName` once (they're settable today from the admin user-profile
panel via `set-user-field`, no new UI):

- Cabbage (`135203806676779008`) → `RandyCabbage`
- Goofer (`168055630916091904`) → `GooferBeans`

Until set, the *Awaiting payment* line uses the generic tip clause (no handle).

## Testing

- **Backend** (`node --test lib/cardRequests.test.js routes/cardRequests.routes.test.js`):
  - `recordDm` stores `message` + `by`, still caps `dmLog` at 10, still leaves
    `status`/`adminNotes` untouched.
  - DM route: the returned `dmLog` entry carries `message` + `by` (from a stubbed
    `req.user`); existing success/403/400/404/no-token/non-admin cases still pass.
  - `GET /api/admin/card-requests`: returns `assignees` with each owner's `rainbet` from a
    stubbed `getSettings`; a missing/empty handle yields `''`.
- **Frontend** (no test suite): `CI=true npm run build` → "Compiled successfully"; preview:
  set a handle → *Awaiting payment* names it; expand history → text + "sent by" render;
  unassigned/no-handle → generic clause; legacy entry → "(message not recorded)".

## Out of scope (YAGNI)

- Editing/deleting past `dmLog` entries.
- A dedicated per-user Rainbet-handle settings UI (the field + admin editor already exist).
- Hardcoded handle fallbacks (pure profile-driven, generic text when unset).
- Threading `message`/`by` into the Discord message content (they're metadata for the panel).

## Rollout (backend-first)

1. Backend PR: `recordDm` fields + DM-route `message`/`by` + `GET` `assignees` enrichment +
   `getSettings` injection. Merge → verify on Railway.
2. Set the two `rainbetName` values.
3. Frontend PR: template signature + wording + `assigneeRainbet` threading + history UI.
   Build, preview-verify, merge.
