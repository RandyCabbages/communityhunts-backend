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
rainbet_slots.json     ← auto-generated AND auto-committed by lib/rainbetSlotSync.js
```

Unit tests sit beside their module as `*.test.js` (`node:test`).

```bash
npm test                    # everything: lib/ + routes/ (641 tests, ~3s)
npm run test:lib            # lib only
npm run test:routes         # routes only
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
A hunt leaves "live" only automatically — the frontend auto-calls /end when every bonus has a win, or
the stale-hunt janitor (server.js) reaps it. `huntHasContent(h)` (lib/hunts-core.js) — bonuses OR a real
equity member (amount>0 or non-`creator_auto`/`bean_auto` id) OR non-solo calls — drives BOTH the hub
filter (getPublicHunts hides empty live hunts) and the janitor's 1h dead-reap (empty regular hunt idle
≥1h → delete; sweep every 10m). tracker:/__mod_hunt__/__affiliate_hunt__ keys are exempt from the 1h
reap and keep the 36h grace.
The frontend /end is best-effort (one call, no retry), so a COMPLETED hunt (every bonus opened,
`huntCompleted(h)`) is handled server-side too: `getPublicHunts` also excludes completed hunts (they
drop off the hub instantly even if still isLive), and the janitor completed-reaps them — regular hunts
only — into the archive within one ~10m sweep (see server.js cleanupStaleHunts). This is the safety net
for a closed tab or a failed /end call stranding a finished hunt as "live".

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

watch:overdrop          ← client joins overdrop:<slug> room (read-only)
overdrop:sync           → full OverDrop state on join (incl. `enabled`)
overdrop:item:add / overdrop:item:update / overdrop:item:remove / overdrop:clear
overdrop:audio:play / overdrop:audio:update / overdrop:audio:stop
overdrop:enabled        → master switch changed ({ enabled })
```

## Slot Autocomplete

- Fetches from `slot.report` API, validates thumbnails daily, caches to `slots_cache.json`
- Pre-fetched on server startup
- Returns: `{ name, slug, provider, thumb }` objects
- Thumbnail URL: `https://slot.report/images/games/{provider}/{slug}.webp`

## Hunt Persistence

- Hunts stored in `hunts_data.json` via `fs.writeFileSync` on every state change
- Survives Railway restarts
- `fs` and `path` requires must stay at the top of `server.js` (before any usage)

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
DATABASE_URL                   # PostgreSQL (Railway)
FRONTEND_URL                   # for CORS + OAuth redirect (Vercel URL)
TWITCH_CLIENT_ID
TWITCH_CLIENT_SECRET
ADMIN_IDS                      # comma-separated Discord IDs (defaults to owner)
ADMINS                         # legacy display-name list (less reliable, kept for compat)
VIP_HOSTS                      # comma-separated display names for VIP access
CHROMIUM_PATH                  # optional: path to system Chromium binary (Railway sets via nixpacks)
GITHUB_PAT                     # repo contents:write PAT — lets lib/rainbetSlotSync.js commit+push rainbet_slots.json
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
