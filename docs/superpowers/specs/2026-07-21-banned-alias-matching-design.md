# Site-wide alias directory + banned-member name matching — design

**Date:** 2026-07-21
**Repos:** `communityhunts-backend`, `communityhunts-frontend` (extension unaffected)
**Builds on:** `2026-07-20-banned-users-design.md`

## Problem

The runner warning ("you're handing a spot to a known scammer") from the banned-users feature
matches **only by Discord ID**. But `addMember` in `HuntTracker.js` creates an equity row from a
typed name with **no `discordId`** — an ID is only attached later via the separate "Link Discord"
action. So the most common way a member is added (by name) carries no ID, and the ban check has
nothing to match against. The exact thing the feature exists to prevent — a runner unknowingly
adding scammer Raph by name — is the case it silently cannot catch.

Confirmed in the field: Raph (`693694981457838140`) was correctly banned by Discord ID, yet
adding a member named "rap" produced no warning, because that equity row had no linked ID.

To match a typed name to a banned user, we need a **name → Discord ID** mapping. Rather than bolt
name storage onto the ban record, we build it as a **site-wide alias directory** covering ALL
users (an extension of the existing `known_users` directory). The ban warning is its first
consumer; other features (equity autocomplete, admin lookups) can use it later.

## Goal

- Build a site-wide directory of the names/handles each user is known by, accumulated for every
  user (not just banned ones).
- Use it to warn a runner when a member's typed name matches a banned user's alias, in addition
  to the existing ID match. Non-blocking and informational, exactly like the current warning.

## Non-goals

- Blocking adds (the feature never blocks — it informs).
- Fuzzy/substring matching (false-positive risk; exact-normalized only).
- Extension changes (the runner warning is web-app only).
- Warning at surfaces other than the hunt equity list (a future extension; out of scope here).

## Existing infrastructure this builds on

- `known_users(user_id PK, display_name, username, avatar, last_seen)` in `lib/settings.js` —
  records every logged-in user's CURRENT display_name/username (overwritten on each login via
  `recordKnownUser`). No history, no reverse name→id lookup.
- `recordKnownUser(user)` is called on every login (via `lib/auth.js`) and by the cardRequests
  Discord-lookup backfill — so it is the single natural hook point for capturing names for all
  users.
- `getPlatformBotToken()` + `GET /users/{id}` pattern (`cardRequests.routes.js:103-130`) — the
  proven way to resolve a Discord ID to current handles, using the WORKING bot token (the
  `DISCORD_BOT_TOKEN` env var is stale in Railway and 401s — do NOT use it).

## Design

### 1. Alias directory (backend, `lib/settings.js`)

New table, owned alongside `known_users`, created idempotently in the settings init:

```sql
CREATE TABLE IF NOT EXISTS user_aliases (
  user_id    TEXT NOT NULL,
  alias_norm TEXT NOT NULL,      -- normalizeName(alias)
  alias      TEXT NOT NULL,      -- display form, first-seen
  source     TEXT,               -- 'login' | 'discord' | 'manual'
  seen_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, alias_norm)
);
CREATE INDEX IF NOT EXISTS idx_user_aliases_norm ON user_aliases (alias_norm);
```

- It **accumulates** — a user gathers multiple alias rows over time (unlike `known_users`, which
  overwrites the single current name). This is the name-history the Discord API itself does not
  expose.
- `normalizeName(s)`: lowercase, trim, collapse internal whitespace to single spaces. NEW
  dedicated helper — do NOT reuse the slot normalizer (it strips punctuation and trailing "s",
  wrong for names). Exported so callers share one definition.
- `recordAlias(userId, name, source)`: normalize `name`; skip empty/blank; upsert
  `(user_id, alias_norm)` `ON CONFLICT DO NOTHING` (keep first-seen display + source), best-effort
  (log + swallow errors, no-op with no pgPool). Never throws.
- `findAliasOwners(names)`: given an array of raw names, normalize each, query
  `SELECT alias_norm, user_id FROM user_aliases WHERE alias_norm = ANY($1)`, then map back so the
  result is keyed by the **original raw name string** the caller passed:
  `Map<rawName, Set<user_id>>`, containing only raw names that had ≥1 owner. Empty map on no DB.
  Read-only, no side effects. Keying by raw name (not normalized) means consumers never need their
  own `normalizeName`.

### 2. Capture hooks — populated for ALL users

- **Login (all users):** `recordKnownUser(user)` (`lib/settings.js:96`), after its existing
  `known_users` upsert, also calls `recordAlias(user.id, user.displayName, 'login')` and — when
  present — `recordAlias(user.id, user.username, 'login')`. This one hook captures aliases for
  every login and every cardRequests backfill that calls `recordKnownUser`.
- **Ban-time Discord enrich (targeted):** the admin add-ban route (§4) resolves the banned id's
  current handles via `getPlatformBotToken()` + `GET /users/{id}` (username, global_name) and,
  best-effort, the guild `nick` via `tenants.getTenantDiscordConfig(req.tenant)` +
  `GET /guilds/{guildId}/members/{id}`; each captured handle is written with
  `recordAlias(id, handle, 'discord')`. Strictly best-effort — must NEVER block or fail the ban;
  wrap in try/catch, log, proceed. Covers a scammer who never logged in.
- **Manual (targeted):** an admin "add alias" action writes `recordAlias(userId, alias, 'manual')`
  for that user_id. Covers nicknames we have never observed (e.g. "rap").

### 3. Ban matching + API (backend)

- `POST /api/banned-status` (`routes/hunts.routes.js:33`) accepts `{ ids, names }` (both optional
  arrays, each `.slice(0, 100)` capped). Matching:
  - **ids:** unchanged — `bans.isBanned(id)` → `bans.getBan(id).reason`.
  - **names:** `findAliasOwners(names)` → for each raw input name, take its candidate user_ids,
    filter to `bans.isBanned(userId)`; if any is banned, that name is a hit with that ban's
    `reason` (from `bans.getBan(userId)`). Orchestrated in the route: add `findAliasOwners` to the
    hunts.routes deps (it already receives `getKnownUser` from settings, so settings funcs are
    already threaded in — see hunts.routes.js:25); `bans` is already a dep.
  - Response shape is conditional for deploy-safety (§6):
    - `names` present → `{ "ids": { "<id>": { "reason" } }, "names": { "<rawName>": { "reason" } } }`
      — `names` keyed by the exact raw name string the frontend sent.
    - `names` absent → the OLD flat `{ "<id>": { "reason" } }` (old frontend unchanged).

### 4. Admin UI (frontend + backend)

- **Backend** `POST /api/admin/banned-users` (`routes/admin.routes.js:259`): keeps banning by ID
  (the `banned_users` table is UNCHANGED — no aliases column). Adds:
  - the ban-time Discord enrich from §2 (writes to the directory, best-effort).
  - accepts an optional `aliases` array in the body; for each, `recordAlias(discordId, alias,
    'manual')`.
  - **Dep wiring:** add `getPlatformBotToken`, `recordKnownUser` (already used elsewhere), and the
    new `recordAlias` to the `admin.routes.js` deps destructuring (lines 29-36) and the
    `adminRoutes(deps)` call in `server.js:642`. `getPlatformBotToken`/`recordAlias`/`recordKnownUser`
    are all constructed in `server.js` scope (see the cardRequests wiring at server.js:497-502).
  - Also expose manual alias management on a banned user via the existing add-ban upsert (re-POST
    with `aliases`) — no new route needed for the MVP.
- **Frontend** `admin/AdminBans.js` + `admin/userProfile/BanControl.js`: an **Aliases** field
  (comma-separated input) on the ban form; `adminApi` threads `aliases` through the add-ban call.
  This is what lets Raph's `raph`/`rap` aliases be added with NO deploy.

### 5. Frontend warning derivation

- `useBannedEquityWarning` (`src/hunt/useBannedEquityWarning.js`) collects two sets from equity:
  - `ids`: rows WITH a `discordId` (unchanged).
  - `names`: names of rows WITHOUT a `discordId`. A row with a linked ID is already
    authoritatively id-checked, so it is excluded from name-matching — this avoids false-flagging
    a legit linked member who happens to share a banned alias.
- POST `{ ids, names }` (always sends `names`, even `[]`, so it always gets the new response
  shape); store both returned maps. Effect key = sorted-unique id set + sorted-unique name set
  (editing amounts must not refetch).
- Pure helper `deriveBannedMembers(equity, idMap, nameMap, dismissedSet)` → array of
  `{ discordId?, name, reason, matchType: 'id' | 'name' }`. `idMap` is keyed by discordId, `nameMap`
  by the raw member name (as sent). Precedence: an id match wins over a name match for the same
  row. Dismissal keyed per row (`id:<discordId>` when present, else `name:<rawName>`) so re-adding
  a dismissed member resurfaces them. No frontend normalization needed — the backend echoes raw
  names. Extracted into its own module so it gets a `.test.js` (repo rule: pure logic is tested;
  the hook/component are not).
- `BannedMemberWarning.js` — copy by `matchType`:
  - `id`:   "**{name}** is banned from CommunityHunts for {reason}." (current copy)
  - `name`: "A member named **{name}** matches a known scammer's alias — verify their Discord
    before giving them a spot."

### 6. Deploy order

Backend first, frontend second:

1. **Backend** ships: `user_aliases` table + capture hooks + `/api/banned-status` reading
   `ids`/`names`. The response-shape change is gated on `names` being present, so the OLD frontend
   (sends only `{ids}`) keeps getting the old flat shape — no breakage window.
2. **Frontend** ships: sends `{ ids, names }`, consumes `{ ids, names }`, renders dual copy, admin
   aliases field.

Backfill: `user_aliases` starts empty; it fills as users log in. Raph's aliases get there via the
ban-time Discord enrich (on next re-save of his ban) and/or the manual Aliases field — no data
migration needed.

## Testing

- **Backend** (`lib/settings` tests + hunts/admin route tests):
  - `normalizeName` (case, whitespace, trim).
  - `recordAlias` upsert + `ON CONFLICT DO NOTHING`; no-op with no pgPool; never throws.
  - `findAliasOwners` returns the right user_id sets; empty on miss.
  - `recordKnownUser` also records aliases (login + username).
  - `/api/banned-status`: `{ names }` present → `{ ids, names }` shape and matches a banned user's
    alias; `{ names }` absent → old flat shape (deploy safety).
  - admin add-ban: `aliases` in body → `recordAlias(..., 'manual')`; Discord enrich mocked
    (`fetch` + `getPlatformBotToken`, as `admin.routes.test.js` already mocks); ban still succeeds
    when the Discord fetch throws (best-effort).
- **Frontend** (`src/hunt/deriveBannedMembers.test.js`):
  - id match, name match, id-precedence over name for one row, dismissed rows filtered,
    linked-row (has discordId) is NOT name-matched.

## Files touched

**Backend:** `lib/settings.js` (table + `normalizeName`/`recordAlias`/`findAliasOwners` +
`recordKnownUser` hook), `routes/hunts.routes.js` (name matching + response shape),
`routes/admin.routes.js` (Discord enrich + manual aliases), `server.js` (dep wiring for
`admin.routes`), settings/hunts/admin tests.
**Frontend:** `src/hunt/useBannedEquityWarning.js`, new `src/hunt/deriveBannedMembers.js` (+test),
`src/hunt/BannedMemberWarning.js`, `src/admin/AdminBans.js`,
`src/admin/userProfile/BanControl.js`, `src/admin/adminApi.js`.
