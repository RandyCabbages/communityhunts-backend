# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

Node.js/Express backend for **BeanHunt** — a community/VIP slot bonus hunt tracker. Features: Discord OAuth, hunt state management, real-time Socket.IO events, slot autocomplete, Discord bot integration (import calls, ticket DMs, parse winners), Twitch live status, and file-based persistence. Deployed on Railway.

## Live URLs

| Resource | URL |
|---|---|
| Backend (Railway) | https://beanhunt-backend-production.up.railway.app |
| Frontend (Vercel) | https://twitchbean-hunt.vercel.app |
| Backend repo | https://github.com/RandyCabbages/beanhunt-backend |
| Frontend repo | https://github.com/RandyCabbages/beanhunt-frontend |
| Railway Project ID | `21885da4-a512-4d3c-b3ff-9d499cb82d4a` |

**Local paths:**
- Backend: `C:\Users\kylew\beanhunt-backend`
- Frontend: `C:\Users\kylew\beanhunt-frontend`

## Commands

```bash
npm start        # production (node server.js)
npm run dev      # development with auto-reload (nodemon server.js)
```

No build step — pure Node.js. Runs on port `3001` or `process.env.PORT`.

## Deploy Workflow

```bash
git pull origin main       # always pull first — Railway may be ahead of local
git add server.js
git commit -m "message"
git push origin main       # Railway auto-deploys (~1-3 min)
```

**Warning:** Each deploy restarts the server, clearing all in-memory sessions (everyone gets logged out). This is expected behavior.

```bash
git revert <hash>          # safe way to undo a pushed commit — never force-push
```

## Project Structure

`server.js` holds Express routes + Socket.IO handlers + auth. Two seams were extracted into
`lib/` (2026-06-18) to prepare for multi-tenancy:

```
server.js            ← routes, Socket.IO, auth, Passport (the bulk of the backend)
lib/persistence.js   ← hunt/archive state + Postgres hunts_kv persistence
lib/integrations.js  ← Twitch live status, beantwitch leaderboard proxy, Discord import/parse
package.json
.env                 ← secrets (never commit)
.env.example         ← config template
hunts_data.json      ← persistent hunt storage (auto-generated, don't commit)
slots_cache.json     ← slot thumbnails cache (auto-generated, 24hr refresh)
```

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

## Key API Endpoints

```
GET  /auth/discord                          → start Discord OAuth
GET  /auth/discord/callback                 → OAuth callback (Passport)
GET  /auth/logout                           → clear session
GET  /auth/me                               → current user + isAdmin/isVipHost flags

GET  /api/hunts                             → public live hunts
GET  /api/hunts/:userId                     → single hunt (permission-aware)
GET  /api/my-hunt                           → user's own hunt (auth required)
POST /api/my-hunt/start                     → create hunt (VIP-gated)
POST /api/my-hunt/golive                    → go live
POST /api/my-hunt/end                       → end hunt
POST /api/my-hunt/reset                     → reset to creating state
PUT  /api/my-hunt                           → update own hunt

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
GET  /api/discord/import-calls              → import calls from Discord channel (20min window)
GET  /api/discord/parse-winners             → parse VIP winner results from Discord
POST /api/tickets                           → send bug report via Discord DM
GET  /api/health                            → health check
```

## Socket.IO Events

```
hub:update              → broadcast public hunts to all clients
hunt:update             → broadcast hunt changes to watchers
hunt:reinvite           → tell watchers to re-fetch permissions
calls:request:new       → new call permission request
calls:granted           → call permission granted
calls:denied            → call permission denied
bean:live               → Twitch live status update
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
DISCORD_BOT_TOKEN              # for Discord API calls (tickets, import, parse-winners)
DISCORD_CALLS_CHANNEL_ID       # channel to import slot calls from
DISCORD_WINNERS_CHANNEL_ID     # channel to parse VIP winner results from
SESSION_SECRET
DATABASE_URL                   # PostgreSQL (Railway)
FRONTEND_URL                   # for CORS + OAuth redirect (Vercel URL)
TWITCH_CLIENT_ID
TWITCH_CLIENT_SECRET
ADMIN_IDS                      # comma-separated Discord IDs (defaults to owner)
ADMINS                         # legacy display-name list (less reliable, kept for compat)
VIP_HOSTS                      # comma-separated display names for VIP access
CHROMIUM_PATH                  # optional: path to system Chromium binary (Railway sets via nixpacks)
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

- [ ] Held base-games vault feature (frontend pending)
- [ ] Community Hunt punt calculator at bottom of equity section
- [ ] Placeholder text in slot + caller name inputs
- [ ] Verify Share button captures full equity section (html2canvas + `data-equity-section`)
- [ ] Responsive/mobile pass on equity layout
