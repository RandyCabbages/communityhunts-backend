# CommunityHunts Developer API Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A tiered, read-only, per-community Developer API (`/api/public/v1/*`) with self-serve key management, so streamers can pull their own community's hunt data programmatically.

**Architecture:** A dedicated `/api/public/*` router mounted BEFORE the session/tenant middleware, authed by a per-community hashed API key (tenant derived from the key, never the request), tier-gated through the existing `canUse()`/`FEATURES` system, rate-limited in-memory per tenant, and serialized through stable whitelists that reuse the app's existing redaction (`publicHuntView`/`huntSummary`). Keys are managed from a session-authed admin page.

**Tech Stack:** Node.js + Express, Postgres (`pg`), `node:test`; React CRA frontend.

## Global Constraints

- **Two repos.** Backend `communityhunts-backend/` (remote `RandyCabbages/communityhunts.gg-backend`), frontend `communityhunts-frontend/` (remote `GooferG/communityhunts-frontend`, shared `main`). Git inside each subdir; `git pull --ff-only` before push.
- **Backend-first.** Deploy backend before the frontend page consumes it.
- **No Claude attribution in commits/PRs.**
- **Backend tests:** `node --test lib/<file>.test.js` (node 24 — pass explicit file globs). Backend has NO build step.
- **Frontend gate:** `CI=true npm run build` must print "Compiled successfully" before any push (Vercel fails on warnings). CRA does not flag a missing prop on an extracted component — check call sites by hand.
- **Security invariants (never violate):** tenant is derived from the KEY (ignore `X-Tenant-Slug` on `/api/public/*`); keys stored HASHED; public serializers whitelist fields and never emit Discord IDs / editor lists / permission arrays; anonymous equity members stay masked; deactivated (`isActive===false`) tenants fail closed.
- **Tier gate via existing system:** `canUse('developer_api', null, tenant.plan)` (needs `pro`) and `canUse('developer_api_premium', null, tenant.plan)` (needs `partner`). Do NOT invent a tier ladder. Plans are `free<starter<pro<partner`.
- **Identifiers:** store the tenant **slug** in the key row; resolve via `getTenantBySlug(slug)`; call hunts-core data fns with `tenant.id`; rate-limit key = slug.
- **Locked YAGNI:** read-only v1; one key per community (revoke = delete row); in-memory rate limit; no Redis/bcrypt/OpenAPI/audit-table/scopes.

---

### Task 1: `lib/apiKeys.js` — key storage, hashing, lifecycle (TDD)

**Files:**
- Create: `communityhunts-backend/lib/apiKeys.js`
- Test: `communityhunts-backend/lib/apiKeys.test.js`

**Interfaces:**
- Produces: `initApiKeys({ pgPool })`, `generateKey(slug, createdBy) → {rawKey, prefix}`, `getKeyMeta(slug) → {prefix,createdAt,lastUsedAt}|null`, `revokeKey(slug) → bool`, `lookupByRawKey(rawKey) → {slug}|null`, `hashKey(rawKey) → string`.

- [ ] **Step 1: Write the failing test**

Create `communityhunts-backend/lib/apiKeys.test.js`:

```js
const { test, after } = require('node:test');
const assert = require('node:assert');
const apiKeys = require('./apiKeys');

// No pgPool → module operates on its in-memory fallback Map (see initApiKeys).
after(() => {});

test('hashKey is deterministic and never equals the raw key', () => {
  const raw = 'ch_live_abc123';
  assert.strictEqual(apiKeys.hashKey(raw), apiKeys.hashKey(raw));
  assert.notStrictEqual(apiKeys.hashKey(raw), raw);
});

test('generate → lookup round trip; prefix masks the middle', () => {
  const { rawKey, prefix } = apiKeys.generateKey('acme', '135203806676779008');
  assert.ok(rawKey.startsWith('ch_live_'));
  assert.match(prefix, /^ch_live_.+….+$/);
  assert.deepStrictEqual(apiKeys.lookupByRawKey(rawKey), { slug: 'acme' });
  assert.strictEqual(apiKeys.lookupByRawKey('ch_live_wrong'), null);
});

test('generate again = roll: old key stops working, new key works', () => {
  const first = apiKeys.generateKey('roller', 'u1').rawKey;
  const second = apiKeys.generateKey('roller', 'u1').rawKey;
  assert.notStrictEqual(first, second);
  assert.strictEqual(apiKeys.lookupByRawKey(first), null);
  assert.deepStrictEqual(apiKeys.lookupByRawKey(second), { slug: 'roller' });
});

test('revoke deletes the key; lookup then fails; getKeyMeta null', () => {
  const { rawKey } = apiKeys.generateKey('gone', 'u1');
  assert.strictEqual(apiKeys.revokeKey('gone'), true);
  assert.strictEqual(apiKeys.lookupByRawKey(rawKey), null);
  assert.strictEqual(apiKeys.getKeyMeta('gone'), null);
  assert.strictEqual(apiKeys.revokeKey('gone'), false);
});

test('getKeyMeta returns masked prefix, never the hash or raw key', () => {
  apiKeys.generateKey('meta', 'creator-9');
  const m = apiKeys.getKeyMeta('meta');
  assert.ok(m.prefix.includes('…'));
  assert.ok(!('keyHash' in m) && !('rawKey' in m));
  assert.strictEqual(m.createdBy, undefined); // meta is display-only; createdBy not exposed here
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd communityhunts-backend && node --test lib/apiKeys.test.js`
Expected: FAIL — `Cannot find module './apiKeys'`.

- [ ] **Step 3: Write the implementation**

Create `communityhunts-backend/lib/apiKeys.js`:

```js
// Per-community Developer API keys. One active key per tenant (keyed by slug).
// Stored HASHED (sha256, optional API_KEY_PEPPER → HMAC). Postgres-backed with an
// in-memory fallback Map (like other lib/* modules) so unit tests + no-DB boots work.
//
// DI: initApiKeys({ pgPool }).

const crypto = require('crypto');

const PEPPER = (process.env.API_KEY_PEPPER || '').trim();
let pgPool = null;

// In-memory mirror: slug -> { keyHash, prefix, createdBy, createdAt, lastUsedAt }.
// Authoritative when no pgPool; a write-through cache when pgPool is set.
const mem = new Map();
// Positive lookup cache: keyHash -> { slug, at }. Invalidated on roll/revoke.
const hashCache = new Map();
const HASH_CACHE_TTL = 45 * 1000;
// Throttle last_used_at writes: slug -> last write ms.
const lastUsedWrite = new Map();

async function initApiKeys(deps) {
  pgPool = (deps && deps.pgPool) || null;
  if (!pgPool) return;
  try {
    await pgPool.query(`
      CREATE TABLE IF NOT EXISTS tenant_api_keys (
        tenant_slug  TEXT PRIMARY KEY,
        key_hash     TEXT NOT NULL,
        key_prefix   TEXT NOT NULL,
        created_by   TEXT NOT NULL,
        created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
        last_used_at TIMESTAMPTZ
      )
    `);
    await pgPool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_tenant_api_keys_hash ON tenant_api_keys(key_hash)`);
    console.log('[apikeys] table ready');
  } catch (e) { console.error('[apikeys] init failed:', e.message); }
}

function hashKey(rawKey) {
  return PEPPER
    ? crypto.createHmac('sha256', PEPPER).update(rawKey).digest('hex')
    : crypto.createHash('sha256').update(rawKey).digest('hex');
}

function maskPrefix(rawKey) {
  // "ch_live_" + first 6 + "…" + last 4
  const body = rawKey.slice('ch_live_'.length);
  return `ch_live_${body.slice(0, 6)}…${body.slice(-4)}`;
}

function generateKey(slug, createdBy) {
  const rawKey = 'ch_live_' + crypto.randomBytes(32).toString('base64url');
  const keyHash = hashKey(rawKey);
  const prefix = maskPrefix(rawKey);
  const createdAt = new Date().toISOString();
  // Roll: drop any prior hash from the positive cache.
  const prior = mem.get(slug);
  if (prior) hashCache.delete(prior.keyHash);
  mem.set(slug, { keyHash, prefix, createdBy, createdAt, lastUsedAt: null });
  if (pgPool) {
    pgPool.query(
      `INSERT INTO tenant_api_keys(tenant_slug,key_hash,key_prefix,created_by,created_at)
       VALUES($1,$2,$3,$4,now())
       ON CONFLICT(tenant_slug) DO UPDATE SET key_hash=$2, key_prefix=$3, created_by=$4, created_at=now(), last_used_at=null`,
      [slug, keyHash, prefix, String(createdBy)]
    ).catch(e => console.error('[apikeys] save failed:', e.message));
  }
  return { rawKey, prefix };
}

function getKeyMeta(slug) {
  const row = mem.get(slug);
  if (!row) return null;
  return { prefix: row.prefix, createdAt: row.createdAt, lastUsedAt: row.lastUsedAt };
}

function revokeKey(slug) {
  const row = mem.get(slug);
  if (!row) return false;
  hashCache.delete(row.keyHash);
  mem.delete(slug);
  if (pgPool) pgPool.query(`DELETE FROM tenant_api_keys WHERE tenant_slug=$1`, [slug])
    .catch(e => console.error('[apikeys] delete failed:', e.message));
  return true;
}

function touchLastUsed(slug) {
  const now = Date.now();
  if ((lastUsedWrite.get(slug) || 0) > now - 60000) return; // throttle to ≤1/min
  lastUsedWrite.set(slug, now);
  const row = mem.get(slug);
  if (row) row.lastUsedAt = new Date(now).toISOString();
  if (pgPool) pgPool.query(`UPDATE tenant_api_keys SET last_used_at=now() WHERE tenant_slug=$1`, [slug])
    .catch(() => {});
}

// Returns { slug } or null. Uses the in-memory mirror (authoritative) + a short positive cache.
function lookupByRawKey(rawKey) {
  if (typeof rawKey !== 'string' || !rawKey.startsWith('ch_live_')) return null;
  const keyHash = hashKey(rawKey);
  const cached = hashCache.get(keyHash);
  if (cached && Date.now() - cached.at < HASH_CACHE_TTL) { touchLastUsed(cached.slug); return { slug: cached.slug }; }
  for (const [slug, row] of mem) {
    if (row.keyHash === keyHash) {
      hashCache.set(keyHash, { slug, at: Date.now() });
      touchLastUsed(slug);
      return { slug };
    }
  }
  return null;
}

module.exports = { initApiKeys, hashKey, generateKey, getKeyMeta, revokeKey, lookupByRawKey };
```

> Note: the in-memory `mem` mirror is authoritative for lookups (loaded from Postgres on init in a production boot — add a `SELECT * FROM tenant_api_keys` load in `initApiKeys` when pgPool is present, populating `mem`). For this task the write-through + fallback is sufficient and unit-testable; add the initial load as the first line after the index create:
> ```js
> const r = await pgPool.query('SELECT tenant_slug,key_hash,key_prefix,created_by,created_at,last_used_at FROM tenant_api_keys');
> for (const x of r.rows) mem.set(x.tenant_slug, { keyHash:x.key_hash, prefix:x.key_prefix, createdBy:x.created_by, createdAt:x.created_at, lastUsedAt:x.last_used_at });
> ```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd communityhunts-backend && node --test lib/apiKeys.test.js`
Expected: PASS — 5 tests.

- [ ] **Step 5: Commit**

```bash
cd communityhunts-backend
git add lib/apiKeys.js lib/apiKeys.test.js
git commit -m "feat: per-community API key storage (hashed, roll/revoke)"
```

---

### Task 2: Tier features + `requireApiKey`/`requireApiFeature` middleware

**Files:**
- Modify: `communityhunts-backend/lib/features.js` (add 2 FEATURES entries)
- Modify: `communityhunts-backend/lib/apiKeys.js` (add the two middlewares + `initApiKeys` deps for tenant resolution)

**Interfaces:**
- Consumes: `apiKeys.lookupByRawKey` (Task 1), `tenants.getTenantBySlug`, `features.canUse`.
- Produces: `requireApiKey(req,res,next)` (sets `req.apiTenant`, `req.apiTenantId`, `req.apiTier`), `requireApiFeature(featureName)` factory.

- [ ] **Step 1: Add the feature entries**

In `communityhunts-backend/lib/features.js`, inside the `FEATURES` object (after `full_extension`, ~line 35), add:

```js
  // Developer API — community-plan capability only (individual subs never unlock a community's API).
  developer_api:         { community: 'pro',     individual: null },
  developer_api_premium: { community: 'partner', individual: null },
```

- [ ] **Step 2: Add middleware to `lib/apiKeys.js`**

At the top of `lib/apiKeys.js`, extend the DI to capture tenant + feature helpers. Change `initApiKeys` and add middlewares:

```js
let getTenantBySlug = () => null;
let canUse = () => false;

async function initApiKeys(deps) {
  pgPool = (deps && deps.pgPool) || null;
  if (deps && deps.getTenantBySlug) getTenantBySlug = deps.getTenantBySlug;
  if (deps && deps.canUse) canUse = deps.canUse;
  // ... existing table-create body ...
}
```

Add before `module.exports`:

```js
function sendErr(res, status, code, message) {
  return res.status(status).json({ error: { code, message } });
}

// Public-layer auth: identify the tenant FROM THE KEY. Ignores X-Tenant-Slug (this router
// is mounted before resolveTenant). Rejects unknown keys, missing/deactivated tenants.
function requireApiKey(req, res, next) {
  const auth = req.headers.authorization || '';
  const raw = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  if (!raw) return sendErr(res, 401, 'unauthorized', 'Missing API key');
  let hit;
  try { hit = lookupByRawKey(raw); }
  catch (e) { return sendErr(res, 503, 'unavailable', 'Temporarily unavailable'); }
  if (!hit) return sendErr(res, 401, 'unauthorized', 'Invalid API key');
  const tenant = getTenantBySlug(hit.slug);
  if (!tenant || tenant.isActive === false) return sendErr(res, 403, 'forbidden', 'Community not available');
  req.apiTenant = tenant;
  req.apiTenantId = tenant.id;      // hunts-core data fns are keyed by tenant.id
  req.apiTier = tenant.plan;        // already normalized in the tenants cache
  // Defense-in-depth: resolveTenant ran earlier and set req.tenant from the header/default.
  // Overwrite it with the KEY's tenant so any stray req.tenant read can't cross tenants.
  req.tenant = tenant;
  next();
}

// Tier gate via the existing feature system. individualTier is always null (community capability).
function requireApiFeature(featureName) {
  return (req, res, next) => {
    if (!canUse(featureName, null, req.apiTier)) {
      return sendErr(res, 403, 'forbidden_tier', 'Your plan does not include this endpoint');
    }
    next();
  };
}
```

Export them: add `requireApiKey, requireApiFeature, sendErr` to `module.exports`.

- [ ] **Step 3: Verify existing tests still pass**

Run: `cd communityhunts-backend && node --test lib/apiKeys.test.js`
Expected: PASS (unchanged — middlewares aren't unit-tested here; verified via the public routes boot in Task 6).

- [ ] **Step 4: Commit**

```bash
cd communityhunts-backend
git add lib/features.js lib/apiKeys.js
git commit -m "feat: developer_api tier features + requireApiKey/requireApiFeature"
```

---

### Task 3: Admin key-management routes + server wiring

**Files:**
- Create: `communityhunts-backend/routes/apiKeys.routes.js`
- Modify: `communityhunts-backend/server.js` (init `apiKeys` with deps; mount admin router)

**Interfaces:**
- Consumes: `apiKeys` (Tasks 1–2), `requireAuth`, `isPlatformAdmin`, `tenants.isTenantAdmin`, `canUse`, rate-limit tier numbers (Task 4 — import lazily or inline the limits map here).
- Produces (HTTP, session-authed): `GET /api/admin/api-key`, `POST /api/admin/api-key`, `DELETE /api/admin/api-key`.

- [ ] **Step 1: Create the admin router**

Create `communityhunts-backend/routes/apiKeys.routes.js`:

```js
// Session-authed management of the community's Developer API key. Owner + platform admin only
// (mods excluded). Tenant from X-Tenant-Slug as usual (this is NOT the public key-authed layer).

const express = require('express');

// Tier → published rate limits (mirrors lib/rateLimit.js LIMITS; shown on the admin card).
const TIER_LIMITS = {
  pro:     { perMin: 100, perHour: 2000 },
  partner: { perMin: 300, perHour: 10000 },
};

module.exports = function apiKeysRoutes(deps) {
  const { requireAuth, apiKeys, tenants, isPlatformAdmin, canUse } = deps;
  const router = express.Router();

  function requireOwnerOrPlatform(req, res, next) {
    const u = req.user;
    if (u && (isPlatformAdmin(u) || tenants.isTenantAdmin(u, req.tenant))) return next();
    return res.status(403).json({ error: 'Owner or platform admin only' });
  }
  function qualifies(req) { return canUse('developer_api', null, req.tenant.plan); }

  router.get('/api/admin/api-key', requireAuth, requireOwnerOrPlatform, (req, res) => {
    const tier = req.tenant.plan;
    res.json({
      key: apiKeys.getKeyMeta(req.tenant.slug),      // null if none
      qualifies: qualifies(req),
      tier,
      limits: TIER_LIMITS[tier] || null,
      premium: canUse('developer_api_premium', null, tier),
    });
  });

  router.post('/api/admin/api-key', requireAuth, requireOwnerOrPlatform, (req, res) => {
    if (!qualifies(req)) return res.status(403).json({ error: 'Upgrade to Pro to use the Developer API' });
    const { rawKey, prefix } = apiKeys.generateKey(req.tenant.slug, req.user.id);
    res.set('Cache-Control', 'no-store');
    res.json({ rawKey, prefix }); // rawKey shown exactly once
  });

  router.delete('/api/admin/api-key', requireAuth, requireOwnerOrPlatform, (req, res) => {
    apiKeys.revokeKey(req.tenant.slug);
    res.json({ ok: true });
  });

  return router;
};
```

- [ ] **Step 2: Wire into `server.js`**

Find the `apiKeys` init spot — near the other lib inits (around the announcements block, ~line 356). Add:

```js
// Developer API keys (per-community). initApiKeys gets tenant + feature helpers for the middlewares.
const apiKeys = require('./lib/apiKeys');
const features = require('./lib/features');
apiKeys.initApiKeys({ pgPool, getTenantBySlug: tenants.getTenantBySlug, canUse: features.canUse })
  .catch(e => console.error('[apikeys] init error:', e.message));
app.use(require('./routes/apiKeys.routes')({
  requireAuth, apiKeys, tenants, isPlatformAdmin, canUse: features.canUse,
}));
```

(`tenants` and `isPlatformAdmin` are already in scope in server.js; `isPlatformAdmin` comes from the `auth` destructure — confirm it's included there, it is exported by lib/auth.js.)

- [ ] **Step 3: Verify the server boots**

Run:
```bash
cd communityhunts-backend
DISCORD_CLIENT_ID=x DISCORD_CLIENT_SECRET=x DISCORD_CALLBACK_URL=http://localhost:3101/cb \
SESSION_SECRET=x PORT=3101 node server.js
```
Expected: boots without error; logs `[apikeys] table ready` (or nothing if no DB). Ctrl-C to stop. (The admin routes are session-authed, so a curl without a session returns 401 `Not authenticated` — that's correct.)

- [ ] **Step 4: Commit**

```bash
cd communityhunts-backend
git add routes/apiKeys.routes.js server.js
git commit -m "feat: admin API key management routes (owner/platform only)"
```

---

### Task 4: `lib/rateLimit.js` — per-tenant tiered limiter (TDD)

**Files:**
- Create: `communityhunts-backend/lib/rateLimit.js`
- Test: `communityhunts-backend/lib/rateLimit.test.js`

**Interfaces:**
- Produces: `checkRate(slug, tier, now) → { ok, limit, remaining, resetSec, retryAfter }` (pure, injectable clock), `rateLimit(req,res,next)` (Express middleware using `Date.now()`), `LIMITS`.

- [ ] **Step 1: Write the failing test**

Create `communityhunts-backend/lib/rateLimit.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert');
const rl = require('./rateLimit');

test('allows requests under the per-minute limit', () => {
  const t0 = 1_000_000;
  let last;
  for (let i = 0; i < 100; i++) last = rl.checkRate('pro-a', 'pro', t0);
  assert.strictEqual(last.ok, true);
  assert.strictEqual(last.limit, 100);
  assert.strictEqual(last.remaining, 0);
});

test('429s the request over the per-minute limit', () => {
  const t0 = 2_000_000;
  for (let i = 0; i < 100; i++) rl.checkRate('pro-b', 'pro', t0);
  const over = rl.checkRate('pro-b', 'pro', t0);
  assert.strictEqual(over.ok, false);
  assert.ok(over.retryAfter > 0);
});

test('reports the tighter of minute vs hour remaining', () => {
  // partner: 300/min, 10000/hr. After 300 in one minute, minute window is the binding one.
  const t0 = 3_000_000;
  for (let i = 0; i < 300; i++) rl.checkRate('partner-a', 'partner', t0);
  const over = rl.checkRate('partner-a', 'partner', t0);
  assert.strictEqual(over.ok, false);
});

test('window resets after the minute rolls over', () => {
  const t0 = 4_000_000;
  for (let i = 0; i < 100; i++) rl.checkRate('pro-c', 'pro', t0);
  const after = rl.checkRate('pro-c', 'pro', t0 + 61_000);
  assert.strictEqual(after.ok, true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd communityhunts-backend && node --test lib/rateLimit.test.js`
Expected: FAIL — `Cannot find module './rateLimit'`.

- [ ] **Step 3: Write the implementation**

Create `communityhunts-backend/lib/rateLimit.js`:

```js
// Per-tenant, tier-based rate limiting. In-memory fixed windows (minute + hour), keyed by
// tenant slug so rolling a key doesn't reset the window. Single-instance; resets on deploy.

const LIMITS = {
  pro:     { perMin: 100, perHour: 2000 },
  partner: { perMin: 300, perHour: 10000 },
};

// slug -> { minStart, minCount, hourStart, hourCount }
const buckets = new Map();
let lastSweep = 0;

function checkRate(slug, tier, now) {
  const lim = LIMITS[tier] || LIMITS.pro;
  let b = buckets.get(slug);
  if (!b) { b = { minStart: now, minCount: 0, hourStart: now, hourCount: 0 }; buckets.set(slug, b); }
  if (now - b.minStart >= 60_000)  { b.minStart = now; b.minCount = 0; }
  if (now - b.hourStart >= 3_600_000) { b.hourStart = now; b.hourCount = 0; }

  const minLeft  = lim.perMin  - b.minCount;
  const hourLeft = lim.perHour - b.hourCount;
  const binding  = minLeft <= hourLeft ? 'min' : 'hour';
  const limit    = binding === 'min' ? lim.perMin : lim.perHour;
  const start    = binding === 'min' ? b.minStart : b.hourStart;
  const windowMs = binding === 'min' ? 60_000 : 3_600_000;
  const resetSec = Math.ceil((start + windowMs) / 1000);

  if (minLeft <= 0 || hourLeft <= 0) {
    return { ok: false, limit, remaining: 0, resetSec, retryAfter: Math.max(1, Math.ceil((start + windowMs - now) / 1000)) };
  }
  b.minCount++; b.hourCount++;
  return { ok: true, limit, remaining: Math.max(0, Math.min(minLeft, hourLeft) - 1), resetSec, retryAfter: 0 };
}

function rateLimit(req, res, next) {
  const now = Date.now();
  if (now - lastSweep > 600_000) { // evict idle buckets every ~10m
    lastSweep = now;
    for (const [k, b] of buckets) if (now - b.hourStart > 3_600_000) buckets.delete(k);
  }
  const r = checkRate(req.apiTenant.slug, req.apiTier, now);
  res.set('X-RateLimit-Limit', String(r.limit));
  res.set('X-RateLimit-Remaining', String(r.remaining));
  res.set('X-RateLimit-Reset', String(r.resetSec));
  if (!r.ok) {
    res.set('Retry-After', String(r.retryAfter));
    return res.status(429).json({ error: { code: 'rate_limited', message: 'Rate limit exceeded' } });
  }
  next();
}

module.exports = { LIMITS, checkRate, rateLimit };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd communityhunts-backend && node --test lib/rateLimit.test.js`
Expected: PASS — 4 tests.

- [ ] **Step 5: Commit**

```bash
cd communityhunts-backend
git add lib/rateLimit.js lib/rateLimit.test.js
git commit -m "feat: per-tenant tiered rate limiter"
```

---

### Task 5: `lib/publicSerializers.js` — stable whitelists (TDD)

**Files:**
- Create: `communityhunts-backend/lib/publicSerializers.js`
- Test: `communityhunts-backend/lib/publicSerializers.test.js`

**Interfaces:**
- Consumes: `publicHuntView(h)` from `lib/hunts-core.js` (masks anonymous equity + strips secrets when called with no viewerId).
- Produces: `publicHunt(hunt)`, `publicStats(rawStats)`, `publicGotIn(rows)`, `publicBanger(b)`. Pure; `publicHunt` takes a raw hunt and internally calls the injected `publicHuntView`.

- [ ] **Step 1: Write the failing test**

Create `communityhunts-backend/lib/publicSerializers.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert');
const S = require('./publicSerializers');

// Inject a fake publicHuntView that mimics anonymity masking + secret strip.
S._setPublicHuntView(h => ({
  ...h,
  equity: (h.equity || []).map(e => e.discordId === 'anon1' ? { ...e, name: 'Anonymous' } : e),
}));

const HUNT = {
  huntId: 'h_1', user: { id: '111', displayName: 'Runner' }, tenantId: 'acme',
  huntType: 'community', isLive: false, archivedAt: '2026-07-10T00:00:00Z',
  startedAt: '2026-07-09T00:00:00Z', createdAt: '2026-07-09T00:00:00Z', currency: 'USD',
  invitedEditors: ['secret'], callsPermissions: { x: 1 },
  bonuses: [{ slot: 'Le Bandit', bet: 2, win: 200, ts: 1 }],
  equity: [{ name: 'Alice', amount: 100, discordId: '222' }, { name: 'Bob', amount: 50, discordId: 'anon1' }],
};

test('publicHunt whitelists — no Discord IDs / editor lists / permissions leak', () => {
  const out = S.publicHunt(HUNT);
  const json = JSON.stringify(out);
  assert.ok(!json.includes('invitedEditors') && !json.includes('callsPermissions'));
  assert.ok(!json.includes('"111"') && !json.includes('discordId'));
  assert.strictEqual(out.id, 'h_1');
  assert.strictEqual(out.status, 'archived');
  assert.strictEqual(out.bonuses[0].multiplier, 100);
});

test('publicHunt keeps anonymous member masked', () => {
  const out = S.publicHunt(HUNT);
  const bob = out.equity.find(e => e.amount === 50);
  assert.strictEqual(bob.name, 'Anonymous');
});

test('publicStats drops name-bearing lists (topHunters/biggestHits)', () => {
  const raw = { currencies: [{ code: 'USD', hunts: 3 }], tz: 'UTC',
    byCurrency: { USD: { summary: { totalHunts: 3, totalWon: 9 }, topGotIn: [{ slot: 'X', count: 2 }],
      topCalled: [], topHunters: [{ name: 'Alice' }], biggestHits: [{ member: 'Bob' }], hours: [], weekdays: [], weeks: [] } } };
  const out = S.publicStats(raw);
  const json = JSON.stringify(out);
  assert.ok(!json.includes('topHunters') && !json.includes('biggestHits'));
  assert.strictEqual(out.byCurrency.USD.summary.totalWon, 9);
  assert.deepStrictEqual(out.byCurrency.USD.topGotIn, [{ slot: 'X', count: 2 }]);
});

test('publicGotIn + publicBanger shape', () => {
  assert.deepStrictEqual(S.publicGotIn([{ ts: 5, slot: 'Y', bet: 1 }]), [{ slot: 'Y', bet: 1, at: 5 }]);
  const b = S.publicBanger({ slot: 'Z', bet: 1, win: 500, mult: 500, userId: 'x', avatar: 'a', username: 'Runner', huntType: 'solo', at: 't' });
  assert.deepStrictEqual(b, { slot: 'Z', bet: 1, win: 500, multiplier: 500, username: 'Runner', huntType: 'solo', at: 't' });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd communityhunts-backend && node --test lib/publicSerializers.test.js`
Expected: FAIL — `Cannot find module './publicSerializers'`.

- [ ] **Step 3: Write the implementation**

Create `communityhunts-backend/lib/publicSerializers.js`:

```js
// Stable public shapes for the Developer API. Whitelist-only: a new internal field can NEVER
// auto-leak. Anonymous-member masking + secret stripping is inherited from publicHuntView.

let publicHuntView = h => h; // injected from server.js (lib/hunts-core.publicHuntView)
function _setPublicHuntView(fn) { publicHuntView = fn; }

function huntStatus(h) {
  if (h.archivedAt) return 'archived';
  return h.isLive ? 'live' : 'ended';
}

function publicHunt(hunt) {
  if (!hunt) return null;
  const pv = publicHuntView(hunt); // masks anonymous equity, strips secrets (no viewer = unprivileged)
  const bonuses = (hunt.bonuses || []).map(b => ({
    slot: b.slot || null,
    bet: b.bet ?? null,
    win: b.win ?? null,
    multiplier: (Number(b.bet) > 0 && b.win != null) ? +(b.win / b.bet).toFixed(2) : null,
  }));
  return {
    id: hunt.huntId || null,
    status: huntStatus(hunt),
    huntType: hunt.huntType || 'community',
    currency: hunt.currency || null,
    createdAt: hunt.createdAt || hunt.startedAt || null,
    startedAt: hunt.startedAt || null,
    endedAt: hunt.archivedAt || null,
    bonusCount: bonuses.length,
    totalWon: bonuses.reduce((s, b) => s + (b.win || 0), 0),
    bonuses,
    equity: (pv.equity || []).map(e => ({ name: e.name, amount: e.amount ?? null })),
  };
}

// getHuntStats(tenantId) → { currencies, byCurrency:{code:{summary,topGotIn,topCalled,topHunters,biggestHits,hours,weekdays,weeks}}, tz }
// Drop topHunters + biggestHits (carry member names — anonymity risk); keep numeric/slot aggregates.
function publicStats(raw) {
  if (!raw) return null;
  const byCurrency = {};
  for (const [code, s] of Object.entries(raw.byCurrency || {})) {
    byCurrency[code] = {
      summary: s.summary,
      topGotIn: s.topGotIn || [],
      topCalled: s.topCalled || [],
      hours: s.hours || [], weekdays: s.weekdays || [], weeks: s.weeks || [],
    };
  }
  return { currencies: raw.currencies || [], byCurrency, tz: raw.tz || null };
}

function publicGotIn(rows) {
  return (rows || []).map(r => ({ slot: r.slot, bet: r.bet, at: r.ts }));
}

function publicBanger(b) {
  return { slot: b.slot, bet: b.bet, win: b.win, multiplier: b.mult, username: b.username, huntType: b.huntType, at: b.at };
}

module.exports = { _setPublicHuntView, publicHunt, publicStats, publicGotIn, publicBanger };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd communityhunts-backend && node --test lib/publicSerializers.test.js`
Expected: PASS — 4 tests.

- [ ] **Step 5: Commit**

```bash
cd communityhunts-backend
git add lib/publicSerializers.js lib/publicSerializers.test.js
git commit -m "feat: stable public serializers (whitelist, anon-safe)"
```

---

### Task 6: `routes/public.routes.js` — base endpoints, early mount, CORS, error envelope

**Files:**
- Create: `communityhunts-backend/routes/public.routes.js`
- Modify: `communityhunts-backend/server.js` (mount EARLY, before session/resolveTenant; inject `publicHuntView` into serializers)

**Interfaces:**
- Consumes: `requireApiKey`, `requireApiFeature`, `rateLimit`, serializers, `getPublicHunts`, `getArchivedHunts`, `getHuntStats`, `hunts`, `archive`, `tenantOf`.
- Produces (HTTP, key-authed): `GET /api/public/v1/hunts`, `/hunts/:id`, `/stats`.

- [ ] **Step 1: Create the public router**

Create `communityhunts-backend/routes/public.routes.js`:

```js
// Public Developer API — key-authed, tier-gated, rate-limited, stable serializers.
// MOUNTED BEFORE session/resolveTenant in server.js: tenant comes from the KEY, never a header.

const express = require('express');

function paginate(req) {
  let limit = parseInt(req.query.limit, 10); if (!Number.isFinite(limit) || limit <= 0) limit = 25;
  limit = Math.min(limit, 100);
  let offset = parseInt(req.query.offset, 10); if (!Number.isFinite(offset) || offset < 0) offset = 0;
  return { limit, offset };
}

module.exports = function publicRoutes(deps) {
  const {
    requireApiKey, requireApiFeature, rateLimit, serializers,
    getPublicHunts, getArchivedHunts, getHuntStats, hunts, archive, tenantOf,
  } = deps;
  const router = express.Router();

  // Own CORS: open to any origin, NO credentials (Bearer-key auth, no cookies).
  router.use((req, res, next) => {
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Methods', 'GET,OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Authorization,Content-Type');
    if (req.method === 'OPTIONS') return res.status(204).end();
    next();
  });

  // Every route: key → rate limit → (tier) → handler.
  router.use('/api/public/v1', requireApiKey, rateLimit);

  router.get('/api/public/v1/hunts', requireApiFeature('developer_api'), (req, res) => {
    const tid = req.apiTenantId;
    const status = String(req.query.status || 'all');
    let list = [];
    if (status === 'live' || status === 'all')     list = list.concat(Object.values(hunts).filter(h => h.isLive && tenantOf(h) === tid));
    if (status === 'archived' || status === 'all') list = list.concat(archive.filter(h => tenantOf(h) === tid));
    list.sort((a, b) => new Date(b.archivedAt || b.startedAt || 0) - new Date(a.archivedAt || a.startedAt || 0));
    const { limit, offset } = paginate(req);
    const page = list.slice(offset, offset + limit).map(serializers.publicHunt);
    res.set('Cache-Control', 'no-store');
    res.json({ data: page, pagination: { limit, offset, total: list.length } });
  });

  router.get('/api/public/v1/hunts/:id', requireApiFeature('developer_api'), (req, res) => {
    const tid = req.apiTenantId, id = req.params.id;
    const found = [...Object.values(hunts), ...archive].find(h => h.huntId === id && tenantOf(h) === tid);
    if (!found) return res.status(404).json({ error: { code: 'not_found', message: 'Hunt not found' } });
    res.json({ data: serializers.publicHunt(found) });
  });

  router.get('/api/public/v1/stats', requireApiFeature('developer_api'), (req, res) => {
    const stats = getHuntStats(req.apiTenantId);
    res.set('Cache-Control', 'public, max-age=60');
    res.json({ data: serializers.publicStats(stats) });
  });

  // Public-scoped error envelope (the global handler returns a bare string — wrong shape).
  router.use((err, req, res, next) => {
    console.error('[public-api] error:', err && err.message);
    res.status(500).json({ error: { code: 'server_error', message: 'Internal error' } });
  });

  return router;
};
```

- [ ] **Step 2: Mount the public router (late, via DI) + inject serializers' `publicHuntView` in `server.js`**

The public router is key-authed, so it does NOT need to run before `resolveTenant`: `requireApiKey` overwrites `req.tenant` with the key's tenant (Task 2) and every handler uses `req.apiTenantId`. A public client that omits `X-Tenant-Slug` passes `resolveTenant` fine (`req.tenant`→Bean, then overridden). So mount it with the other DI routers — this keeps the codebase's injection convention and avoids hoisting a dozen requires. Add this **immediately after the admin `apiKeys.routes` mount from Task 3** (near the announcements block, ~line 360), where `apiKeys` (Task 3), `huntsCore` (line 280), and the `hunts`/`archive` singletons (destructured at line 229) are all in scope:

```js
// Public Developer API (key-authed, tier-gated). requireApiKey derives the tenant from the key
// and overrides req.tenant, so a post-resolveTenant mount is safe. Handlers use req.apiTenantId.
const serializers = require('./lib/publicSerializers');
serializers._setPublicHuntView(huntsCore.publicHuntView);
const rateLimitLib = require('./lib/rateLimit');
app.use(require('./routes/public.routes')({
  requireApiKey: apiKeys.requireApiKey,
  requireApiFeature: apiKeys.requireApiFeature,
  rateLimit: rateLimitLib.rateLimit,
  serializers,
  getPublicHunts: huntsCore.getPublicHunts,
  getArchivedHunts: huntsCore.getArchivedHunts,
  getHuntStats: huntsCore.getHuntStats,
  hunts, archive, tenantOf: huntsCore.tenantOf,
}));
```

Confirmed in scope at this line: `huntsCore` (`require('./lib/hunts-core')`, line 280), `hunts`/`archive` (destructured from `persistence` at line 229), `apiKeys` (Task 3, required just above). No require-hoisting needed.

- [ ] **Step 3: Verify end-to-end locally**

Because the admin key route is session-authed, generate a key for a quick test via a one-off node REPL against the running server is awkward; instead temporarily seed a key through the module. Simplest: boot, then in a second shell use `node -e` to call the lib directly is NOT shared-process. Use this manual flow:
```bash
cd communityhunts-backend
# Boot with a DB-less in-memory key by temporarily calling generateKey at boot via env is overkill;
# instead verify the auth gates without a key:
DISCORD_CLIENT_ID=x DISCORD_CLIENT_SECRET=x DISCORD_CALLBACK_URL=http://localhost:3101/cb \
SESSION_SECRET=x PORT=3101 node server.js &
sleep 3
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3101/api/public/v1/hunts            # 401 (no key)
curl -s -o /dev/null -w "%{http_code}\n" -H "Authorization: Bearer ch_live_bogus" http://localhost:3101/api/public/v1/hunts  # 401 (bad key)
kill %1
```
Expected: `401` then `401`. (Full happy-path with a real key is exercised on the deployed backend after the admin page ships, and in the frontend preview verification.)

- [ ] **Step 4: Commit**

```bash
cd communityhunts-backend
git add routes/public.routes.js server.js
git commit -m "feat: public /api/public/v1 base endpoints (hunts, stats)"
```

---

### Task 7: Premium endpoints + `lib/bangers.js` extraction

**Files:**
- Create: `communityhunts-backend/lib/bangers.js`
- Test: `communityhunts-backend/lib/bangers.test.js`
- Modify: `communityhunts-backend/routes/misc.routes.js` (call the extracted fn)
- Modify: `communityhunts-backend/routes/public.routes.js` (+ `/got-in`, `/bangers`)
- Modify: `communityhunts-backend/server.js` (pass `getGotInLog`, `collectBangers` to public routes)

**Interfaces:**
- Produces: `collectBangers(hunts, archive, tenantId, { minMult=300, maxPerUser=2, cap=24 }={}) → Array<{slot,bet,win,mult,userId,username,avatar,huntType,live,at,archivedAt}>`.
- Consumes: `getGotInLog` (hunts-core), serializers `publicGotIn`/`publicBanger`.

- [ ] **Step 1: Write the failing test**

Create `communityhunts-backend/lib/bangers.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert');
const { collectBangers } = require('./bangers');

const mk = (id, tenantId, bonuses, extra = {}) => ({ user: { id, displayName: id }, tenantId, bonuses, ...extra });

test('only >=300x wins from the given tenant, capped per user', () => {
  const hunts = {
    a: mk('a', 'acme', [{ slot: 'Big', bet: 1, win: 400 }, { slot: 'Also', bet: 1, win: 500 }, { slot: 'Third', bet: 1, win: 600 }], { isLive: true }),
    b: mk('b', 'other', [{ slot: 'Nope', bet: 1, win: 900 }], { isLive: true }),
  };
  const out = collectBangers(hunts, [], 'acme');
  assert.ok(out.every(x => x.mult >= 300));
  assert.ok(out.every(x => x.userId === 'a'));       // other tenant excluded
  assert.ok(out.length <= 2);                         // maxPerUser default 2
});

test('skips sub-threshold and zero-bet bonuses', () => {
  const hunts = { a: mk('a', 'acme', [{ slot: 'Low', bet: 1, win: 10 }, { slot: 'ZeroBet', bet: 0, win: 999 }], { isLive: true }) };
  assert.strictEqual(collectBangers(hunts, [], 'acme').length, 0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd communityhunts-backend && node --test lib/bangers.test.js`
Expected: FAIL — `Cannot find module './bangers'`.

- [ ] **Step 3: Extract the implementation**

Create `communityhunts-backend/lib/bangers.js` (lifted verbatim from `routes/misc.routes.js` `/api/bangers`, parameterized):

```js
// Top recent big-multiplier wins ("bangers", >=300x) for a tenant. Extracted from
// routes/misc.routes.js so the Developer API can reuse the exact selection logic.

const BANGER_MIN_MULT = 300;

function collectBangers(hunts, archive, tenantId, opts = {}) {
  const minMult = opts.minMult ?? BANGER_MIN_MULT;
  const maxPerUser = opts.maxPerUser ?? 2;
  const cap = opts.cap ?? 24;
  const tid = tenantId || 'bean';
  const out = [], seen = new Set();
  const collect = (h, live) => {
    if (!h || !h.user || !Array.isArray(h.bonuses)) return;
    if ((h.tenantId || 'bean') !== tid) return;
    const at = h.archivedAt || h.startedAt || null;
    for (const b of h.bonuses) {
      const bet = +b.bet || 0, win = +b.win || 0;
      if (bet <= 0 || win <= 0) continue;
      const mult = win / bet;
      if (mult < minMult) continue;
      const key = `${h.user.id}|${(b.slot || '').toLowerCase()}|${bet}|${win}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ slot: b.slot || 'Unknown', bet, win, mult: +mult.toFixed(2),
        userId: h.user.id, username: h.user.displayName, avatar: h.user.avatar,
        huntType: h.huntType || 'community', live: !!live, at, archivedAt: h.archivedAt || null });
    }
  };
  Object.values(hunts).forEach(h => { if (h.isLive) collect(h, true); });
  archive.forEach(h => collect(h, false));
  out.sort((a, b) => {
    const ta = a.at ? new Date(a.at).getTime() : 0, tb = b.at ? new Date(b.at).getTime() : 0;
    return tb - ta || b.mult - a.mult;
  });
  const userCount = new Map(), diverse = [];
  for (const b of out) {
    const c = userCount.get(b.userId) || 0;
    if (c >= maxPerUser) continue;
    userCount.set(b.userId, c + 1);
    diverse.push(b);
    if (diverse.length >= cap) break;
  }
  return diverse;
}

module.exports = { collectBangers, BANGER_MIN_MULT };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd communityhunts-backend && node --test lib/bangers.test.js`
Expected: PASS — 2 tests.

- [ ] **Step 5: Refactor `misc.routes.js` to use it (behavior unchanged)**

In `communityhunts-backend/routes/misc.routes.js`, replace the entire `/api/bangers` handler body (lines ~31–76) with:

```js
  router.get('/api/bangers', (req, res) => {
    res.json(collectBangers(hunts, archive, req.tenant?.id || 'bean'));
  });
```

And add near the top (next to the `collectHallOfFame` require, line 11):

```js
const { collectBangers } = require('../lib/bangers');
```

(Remove the now-unused local `BANGER_MIN_MULT` const at line 14 if nothing else references it.)

- [ ] **Step 6: Add premium endpoints to `public.routes.js`**

In `communityhunts-backend/routes/public.routes.js`, extend `deps` destructure with `getGotInLog, collectBangers`, and add these routes before the error middleware:

```js
  router.get('/api/public/v1/got-in', requireApiFeature('developer_api_premium'), (req, res) => {
    const rows = getGotInLog(req.apiTenantId);
    const { limit, offset } = paginate(req);
    const page = serializers.publicGotIn(rows.slice(offset, offset + limit));
    res.set('Cache-Control', 'no-store');
    res.json({ data: page, pagination: { limit, offset, total: rows.length } });
  });

  router.get('/api/public/v1/bangers', requireApiFeature('developer_api_premium'), (req, res) => {
    const list = collectBangers(hunts, archive, req.apiTenantId).map(serializers.publicBanger);
    res.set('Cache-Control', 'public, max-age=60');
    res.json({ data: list, pagination: { limit: list.length, offset: 0, total: list.length } });
  });
```

- [ ] **Step 7: Pass the new deps in `server.js`**

In the `public.routes` mount block (Task 6 Step 2), add to the deps object:

```js
  getGotInLog: huntsCore.getGotInLog,
  collectBangers: require('./lib/bangers').collectBangers,
```

- [ ] **Step 8: Verify tests + boot**

Run:
```bash
cd communityhunts-backend
node --test lib/bangers.test.js
DISCORD_CLIENT_ID=x DISCORD_CLIENT_SECRET=x DISCORD_CALLBACK_URL=http://localhost:3101/cb SESSION_SECRET=x PORT=3101 node server.js &
sleep 3
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3101/api/bangers   # 200 (unchanged public route)
curl -s -o /dev/null -w "%{http_code}\n" -H "Authorization: Bearer ch_live_bogus" http://localhost:3101/api/public/v1/got-in  # 401
kill %1
```
Expected: bangers test PASS; `200` then `401`.

- [ ] **Step 9: Commit**

```bash
cd communityhunts-backend
git add lib/bangers.js lib/bangers.test.js routes/misc.routes.js routes/public.routes.js server.js
git commit -m "feat: premium API endpoints (got-in, bangers) + extract lib/bangers"
```

> **Backend deploy gate:** merge the backend branch → `main` (Railway) and confirm `GET https://api.communityhunts.gg/api/public/v1/hunts` returns `401` (auth required = layer is live) before starting the frontend task.

---

### Task 8: Frontend — Developer API admin page

**Files:**
- Create: `communityhunts-frontend/src/admin/DeveloperApi.js`, `communityhunts-frontend/src/admin/apiEndpoints.js`
- Modify: `communityhunts-frontend/src/admin/adminApi.js`, `communityhunts-frontend/src/App.js`, `communityhunts-frontend/src/admin/AdminLayout.js`, `communityhunts-frontend/src/auth/features.js`

**Interfaces:**
- Consumes: `GET/POST/DELETE /api/admin/api-key`; `useTheme()`.
- Produces: `AdminDeveloperApi` page; adminApi `getApiKey`/`rollApiKey`/`revokeApiKey`.

- [ ] **Step 1: Mirror the two features in the frontend**

In `communityhunts-frontend/src/auth/features.js`, add to its `FEATURES` map (matching the backend keys/tiers):

```js
  developer_api:         { community: 'pro',     individual: null },
  developer_api_premium: { community: 'partner', individual: null },
```

- [ ] **Step 2: Add admin API calls**

In `communityhunts-frontend/src/admin/adminApi.js`, append:

```js
// Developer API key management (owner/platform admin)
export const getApiKey = () => apiFetch('/api/admin/api-key');
export const rollApiKey = () => apiFetch('/api/admin/api-key', { method: 'POST' });
export const revokeApiKey = () => apiFetch('/api/admin/api-key', { method: 'DELETE' });
```

- [ ] **Step 3: Create the endpoints doc data**

Create `communityhunts-frontend/src/admin/apiEndpoints.js`:

```js
// Documentation data for the Developer API page. Drives the endpoint list + Copy-as-Markdown.
export const BASE = '/api/public/v1';
export const API_ENDPOINTS = [
  { method: 'GET', path: `${BASE}/hunts`, title: 'List Hunts', tier: 'Pro',
    params: ['status=live|archived|all', 'limit (≤100)', 'offset'],
    example: '{ "data": [ { "id": "...", "status": "archived", "bonuses": [...], "equity": [...] } ], "pagination": { "limit": 25, "offset": 0, "total": 42 } }' },
  { method: 'GET', path: `${BASE}/hunts/{id}`, title: 'Get Hunt by ID', tier: 'Pro',
    params: [], example: '{ "data": { "id": "...", "status": "live", "bonuses": [...] } }' },
  { method: 'GET', path: `${BASE}/stats`, title: 'Community Stats', tier: 'Pro',
    params: [], example: '{ "data": { "currencies": [...], "byCurrency": { "USD": { "summary": {...} } } } }' },
  { method: 'GET', path: `${BASE}/got-in`, title: 'Got-In Log', tier: 'Partner',
    params: ['limit (≤100)', 'offset'], example: '{ "data": [ { "slot": "...", "bet": 2, "at": 1720000000000 } ] }' },
  { method: 'GET', path: `${BASE}/bangers`, title: 'Bangers (≥300x)', tier: 'Partner',
    params: [], example: '{ "data": [ { "slot": "...", "multiplier": 512, "win": 1024 } ] }' },
];

export function endpointsToMarkdown(base) {
  const lines = ['# CommunityHunts Developer API', '', `Base URL: \`${base}${BASE}\``, '', 'Auth: `Authorization: Bearer YOUR_KEY`', ''];
  for (const e of API_ENDPOINTS) {
    lines.push(`## ${e.method} ${e.path} — ${e.title} (${e.tier})`);
    if (e.params.length) lines.push('', 'Query params: ' + e.params.map(p => `\`${p}\``).join(', '));
    lines.push('', '```json', e.example, '```', '');
  }
  return lines.join('\n');
}
```

- [ ] **Step 4: Create the page**

Create `communityhunts-frontend/src/admin/DeveloperApi.js` (mirrors the bonushunt screenshot: key card, rate-limits card, endpoint list with GET/POST filter + Copy-as-Markdown; upgrade CTA when not qualified):

```jsx
import React from 'react';
import { useTheme } from '../theme/ThemeContext';
import { getApiKey, rollApiKey, revokeApiKey } from './adminApi';
import { API_ENDPOINTS, endpointsToMarkdown } from './apiEndpoints';

export default function AdminDeveloperApi() {
  const C = useTheme();
  const [info, setInfo] = React.useState(null);
  const [reveal, setReveal] = React.useState('');   // raw key shown once after generate/roll
  const [err, setErr] = React.useState('');
  const [filter, setFilter] = React.useState('ALL');
  const [copied, setCopied] = React.useState(false);

  const load = () => getApiKey().then(setInfo).catch(e => setErr(e.message));
  React.useEffect(() => { load(); }, []);

  const roll = async () => {
    setErr('');
    if (info && info.key && !window.confirm('Generate a new key? The old key stops working immediately.')) return;
    try { const r = await rollApiKey(); setReveal(r.rawKey); load(); } catch (e) { setErr(e.message); }
  };
  const revoke = async () => {
    if (!window.confirm('Revoke the API key? Any integrations using it will break.')) return;
    try { await revokeApiKey(); setReveal(''); load(); } catch (e) { setErr(e.message); }
  };
  const copyMd = () => {
    const base = window.location.origin.replace('communityhunts.gg', 'api.communityhunts.gg');
    navigator.clipboard.writeText(endpointsToMarkdown(base)).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); });
  };

  const card = { background: C.sur, border: `1px solid ${C.bdr}`, borderRadius: C.rCard, padding: 16 };
  const btn = (bg, fg) => ({ height: 32, padding: '0 14px', background: bg, color: fg, border: 'none', borderRadius: C.rCtl, fontFamily: C.body, fontWeight: 700, fontSize: 12, cursor: 'pointer' });
  const code = { fontFamily: C.mono || 'monospace', fontSize: 12, color: C.accent || C.gold, background: C.bg2 || C.bg, padding: '2px 6px', borderRadius: 4 };

  if (!info) return <div style={{ color: C.t3, fontFamily: C.body }}>{err || 'Loading…'}</div>;

  return (
    <div>
      <h2 style={{ color: C.t1, fontFamily: C.display, margin: '0 0 16px' }}>Developer API</h2>
      {err && <div style={{ color: C.red, fontFamily: C.body, marginBottom: 10 }}>{err}</div>}

      {!info.qualifies ? (
        <div style={{ ...card }}>
          <div style={{ color: C.t1, fontFamily: C.body, fontWeight: 700, marginBottom: 6 }}>Upgrade to unlock the Developer API</div>
          <div style={{ color: C.t3, fontFamily: C.body, fontSize: 13 }}>The Developer API is available on the Pro plan and above. Premium endpoints (got-in log, bangers) require Partner.</div>
        </div>
      ) : (
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 20 }}>
          <div style={{ ...card, flex: '1 1 320px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
              <span style={{ color: C.t1, fontFamily: C.body, fontWeight: 700 }}>🔑 Your API Key</span>
              {info.key && <button onClick={revoke} style={{ ...btn('transparent', C.red), border: `1px solid ${C.red}` }}>Revoke</button>}
            </div>
            {reveal ? (
              <div style={{ marginBottom: 10 }}>
                <div style={{ color: C.gold || C.accent, fontFamily: C.body, fontSize: 12, marginBottom: 4 }}>Copy this now — you won't see it again:</div>
                <div style={{ ...code, display: 'block', wordBreak: 'break-all', padding: 8 }}>{reveal}</div>
              </div>
            ) : info.key ? (
              <div style={{ marginBottom: 10 }}><span style={{ ...code }}>{info.key.prefix}</span> <span style={{ color: C.t4, fontSize: 11, fontFamily: C.mono }}>Active</span></div>
            ) : (
              <div style={{ color: C.t3, fontFamily: C.body, fontSize: 13, marginBottom: 10 }}>No key yet.</div>
            )}
            <button onClick={roll} style={btn(C.accent || C.gold, C.bg)}>{info.key ? 'Roll Key' : 'Generate Key'}</button>
            <div style={{ color: C.t4, fontFamily: C.body, fontSize: 11, marginTop: 10 }}>Authenticate with header: <span style={code}>Authorization: Bearer YOUR_KEY</span></div>
          </div>

          <div style={{ ...card, flex: '1 1 240px' }}>
            <div style={{ color: C.t1, fontFamily: C.body, fontWeight: 700, marginBottom: 10 }}>Rate Limits</div>
            {info.limits ? (
              <ul style={{ margin: 0, paddingLeft: 16, color: C.t2, fontFamily: C.body, fontSize: 13, lineHeight: 1.7 }}>
                <li><b>{info.limits.perMin}</b> requests per minute</li>
                <li><b>{info.limits.perHour}</b> requests per hour</li>
              </ul>
            ) : null}
            <div style={{ color: C.t4, fontFamily: C.body, fontSize: 11, marginTop: 8 }}>Rate-limit info is in response headers.</div>
          </div>
        </div>
      )}

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
        <h3 style={{ color: C.t1, fontFamily: C.display, margin: 0 }}>Endpoints</h3>
        <div style={{ display: 'flex', gap: 6 }}>
          {['ALL', 'GET'].map(f => (
            <button key={f} onClick={() => setFilter(f)} style={btn(filter === f ? (C.accent || C.gold) : 'transparent', filter === f ? C.bg : C.t3)}>{f}</button>
          ))}
          <button onClick={copyMd} style={btn('transparent', C.accent || C.gold)}>{copied ? 'Copied!' : 'Copy as Markdown'}</button>
        </div>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {API_ENDPOINTS.filter(e => filter === 'ALL' || e.method === filter).map(e => (
          <details key={e.path} style={{ background: C.sur, border: `1px solid ${C.bdr}`, borderRadius: C.rCtl, padding: '10px 12px' }}>
            <summary style={{ cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 10 }}>
              <span style={{ ...btn(C.bg2 || C.bg, C.accent || C.gold), height: 22, padding: '0 8px', fontSize: 11 }}>{e.method}</span>
              <span style={{ ...code }}>{e.path}</span>
              <span style={{ color: C.t3, fontFamily: C.body, fontSize: 13 }}>{e.title}</span>
              <span style={{ marginLeft: 'auto', color: C.t4, fontFamily: C.mono, fontSize: 10 }}>{e.tier}</span>
            </summary>
            <div style={{ marginTop: 8 }}>
              {e.params.length ? <div style={{ color: C.t3, fontFamily: C.body, fontSize: 12, marginBottom: 6 }}>Params: {e.params.map(p => <span key={p} style={{ ...code, marginRight: 4 }}>{p}</span>)}</div> : null}
              <pre style={{ background: C.bg2 || C.bg, color: C.t2, fontFamily: C.mono, fontSize: 11, padding: 10, borderRadius: 6, overflowX: 'auto', margin: 0 }}>{e.example}</pre>
            </div>
          </details>
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 5: Register the route + sidebar entry**

In `communityhunts-frontend/src/App.js`, add the import (near the other admin imports):

```jsx
import AdminDeveloperApi from './admin/DeveloperApi';
```

Add the route in BOTH admin trees (after the `slot-lists` / `announcements` routes):

```jsx
          <Route path="developer-api" element={<AdminDeveloperApi />} />
```
(both the `/admin` tree and the `/:slug/admin` tree — same two-place pattern as slot-lists).

In `communityhunts-frontend/src/admin/AdminLayout.js`, add to the `tabs` array:

```jsx
    { to: `${base}/developer-api`, label: 'Developer API' },
```

- [ ] **Step 6: Verify the build**

Run: `cd communityhunts-frontend && CI=true npm run build`
Expected: "Compiled successfully".

- [ ] **Step 7: Commit**

```bash
cd communityhunts-frontend
git add src/auth/features.js src/admin/adminApi.js src/admin/apiEndpoints.js src/admin/DeveloperApi.js src/App.js src/admin/AdminLayout.js
git commit -m "feat: Developer API admin page (key card, rate limits, endpoint docs)"
```

- [ ] **Step 8: Full preview verification (after backend deployed)**

On the Vercel branch preview: as a Pro+ community owner open `/<slug>/admin/developer-api` → Generate Key → copy the revealed `ch_live_…` → `curl -H "Authorization: Bearer ch_live_…" https://api.communityhunts.gg/api/public/v1/hunts` returns `{data,pagination}`; a premium endpoint (`/got-in`) returns 200 only on a Partner tenant (403 on Pro); roll invalidates the old key; revoke → 401. Confirm the response carries `X-RateLimit-*` headers. On a non-qualifying (Creator/free) tenant, the page shows the upgrade CTA and `POST` returns 403.

---

## Self-Review Notes

- **Spec coverage:** key infra (T1) ✓, tier features + middleware (T2) ✓, admin routes (T3) ✓, rate limiting (T4) ✓, serializers w/ anon-mask + no-leak (T5) ✓, public base endpoints + router-level CORS + error envelope (T6) ✓, premium + bangers extraction (T7) ✓, admin docs page + features mirror (T8) ✓. Deploy gate after T7 ✓. `/leaderboard` intentionally deferred (phase-5, ships with the leaderboard feature) ✓.
- **Refinements vs spec:** (a) store tenant **slug** in the key row + resolve via `getTenantBySlug` (call data fns with `tenant.id`) instead of adding `getTenantById` — simpler, uses existing exports. (b) Serializers reuse `publicHuntView` for anon-masking rather than re-implementing. (c) The spec's "mount before `resolveTenant`" is replaced by a **late DI mount + `requireApiKey` overriding `req.tenant`** — equally safe (verified: `resolveTenant` only 404s a *sent* unknown slug; public clients omit it), respects the router convention, avoids hoisting requires.
- **Security invariants:** tenant-from-key (T2 `requireApiKey` sets `apiTenant` + overrides `req.tenant`; handlers use `req.apiTenantId`), hashed keys (T1), whitelist serializers + anon mask (T5), `isActive` check (T2), cross-tenant `/hunts/:id` 404 (T6), router-level `*`/no-cred CORS (T6).
- **Naming consistency:** `requireApiKey`/`requireApiFeature`, `req.apiTenant`/`req.apiTenantId`/`req.apiTier`, `developer_api`/`developer_api_premium`, `publicHunt`/`publicStats`/`publicGotIn`/`publicBanger`, `collectBangers`, `getApiKey`/`rollApiKey`/`revokeApiKey` — consistent across tasks.
- **Open confirm-at-impl:** in T6 Step 2, confirm whether server.js references hunts-core as a namespace (`huntsCore`) or destructures it, and adapt the deps wiring accordingly (both forms noted).
