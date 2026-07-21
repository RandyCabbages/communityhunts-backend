# Banned Users — Platform Ban List

**Date:** 2026-07-20
**Repos:** communityhunts-backend, communityhunts-frontend, communityhunts-extension
**First subject:** Raph — Discord ID `693694981457838140` (took equity payouts and disappeared)

## Problem

Community hunts pay real money to equity members. A user who wins/receives money
and then disappears ("scams their community") should be cut off from the platform,
and hunt runners should be warned before they hand such a person a spot again.

## Two distinct behaviors

The ban has two independent halves. Keeping them separate is the core of the design:

1. **Hard lockout of the banned user's OWN access.** When the banned user themselves
   authenticates — website, extension, API, or socket — they are refused everywhere and
   shown a ban notice. No data, no permissions, nothing.

2. **Runner warning when the banned user is ADDED to a hunt by someone else.** A hunt
   runner writes the whole `equity` array from their own (non-banned) session, so half #1
   never fires for this. Adding a banned user is **not blocked** — instead the runner gets
   a pop-up box telling them this person has been banned for scamming, so they decide
   whether to keep them. This applies to **every** hunt type (community, mod, affiliate/VIP).

Matching is always by **Discord ID**, never display name.

## Storage — `lib/bans.js` (backend)

Mirror the existing `lib/admins.js` DI + cache pattern exactly.

- Postgres table:
  ```sql
  CREATE TABLE IF NOT EXISTS banned_users (
    discord_id TEXT PRIMARY KEY,
    reason     TEXT,                       -- short, shown to runners e.g. "scamming"
    message    TEXT,                       -- full lockout copy shown to the banned user
    banned_by  TEXT,
    banned_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  ```
- In-memory `Set` cache of banned discord_id strings + `reloadBanCache()`.
- `initBans({ pgPool })` — creates the table, seeds from env `BANNED_IDS`
  (comma-separated) via `INSERT … ON CONFLICT (discord_id) DO NOTHING`, loads cache.
  No-ops safely with no DB (logs and disables, like admins).
- Exports: `isBanned(id)`, `getBan(id)` → `{ reason, message, … }` (or null),
  `addBan(id, { reason, message, bannedBy })`, `removeBan(id)`, `listBans()`,
  `reloadBanCache()`.
- Constants:
  - `DEFAULT_BAN_MESSAGE = "You have been banned from communityhunts.gg for taking advantage of your community, please repay before you can continue."`
  - `DEFAULT_BAN_REASON  = "scamming"`
- Wire `initBans` in `server.js` next to `initAdmins`.

**Activation for Raph:** set `BANNED_IDS=693694981457838140` in Railway. No redeploy
needed to add/remove later once the table exists (managed via the DB / a future admin UI).

## Enforcement — half #1 (hard lockout of the banned user)

Every one of these paths already has `req.user` (or a verified socket identity) populated
before it runs, so each just consults `isBanned`.

1. **Global middleware `enforceBan`** — mounted after passport/session + `bearerFallback`
   populate `req.user`, before route mounting. If `req.user && isBanned(req.user.id)`:
   ```js
   res.status(403).json({ error: 'banned', banned: true,
                          message: (getBan(req.user.id)?.message) || DEFAULT_BAN_MESSAGE });
   ```
   This single gate covers the website API, the extension API, hunt start, everything the
   banned user's own token touches. **Exempt only `/auth/logout`** so they can still sign out
   and aren't trapped in a redirect loop.

2. **Discord OAuth callback** (`routes/auth.routes.js`, `/auth/discord/callback`) — after
   passport success, before issuing the token:
   `if (isBanned(req.user.id)) return res.redirect(\`${FRONTEND_URL}/?banned=1\`);`
   This is the "tries to get into Bean's hub → popup" path.

3. **Socket handshake** (`io.use` in `sockets/`) — after the token is verified and
   `socket.data.userId` is set, reject the connection when that id is banned, so live hunt
   data / calls never stream to a banned user.

## Enforcement — half #2 (runner warning when a banned user is added)

The runner needs to know a member is banned without the frontend having to hold raw
Discord IDs. Do the match server-side and expose a boolean.

1. **Annotate the runner-facing hunt payload.** In the *privileged* hunt serialization
   (owner/editor/mod view — the same branch that already carries full equity, NOT the
   public/masked view), add `banned: isBanned(e.discordId)` to each equity member. Ship
   this on both the REST editor branch (`GET /api/hunts/:userId`) and the owner socket
   broadcast. The public/anonymous serializers are unchanged — `banned` is never exposed
   publicly, and neither is `discordId`.
2. **Optionally** include `banReason` (from `getBan`) on flagged members so the box can say
   the specific reason; default to `DEFAULT_BAN_REASON`.

**Limitation (accepted):** the warning fires only when the equity row carries the banned
user's Discord ID — i.e. they were added via known-users autocomplete, an equity `link`,
or a roll, all of which attach the id. A row typed as a bare name with no id can't be
matched and won't warn. This is acceptable: real adds of a known user carry the id.

## Frontend (communityhunts-frontend)

**Banned user's own lockout:**
- `src/api.js` `apiFetch`: on `res.status === 403`, read the body; if `banned === true`,
  `clearAuth()` and `window.dispatchEvent(new CustomEvent('ch:banned', { detail: { message } }))`,
  then throw. (401 already calls `clearAuth`; this adds the 403-banned branch.)
- `BanModal` component mounted at the App root: opens on the `ch:banned` event **and** when
  `?banned=1` is present in the URL on load (the OAuth-callback path — see `App.js:91`).
  Non-dismissible; shows the message; the only action is "Sign out". Clears auth.

**Runner warning box:**
- A `useBannedMemberWarning(equity)` hook used by the runner hunt views (`MyHunt`,
  mod-hunt, affiliate-hunt). When a member with `banned: true` appears in the equity list
  (especially a newly-added one), pop a warning modal: e.g.
  *"⚠ {name} has been banned from CommunityHunts for {reason}. Handing them a spot is at
  your own risk."* Dismissible — it warns, it does not block.

## Extension (communityhunts-extension)

- In the extension's auth bridge / background fetch layer (`src/pages/Background`,
  `authBridge`), detect the same `403 { banned: true }` response: stop all work, drop the
  stored token, and render the identical ban message in the extension panel. The banned
  user loses all extension permissions and data — the 403 already strips access; this makes
  the reason visible.

## Testing

- `lib/bans.test.js` — `isBanned`/`getBan`/`addBan`/`removeBan`/`listBans`, no-DB no-op,
  `BANNED_IDS` env-seed parsing, default message/reason fallback.
- `enforceBan` unit test — banned `req.user` → 403 `{ banned:true, message }`;
  non-banned → `next()`; `/auth/logout` exempt.
- Serializer test — privileged equity view flags `banned` members by discordId; public
  view never includes `banned` or `discordId`.

## Ship path

1. Backend: `lib/bans.js` + `initBans` in `server.js` + `enforceBan` middleware + OAuth
   callback check + socket handshake check + privileged-serializer annotation + tests.
2. Frontend: `api.js` 403 branch + `BanModal` + `?banned=1` handling + runner warning hook.
3. Extension: auth-bridge/background 403 handling + panel ban message.
4. Set `BANNED_IDS=693694981457838140` in Railway to activate Raph.

## Notes

- Fully reversible: remove the row / env entry and the user is restored.
- No data is deleted — past hunts and payout records are untouched ("banned until repaid").
