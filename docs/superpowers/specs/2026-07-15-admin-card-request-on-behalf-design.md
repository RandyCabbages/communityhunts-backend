# Admin-filed card requests (on behalf of a user)

**Date:** 2026-07-15
**Status:** Approved, not implemented
**Repos:** `communityhunts-backend` (first), `communityhunts-frontend`

## Problem

Custom card commissions can only be filed from the Shop's "Request yours" tile
(`POST /api/card-requests`, self-service). But people ask for cards over Discord DM instead —
and today the only answer is "go to the site and fill the form", which is friction at exactly
the moment someone has decided to spend money.

A platform owner should be able to file the request themselves, from the admin panel, on behalf
of the person who asked.

## Scope

In: an admin-only create path for card requests, with requester identity resolution.
Out: editing user content after submit (still immutable), bulk import, non-platform-admin access.

## Decisions

| Decision | Choice | Why |
| --- | --- | --- |
| Requester who isn't in `known_users` | Picker **+ raw Discord ID fallback** | The premise is "they never came to the site". Picker-only would just move the friction from filling a form to signing in. A null `userId` (free-text requester) would break the DM button, `exclusiveUserId` gating, and equip — every downstream feature would grow a null branch. |
| Starting status | Always `new` | Keeps `new → awaiting_tip → in_progress → done` honest: every request passed every stop, so "did we quote them?" stays answerable from the record. Costs one click when the idea was pre-approved in DM. |
| Discord doorbell | Always post, same as public | The embed is not just a notification — `setDiscordMessage` stores its id and every status change PATCHes it. Skipping the post leaves `discordMessageId` unset, so `routes/cardRequests.routes.js` silently skips the embed update *forever* and that request is permanently dark in the channel while every other one tracks live. A redundant ping is cheaper than a queue record that lies. Also tells the co-owner a commission landed. |

## Data model

One new field on the request record:

```js
createdBy: { id, name } | null   // null/absent = self-submitted from the Shop
```

Absent on all existing rows, which reads correctly as "the user submitted this themselves".
No migration, no backfill.

`userId` / `displayName` / `avatar` keep their current meaning: **the requester**, never the
admin. This is what keeps the DM button, `exclusiveUserId`, and equip working unchanged.

## Backend

### `lib/cardRequests.js`

- `createRequest(body, user, opts)` — third optional arg `{ createdBy }`.
  The identity snapshot already reads from the passed `user` object, so filing on behalf is just
  passing a different one. The only real change is persisting `createdBy`.
- `validateAdminCreate(body)` — new. Checks `body.userId` against `/^\d{17,20}$/` (Discord
  snowflake), then delegates to the existing `validateInput` for idea/cardName/refLinks/rainbet.
- Export both.

### `POST /api/admin/card-requests` (`requireAuth, requirePlatformAdmin`)

1. `validateAdminCreate(req.body)` → 400 on failure.
2. Resolve requester identity for `body.userId`, falling through on miss:
   1. `getKnownUser(userId)` — new injected dep; the same one-row query
      `settings.routes.js` already runs (`SELECT display_name, username, avatar FROM known_users WHERE user_id=$1`).
   2. Discord `GET /users/{id}` with the platform bot token → on success `recordKnownUser(...)`
      (already exported from `lib/settings.js`) so they're searchable next time.
   3. Both fail → `displayName: 'Unknown (<id>)'`, `avatar: null`. **The request still files** —
      a wrong display name is cosmetic and fixable; `userId`, the load-bearing part, came from
      the admin.
3. `createRequest(body, resolvedUser, { createdBy: { id: req.user.id, name: <admin display name> } })`
4. Post the doorbell (below).
5. Respond with the created row (**not** the public route's `{ ok, discord }`) so the board can
   prepend without a refetch.

**No IP throttle, no `MAX_OPEN_PER_USER` cap.** Both exist to stop strangers spamming the public
form; neither describes a platform owner working through their DMs. `requirePlatformAdmin` is the
gate.

### Shared doorbell

Both routes now post the embed, so the block currently inline in `POST /api/card-requests`
(open the channel, POST the embed, `setDiscordMessage` on success, swallow failures) is extracted
to a `postDoorbell(r)` helper rather than copy-pasted. Behavior is unchanged for the public route:
the request is already saved, and a Discord failure is only logged.

`buildRequestEmbed` gains a field when `createdBy` is set:

```js
if (r.createdBy) fields.push({ name: 'Filed by', value: `${r.createdBy.name} (on their behalf)`, inline: true });
```

## Frontend

- **`src/admin/NewShopRequestModal.js`** — new file (File Discipline: new UI → new file).
  Debounced search over the existing `fetchUsers({ q })` in `adminApi.js`; results render as
  avatar + display name + id. When nothing matches, a "Use Discord ID" input accepts a raw
  snowflake. Then the same fields the public form collects: idea (required, ≤2000), card name,
  Rainbet username, reference links.
- **`src/admin/adminApi.js`** — `createCardRequest(body)` → `POST /api/admin/card-requests`.
- **`src/admin/AdminShopRequests.js`** — "+ New request" button by the header; on success
  `setRows(rs => [created, ...rs])`.
- **`ShopRequestBoard` + `ShopRequestModal`** — small "filed by X" chip when `createdBy` is set.
  This keeps the DM button honest: it DMs `userId` (the requester), not the admin who filed it.

Tokens via `useTheme()`; no local token object.

## Testing

**`lib/cardRequests.test.js`**
- `createRequest` with `{ createdBy }` sets the field; without it, `createdBy` is absent/null.
- Identity is snapshotted from the *passed* user object, not a session.
- `validateAdminCreate`: rejects a non-snowflake `userId`, rejects a missing/empty idea, accepts
  a valid body.

**`routes/cardRequests.routes.test.js`**
- Admin create → 200 + the created row.
- Non-platform-admin → 403.
- Bad snowflake → 400.
- `known_users` miss + Discord unreachable → placeholder display name, still 200.

Run captured to a **file, not a pipe** — route suites with `app.listen` hang on exit and piped
exit codes mask failures (see the backend node --test gotcha).

**Frontend:** no component test (`@testing-library/react` is deliberately not installed).
`CI=true npm run build` must print "Compiled successfully", plus driving the real modal on a
Vercel preview URL.

## Deploy order

Backend merges and deploys to Railway **first** — the frontend's create button 404s until the
route is live. Then frontend. Standard for this repo pair.
