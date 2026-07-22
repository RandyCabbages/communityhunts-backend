# Banned-member name/alias matching — design

**Date:** 2026-07-21
**Repos:** `communityhunts-backend`, `communityhunts-frontend` (extension unaffected)
**Builds on:** `2026-07-20-banned-users-design.md`

## Problem

The runner warning ("you're handing a spot to a known scammer") added in the banned-users
feature matches **only by Discord ID**. But `addMember` in `HuntTracker.js` creates an equity
row from a typed name with **no `discordId`** — an ID is only attached later via the separate
"Link Discord" action. So the most common way a member is added (by name) carries no ID, and the
ban check has nothing to match against. The exact thing the feature exists to prevent — a runner
unknowingly adding scammer Raph by name — is the case it silently cannot catch.

Confirmed in the field: Raph (`693694981457838140`) was correctly banned by Discord ID, yet
adding a member named "rap" produced no warning, because that equity row had no linked ID.

## Goal

Warn a runner when a member's **typed name** matches a known scammer's alias, in addition to the
existing ID match. Non-blocking and informational, exactly like the current warning.

## Non-goals

- Blocking adds (the feature never blocks — it informs).
- Fuzzy/substring matching (false-positive risk; exact-normalized only).
- Extension changes (the runner warning is web-app only; the extension only renders the banned
  user's OWN lockout notice, never a runner-side member-add warning).

## Design

### 1. Data model (backend, `lib/bans.js`)

- Migration in `initBans`: `ALTER TABLE banned_users ADD COLUMN IF NOT EXISTS aliases TEXT[]
  DEFAULT '{}'` (idempotent, alongside the existing `CREATE TABLE IF NOT EXISTS`).
- Aliases stored **as-entered** (display case preserved) but **matched normalized**.
- `normalizeName(s)`: lowercase, trim, collapse internal whitespace to single spaces. This is a
  NEW dedicated helper — do NOT reuse the slot normalizer (it strips punctuation and trailing
  "s", which is wrong for names).
- `reloadBanCache()` builds a second index: `aliasIndex = Map<normalizedAlias, discord_id>`,
  rebuilt on every reload alongside the id `cache`. Last-writer-wins if two bans share an alias
  (acceptable — rare, and any match still points at a real ban).
- `listBans()` returns `aliases` in each row (for the admin UI).
- `addBan(discordId, { reason, message, bannedBy, aliases })`: persist `aliases` (TEXT[]),
  deduped by normalized form, empty array when none. Upsert sets `aliases = EXCLUDED.aliases`.

### 2. Matching + API (backend)

- `matchNames(names)` in `lib/bans.js`: for each input name, `normalizeName` it, look up in
  `aliasIndex`; on hit, resolve the ban via `getBan(id)` and return `{ reason, alias }` keyed by
  the **normalized** input name. Returns only hits (mirrors `isBanned`/`getBan` no-op-safe
  behavior with no DB).
- `POST /api/banned-status` ([routes/hunts.routes.js:33]) accepts `{ ids, names }` (both
  optional arrays, each `.slice(0, 100)` capped). New response shape:

  ```json
  {
    "ids":   { "<discordId>": { "reason": "scamming" } },
    "names": { "<normalizedName>": { "reason": "scamming", "alias": "raph" } }
  }
  ```

- **Auto-capture of display name:** the ADMIN add-ban route (`POST /api/admin/banned-users`)
  resolves the banned id's display name by querying `known_users` via `pgPool` — the SAME
  mechanism the list handler already uses to enrich rows (`SELECT display_name FROM known_users
  WHERE user_id = $1`, see admin.routes.js:240). If a display name is found, merge it into
  `aliases` (deduped by normalized form) before calling `addBan`. Manual aliases from the request
  merge on top. Auto-capture lives in the route, not `addBan`, so `addBan` stays a pure
  persistence primitive. (No new dep needed — `pgPool` is already in `admin.routes.js` deps;
  `getKnownUser` is NOT, so do not use it here.)

### 3. Frontend warning derivation

- `useBannedEquityWarning` ([src/hunt/useBannedEquityWarning.js]) collects two sets from equity:
  - `ids`: rows WITH a `discordId` (unchanged).
  - `names`: names of rows WITHOUT a `discordId`. A row with a linked ID is already
    authoritatively id-checked, so it is excluded from name-matching — this avoids false-flagging
    a legit linked member who happens to share a banned alias.
- POST `{ ids, names }`; store both returned maps in state. Effect key = sorted-unique id set +
  sorted-unique normalized name set (editing amounts still must not refetch).
- Pure helper `deriveBannedMembers(equity, idMap, nameMap, dismissedSet)` → array of
  `{ discordId?, name, reason, matchType: 'id' | 'name' }`. Precedence: an id match wins over a
  name match for the same row (certain over possible). Dismissal keyed per row (id when present,
  else `name:<normalizedName>`), so re-adding a dismissed member resurfaces them.
- Extract `deriveBannedMembers` into its own module so it gets a `.test.js` (repo rule: pure
  logic is tested; the hook and component are not).

### 4. Admin UI + warning copy (frontend)

- `BannedMemberWarning.js` ([src/hunt/BannedMemberWarning.js]) — copy by `matchType`:
  - `id`:   "**{name}** is banned for scamming."
  - `name`: "A member named **{name}** matches a known scammer's alias — verify their Discord
    before giving them a spot."
- `admin/AdminBans.js` + `admin/userProfile/BanControl.js`: an **Aliases** field
  (comma-separated input; existing aliases rendered as a list/chips). `adminApi` threads
  `aliases` through the add-ban call. This is what lets Raph's `raph`/`rap` aliases be added with
  NO deploy.

### 5. Deploy order

Backend first, frontend second:

1. **Backend** ships: migration adds `aliases`; `/api/banned-status` now reads `ids`/`names` and
   returns `{ ids, names }`. The OLD frontend still sends `{ ids }` and reads a flat map — but the
   new response is `{ ids: {...}, names: {...} }`, which the old frontend would misread. **Therefore
   the response-shape change is NOT backward compatible with the old frontend.** To keep the
   deploy safe, the backend keeps returning the OLD flat `{ <id>: {...} }` shape when the request
   omits `names`, and the NEW `{ ids, names }` shape when `names` is present. New frontend always
   sends `names` (even if empty `[]`), so it always gets the new shape; old frontend never sends
   `names`, so it keeps the old shape. One small branch, no window of breakage.
2. **Frontend** ships: sends `{ ids, names: [...] }`, consumes `{ ids, names }`, renders dual copy,
   admin aliases field.

### 6. Testing

- **Backend** (`lib/bans.test.js` or the existing bans test + a hunts route test):
  - `normalizeName` (case, whitespace, trim).
  - alias storage + normalized dedup in `addBan`.
  - `matchNames`: hit, miss, case/space-insensitive, only-banned-return, no-DB no-op.
  - `/api/banned-status`: `{ names }` present → `{ ids, names }` shape; `{ names }` absent → old
    flat shape (deploy-safety branch).
  - admin add-ban auto-captures `getKnownUser` display name into aliases.
- **Frontend** (`src/hunt/deriveBannedMembers.test.js`):
  - id match, name match, id-precedence over name for one row, dismissed rows filtered,
    linked-row (has discordId) is NOT name-matched.

## Files touched

**Backend:** `lib/bans.js`, `routes/hunts.routes.js`, `routes/admin.routes.js` (auto-capture +
aliases passthrough), bans/hunts tests.
**Frontend:** `src/hunt/useBannedEquityWarning.js`, new `src/hunt/deriveBannedMembers.js` (+test),
`src/hunt/BannedMemberWarning.js`, `src/admin/AdminBans.js`,
`src/admin/userProfile/BanControl.js`, `src/admin/adminApi.js`.
