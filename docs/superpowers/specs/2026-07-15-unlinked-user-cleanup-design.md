# Unlinked User Cleanup — Design

**Date:** 2026-07-15
**Status:** Approved, ready for planning
**Repos:** `communityhunts-backend` (first), `communityhunts-frontend` (second)

## Problem

Fake "users" pollute the equity-name autocomplete dropdown and the `/admin/users` list. They are
accounts that never corresponded to a Discord login, and there is no way to see or remove them.

### Where they come from

An admin sets a Rainbet handle for a person with no Discord account via
`POST /api/admin/set-rainbet-name` with `{ name }` instead of `{ userId }`. The name-only path
(`routes/settings.routes.js:222-229`) writes a synthetic `user_settings` row keyed
`manual:<lowercased-name>`, carrying `rainbetName` + `discordDisplayName`, so the by-name lookup
can resolve the handle later.

On the next server restart, `backfillKnownUsers` (`lib/settings.js:106-135`) sweeps
`user_settings` and re-inserts every row into `known_users` whenever
`s.discordDisplayName || s.rainbetName` is truthy — which is exactly what the synthetic row has.
The `manual:` row is now indistinguishable from a real login in `known_users`.

`GET /api/known-users` (`routes/auth.routes.js:92-106`) does not filter, so the row surfaces in the
equity autocomplete. `GET /api/admin/users` (`routes/settings.routes.js:235`) joins straight off
`known_users`, so it surfaces there too.

The second loop in `backfillKnownUsers` (over `hunts`, line 127-133) only inserts hunt owners, whose
ids are real snowflakes. So **`manual:`-prefixed rows are the entire junk set.**

### What is NOT the problem

A manually-typed equity name creates **no user record at all** — it is a plain string in the hunt's
`equity[]` array (`HuntTracker.js:835-840`). Equity rows have never carried a Discord id: selecting
an autocomplete suggestion copies only the display-name string and discards `u.id`
(`EquityNameInput.js:82-87`). This spec does not change that.

Nor do these rows affect stats. `getNameIndex` already skips them (`lib/statsStore.js:44-47`), so a
`manual:` row has never attributed anything to anyone. They were only ever autocomplete decoration.

## Scope

**In scope:** stop minting junk into `known_users`, filter it out of the autocomplete, and give
admins a way to see and purge existing rows.

**Out of scope (deliberate):**

- **Free-text equity names stay.** Equity rows remain typed by hand. Gating equity on a real login
  would block a streamer whose participant has no site account, and the auto-injected `bean_auto` /
  `creator_auto` placeholder rows on VIP hunts are not real users either.
- **Profile aliases** — letting a user register alternate names that resolve to their real Discord
  id — is a follow-on spec, not this one. It is a bigger win than this cleanup (it would make equity
  rows actually attribute, which `manual:` rows never did), but its crux is impersonation: a name
  collision in `getNameIndex` (`lib/statsStore.js:51`) drops the name for *everyone*, so a user
  claiming the alias "Bean" would silently strip attribution from the real Bean. That needs a
  globally-unique namespace with first-come-first-served rejection, and deserves its own design.
  This cleanup ships first so aliases validate uniqueness against a `known_users` table that holds
  only real people — otherwise a stale `manual:cabbage` row would block the real Cabbage from
  claiming their own alias.

## Architecture

One shared predicate, four consumers.

New `communityhunts-backend/lib/userIds.js`:

```js
// A real Discord login. Snowflakes are 17-19 digits today; 20 is headroom.
const isRealDiscordId = (id) => /^\d{17,20}$/.test(String(id || ''));
```

This becomes the single definition of "attached to a Discord login" and replaces the ad-hoc
`uid.startsWith('manual:')` test at `lib/statsStore.js:47`. Three near-identical rules for "is this
a real user?" already exist and disagree slightly; this feature needs a fourth, so it unifies them
rather than adding to the drift.

**Adopting it in `statsStore` is a no-op tightening.** `recordKnownUser` is only called from the
Discord OAuth callback / Bearer middleware (`server.js:251`) and from hunt owners
(`lib/settings.js:130`) — both snowflakes. Every non-`manual:` row in `known_users` therefore
already passes the regex. Behavior is unchanged; only the rule stops being duplicated.

**`GET /api/admin/users` is not filtered by default.** The admin list is exactly where the junk
should remain visible. Only the autocomplete is cleaned.

## Backend changes

### 1. Filter the autocomplete — `routes/auth.routes.js:92`

Add a snowflake predicate to the `/api/known-users` query:

```sql
SELECT user_id AS id, display_name AS "displayName", avatar
FROM known_users
WHERE user_id ~ '^[0-9]{17,20}$'
ORDER BY last_seen DESC
LIMIT 500
```

The dropdown becomes "people who have actually logged in". Any name is still typeable by hand; it
just does not get a suggestion.

### 2. Stop re-minting — `lib/settings.js:112`

In the `user_settings` loop of `backfillKnownUsers`:

```js
if (!isRealDiscordId(row.user_id)) continue;
```

Without this, every purged row resurrects in `known_users` on the next restart and the autocomplete
junk comes back. The `hunts` loop below needs no guard (hunt-owner ids are snowflakes), but adding
the same check there is harmless and keeps the two loops symmetrical.

### 3. Purge route — `routes/settings.routes.js`

`DELETE /api/admin/users/:userId`, guarded `requireAuth, requireAdmin`. Placed beside the sibling
`GET /api/admin/users` / `GET /api/admin/users/:userId` routes.

**`admin.routes.js` is the wrong file** — it holds hunts/tenants/admins/subscriptions only; every
user + settings route lives in `settings.routes.js` (see its header block, lines 9-13).

Behavior:

1. **Safety rail:** if `isRealDiscordId(req.params.userId)`, return `400 { error: 'Only unlinked
   (non-Discord) accounts can be removed' }` and write nothing. The route can only ever destroy
   unlinked rows — there is no path from this feature to deleting a real user's settings, even by
   typo'ing a URL.
2. Delete the `known_users` row and the `user_settings` row for that id, in one transaction.
3. Respond `{ ok: true, deleted: { knownUsers: n, userSettings: n } }`.
4. A miss is `404 { error: 'User not found' }` and writes nothing. **A miss means neither row
   existed** — not "the `known_users` row was absent". The two tables fall out of sync by design:
   after change 2, a fresh `manual:` row lives in `user_settings` with no `known_users` row, and
   deleting it must still succeed. Distinguish the codes: 400 means "that id is a real account,
   refused"; 404 means "no such unlinked row anywhere".

### 4. Unlinked filter — `routes/settings.routes.js:235`

`GET /api/admin/users?unlinked=1` adds `ku.user_id !~ '^[0-9]{17,20}$'` to the `WHERE` clause,
composable with the existing `q` search and `limit` / `offset` paging.

### 5. File-mode delete — `lib/settings.js`

Add `deleteSettings(userId)` alongside `getSettings` / `saveSettings`, so the no-`pgPool` path
(the in-memory `userSettings` object mirrored to `user_settings.json`) stays consistent with the
Postgres path.

**Deploy backend first** — the frontend Remove button 404s until the route exists.

## Frontend changes

### `src/admin/adminApi.js`

Add `deleteUser(userId)` → `DELETE /api/admin/users/:userId`. `fetchUsers` gains an `unlinked` flag
that maps to the query param. Follow the existing delete wrappers (hunts, mods, tickets) in the same
file; `apiFetch` throws `new Error(err.error)`, so the backend's copy surfaces verbatim.

### `src/admin/AdminUsers.js`

- An **"Unlinked only"** toggle that re-fetches with `unlinked=1`.
- A per-row **Remove** button, rendered *only* on unlinked rows, modelled on the removal pattern in
  `AdminMods.js:74`.
- A confirm that names what dies:

  > Remove **Cabbage**? This is not a Discord account. Their saved Rainbet handle will be deleted
  > and equity rows naming them will no longer resolve one. Existing hunts are not changed.

## Edge cases

- **Equity rows are untouched.** Purging `manual:cabbage` alters no hunt. A row named "Cabbage"
  keeps its name and amount; it stops resolving a Rainbet handle via
  `GET /api/settings/by-name/:name` (`routes/settings.routes.js:187`), which then returns the empty
  fallback at line 201. An admin can re-add the handle at any time — the purge is recoverable.
- **`loadCardInfo` degrades cleanly.** `HuntTracker.js:598` falls back to the by-name lookup for any
  non-snowflake `eq.id` (i.e. always, since `eq.id` is a per-row UUID). A miss already returns empty
  fields, so a purged name renders without cosmetics rather than erroring.
- **No stats movement.** These rows were already excluded from attribution
  (`lib/statsStore.js:44-47`), so a purge cannot change any number on any leaderboard or profile.
- **Name-index cache** self-heals on its 5-minute TTL (`lib/statsStore.js:36`). No busting needed.
- **Re-minting after a purge** is possible and correct: an admin who sets a rainbet handle by name
  again re-creates the `user_settings` row. It will no longer reach `known_users` (change 2), so it
  stays out of the autocomplete and out of `/admin/users`. That is the intended end state — the
  handle stays resolvable by name without pretending to be a user.

## Testing

- **`lib/userIds.test.js`** — `isRealDiscordId` is pure. Cover: 17/18/19/20-digit snowflakes pass;
  `manual:cabbage`, `''`, `null`, `undefined`, a UUID, `creator_auto`, `bean_auto`, and a 16- or
  21-digit string all fail. Run with `node --test lib/`.
- **No route suite.** Route tests that call `app.listen` hang on exit in this repo, and a piped exit
  code masks failures. The route's logic is thin over the pure predicate, which is covered above.
- **Manual pass** on a Vercel preview + backend branch: the toggle filters, Remove is absent on real
  users, the confirm copy is accurate, a purged row disappears from both the admin list and the
  equity dropdown, and — the load-bearing one — **it is still gone after a backend restart**. That
  last check is what proves change 2 works; without it the bug looks fixed and silently is not.
