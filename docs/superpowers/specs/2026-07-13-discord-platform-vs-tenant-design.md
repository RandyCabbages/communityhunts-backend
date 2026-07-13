# Discord Integrations — Platform-vs-Tenant Bot Resolution (Multi-Tenant Future-Proofing) — Design

**Date:** 2026-07-13
**Status:** Approved
**Repo:** communityhunts-backend (backend-only)
**Supersedes:** the token-resolution approach in commit `2b3b865` (Cabbage's tickets fix — tenant-first)
**Related:** `2026-07-13-card-requests-discord-phase-design.md`, `discord-one-bot-rule` memory

## Problem

Discord posting splits into two kinds that were never cleanly separated:

- **Platform-level** — tickets, feature-requests, shop-requests, platform announcements. These post
  to **communityhunts.gg's own** Discord channels (global env channel IDs) and must use the
  **platform bot**.
- **Per-tenant** — call-import, winner-parse, role gating. These post to **each streamer's own**
  Discord using that tenant's own bot + channels (`req.tenant.*`). Already correct.

All four platform integrations currently resolve the bot token from `req.tenant.discordBotToken`
(env fallback). Commit `2b3b865` made tickets do this explicitly. It **works only because Bean is
the platform tenant** — for any other tenant, a ticket submitted from their hub (`/:slug`, which
sets `req.tenant` to that streamer) would post with **the streamer's own bot** into
communityhunts.gg's channel → the streamer's bot isn't in that server → **403**. It breaks for
every non-Bean tenant that has its own bot (i.e. anyone using call-import/winner-parse).

Second problem: the platform-bot token lives in **two drifting places** — Railway env
`DISCORD_BOT_TOKEN` (also the *seed* for Bean's tenant-DB token) and Bean's tenant-DB
`discord_bot_token` (admin-panel-managed). They've diverged and caused **two prod 401 outages**
(announcements 2026-07-08, tickets 2026-07-13).

## Locked decisions

1. **Platform-bot token source of truth = the platform tenant (Bean)'s DB token**, admin-managed;
   env `DISCORD_BOT_TOKEN` is only a seed/fallback. Ends the drift (one managed home).
2. **Platform notifications stay centralized** in communityhunts.gg's Discord (global env channels).
   A new tenant configures **nothing** platform-level.
3. **Scope = backend code fix + onboarding runbook now.** The admin Discord-config **UI page** is a
   separate follow-up (the `fetch/updateDiscordConfig` API exists but no page renders it).
4. **Announcements are platform-level** (patch notes, one global channel, platform-admin publish) →
   always the platform bot. Reversible later if per-community announcements to a streamer's own
   Discord are ever wanted (out of scope now).

## Architecture — two explicit axes

**Platform integrations resolve the bot through one helper and never read `req.tenant`:**

- `lib/tenants.js` adds **`getPlatformBotToken()`** → the platform tenant (Bean)'s
  `discordBotToken`, falling back to `process.env.DISCORD_BOT_TOKEN`, trimmed:

  ```js
  // Platform-level Discord token (tickets, feature-requests, shop-requests, platform announcements).
  // ALWAYS the platform tenant (Bean) — never req.tenant, which for a ticket from a streamer's hub
  // would be that streamer's own community bot. Env DISCORD_BOT_TOKEN is only seed/fallback.
  function getPlatformBotToken() {
    const platform = getTenantBySlug('bean') || BEAN_TENANT;
    return ((platform && platform.discordBotToken) || process.env.DISCORD_BOT_TOKEN || '').trim();
  }
  ```

  Reads the live cached Bean tenant, so an admin-panel token update takes effect after
  `reloadCache()` without a redeploy. Exported from the module.

**Per-tenant integrations are unchanged** — `req.tenant.discordBotToken` + that tenant's channels
stay exactly as they are (call-import, winner-parse, role gating). This is the correct axis for them.

## Backend changes

1. **`lib/tenants.js`** — add + export `getPlatformBotToken()`.
2. **`routes/misc.routes.js`** — replace the `((req.tenant && req.tenant.discordBotToken) ||
   ENV_BOT_TOKEN).trim()` line (from `2b3b865`) with `const botToken = getPlatformBotToken();`;
   drop the module-level `ENV_BOT_TOKEN`; take `getPlatformBotToken` from deps; update the comment.
3. **`routes/cardRequests.routes.js`** — POST (line ~69) and PUT (line ~106) use
   `getPlatformBotToken()` instead of `(req.tenant && req.tenant.discordBotToken) || envBotToken`;
   swap the `envBotToken` dep for `getPlatformBotToken`.
4. **`routes/announcements.routes.js`** — line 60 uses `getPlatformBotToken()` instead of
   `(req.tenant && req.tenant.discordBotToken) || envBotToken`; swap the dep.
5. **`server.js`** — pass `getPlatformBotToken: tenants.getPlatformBotToken` into the misc,
   cardRequests, and announcements router deps; remove the now-unused `envBotToken` from the latter
   two. (misc.routes gains the dep alongside its existing `{ hunts, archive }`.)

No frontend changes.

## Testing

- **`routes/misc.routes.test.js`** — rewrite Cabbage's two tests (which pin the wrong tenant-first
  order) to inject a stub `getPlatformBotToken: () => 'platform-token'` into the router deps and
  assert:
  - **Regression guard (the multi-tenant bug):** with `req.tenant = { id: 'streamerX',
    discordBotToken: 'streamer-x-token' }`, the Discord call's `Authorization` header is
    `Bot platform-token` — **not** `Bot streamer-x-token`. This is the assertion that would have
    caught `2b3b865`.
  - With no `req.tenant`, still `Bot platform-token`.
  - When `getPlatformBotToken()` returns `''` → 500 "Discord bot not configured".
  - Channel routing unchanged: Feature Request → suggestions channel, else tickets channel.
- **`lib/tenants.js`** — if a `lib/tenants.test.js` harness is practical, add a direct
  `getPlatformBotToken` test (Bean DB token preferred; env fallback when Bean's is empty). If the
  tenants cache is awkward to bootstrap in isolation, the route-level stub tests above are the
  authoritative coverage and the lib test may be skipped — do not fake a passing lib test.
- `node --test lib/*.test.js routes/*.test.js` green. Deploy backend-first (Railway auto-deploy).

## New-tenant onboarding runbook

**Platform side (one-time, already done):** platform bot in communityhunts.gg's Discord with post
access to the 4 platform channels; Bean's tenant-DB `discordBotToken` = the valid token; Railway
`DISCORD_BOT_TOKEN` = same value (seed/fallback); the 4 `DISCORD_*_CHANNEL_ID` envs set.

**Per new streamer tenant** — set via `PUT /api/admin/discord-config` (platform-admin, while on
that tenant's slug). **Per-tenant only; nothing platform-level:**
- `discordBotToken` — their community bot's token (only if they use call-import/winner-parse; optional)
- `discordGuildId` + `discordAffiliateRoleId` / `discordVipRoleId` / `discordModRoleId`
- `discordCallsChannelId`, `discordVipWinnersChannelId`, `discordAffiliateWinnersChannelId`
- Their bot must live in **their** Discord with access to **their** channels.
- Tickets / feature-requests / shop-requests / announcements need no per-tenant setup — they route
  to communityhunts.gg via the platform bot automatically.

## Coordination

`2b3b865` is on shared `main` and is Cabbage's work. Ship this as a branch + PR whose description
explains the multi-tenant regression it corrects (link this spec) rather than a silent revert; let
Cabbage review before merge. No Claude attribution in commits/PR (repo rule).

## Out of scope

- Admin Discord-config UI page (separate follow-up).
- Per-community announcements / per-tenant support channels (centralized decision stands).
- Any change to the per-tenant call-import / winner-parse / role-gating paths.
