# Security Audit — communityhunts-backend

**Date:** 2026-07-18
**Scope:** Express/Passport/Socket.IO multi-tenant backend. Static review only — nothing run against production, **no files changed**. This is a findings-only report; fixes to be done on a separate branch.
**Paths** are relative to `communityhunts-backend/`.

---

## TL;DR

Secrets and payments are clean. The real risk is a **repeated authorization mistake**: several routes check "are you an admin?" without checking "an admin **of the community that owns this resource?**" — plus one place that identifies people by **display name instead of Discord ID** (the exact pattern CLAUDE.md calls the #1 regression).

Most of this is low-impact **today** because full multi-tenant mode isn't switched on. **These become live holes the moment `MULTI_TENANT=true` is on.** Fix findings 1–4 before that.

**Root theme:** findings 1–4 are all the same shape — an authorization decision that trusts the *caller's own* tenant context (or their display name) instead of the *target resource's* tenant/identity. `admin.routes.js` already does this correctly with `inTenant()`; the fix is bringing the older gates up to that standard.

---

## Findings (most severe first)

### 1. HIGH — Cross-tenant hunt read/write/delete
**CWE-863 Incorrect Authorization / CWE-639 IDOR**
**Where:** `lib/auth.js:120-132` (`canEditHunt`) — consumed without tenant scoping in `routes/calls.routes.js:66,69,84,92,151,159`, `routes/hunts.routes.js:359,375`, `routes/share.routes.js:15`.

`canEditHunt(req, huntOwnerId)` returns `true` as soon as `reqIsAdmin(req)` is true. `reqIsAdmin` (`lib/auth.js:185-189`) resolves admin/mod status against **`req.tenant`** (the caller's own `X-Tenant-Slug`) — it never checks that the target hunt's `tenantId` matches. `hunts` is a single global map keyed by Discord user-id across all tenants.

Contrast: `routes/admin.routes.js:294,305,314,327,337` correctly gate every hunt mutation on `inTenant(h, req.tenant.id)`. The `canEditHunt` path is missing that guard — internal inconsistency in the same codebase.

**Failure scenario (needs `MULTI_TENANT=true`):** Mallory self-provisions community `evilco` via Stripe checkout → `createTenant` makes her its tenant admin (`lib/tenants.js:395`). She sends `X-Tenant-Slug: evilco` and calls `PUT /api/hunts/110983319176384512` (Bean's Discord ID) with a full body → `canEditHunt` → `reqIsAdmin` → `isTenantAdmin(user, evilco)` → `true` → Bean's live hunt in the `bean` tenant is overwritten/wiped. Same path reaches `DELETE /api/hunts/:userId/invite`, `POST /api/hunts/:userId/calls`, `POST /api/hunts/:userId/share-token`, and read/grant of call-permission requests on any other community. Community *mods* inherit the same reach via `reqIsMod`.

**Note:** this is the same root cause as the "Admin canEditHunt Bug" already in our notes — logged there as a UX annoyance, it's actually an authz hole from the other direction.

**Fix direction:** In `canEditHunt` (and the `reqIsAdmin` checks in `calls.routes.js`), require the target hunt's `tenantId === req.tenant.id` before honoring the admin/mod branch — mirror the `inTenant(h, req.tenant.id)` guard already used throughout `admin.routes.js`.

---

### 2. MEDIUM — Authorization by display name + identity claim on GET
**CWE-639 / CWE-290 Authentication Bypass by Spoofing** — the repo's explicitly-forbidden pattern (gate by ID, never display name).
**Where:** `lib/auth.js:133-169` (`isEquityMember`), `routes/hunts.routes.js:74-100` (auto-link on read).

`isEquityMember` matches a caller to a hunt's equity by **loose display-name comparison**, including `c.startsWith(en) || en.startsWith(c)` (`auth.js:165`). Worse, `GET /api/hunts/:userId` (`hunts.routes.js:74-100`) auto-links on read: any logged-in viewer whose display name exactly matches an equity entry gets their `discordId` written onto that entry — a persistent identity claim performed by a side-effecting GET.

**Failure scenario:** A hunt lists a non-anonymous equity member "walker". Attacker sets their Discord display name to `walker`, opens the hunt once → `hunts.routes.js:95` stamps `discordId: attacker.id` onto the "walker" row. From then on `isEquityMember` returns true via the reliable ID path, granting the attacker call-adding rights (`POST /api/hunts/:userId/calls`) and equity/payout attribution in someone else's hunt. Even without exact-match linking, the `startsWith` gate alone lets `walkerX` pass. No funds move through the app (it's a tracker), which is why it's Medium — but any logged-in user can trigger it, and it violates the ID-only rule.

**Fix direction:** Gate `isEquityMember` on `discordId`/`callsPermissions` only; drop name-variant and `startsWith` matching. If name→ID linking is kept, require an explicit owner-approved action (the call-permission-request flow already exists) rather than an implicit write on GET.

---

### 3. MEDIUM — Cross-tenant user PII exposed to any community mod/admin
**CWE-863 Incorrect Authorization**
**Where:** `routes/settings.routes.js:237-347` (`GET /api/admin/users`, `GET /api/admin/users/:userId`).

Both gated by `requireAdmin`, which folds in `reqIsMod` (`lib/auth.js:185-188`), and the query is **not tenant-scoped** (marked "INTERIM" at `settings.routes.js:234,284`). `known_users` has no tenant column, so any mod/admin of any community can list **every** user on the platform and read any profile — `rainbetName`, `twitchName`, communities, stats. The profile route returns rainbet/twitch names even for users flagged `anonymous` (the `canSeeIdentity` gate at `settings.routes.js:133` is applied on the public lookup routes but not here).

**Failure scenario:** A mod of a tiny community calls `GET /api/admin/users?q=` and `GET /api/admin/users/<anyDiscordId>` and harvests rainbet/twitch handles of users who never joined their community and marked themselves anonymous.

**Fix direction:** Scope these lists/profiles to the caller's tenant (via `community_members`) and/or restrict to `requirePlatformAdmin`; apply the `anonymous` redaction to the admin profile route too.

---

### 4. MEDIUM — Live hunt readable across tenants
**CWE-639 Authorization Bypass Through User-Controlled Key**
**Where:** `routes/hunts.routes.js:67-114`.

The live single-hunt route reads `hunts[req.params.userId]` and returns `publicHuntView(...)` with **no** `inTenant` check — unlike its archived sibling at `hunts.routes.js:63` which correctly enforces `inTenant(found, req.tenant?.id)`. `publicHuntView` strips secrets and masks anonymous members, but non-anonymous equity names, bonuses, calls, and the existence of in-setup/offline hunts (which never appear on any hub) leak across tenant boundaries to anyone who knows a Discord ID.

**Fix direction:** Add the same `inTenant(hunt, req.tenant?.id)` guard the archived route already uses; 404 otherwise.

---

### 5. MEDIUM — Discord bot token substrings written to logs
**CWE-532 Insertion of Sensitive Information into Log File**
**Where:** `routes/integrations.routes.js:82` (`tokenStart=${discordBotToken.slice(0,20)}`), `lib/integrations.js:185` (`token.slice(0,10)…`); plus role/guild-id debug logs at `server.js:90,124`.

Per-tenant Discord bot tokens are partially logged to stdout (Railway logs) on every parse-winners/import call. The first 20 chars expose the bot's user-id segment plus part of the timestamp segment; with log retention/access this needlessly narrows a live secret that grants control of the community's bot.

**Fix direction:** Log only a boolean `hasToken`/length — never any slice of the value. Rotate any tenant bot token that has appeared in shipped logs (Discord Developer Portal); removal from code does not un-leak what logs already captured.

---

### 6. LOW — CORS reflects any browser-extension origin with credentials
**CWE-942 Permissive Cross-domain Policy with Untrusted Domains**
**Where:** `server.js:26-35,167` — reflects any `chrome-extension://` / `moz-extension://` origin with `credentials: true`.

Any installed extension (not just CommunityHunts') gets an `Access-Control-Allow-Origin` reflection plus `Allow-Credentials: true`, so a malicious extension can make cookie-authenticated calls on the user's behalf. Bounded impact (an extension with host permissions can already act broadly), hence Low.

**Fix direction:** The extension authenticates by HMAC Bearer token, not cookies — reflect the extension scheme with `credentials:false`, or pin known extension IDs.

---

### 7. LOW / INFORMATIONAL
- **`SESSION_SECRET` silent random fallback** (`server.js:40-43`): if unset in prod, a per-boot random secret is used. Fails *safe* (not a known default, so tokens aren't forgeable) but silently logs everyone out each deploy and disables the Bearer fallback across restarts. Ensure it's set in Railway. (CWE-1188)
- **No rate limiting on expensive authenticated proxy endpoints** (`GET /api/leaderboard`, `GET /api/discord/import-calls`, `GET /api/discord/parse-winners` in `routes/integrations.routes.js`): each fans out to upstream Discord/beantwitch. Auth-gated and cached, so low risk, but a logged-in user can drive repeated upstream fetches. (CWE-770) The public tickets route (`misc.routes.js:64-68`) and the public API (`lib/rateLimit.js`) are correctly throttled.

---

## What passed (verified clean)

- ✅ **No hardcoded secrets.** `SESSION_SECRET`, `STRIPE_*`, `DISCORD_BOT_TOKEN`, `DATABASE_URL`, `GITHUB_PAT` all read from env. `.env` gitignored and untracked; only `.env.example` committed.
- ✅ **Stripe webhook verified correctly** — `express.raw()` before JSON parser (`server.js:171`), `stripe.webhooks.constructEvent(rawBody, sig, secret)` (`lib/stripe.js:221-225`), replay-guarded via `stripe_events`.
- ✅ **Bearer token scheme sound** — HMAC-SHA256, length-checked `crypto.timingSafeEqual`, expiry enforced (`lib/auth.js:103-114`). No algorithm confusion.
- ✅ **Public Developer API tiers enforced per-route** (`requireApiFeature` on every route, `routes/public.routes.js`); PII stripped — `publicStats` drops `topHunters`/`biggestHits` (`lib/publicSerializers.js:65-77`).
- ✅ **SQL fully parameterized** (`lib/statsStore.js`, `lib/tenants.js`, `routes/settings.routes.js`), incl. the `:huntKey` admin path.
- ✅ **Tenant role checks are ID-based** (`lib/tenants.js` `isTenantAdmin/Vip/Mod` key on `user.id`). Overdrop upload/serve traversal-safe (strict name regex, `lib/overdrop.js:215`).

---

## Summary table

| # | Sev | Finding | CWE | Location |
|---|-----|---------|-----|----------|
| 1 | HIGH | Cross-tenant hunt read/write/delete — `canEditHunt`/`reqIsAdmin` ignore hunt's `tenantId` | 863 / 639 | `lib/auth.js:120-132`; `calls.routes.js`, `hunts.routes.js:359,375`, `share.routes.js:15` |
| 2 | MED | Display-name equity authz + auto-link identity claim on GET | 639 / 290 | `lib/auth.js:133-169`; `hunts.routes.js:74-100` |
| 3 | MED | Cross-tenant user PII to any mod/admin (`/api/admin/users*` not tenant-scoped) | 863 | `settings.routes.js:237-347` |
| 4 | MED | Live hunt readable across tenants (missing `inTenant`) | 639 | `hunts.routes.js:67-114` |
| 5 | MED | Discord bot token substrings logged | 532 | `integrations.routes.js:82`; `integrations.js:185` |
| 6 | LOW | CORS reflects any extension origin w/ credentials | 942 | `server.js:26-35,167` |
| 7 | LOW | `SESSION_SECRET` fallback; no rate-limit on proxy endpoints | 1188 / 770 | `server.js:40`; `integrations.routes.js` |

---

## Suggested fix order

1. **#1** — hunt edit/delete tenant check (worst impact; already partly diagnosed in the "Admin canEditHunt Bug" note).
2. **#2** — stop matching by display name (breaks our own #1 rule; any logged-in user can trigger).
3. **#3 & #4** — scope admin lists and hunt views to the correct community (privacy leaks).
4. **#5** — stop logging bot tokens, then rotate them.

#1–#4 share the fix pattern: **check the target resource belongs to `req.tenant.id`, and identify people by Discord ID — never by name.** Copy the `inTenant()` pattern already used in `admin.routes.js`.

**No code changes were made in producing this report.**
