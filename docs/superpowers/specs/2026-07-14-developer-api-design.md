# CommunityHunts Developer API — Design

**Date:** 2026-07-14
**Status:** Approved (design), hardened via backend-architect review, pending implementation plan
**Spans:** backend (`communityhunts-backend`, the bulk) + frontend admin page (`communityhunts-frontend`). **Backend-first deploy.**

> **Architect review incorporated (2026-07-14).** Corrections folded in: real plan ladder (`free < starter < pro < partner`, no `creator`); gate via existing `canUse()`/`FEATURES`; public router mounted **before** the session/tenant middleware; own `*`/no-credentials CORS; admin routes exclude mods; serializers mask anonymous members; `/hunts/:id` scans by real `huntId`; `/stats` + `/bangers` use real tenant-scoped sources; `last_used_at` throttled + positive key cache; deactivated (`isActive=false`) tenants rejected; idempotent unique index; public error-envelope middleware.

## Problem

Community owners want to pull **their own community's** hunt data out of CommunityHunts programmatically — for spreadsheets, bots, overlays, and stats dashboards. Today the only read paths are the app's own session-authed endpoints and the unauthenticated tenant-scoped public reads; there is no per-community credential, no tiering, no rate limiting, and no developer-facing contract or docs.

This adds a professional, tiered, read-only **Developer API**, modeled on bonushunt.gg's Developer API page (single key, `Authorization: Bearer`, rate-limit card, `/api/public/*` endpoints, copy-as-markdown docs) and extended with **tiered access** they don't have.

## Consumer & trust model

The consumer is a **streamer/mod pulling their own community's data** — NOT an open third-party developer platform. So keys are issued **per community**, scoped to that community's data only, managed by the **community owner or a platform admin** (not mods), read-only in v1.

## Core decisions (locked)

1. **Key model:** one active key per community, managed by owner + platform admin.
2. **Tier gating:** gated through the existing feature system. API access needs community plan **`pro`**; premium endpoints need **`partner`**. (Marketing "Creator" = internal `starter`, "Pro" = `pro`, "Partner" = `partner`; `free`/`starter` get no API.)
3. **Methods:** read-only (GET) in v1.
4. **Approach:** a dedicated `/api/public/v1/*` layer with its own key-auth, tier gate, rate limiting, CORS, error envelope, and **stable serialized shapes** — NOT key-auth bolted onto internal endpoints. The public contract is decoupled from internal storage so internal refactors don't break developers and no internal fields (Discord IDs, editor lists, permission arrays) leak.

## Tier gating — use the existing `canUse()`, do NOT invent a ladder

`lib/features.js` already owns `COMMUNITY_RANK = { free:0, starter:1, pro:2, partner:3 }` and `canUse(featureName, individualTier, tenantPlan)`. Add two features (mirrored in the frontend `src/auth/features.js`):

```js
developer_api:         { community: 'pro',     individual: null },  // base endpoints + key issuance
developer_api_premium: { community: 'partner', individual: null },  // got-in, bangers, leaderboard
```

- Base endpoints + key generation gate on `canUse('developer_api', null, tenant.plan)`; premium on `canUse('developer_api_premium', null, tenant.plan)`.
- **`individual: null`** — this is a *community-plan* capability only; an individual subscription never unlocks a community's API (it's the tenant's data/perk).
- **On the `normalizePlan` `pro` fallback:** `normalizePlan()` returns `pro` for an unset/unknown plan, so an unconfigured community reads as `pro` and *can* generate a base key. This is **accepted and intentional** — it is the platform's existing behavior for every `pro`-gated feature (obs_overlay, share, co_edit; Bean's tenant is `pro`), and the API only ever exposes a community's **own** data to its **own** owner, who must **manually generate** the key first. We deliberately do NOT add a stricter "explicit pro" rule for the API alone — that inconsistency would be more surprising than the existing fallback. (Flagged by the architect; resolved toward platform consistency.)

## Non-goals (YAGNI)

- No writes (no slot-request / guess-the-balance POSTs). Read-only v1.
- No open third-party signup / OAuth client-credentials.
- No multi-key / named / per-scope keys. One active key per community; **revoke = delete the row** (no `revoked` state machine).
- No per-key custom rate limits (limits are a function of tier only).
- No distributed rate-limit store (in-memory per-key; resets on deploy — acceptable). No Redis, no bcrypt/argon2 for keys, no OpenAPI generator, no per-request audit table.

## Security properties (must hold)

- **Tenant derived from the key, never from the request.** The public layer is mounted **before** `resolveTenant`/session/passport and ignores `X-Tenant-Slug`. A key can only ever read its own community's data.
- **Key-only auth on `/api/public/*`.** No session cookies, no `req.user`, no Bearer-session-token acceptance on this layer.
- **Keys hashed at rest** (SHA-256, optional `API_KEY_PEPPER` → HMAC-SHA256). Persist only the hash + a display prefix + metadata. Raw key shown exactly once at generation (`Cache-Control: no-store` on that response); masked thereafter. Never log the raw key; never `===` a raw key in JS (indexed hash equality sidesteps timing; if any in-process compare appears, use `crypto.timingSafeEqual` like `verifyToken`).
- **Deactivated communities fail closed.** `requireApiKey` resolves the **live cached tenant** each request and rejects `isActive === false` (a cancelled sub sets this via the Stripe deactivate hook) — never trust a plan/status snapshot stored with the key.
- **Cross-tenant reads impossible.** `/hunts/:id` matches by real `huntId` and verifies `tenantOf(hunt) === apiTenant.id` → 404 otherwise.

## Architecture

### Key storage & lifecycle — `lib/apiKeys.js`

Postgres table (idempotent create + **idempotent unique index**, mirroring `statsStore.js`):

```sql
CREATE TABLE IF NOT EXISTS tenant_api_keys (
  tenant_id    TEXT PRIMARY KEY,      -- one active key per community
  key_hash     TEXT NOT NULL,         -- sha256|hmac(rawKey); looked up by equality
  key_prefix   TEXT NOT NULL,         -- display: "ch_live_df2ea8ab…1358"
  created_by   TEXT NOT NULL,         -- Discord id
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_tenant_api_keys_hash ON tenant_api_keys(key_hash);
```

No `revoked` column — **revoke deletes the row** (lookup then finds nothing → 401). `initApiKeys({ pgPool })`. Exports:
- `generateKey(tenantId, createdBy) → { rawKey, prefix }` — `rawKey = 'ch_live_' + crypto.randomBytes(32).toString('base64url')`; **upserts** the row (replacing any existing = roll); invalidates the positive cache for the old hash. Returns rawKey ONCE.
- `getKeyMeta(tenantId) → { prefix, createdAt, lastUsedAt } | null` — for the admin card; never returns raw key or hash.
- `revokeKey(tenantId) → bool` — deletes the row + cache entry.
- `lookupByRawKey(rawKey) → { tenantId } | null` — hashes, matches by indexed equality; on hit, **throttled** `last_used_at` update (in-memory `Map<tenantId, ms>`, skip if written < 60s ago; fire-and-forget). Backed by a **positive cache** `Map<keyHash, { tenantId, at }>` (TTL ~30–60s) invalidated on roll/revoke, so most requests skip the DB entirely and survive a brief Postgres blip.

### Auth + tier middleware

- `requireApiKey(req, res, next)` — parse `Authorization: Bearer ch_live_…`; `lookupByRawKey`; on miss/invalid → `401 { error: { code:'unauthorized' } }`. Resolve the **live tenant object** (`tenants.getTenantById(tenantId)` — see below); if missing or `isActive===false` → `403 { error:{ code:'forbidden' } }`. Set `req.apiTenant` (tenant object) + `req.apiTier` = `req.apiTenant.plan` (already normalized in the tenants cache — **do not re-normalize**). On a Postgres/infra error during lookup (not a bad key) → `503 { error:{ code:'unavailable' } }` + `Retry-After`.
- `requireApiFeature(featureName)` — factory; `canUse(featureName, null, req.apiTier)` else `403 { error:{ code:'forbidden_tier' } }`. Base routes use `requireApiFeature('developer_api')`; premium use `requireApiFeature('developer_api_premium')`.

`lib/tenants.js` today exports only `getTenantBySlug` (slug-keyed cache). **Add `getTenantById(id)`** (P3) so a key's `tenant_id` resolves to the live cached tenant without storing a mutable slug in the key row.

### Rate limiting — `lib/rateLimit.js`

Per-key limiter keyed by **`tenant_id`** (so rolling a key doesn't reset the window mid-period). Dual fixed-window counters — **per-minute AND per-hour** — enforced together; the **tighter remaining** is reported. Tier → limits:
- **pro:** 100/min, 2,000/hr
- **partner:** 300/min, 10,000/hr

Runs after `requireApiKey`. Sets `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset` (epoch seconds) on every response. On exceed → `429 { error:{ code:'rate_limited' } }` + `Retry-After` (seconds). A periodic sweep evicts idle keys so the `Map` can't grow unbounded. Restart resetting windows is acceptable (locked).

### Stable serializers — `lib/publicSerializers.js`

Pure whitelist functions (decoupled from storage; a new internal field can NOT auto-leak). **Anonymous equity members are masked** the way share links do — apply `settings.isAnonymousUser` (as `publicHuntView`/`maskEquityMember` do in `hunts-core.js`), because the public API has no viewer identity and the owner may pipe the response somewhere public:
- `publicHunt(hunt)` → `{ id (huntId), status, createdAt, endedAt, currency, startBalance, endBalance, totalWon, bonusCount, bonuses:[{ slot, provider, bet, win, multiplier, order }], equity:[{ name /* masked if anonymous */, amount, sharePct }], callers?:[…] }` — NO Discord IDs, editor lists, permission fields.
- `publicStats(stats)` → community rollups (totals, best/worst, avg multiplier, profit, top slots) — masked/whitelisted.
- `publicGotIn(row)` → `{ slot, provider, caller /* masked if anonymous */, bet, huntId, at }`.
- `publicBanger(b)` → `{ slot, provider, multiplier, win, huntId, at, replayUrl? }`.

### Public endpoints — `routes/public.routes.js`

Own `express.Router` with its **own CORS** (`Access-Control-Allow-Origin: *`, **no** credentials, allow `Authorization` header + `GET,OPTIONS`) and, at the end, its **own error middleware** serializing uncaught throws to `{ error:{ code:'server_error', message } }` (the global handler returns a bare string — wrong shape). Every route: `requireApiKey` → `rateLimit` → (`requireApiFeature`) → handler → serializer.

| Method | Path | Gate | Backing source |
|---|---|---|---|
| GET | `/api/public/v1/hunts` | `developer_api` | `getPublicHunts(tid)` + `getArchivedHunts(tid)`; `?status=live\|archived\|all` (default all), paginated |
| GET | `/api/public/v1/hunts/:id` | `developer_api` | scan `Object.values(hunts)` + `archive` for `huntId===id`; verify `tenantOf===apiTenant.id` → else 404 |
| GET | `/api/public/v1/stats` | `developer_api` | `huntsCore.getHuntStats(tid)` (community rollup — confirm exact shape in impl; NOT the per-user `statsStore`) |
| GET | `/api/public/v1/got-in` | `developer_api_premium` | `getGotInLog(tid)`; paginated, optional `?from&to` |
| GET | `/api/public/v1/bangers` | `developer_api_premium` | **extract** `collectBangers(hunts, archive, tid)` into `lib/bangers.js` (the `/api/bangers` logic is currently inline in `routes/misc.routes.js`; mirror the `lib/hallOfFame.js` extraction) |
| GET | `/api/public/v1/leaderboard` | `developer_api_premium` | **phase-2** — ships with the leaderboard feature |

**Pagination:** `?limit` (default 25, **cap 100**), `?offset` (clamp ≥0). Response `{ data:[…], pagination:{ limit, offset, total } }`. Single: `{ data:{…} }`. Errors: `{ error:{ code, message } }` with matching status.

**Caching headers:** `Cache-Control: no-store` for live `/hunts`; short `max-age` + `ETag` (Express default weak ETag) for `/stats` and archived reads.

### Admin key management — `routes/apiKeys.routes.js`

Session-authed (NOT key-authed); tenant from `X-Tenant-Slug` as usual. **Gate excludes mods** — use `isPlatformAdmin(req.user) || tenants.isTenantAdmin(req.user, req.tenant)` (owner = tenant admin), NOT `requireAdmin` (which folds mods in via `reqIsMod`). Also require `canUse('developer_api', null, req.tenant.plan)` so only Pro+ can generate (Creator/free → 403 → UI upgrade CTA).
- `GET /api/admin/api-key` → `getKeyMeta` (masked) + this tenant's tier limits + `qualifies` flag.
- `POST /api/admin/api-key` → `generateKey` (create or roll); returns the raw key ONCE (`Cache-Control: no-store`).
- `DELETE /api/admin/api-key` → `revokeKey`.

### Wiring — `server.js`

Mount the public router **early** — right after `helmet` + `express.json` (~line 151), **before** `session`/`passport`/the Bearer fallback/`resolveTenant` — so it structurally never receives a session, `req.user`, or a header-derived `req.tenant`. `apiKeys.initApiKeys({ pgPool })` next to the other lib inits; `apiKeys.routes` mounts with the normal admin stack (it IS session-authed).

## Frontend — Developer API admin page

`src/admin/DeveloperApi.js`, tab `/:slug/admin/api` (both admin route trees; sidebar entry gated to owner + platform admin). Mirrors the bonushunt screenshot: **key card** (masked key + `Active`, Roll, Revoke, `Authorization: Bearer` hint; on generate/roll reveal the raw key once in a copy box with a "you won't see this again" warning), **rate-limits card** (this tenant's tier limits), **endpoints list** from `src/admin/apiEndpoints.js` (method, path, title, tier badge, params, example response) with a GET/POST filter, expandable details, and **Copy as Markdown**. Non-qualifying (Creator/free) communities see an upgrade CTA instead of the key card (`canUse('developer_api', …)` mirrored in `src/auth/features.js`). `adminApi.js`: `getApiKey`, `rollApiKey`, `revokeApiKey`.

## Data flow

```
Owner → /:slug/admin/api → adminApi → GET/POST/DELETE /api/admin/api-key
                                       → lib/apiKeys (tenant_api_keys)
Developer → GET /api/public/v1/hunts  (Authorization: Bearer ch_live_…)
   → [mounted pre-session] requireApiKey (tenant from key; live tenant; isActive check)
   → rateLimit (by tenant_id, tier limits) → requireApiFeature
   → getPublicHunts/… → publicSerializers (anon-masked, whitelisted) → { data, pagination }
```

## Error handling & edge cases

- Missing/malformed/unknown/rolled/revoked key → 401 `unauthorized`.
- Valid key, deactivated tenant → 403 `forbidden`. Valid key, insufficient tier → 403 `forbidden_tier`.
- Postgres down during lookup (valid key) → 503 `unavailable` + `Retry-After` (mitigated by the positive cache) — NOT a misleading 401.
- Rate exceeded → 429 `rate_limited` + `Retry-After`; `X-RateLimit-*` on every response.
- `/hunts/:id` for another tenant's hunt or a bad id → 404 (never index `hunts[param]`; match real `huntId` + tenant check).
- `X-Tenant-Slug` on a public request → ignored (router mounted before `resolveTenant`).
- Anonymous equity members → masked in every serializer.
- Uncaught throw on `/api/public/*` → public error middleware returns the documented envelope, not a bare string.

## Testing

- **Backend `node --test`:**
  - `lib/apiKeys.test.js` — generate→lookup round trip; roll invalidates old raw key + cache; revoke (delete row) → lookup null; hash ≠ raw; prefix masks.
  - `lib/rateLimit.test.js` — under-limit passes, over-limit 429, minute-vs-hour tighter-wins, remaining/reset math, keyed by tenant_id (roll mid-window doesn't reset).
  - `lib/publicSerializers.test.js` — output whitelist ONLY (assert no `discordId`/`invitedEditors`/permission keys); anonymous member → masked name.
  - `lib/bangers.test.js` — `collectBangers` tenant-scoping (after extraction).
- **Manual (local boot + curl):** generate key via admin route → `curl -H "Authorization: Bearer …" /api/public/v1/hunts` → `{data,pagination}`; no/bad key → 401; `free`/`starter` tenant → 403; premium endpoint on a `pro` tenant → 403; `X-Tenant-Slug` spoof ignored; deactivated tenant → 403.
- **Frontend:** `CI=true npm run build` → "Compiled successfully". Branch preview: generate/roll/revoke, one-time reveal, copy-as-markdown, GET/POST filter, upgrade CTA on a non-qualifying tenant.

## Rollout & phasing

Backend-first (Railway) before the frontend page. Phases (each independently shippable):
1. **Key infra** — `lib/apiKeys.js` + `tenant_api_keys` + `tenants.getTenantById` + `routes/apiKeys.routes.js` + admin key card (generate/roll/revoke) + the two `FEATURES` entries (backend + frontend).
2. **Base endpoints** — early-mounted `routes/public.routes.js` (CORS + error middleware) + `requireApiKey`/`requireApiFeature` + `lib/rateLimit.js` + `publicSerializers` + `/hunts`, `/hunts/:id`, `/stats`.
3. **Premium endpoints** — extract `lib/bangers.js`; `/got-in`, `/bangers` behind `developer_api_premium`.
4. **Docs page polish** — endpoint list, GET/POST filter, copy-as-markdown.
5. **Deferred:** `/leaderboard` ships with the leaderboard feature.

## Tunable defaults (locked unless changed)

- Base path `/api/public/v1/` (breaking changes → `/v2/`). Key prefix `ch_live_`.
- Rate limits: pro 100/min + 2,000/hr; partner 300/min + 10,000/hr.
- Pagination default 25, cap 100.

## Files

**Backend (new):** `lib/apiKeys.js`, `lib/rateLimit.js`, `lib/publicSerializers.js`, `lib/bangers.js` (extracted), `routes/public.routes.js`, `routes/apiKeys.routes.js` (+ `*.test.js` for apiKeys/rateLimit/publicSerializers/bangers).
**Backend (edit):** `server.js` (early public mount + inits), `lib/features.js` (`developer_api` + `developer_api_premium`), `lib/tenants.js` (`getTenantById`), `lib/auth.js` (`requireApiKey`/`requireApiFeature` — or house them in `lib/apiKeys.js`), `routes/misc.routes.js` (call the extracted `collectBangers`).
**Frontend (new):** `src/admin/DeveloperApi.js`, `src/admin/apiEndpoints.js`.
**Frontend (edit):** `src/auth/features.js` (mirror the two features), `src/admin/adminApi.js` (3 calls), `src/App.js` (2 route registrations), `src/admin/AdminLayout.js` (sidebar entry).
