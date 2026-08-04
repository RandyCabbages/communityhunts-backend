# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

Node.js/Express backend for **CommunityHunts.gg** — a community/VIP slot bonus hunt tracker. Features: Discord OAuth, hunt state management, real-time Socket.IO events, slot autocomplete, Discord bot integration (ticket DMs, parse winners), Twitch live status, and file-based persistence. Deployed on Railway.

## Live URLs

| Resource | URL |
|---|---|
| Backend (Railway) | https://beanhunt-backend-production.up.railway.app |
| Frontend (Vercel) | https://communityhunts.gg |
| Backend repo | https://github.com/RandyCabbages/communityhunts-backend |
| Frontend repo | https://github.com/GooferG/communityhunts-frontend |
| Railway Project ID | `21885da4-a512-4d3c-b3ff-9d499cb82d4a` |

**Local paths:**
- Backend: `C:\Users\kylew\communityhunts-backend`
- Frontend: `C:\Users\kylew\communityhunts-frontend`

## Commands

```bash
npm start        # production (node server.js)
npm run dev      # development with auto-reload (nodemon server.js)
```

No build step — pure Node.js. Runs on port `3001` or `process.env.PORT`.

## Deploy Workflow

**Never commit to `main`.** Branch and open a PR, even for a one-line change. Two people push
to this remote in tandem and `main` auto-deploys to production on merge, so a direct push is
both a merge-race risk and an untested deploy.

```bash
git fetch origin
git pull --ff-only                       # branch off fresh main, never a stale local one
git checkout -b fix/some-slug
git add routes/foo.routes.js lib/foo.js  # explicit paths only — never `git add -A`
git commit -m "message"
git push -u origin fix/some-slug         # then open the PR
```

Railway auto-deploys `main` on merge (~1–3 min). Merge races have dropped commits here before —
verify the merge-base after every merge.

```bash
git revert <hash>          # safe way to undo a merged commit — never force-push
```

**A deploy does NOT log users out.** It restarts the server and clears in-memory sessions, but
the `Authorization: Bearer` fallback (`lib/auth.js`, HMAC-signed with `SESSION_SECRET`) silently
re-authenticates on the next request, so users stay signed in across restarts. Only **rotating
`SESSION_SECRET`** invalidates every token and actually logs everyone out.

## Project Structure

**`server.js` no longer holds the routes.** The 2026 de-slop turned it into a composition root:
it wires config, Passport, Postgres, and dependency-injected routers, then starts the server.
Behavior lives in `routes/` and `lib/`.

```text
server.js              ← composition root: config, Passport, DI wiring, startup
routes/*.routes.js     ← 24 thin routers; each exports a factory taking injected deps
lib/*.js               ← 50 domain modules (hunts-core, auth, tenants, persistence, features, …)
sockets/index.js       ← Socket.IO handlers
scripts/               ← one-shot maintenance (backfills, exports, reconciliation)
package.json
.env                   ← secrets (never commit)
.env.example           ← config template
hunts_data.json        ← persistent hunt storage (auto-generated, don't commit)
slots_cache.json       ← slot thumbnails cache (auto-generated, 24hr refresh)
rainbet_slots.json     ← repo SNAPSHOT + first-boot seed of the slot catalogue, whose real home
                         is Postgres (lib/rainbetSlotStore.js). Auto-committed by rainbetSlotSync.
rainbet_live_names.json  ← live-catalogue snapshot from the reconcile job (gates the slot.report merge)
rainbet_playability.json ← per-slug "does the game actually launch" history (see below)
```

Unit tests sit beside their module as `*.test.js` (`node:test`).

```bash
npm test                    # everything: lib/ + routes/ + sockets/ (652 tests, ~3s)
npm run test:lib            # lib only
npm run test:routes         # routes only
npm run test:sockets        # socket authz / viewer-count invariants
node --test lib/            # BROKEN on Node 24 — reports a bogus `test at lib:1:1` failure
```

CI runs `npm test` on every PR and on push to `main` (`.github/workflows/test.yml`).
Piping the output masks the exit code — check it directly.

> **Route suites no longer hang.** The old "route suites that call `app.listen` hang, run lib
> suites only" rule was wrong and cost real coverage — it was ONE file. `adminTickets.routes.test.js`
> closed its server with `server.close()`, which only stops *new* connections and waits forever for
> `fetch`'s idle keep-alive sockets to drain. Fixed by calling `server.closeAllConnections()` first.
> **If you add a route suite that drives requests over `fetch`, close it the same way** — see the
> `req()` helper in that file.

**Shared-state rule:** `hunts` and `archive` are mutable singletons **owned by `lib/persistence.js`**.
`server.js` imports them by reference (`const { hunts, archive } = require('./lib/persistence')`).
Never reassign them (no `hunts = …`) — only mutate (`Object.assign`, `.push`, `.unshift`, `.splice`).
A second instance would silently desync live hunt state.

`lib/persistence.js` takes `pgPool` + `normalizeSlot` via `initPersistence(...)` (dependency
injection, to avoid a circular require). `lib/integrations.js` takes `io` via `startTwitchPolling(io)`
and receives the active hunt + `normalizeSlot` as args to `importCalls(...)`.

## Auth System

- Discord OAuth via Passport.js (`passport-discord`, scope: `identify`)
- Sessions are **in-memory** (lost on restart/deploy)
- `displayName` set at OAuth time from `profile.global_name || profile.username`
- User object: `{ id, username, displayName, avatar, isAdmin, isVipHost }`

## VIP / Admin Logic — DO NOT BREAK

```javascript
// Admin by Discord ID (permanent — immune to display name changes)
const ADMIN_IDS = (process.env.ADMIN_IDS || '135203806676779008')
  .split(',').map(s => s.trim()).filter(Boolean);

function isAdmin(user) {
  return user
    ? (ADMINS.includes(nameOf(user)) || ADMIN_IDS.includes(String(user.id)))
    : false;
}

// VIP gate pattern used throughout the code:
isAdmin(req.user) || VIP_HOSTS.includes(nameOf(req.user))
```

- **Owner Discord ID:** `135203806676779008` (permanent, hardcoded as default in `ADMIN_IDS`)
- Because `isAdmin` is checked first at every VIP gate, the owner gets full admin + VIP access everywhere
- **Never gate on display name** — it can change and locks people out (this broke access once)
- To add more admins: set `ADMIN_IDS` env var in Railway with comma-separated Discord IDs

## Multi-Tenancy (2026-06-18)

The backend serves many isolated streamer communities. **Gated by `MULTI_TENANT` env var** —
when unset/false, behavior is identical to single-tenant Bean (the default fallback everywhere).

- **Config** lives in Postgres: `tenants` (slug, display name, twitch channel, discord bot token +
  channel ids, leaderboard url, host discord id, branding JSONB) + `tenant_roles` (admin/vip by
  Discord ID). Managed in `lib/tenants.js`; cached in memory; Bean row seeded from current env vars
  (`ADMIN_IDS`/`VIP_IDS`/`DISCORD_*`) on startup so nobody loses access.
- **Resolution:** `resolveTenant` middleware reads `X-Tenant-Slug` (header) or `?_tenant=` (query),
  sets `req.tenant`. Defaults to `BEAN_TENANT` when the flag is off OR no slug is sent. Socket.IO
  reads the slug from the handshake `?_tenant=` query.
- **Three-tier auth:** `PLATFORM_OWNER_ID` (constant `135203806676779008`, admin on ALL tenants,
  never in the DB) → tenant admin (`tenant_roles` role=admin) → tenant VIP (role=vip). Use
  `reqIsAdmin(req)` / `reqIsVipHost(req)` in handlers — they resolve against `req.tenant` when the
  flag is on, else the env globals. **Still ID-only, never display name.**
- **Hunt isolation:** each hunt carries a `tenantId` field; `getPublicHunts/getAllHunts/getArchivedHunts(tenantId)`
  filter by it; `tenantOf(h)` treats untagged hunts as `'bean'` (back-compat). Socket hub updates go to
  the `hub:<slug>` room.
- **Per-tenant integrations:** Twitch poll uses `tenant.twitchChannel`; Discord import/parse use the
  tenant's bot token + channels; leaderboard uses `tenant.leaderboardUrl` (null → no panel).
- **Public endpoints:** `GET /api/tenant-config` (active tenant branding, no secrets),
  `GET /api/tenants` (directory list).
- **Rollout:** deploy with `MULTI_TENANT` unset (no-op). Run `scripts/stamp-bean-tenant.js` once.
  Flip `MULTI_TENANT=true` only once the frontend sends `X-Tenant-Slug` (it already does). Add a
  tenant by inserting a `tenants` row + `tenant_roles`; no code change needed.

## Key API Endpoints

```
GET  /auth/discord                          → start Discord OAuth
GET  /auth/discord/callback                 → OAuth callback (Passport)
GET  /auth/logout                           → clear session
GET  /auth/me                               → current user + isAdmin/isVipHost flags

GET  /api/hunts                             → public live hunts
GET  /api/hunts/:userId                     → single hunt (permission-aware)
GET  /api/my-hunt                           → user's own hunt (auth required)
POST /api/my-hunt/start                     → create hunt (VIP-gated) — BORN LIVE (isLive:true)
POST /api/my-hunt/golive                    → go live (legacy; hunts are born live — kept for back-compat, UI no longer calls it)
POST /api/my-hunt/end                       → end hunt (called by frontend AUTO-end when all bonuses opened; no manual end button)
POST /api/my-hunt/reset                     → reset to a fresh (born-live) hunt
PUT  /api/my-hunt                           → update own hunt

Hunt lifecycle (2026-07-09): hunts are BORN LIVE on /start (no manual go-live/offline/end in the UI).
A hunt leaves "live" only automatically — the stale-hunt janitor (server.js) reaps it, either as an
empty dead hunt or as a completed hunt that has gone idle past its grace window (see below). `huntHasContent(h)` (lib/hunts-core.js) — bonuses OR a real
equity member (amount>0 or non-`creator_auto`/`bean_auto` id) OR non-solo calls — drives BOTH the hub
filter (getPublicHunts hides empty live hunts) and the janitor's 1h dead-reap (empty regular hunt idle
≥1h → delete; sweep every 10m). tracker:/__mod_hunt__/__affiliate_hunt__ keys are exempt from the 1h
reap and keep the 36h grace.
**A completed hunt does NOT end immediately — it keeps a 10-MINUTE EDITABLE GRACE WINDOW.** Opening the
last bonus does not archive anything: `COMPLETED_GRACE_MS = 10 * 60 * 1000` (server.js), and the janitor
only auto-ends a completed hunt once it has been **idle** that long (`huntCompleted(h) &&
idleMs(h.updatedAt) >= COMPLETED_GRACE_MS`). **Every edit resets the timer**, and the sweep itself runs
every 10m, so a real end lands ~10–20m after the host stops touching it. That window exists so the host
can do final tweaks — equity, payouts, win corrections, **vaulting a base-game win from the Opening
page** — after the last slot is opened. Persistent shared/tracker keys keep the 36h grace instead.
Correspondingly `getPublicHunts` **deliberately KEEPS completed hunts on the hub** while they are still
`isLive`, so the hunt stays visible for that window.

> This paragraph previously claimed the frontend auto-calls `/end` the moment every bonus has a win and
> that `getPublicHunts` excludes completed hunts. Both were stale and directly contradicted the inline
> comments in `server.js` — it cost a 2026-07-27 investigation a wrong hypothesis (that a vault entry
> added after the last slot missed the archive snapshot). The two remaining `/api/my-hunt/end` calls in
> `MyHunt.js` are the explicit reset / back-to-back-start paths, not an auto-end.

POST /api/hunts/:userId/calls               → add slot call (equity members)
PUT  /api/hunts/:userId                     → edit any hunt (editors)
POST /api/hunts/:userId/request-calls       → request call permissions
GET  /api/hunts/:userId/call-requests       → pending requests (owner)
POST /api/hunts/:userId/call-requests/:id   → grant/deny calls

GET  /api/admin/hunts                       → all hunts (admin only)
POST /api/admin/hunts/:userId/end           → force-end any hunt (admin)
DELETE /api/admin/hunts/:userId             → delete any hunt (admin)

GET  /api/slots/search?q=                   → slot autocomplete (cached 1hr)
GET  /api/bean-live                         → Twitch live status (polled 5min)
GET  /api/discord/parse-winners             → parse VIP winner results from Discord
POST /api/tickets                           → post inquiry/suggestion into the business Discord (type-routed)
GET  /api/health                            → health check

GET    /api/overdrop                        → OverDrop overlay state (mods/admins)
POST   /api/overdrop/items                  → add overlay item (image/text/video; mod-gated)
PUT    /api/overdrop/items/:id              → update item (drag/resize/edit; mod-gated)
DELETE /api/overdrop/items/:id              → remove item (mod-gated)
POST   /api/overdrop/clear                  → clear all items + audio (mod-gated)
POST   /api/overdrop/audio                  → play sound/music URL (mod-gated)
PUT    /api/overdrop/audio                  → update volume/loop (mod-gated)
DELETE /api/overdrop/audio                  → stop audio (mod-gated)
PUT    /api/overdrop/enabled                → master switch: OFF = staging, ON = live (mod-gated)
POST   /api/overdrop/upload                 → raw-body file upload, ≤30 MB (mod-gated)
GET    /api/overdrop/media/:name            → serve uploaded file (PUBLIC — OBS loads these)
```

### OverDrop (mod-controlled stream overlay)

`lib/overdrop.js` + `routes/overdrop.routes.js`. Mods/admins push images, text, sounds and video
clips onto the community's stream; OBS loads the frontend's `/:slug/overdrop/source` page, which
joins the `overdrop:<slug>` socket room via `watch:overdrop`. **Sockets are read-only for this
feature** (the socket layer is unauthenticated) — every mutation goes through the requireMod REST
routes above, which broadcast the delta to the room. State is per-tenant, in-memory only
(transient on-stream content; a deploy clearing it is expected). Media is URL-based (http/https
enforced by `safeUrl`) or uploaded via `POST /api/overdrop/upload` (raw body, mime in the
Content-Type header — no multipart dep; type whitelist + 30 MB cap in `saveUpload`). Uploads
live on the EPHEMERAL disk (`os.tmpdir()/overdrop-media`, ~24h TTL + count-cap sweep on each
upload) — same transient lifecycle as the in-memory overlay state, deliberately not an archive.
`GET /api/overdrop/media/:name` serves them publicly (OBS source has no session; strict
name-pattern check, no traversal). The `enabled` flag is the
master switch: OFF means the OBS source page renders nothing while mods stage/arrange items in
the control panel; state still broadcasts normally — only source-page rendering is gated.

## Socket.IO Events

```
hub:update              → broadcast public hunts to all clients
hunt:update             → broadcast hunt changes to watchers
hunt:reinvite           → tell watchers to re-fetch permissions
calls:request:new       → new call permission request
calls:granted           → call permission granted
calls:denied            → call permission denied
bean:live               → Twitch live status update (tenant channel)
hunts:twitchlive        → per-creator Twitch live map for the hub ({ userId: { isLive, login } })

watch:hunt              ← join hunt:<userId> — TENANT-GATED, see below
leave:hunt              ← leave that room
watch:overdrop          ← client joins overdrop:<slug> room (read-only)
overdrop:sync           → full OverDrop state on join (incl. `enabled`)
overdrop:item:add / overdrop:item:update / overdrop:item:remove / overdrop:clear
overdrop:audio:play / overdrop:audio:update / overdrop:audio:stop
overdrop:enabled        → master switch changed ({ enabled })
```

**Socket authz rules — don't regress these** (`sockets/index.test.js` pins all of them):

- **`watch:hunt` is tenant-gated.** A hunt whose `tenantOf(h)` differs from the socket's handshake
  slug is neither emitted nor joined. This mirrors `GET /api/hunts/:userId`, which got the same
  guard in the 2026-07-18 security audit (#4) — that fix closed the REST path and MISSED this one,
  so the same cross-tenant leak (non-anonymous equity names, bonuses, calls, existence of
  in-setup/offline hunts) stayed reachable over Socket.IO until 2026-07-27.
- **The tenant gate is enforced TWICE, and the second one is the real one.** `watch:hunt` can only
  check a hunt that already exists, so a socket asking to watch a Discord id with **no hunt yet**
  joins `hunt:<id>` unchecked — and socket.io room membership persists, so it would be served
  every update once that hunt was created in another tenant (found in the 2026-07-27 audit, same
  leak class as #4/BE #110 through a timing window). **`emitHuntUpdate` therefore re-checks
  `socket.data.tenantSlug` against `tenantOf(h)` at delivery** (`lib/hunts-core.js`), which is the
  point that actually carries the data. Do NOT "simplify" that back into an `io.to(room).emit(...)`
  room broadcast — a broadcast cannot filter recipients, which is why the error path there emits
  nothing rather than falling back to one. Pinned by `lib/hunts-core.tenant-broadcast.test.js`.
  Corollary: an unknown hunt id does not accrue a viewer count (nothing to verify it against).
- **`io.to('hunt:<id>').emit(...)` is banned. Use `emitToHuntRoom(id, slug, event, payload, accept)`**
  (`lib/hunts-core.js`), which applies the tenant gate per socket and takes an optional extra
  predicate. A room broadcast cannot filter recipients, so every new one silently reopens the leak
  above. Two call sites had already drifted back to a raw broadcast (2026-07-29 sweep): the
  stale-hunt janitor's end-of-sweep `hunt:update`, and the call-request list below.
- **Owner-only payloads need the `accept` predicate, not just the tenant gate** — every viewer of a
  live hunt is in the right tenant. `calls:request:new` / `calls:request:update` carry the Discord
  id, display name and avatar of everyone who asked for call permission (including the ones the
  owner DENIES), while `GET /api/hunts/:userId/call-requests` 403s exactly those people. Delivery
  now matches the frontend's `canEdit` (host / admin-mod with authority / invited editor) because
  those socket events are the request panel's ONLY data source — there is no REST fetch behind it,
  so under-delivering blanks the panel instead of merely delaying it. Pinned by
  `routes/calls.routes.test.js`.
- **Identity comes only from the verified handshake token** (`io.use`), never a client event. The
  old `identify` event let any socket claim any user id and receive the de-masked view; it is gone.
- **Viewer counting is per-socket-per-hunt.** `watch:hunt` is idempotent via a `watched` Set —
  it used to increment on every call from an UNAUTHENTICATED socket (forged hub counts) and
  register a NESTED `disconnect` listener each time (unbounded listener growth). There is now
  exactly one disconnect handler per socket. `leave:hunt` only decrements what this socket
  actually watched.
- **Sockets stay read-only.** Every mutation goes through a `require*` REST route.

## Rainbet Catalogue Reconciliation — presence ≠ playability

`scripts/reconcile_rainbet.js` (+ `lib/rainbetReconcile.js`, `lib/rainbetPlayability.js`).
**The daily cron is deliberately still disarmed** — see the comment in
`.github/workflows/reconcile-rainbet-slots.yml` for the three log lines to check before arming.

The 2026-08-01 investigation into two unplayable slugs (`avatarux-majestic-meow`,
`voltent-wazdan-bell-wizard`) found the job had **never run** in production: no entry carried a
`missingSince` stamp and `rainbet_live_names.json` had never been generated, which also means
`passesLiveGate` in `lib/slots.js` has been failing open the whole time. Three things were wrong
with the job itself, all fixed, none of them safe to undo:

- **Presence is decided by SLUG, never by name.** The games API returns `url` — the exact Rainbet
  slug. Name matching let a dead slug ride forever on a live same-name twin: 40 entries were in
  that state (`pragmatic-play-floating-dragon` masked by `…-floating-dragon-holdspin`,
  `nolimit-gopnik` by `sneaky-slots-gopnik`), across 57 collision groups covering 124 entries.
- **A provider that did not enumerate cleanly is NOT sweep-eligible.** The crawl used to `break`
  silently on a non-200, contributing zero live names for that provider — indistinguishable from
  "everything from them was delisted". The games query for `voltent` returns **HTTP 400 under every
  parameter combination the API accepts**, and Wazdan ships only under voltent, so the live set held
  zero Wazdan games. **900 entries across 13 provider tokens** (wazdan 381, isoftbet 140, gameart
  119, gamomat 92, blueprint 72, push-gaming 61, …) sat in that hole. `providersGateOk` /
  `catalogFloorOk` do NOT catch it — 56 providers and 6,844 games is a healthy-looking crawl that is
  still blind to 11.8% of the catalogue.
- **Being in the catalogue does not mean the game starts** — but the listing still decides removal.
  Stage 2 loads the game page and checks for an iframe with a real http(s) src. **If Rainbet lists a
  slug it is KEPT, even when the probe gets no session**; `alive` can rescue an unlisted entry,
  `unknown` defers, and `dead` on a listed entry is advisory only (logged, recorded in
  `rainbet_playability.json`, never acted on). The asymmetry is deliberate: a probe failure is one
  observation from one exit point, wrongly keeping a broken game costs a `no-session` the extension
  already handles, and wrongly removing a live one deletes a game until somebody hand-edits the file.
  `avatarux-majestic-meow` is therefore deliberately kept despite failing to launch from Iowa, from
  Comoros and on a live VPN'd session — flipping that is a policy call, not a bug fix.

`region_blocked` is **not** a liveness signal — it reflects the region asked about, and 3 of 5
hand-confirmed *playable* games are `region_blocked=true`. Those resolve to `unknown`, which can
never itself cause a removal.

### Crawl from a PERMISSIVE vantage — the exit point is a real variable

The games API validates `country`/`region` against the caller's **actual geo**. From the dev
machine (US/Iowa) `country=US&region=IA` was the only combination that answered — NJ, bare US, CA
and GB all 400. So the old hardcoded IA was not a choice, it was a description of one location, and
it would have 400'd from a GitHub Actions runner. The script now **observes the parameters
Rainbet's own frontend sends** and reuses them (`RAINBET_API_PARAMS` overrides). Two things this
depends on, both learned the hard way when the exit point first changed:

- The frontend issues its `games/list` call *after* the Cloudflare title clears, so the observation
  must be awaited, not read. Reading it immediately raced and silently fell back to IA.
- The providers endpoint takes a country and **rejects a region**, so it cannot reuse the games
  parameter string verbatim — hence `countryOf()`.

**Iowa is the worst possible vantage for this catalogue** and the numbers are stark. `rainbet_slots.json`
is a single global list serving every tenant's users, so it should be reconciled from the most
permissive exit available; region-blocking is a per-user display concern, not a question of
catalogue membership.

| measured 2026-08-01 | US / Iowa | Comoros (NordVPN desktop) |
|---|---|---|
| `hacksaw` games `region_blocked` | 64 of 64 | **0 of 64** |
| 6 elk-studios `region_blocked` games, launcher boots | 0 of 6 | **6 of 6** |
| catalogue the probe can adjudicate | 28.5% | ~all listed entries |

Those six elk games score a raw `dead` on page evidence from Iowa and are perfectly alive — the
`regionBlocked → unknown` guard is the only thing that stops the job condemning 4,301 healthy rows,
so **do not "optimise" it away**. What does NOT change with the exit point is listing *membership*:
both vantages produce the identical 230 sweep candidates and 900 held-back entries.

A system-wide VPN (NordVPN desktop) moves the crawl; a **browser-extension VPN does not** — the
script launches its own Chromium. For CI, `RAINBET_PROXY_SERVER` / `_USERNAME` / `_PASSWORD` are
read from the environment (never logged); without one, an Actions runner crawls from its own US
region and most verdicts go back to `unknown`.

## Slot Autocomplete

- Fetches from `slot.report` API, validates thumbnails daily, caches to `slots_cache.json`
- Pre-fetched on server startup
- Returns: `{ name, slug, provider, thumb }` objects
- Thumbnail URL: `https://slot.report/images/games/{provider}/{slug}.webp`

## Slot Catalogue Persistence — Postgres, not the file (2026-08-04)

The Rainbet catalogue lives in the **`rainbet_slots` table** (`lib/rainbetSlotStore.js`).
`rainbet_slots.json` is now only the repo-readable snapshot and the seed for a fresh database.

**Why it moved.** The scrape takes **5–7 minutes** and restarts from zero on every deploy, because
the file is reset by the Railway image. That made the catalogue hostage to deploy timing: across
**2026-08-01/02**, the two heaviest merge days on record (PRs #160–#167, containers living 2, 5, 9
and 13 minutes), the catalogue got **zero** updates, while quiet days either side managed 1–2. A
scrape that *did* finish could still lose its work to a deploy landing before the GitHub commit.

- **Boot is still the file, synchronously** (`lib/slots.js`), so the picker works from the first
  request; `adoptRainbetSlotStore({ pgPool })` swaps in the durable copy a moment later. If
  Postgres is unreachable the process simply stays on the file — the old behaviour.
- **`seedIfEmpty` only fires on an empty table**, so the committed snapshot can never overwrite a
  live catalogue that has moved ahead of it.
- **`runCheck` takes injected storage hooks** (`readExisting` / `writeResult`), defaulting to the
  file for the CLI and GitHub Actions. **They must be passed as a pair** — reading the file while
  writing the database computes the merge from a stale base, and since the write replaces the whole
  catalogue that would delete every row the file hasn't caught up with.
- **`saveAll` has a shrink floor** (50%): a run that would halve the catalogue writes nothing. A
  rejected write is also NOT mirrored to the file, committed, or made live — otherwise the guard is
  undone one layer up when the next container seeds from the bad snapshot.
- `GITHUB_PAT` is **no longer load-bearing**. Without it the repo snapshot goes stale; the
  catalogue is safe.
- **`scripts/reconcile_rainbet.js` writes through the store too**, and **fails closed without
  `DATABASE_URL`** — a file-only run would compute a good sweep, commit it, report success and
  change nothing in production, which is the quietest way this job can fail. `--file-only` opts
  into that deliberately. Its workflow passes `secrets.DATABASE_URL`; **that secret must exist
  before the schedule is armed.**
- **The reconcile job applies TARGETED deletes/marks, not a whole-catalogue replace.** It crawls
  for ~20 minutes while the in-process 10-minute sync keeps adding new releases; a replace built
  from its own read would delete every one of them. Against the file that race was at least loud
  (a git rebase conflict failed the job) — in Postgres it would have been silent.
- **`missing_since` is a column, not just a JSON key.** The mark-then-sweep grace is 3 days, so a
  store that dropped the stamp would have the 10-minute sync erase every mark within 10 minutes and
  nothing would ever be swept — while looking exactly like "no stale slots found".

## Hunt Persistence

- Postgres is the durable store. **Hunts live in `hunts_rows` and archived hunts in `archive_rows`,
  ONE ROW EACH** (`hunts_rows`: `user_id` PK; `archive_rows`: `archive_id` PK + `archived_at`).
  `hunts_kv` now holds only `shareTokens`, plus the frozen `hunts` and `archive` blobs left
  behind by the migrations.
- `hunts_data.json` is the fallback for when Postgres is **not** available: no `DATABASE_URL`
  (local dev) or writes blocked by the clobber guard. On Railway the file lands on an ephemeral
  disk that is empty after every redeploy, so production never reads it.
- `fs` and `path` requires must stay at the top of `server.js` (before any usage)

**Why one row per hunt.** The 250ms debounce capped the write RATE, but every flush still rewrote
the entire hunt map as a single JSONB value — change 50 bytes on one hunt, rewrite all of them.
That cost is paid three times: the write, the WAL it generates (which is also the PITR archive),
and the `JSON.stringify` blocking the one event loop serving every tenant. All three scale with
the number of concurrent hunts.

**Changed-ness is decided by comparing content, never by tracking dirty ids.** `persistHunts()`
has 52 call sites and takes no arguments; any scheme asking callers to name what they touched
fails silently the first time a call site is missed, and the failure is "this hunt stopped being
saved". `lastWrittenHunts` (userId → last durably written JSON string) is compared on each flush.
Two consequences worth knowing:

- **A failed write retries itself.** The baseline only advances once the write lands, so the next
  flush naturally re-sends exactly the rows that didn't. The old whole-blob write lost them until
  something else changed.
- **An unchanged flush writes nothing.** Tests asserting "a write happened" must actually mutate a
  hunt first — `flushHunts()` on unchanged state is correctly a no-op now.

**Deletion is explicit and it matters.** The blob got deletion for free: a hunt removed from the
map simply wasn't in the next write. With rows, a missed `DELETE` means the hunt **resurrects on
the next boot**. Anything in `lastWrittenHunts` that is no longer in `hunts` is deleted. This also
raises the stakes on the clobber guard — an unguarded flush against an empty `hunts` map would now
issue DELETEs rather than an empty upsert. Pinned by `lib/persistence.rows.test.js`.

**The archive got the same treatment, and needed it more.** One blob rewritten in full on every
hunt end, growing without bound (281 entries in production), and — unlike hunts — never debounced
at all, across 21 call sites. It is still not debounced: per-row diffing already removes the
amplification, and adding a timer would mean `flushAll()` has to drain it too, where a missed drain
on SIGTERM loses an archived hunt.

Two things are specific to the archive:

- **Every snapshot carries its own `archiveId`**, generated once and persisted with it.
  `sameHuntInstance()` is the in-memory notion of identity but falls back to `(user.id, startedAt)`
  when `huntId` is absent, and neither is guaranteed on older entries — a null or colliding primary
  key silently merges two hunts into one row. `archiveHunt()` REPLACES the snapshot with a fresh
  object when the same hunt is re-ended, so it **carries the id across**; regenerating it would
  orphan the old row and reintroduce the duplicate that upsert exists to prevent.
- **Order is derived, not stored.** The load does `ORDER BY archived_at DESC NULLS LAST`; storing
  positions would mean every insert rewrote every row after it.

  The in-memory array is only *nearly* sorted that way, which is worth knowing before you debug a
  "the Archived tab reshuffled" report. `unshift` puts new entries first, but `archiveHunt()`
  REPLACES in place when a hunt is re-ended (`archive[idx] = snap`) — so that entry keeps its old
  position while taking a NEW `archivedAt`. Measured against production at the migration: **8 of
  283 entries were out of order.** The first boot after the migration therefore preserves the
  blob's drifted order, and the *next* boot normalizes it to strict `archivedAt` descending. That
  is a one-time correction rather than a regression — the tab is labelled newest-first and now
  actually is — but a handful of rows visibly move once.

  `trimArchive` evicts by POSITION, so ordering also decides which entry is dropped at the cap.
  Unreachable today (283 vs a 1000 per-tenant cap), but it is why the ordering matters at all.

Deletions here are routine, not theoretical: `trimArchive` evicts past the per-tenant cap,
`unarchiveHunt` removes a reopened hunt, and both the admin delete and the janitor splice entries
out. All four used to disappear for free by not being in the next blob.

**Migration.** `hunts_rows` is read first; the `hunts_kv` blob is read ONLY when `hunts_rows` is
empty, which is either a fresh database or the single boot that migrates. That boot leaves the
baseline empty so the first flush copies every hunt across, and **does not delete the blob** — it
stays as a frozen last-known-good that a code revert can still read (stale from the migration
onward). Look for `[persist] Migrating N hunts from the hunts_kv blob into hunts_rows` in the
deploy logs; it should appear exactly once, ever.

**`persistHunts()` SCHEDULES a write; it does not perform one.** It marks state dirty and sets a
250ms trailing timer (`flushHunts()` does the work). It has 52 call sites, one of which is
`emitHubUpdate` — every hub broadcast. It used to synchronously run an O(hunts × calls) regex
dedupe over *every* hunt, `JSON.stringify(hunts)` **twice** (once for PG, once for the file), and
a blocking `fs.writeFileSync` + `renameSync`. All of that blocked the single event loop serving
every tenant, and because both the blob size and the write rate grow with concurrency, the cost
grew with its **square** — fine at 3-4 concurrent hunts, ~50x at the 20-30 the platform is
heading for.

- `flushHunts()` → write now; returns a promise that settles with the PG write. Never rejects.
- `flushAll({ timeoutMs })` → flush + wait for every in-flight write. Used by the SIGTERM handler.
- `pgHealth().huntsFlushPending` → dirty-but-unwritten. Stuck `true` means flushes aren't landing.
- **Tests must `await P.flushHunts()` after `persistHunts()`** — otherwise a "nothing was written"
  assertion passes vacuously because the timer simply hasn't fired.
- The dedupe **reassigns** `h.calls` rather than splicing. `archiveHunt` takes a *shallow* copy, so
  a live hunt and its archived snapshot share that array — mutating in place would rewrite history.
- `initPersistence({ dataDir })` overrides the JSON file locations; test suites pass a temp dir so
  parallel `node --test` files don't fight over the repo-root paths.

**Shutdown is graceful, and there is exactly ONE handler** — `installGracefulShutdown` in
`lib/shutdown.js`, wired once at the bottom of `server.js`. **Do not add a second SIGTERM/SIGINT
listener.** Two handlers both run, and whichever reaches `process.exit()` first kills the other
mid-drain; this branch originally added its own alongside the existing one, which would have lost
the debounced write on every deploy — the exact data loss both changes exist to prevent.

The handler is given `flush: () => persistence.flushAll({ timeoutMs: 5000 })`. It **must** be
`flushAll`, never `persistHunts()`/`persistArchive()` — those only SCHEDULE, so the process would
exit before the queued write ran. Registering a signal listener **overrides Node's default exit**,
so the drain must always reach `process.exit()`: `flushAll` resolves rather than rejects, takes its
own timeout, and `lib/shutdown.js` adds an unref'd backstop that force-exits a hung flush. Get that
wrong and every deploy stalls until Railway force-kills. Node on **Windows has no real SIGTERM**, so
verify this path from the Railway deploy logs, not locally. Drain order, idempotence under a second
signal, and the forced exit are pinned by `lib/shutdown.test.js`.

**The clobber guard FAILS CLOSED — don't make it permissive again.** `pgWritesBlocked` is set
`true` the moment `initPersistence` receives a pool, and cleared only when the boot read
SUCCEEDS. It is not enough to block writes after a read *fails*: `server.js` cannot await
`initPersistence` (CommonJS top level), so `server.listen()` starts serving while `hunts` is still
`{}`. A request landing in that window upserted `{}` over the row holding every live hunt — the
same incident the guard was written for, before it was armed (measured: 2.63s per boot, ~11
deploys/day). Pinned by the boot-window case in `lib/persistence.clobber.test.js`.

## Environment Variables

```
DISCORD_CLIENT_ID
DISCORD_CLIENT_SECRET
DISCORD_CALLBACK_URL
DISCORD_BOT_TOKEN              # per-tenant community bot: parse-winners
DISCORD_CALLS_CHANNEL_ID       # UNUSED since import-calls was removed; kept in the tenant schema (harmless)
DISCORD_WINNERS_CHANNEL_ID     # channel to parse VIP winner results from
DISCORD_TICKETS_BOT_TOKEN      # business bot (App 1506278609445191800) — POST /api/tickets posts here
DISCORD_TICKETS_CHANNEL_ID     # inquiries channel: Bug / Other / Community Request tickets
DISCORD_SUGGESTIONS_CHANNEL_ID # suggestions channel: "Feature Request" tickets
SESSION_SECRET
PUBLIC_ID_SECRET               # keys the opaque `owner.id` on /api/public/v1/hunts (lib/publicIds.js).
                               # Set ONCE, never rotate — consumers store that id as a foreign key.
                               # Unset falls back to SESSION_SECRET with a startup warning, which is
                               # wrong long-term because rotating SESSION_SECRET is a thing we do.
DATABASE_URL                   # PostgreSQL (Railway)
FRONTEND_URL                   # for CORS + OAuth redirect (Vercel URL)
EXTRA_ORIGINS                  # comma-separated extra CORS origins. THIS is how you make a Vercel
                               # PREVIEW deploy work: a preview's *.vercel.app origin is not
                               # allowlisted, so every credentialed call from it is refused —
                               # including /auth/me, which is why a preview looks permanently
                               # signed out. Add the specific preview URL here. Never
                               # blanket-allow *.vercel.app: anyone can deploy there and these
                               # origins receive credentials. Rules live in lib/corsPolicy.js.
TWITCH_CLIENT_ID
TWITCH_CLIENT_SECRET
ADMIN_IDS                      # comma-separated Discord IDs (defaults to owner)
ADMINS                         # legacy display-name list (less reliable, kept for compat)
VIP_HOSTS                      # comma-separated display names for VIP access
CHROMIUM_PATH                  # optional: path to system Chromium binary (Railway sets via nixpacks)
GITHUB_PAT                     # repo contents:write PAT — lets lib/rainbetSlotSync.js commit+push
                               # rainbet_slots.json. NO LONGER load-bearing (2026-08-04): the slot
                               # catalogue lives in Postgres, so without this the repo snapshot goes
                               # stale but the catalogue itself is safe.
GITHUB_REPO                    # optional: owner/repo for the push above (defaults to RandyCabbages/communityhunts-backend)
```

## Frontend Design Tokens (HuntTracker.js)

```
Backgrounds: #161618 · #1c1c1f · #222226 · #26262a · #2c2c32
Accent: #c6f135 (gold) · #4ade80 (green/gains) · #f87171 (red/losses) · #c084fc (purple)
Text: #ffffff · #e8e8e8 · #b0b0b0 · #808080
Border: rgba(255,255,255,0.15)
Font: Chakra Petch
```

## Shared UI Section Names

1. **Page Header** — logo, hunt title, action buttons
2. **Slot Calls** — left panel: call queue, + Add Call
3. **Bonus Board** — stats row: Starting Balance, People in Hunt, Call Limit, Slots Called
4. **Add Slot** — input row: slot name, caller, bet $, bonus symbols
5. **Bonus Hunt Section** — middle table: SLOT | BET | WIN | MULT
6. **Equity Section** — right panel: Starting Balance → Live Winnings → $ per Person/Bean → equity inputs
7. **Footer** — Start Hunt button

## Pending

- [ ] Community Hunt punt calculator at bottom of equity section
- [ ] Placeholder text in slot + caller name inputs
- [ ] Verify Share button captures full equity section (html2canvas + `data-equity-section`)
- [ ] Responsive/mobile pass on equity layout
