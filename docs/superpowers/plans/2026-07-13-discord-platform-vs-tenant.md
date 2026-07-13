# Discord Platform-vs-Tenant Bot Resolution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make all platform-level Discord posting (tickets, feature-requests, shop-requests, platform announcements) resolve the bot token from the platform tenant (Bean) via one helper — never `req.tenant` — so it's correct for every future streamer hub, and stop the env-vs-DB token drift.

**Architecture:** Add `tenants.getPlatformBotToken()` (Bean's DB token → `DISCORD_BOT_TOKEN` env fallback, trimmed). Inject it into the four platform routers via deps and replace their `req.tenant`-first resolution. Rewrite the tickets route test to prove a non-Bean tenant still posts with the platform token. Per-tenant integrations (call-import, winner-parse, role gating) are untouched.

**Tech Stack:** Node/Express (no build step), node:test, Discord REST v10.

**Spec:** `docs/superpowers/specs/2026-07-13-discord-platform-vs-tenant-design.md`.

## Global Constraints

- **Repo:** `communityhunts-backend/` only (wrapper dir is not a git repo — run git inside the app dir).
- **Branch:** `feat/discord-platform-token`, cut from current `main` (which already has Cabbage's `2b3b865` + the design-spec commit). `git pull --ff-only` before branching.
- **This corrects `2b3b865` (Cabbage's) on shared main → ship as a PR he reviews. DO NOT self-merge.**
- **No `Co-Authored-By` / Claude attribution** in commits or the PR body.
- **Tests:** `node --test lib/*.test.js routes/*.test.js` must pass (Node 24 needs the glob form).
- **Helper signature (exact):** `getPlatformBotToken()` → `string` (the platform bot token, trimmed). No args.
- **Rule:** platform integrations resolve the bot ONLY via `getPlatformBotToken()`, never `req.tenant`. Per-tenant integrations keep `req.tenant.discordBotToken` — do not touch them.
- **Regression guard (the point of the whole change):** a request whose `req.tenant.discordBotToken` differs from the platform token must still post with the platform token.

---

### Task 1: `getPlatformBotToken()` helper in `lib/tenants.js`

**Files:**
- Modify: `communityhunts-backend/lib/tenants.js` (add function after `getTenantBySlug` at line 217; export in `module.exports`)
- Test: `communityhunts-backend/lib/tenants.test.js` (create)

**Interfaces:**
- Consumes: existing `getTenantBySlug`, `BEAN_TENANT` (both in-module).
- Produces (Tasks 2–3 rely on this): `getPlatformBotToken()` → trimmed platform bot token string. Prefers the platform tenant (Bean)'s `discordBotToken`; falls back to `process.env.DISCORD_BOT_TOKEN`; `''` when neither is set.

- [ ] **Step 1: Create the branch**

```bash
cd communityhunts-backend
git pull --ff-only
git checkout -b feat/discord-platform-token
```

- [ ] **Step 2: Write the failing test**

Create `lib/tenants.test.js`. Set the env var BEFORE requiring the module (BEAN_TENANT seeds `discordBotToken` from it at load), and use a whitespace-padded value to also pin the trim:

```js
// getPlatformBotToken resolves the platform (Bean) bot token, env as seed/fallback.
// BEAN_TENANT reads DISCORD_BOT_TOKEN at module load, so set it before require().
process.env.DISCORD_BOT_TOKEN = '  seed-token  ';

const { test } = require('node:test');
const assert = require('node:assert');
const tenants = require('./tenants');

test('getPlatformBotToken returns the platform bot token, trimmed', () => {
  // No DB/admin token loaded → falls back to the env-seeded Bean token, trimmed.
  assert.strictEqual(tenants.getPlatformBotToken(), 'seed-token');
});

test('getPlatformBotToken is exported as a function', () => {
  assert.strictEqual(typeof tenants.getPlatformBotToken, 'function');
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `node --test lib/tenants.test.js`
Expected: FAIL — `tenants.getPlatformBotToken is not a function`.

- [ ] **Step 4: Add the helper**

In `lib/tenants.js`, immediately after line 217 (`function getTenantBySlug(slug) { return cache.get(slug) || null; }`), add:

```js
// Platform-level Discord bot token — for integrations that post to communityhunts.gg's OWN
// channels (tickets, feature-requests, shop-requests, platform announcements). ALWAYS the
// platform tenant (Bean)'s token, NEVER req.tenant (which, for a ticket submitted from a
// streamer's hub, would be that streamer's own community bot → 403 on our channels).
// Env DISCORD_BOT_TOKEN is only the seed/fallback; the admin-managed DB token wins.
function getPlatformBotToken() {
  const platform = getTenantBySlug('bean') || BEAN_TENANT;
  return ((platform && platform.discordBotToken) || process.env.DISCORD_BOT_TOKEN || '').trim();
}
```

Then add it to the `module.exports` object (the block starting at ~line 414) — insert `getPlatformBotToken,` alongside `getTenantBySlug`:

```js
  getTenantBySlug, getAllTenants, getPlatformBotToken, isPlatformOwner, isTenantAdmin, isTenantVip, isTenantMod,
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test lib/tenants.test.js`
Expected: both PASS. Then `node --test lib/*.test.js` — full lib suite green.

- [ ] **Step 6: Commit**

```bash
git add lib/tenants.js lib/tenants.test.js
git commit -m "feat: tenants.getPlatformBotToken() — platform-tenant bot token, env fallback"
```

---

### Task 2: Tickets use the platform bot (misc.routes) + regression-guard test

**Files:**
- Modify: `communityhunts-backend/routes/misc.routes.js` (deps, token line, comment)
- Rewrite: `communityhunts-backend/routes/misc.routes.test.js` (Cabbage's tenant-first tests → platform-token + regression guard)
- Modify: `communityhunts-backend/server.js:538` (misc mount deps)

**Interfaces:**
- Consumes: `getPlatformBotToken` (Task 1), injected via `deps.getPlatformBotToken`.
- Produces: `/api/tickets` posts with the platform token regardless of `req.tenant`.

- [ ] **Step 1: Rewrite the test to assert the correct behavior (RED)**

Replace the entire body of `routes/misc.routes.test.js` with the version below. It injects a stub `getPlatformBotToken` into the router deps and asserts the platform token is used even when `req.tenant` carries a different token:

```js
// POST /api/tickets — Discord bot token resolution.
// Tickets are PLATFORM-level: they post to communityhunts.gg's own channels and must always use
// the PLATFORM bot (getPlatformBotToken), NEVER req.tenant.discordBotToken — which, for a ticket
// from a streamer's hub, is that streamer's own community bot (→ 403 on our channels).
process.env.DISCORD_TICKETS_CHANNEL_ID = '111';
process.env.DISCORD_SUGGESTIONS_CHANNEL_ID = '222';

const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert');
const express = require('express');

const miscRoutes = require('./misc.routes');

// Stub global fetch to capture the Discord call; keep the real one for local requests.
const realFetch = global.fetch;
let discordCalls = [];
global.fetch = async (url, opts) => {
  discordCalls.push({ url: String(url), opts });
  return { ok: true, json: async () => ({}), text: async () => '' };
};
after(() => { global.fetch = realFetch; });
beforeEach(() => { discordCalls = []; });

// Mount the router with an injectable platform-token resolver + an optional req.tenant.
function appWith({ tenant, platformToken = 'platform-token' } = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { if (tenant) req.tenant = tenant; next(); });
  app.use(miscRoutes({ hunts: {}, archive: [], getPlatformBotToken: () => platformToken }));
  return app;
}

async function postTicket(app, body) {
  const server = await new Promise(resolve => { const s = app.listen(0, () => resolve(s)); });
  try {
    const r = await realFetch(`http://127.0.0.1:${server.address().port}/api/tickets`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: r.status, body: await r.json() };
  } finally {
    server.close();
  }
}

test('REGRESSION GUARD: a non-Bean tenant with its own bot token still posts with the PLATFORM token', async () => {
  const app = appWith({ tenant: { id: 'streamerX', discordBotToken: 'streamer-x-token' } });
  const r = await postTicket(app, { username: 'tester', issue: 'hello', type: 'Bug' });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(discordCalls.length, 1);
  assert.strictEqual(discordCalls[0].opts.headers.Authorization, 'Bot platform-token');
  assert.match(discordCalls[0].url, /\/channels\/111\/messages$/); // Bug → tickets channel
});

test('feature requests post with the platform token to the suggestions channel', async () => {
  const app = appWith({ tenant: null });
  const r = await postTicket(app, { username: 'tester', issue: 'idea', type: 'Feature Request' });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(discordCalls[0].opts.headers.Authorization, 'Bot platform-token');
  assert.match(discordCalls[0].url, /\/channels\/222\/messages$/); // Feature Request → suggestions
});

test('returns 500 when the platform bot token is not configured', async () => {
  const app = appWith({ tenant: null, platformToken: '' });
  const r = await postTicket(app, { username: 'tester', issue: 'hi', type: 'Bug' });
  assert.strictEqual(r.status, 500);
  assert.strictEqual(discordCalls.length, 0);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test routes/misc.routes.test.js`
Expected: FAIL — the regression-guard test sees `Bot streamer-x-token` (current code reads `req.tenant`), not `Bot platform-token`.

- [ ] **Step 3: Change the route to use the injected helper**

In `routes/misc.routes.js`:

3a. Replace the comment + `ENV_BOT_TOKEN` const (lines 13–19):

```js
// Ticket config is env-derived (config, not shared state) — read here so the router is self-sufficient.
// Posts via the one shared community bot — but the LIVE token is per-tenant in the DB
// (tenant.discordBotToken); the DISCORD_BOT_TOKEN env var is only a seed default and has gone
// stale in Railway before (announcements 2026-07-08, tickets 2026-07-13 — both prod 401s).
// Resolve per-request like announcements/cardRequests: req.tenant token first, env fallback.
// Tickets split by type: "Feature Request" → suggestions channel; everything else → tickets channel.
const ENV_BOT_TOKEN = (process.env.DISCORD_BOT_TOKEN || '').trim();
```

with (drop `ENV_BOT_TOKEN`; tickets are platform-level):

```js
// Ticket config is env-derived (config, not shared state) — read here so the router is self-sufficient.
// Tickets are PLATFORM-level: they post to communityhunts.gg's OWN channels, so the bot token is
// the PLATFORM bot (deps.getPlatformBotToken), NOT req.tenant — a ticket from a streamer's hub sets
// req.tenant to that streamer, whose own bot can't post to our channels. Channels stay global env.
// Tickets split by type: "Feature Request" → suggestions channel; everything else → tickets channel.
```

3b. Add `getPlatformBotToken` to the deps destructure (line 27):

```js
  const { hunts, archive, getPlatformBotToken } = deps;
```

3c. Replace the token resolution (line 80):

```js
    const botToken = ((req.tenant && req.tenant.discordBotToken) || ENV_BOT_TOKEN).trim();
```

with:

```js
    const botToken = getPlatformBotToken();
```

- [ ] **Step 4: Wire the dep in server.js**

In `server.js` line 538, replace:

```js
app.use(require('./routes/misc.routes')({ hunts, archive }));
```

with:

```js
app.use(require('./routes/misc.routes')({ hunts, archive, getPlatformBotToken: tenants.getPlatformBotToken }));
```

(`tenants` is already required in server.js — it's used for the slotLists/mods/etc. mounts.)

- [ ] **Step 5: Run tests + syntax to verify GREEN**

```bash
node --check routes/misc.routes.js
node --check server.js
node --test routes/misc.routes.test.js
```

Expected: checks silent; all three tests PASS.

- [ ] **Step 6: Commit**

```bash
git add routes/misc.routes.js routes/misc.routes.test.js server.js
git commit -m "fix: tickets post via platform bot, never req.tenant (multi-tenant safe) + regression test"
```

---

### Task 3: Shop-requests + announcements use the platform bot

**Files:**
- Modify: `communityhunts-backend/routes/cardRequests.routes.js` (deps + POST + PUT)
- Modify: `communityhunts-backend/routes/announcements.routes.js` (deps + POST)
- Modify: `communityhunts-backend/server.js` (announcements mount ~367–371, cardRequests mount ~385–389)

**Interfaces:**
- Consumes: `getPlatformBotToken` (Task 1) via deps.
- Produces: shop-requests + platform announcements post with the platform token, never `req.tenant`.

- [ ] **Step 1: cardRequests — swap the dep + both handlers**

In `routes/cardRequests.routes.js`:

1a. Deps destructure (line 34): replace

```js
  const { requireAuth, requirePlatformAdmin, cardRequests, envBotToken, channelId } = deps;
```

with:

```js
  const { requireAuth, requirePlatformAdmin, cardRequests, getPlatformBotToken, channelId } = deps;
```

1b. POST handler (line ~69) — replace

```js
    const botToken = (req.tenant && req.tenant.discordBotToken) || envBotToken;
```

with:

```js
    const botToken = getPlatformBotToken();
```

1c. PUT handler (line ~106) — the identical line — replace it the same way:

```js
    const botToken = getPlatformBotToken();
```

(Both handlers had `const botToken = (req.tenant && req.tenant.discordBotToken) || envBotToken;` — replace_all is safe here since both should become `getPlatformBotToken()`.)

- [ ] **Step 2: announcements — swap the dep + handler**

In `routes/announcements.routes.js`:

2a. Deps destructure (line 44): replace

```js
  const { requireAuth, requirePlatformAdmin, announcements, envBotToken, announcementsChannelId } = deps;
```

with:

```js
  const { requireAuth, requirePlatformAdmin, announcements, getPlatformBotToken, announcementsChannelId } = deps;
```

2b. Token line (line 60): replace

```js
    const botToken = (req.tenant && req.tenant.discordBotToken) || envBotToken;
```

with:

```js
    const botToken = getPlatformBotToken();
```

- [ ] **Step 3: Wire both mounts in server.js**

3a. Announcements mount (lines 367–371) — replace:

```js
app.use(require('./routes/announcements.routes')({
  requireAuth, requirePlatformAdmin, announcements,
  envBotToken: process.env.DISCORD_BOT_TOKEN,
  announcementsChannelId: process.env.DISCORD_ANNOUNCEMENTS_CHANNEL_ID,
}));
```

with:

```js
app.use(require('./routes/announcements.routes')({
  requireAuth, requirePlatformAdmin, announcements,
  getPlatformBotToken: tenants.getPlatformBotToken,
  announcementsChannelId: process.env.DISCORD_ANNOUNCEMENTS_CHANNEL_ID,
}));
```

3b. cardRequests mount (lines 385–389) — replace:

```js
app.use(require('./routes/cardRequests.routes')({
  requireAuth, requirePlatformAdmin, cardRequests,
  envBotToken: (process.env.DISCORD_BOT_TOKEN || '').trim(),
  channelId: (process.env.DISCORD_SHOP_REQUESTS_CHANNEL_ID || '').trim(),
}));
```

with:

```js
app.use(require('./routes/cardRequests.routes')({
  requireAuth, requirePlatformAdmin, cardRequests,
  getPlatformBotToken: tenants.getPlatformBotToken,
  channelId: (process.env.DISCORD_SHOP_REQUESTS_CHANNEL_ID || '').trim(),
}));
```

- [ ] **Step 4: Syntax + full test suite + boot smoke**

```bash
node --check routes/cardRequests.routes.js
node --check routes/announcements.routes.js
node --check server.js
node --test lib/*.test.js routes/*.test.js
```

Expected: checks silent; all tests green (lib suite + the 3 tickets tests).

Boot smoke (dummy creds, free port) — confirm nothing crashes and routes mount:

```bash
PORT=3101 DISCORD_CLIENT_ID=x DISCORD_CLIENT_SECRET=x SESSION_SECRET=x node server.js
```

Second shell — all must be gated/OK, none 404:

```bash
curl -s -o /dev/null -w "tickets(no-auth POST): %{http_code}\n" -X POST http://localhost:3101/api/tickets -H "Content-Type: application/json" -d '{"username":"x","issue":"x","type":"Bug"}'
curl -s -o /dev/null -w "card-requests(no-auth POST): %{http_code}\n" -X POST http://localhost:3101/api/card-requests -H "Content-Type: application/json" -d '{"idea":"x"}'
curl -s -o /dev/null -w "announcements(GET): %{http_code}\n" http://localhost:3101/api/announcements
```

Expected: tickets → 500 (`Discord bot not configured` — no token in this dummy boot, proving it resolves via the platform helper and got past mount); card-requests → 401 (auth gate); announcements GET → 200 (public list). None 404. Stop the server.

- [ ] **Step 5: Commit**

```bash
git add routes/cardRequests.routes.js routes/announcements.routes.js server.js
git commit -m "fix: shop-requests + announcements post via platform bot (never req.tenant)"
```

---

### Task 4: Ship as a PR for Cabbage's review

**Files:** none (git only)

**Interfaces:**
- Consumes: Tasks 1–3.
- Produces: an open PR. **Not merged by us** — it corrects Cabbage's `2b3b865` on shared main.

- [ ] **Step 1: Push the branch + open the PR**

```bash
git push -u origin feat/discord-platform-token
gh pr create --title "Discord: platform integrations post via the platform bot, never req.tenant (multi-tenant fix)" --body "$(cat <<'EOF'
Follow-up to #40 and to 2b3b865. Tickets/feature-requests/shop-requests/platform-announcements are PLATFORM-level — they post to communityhunts.gg's own channels and must always use the PLATFORM bot.

2b3b865 resolved the tickets token from req.tenant.discordBotToken (env fallback). That works for Bean (Bean == the platform), but the ticket form lives on the tenant hub (/:slug), so for any OTHER streamer req.tenant is THEIR tenant → it would post with THEIR community bot, which isn't in our Discord server → 403. It breaks tickets for every non-Bean tenant that has its own bot.

This adds tenants.getPlatformBotToken() (platform tenant / Bean DB token → DISCORD_BOT_TOKEN env fallback, trimmed) and routes all four platform integrations through it, never req.tenant. Per-tenant integrations (call-import, winner-parse, role gating) are untouched — they correctly stay on req.tenant.

Also ends the env-vs-DB token drift that caused two prod 401s (announcements 7/8, tickets 7/13): one managed source (Bean's admin-set DB token), env as seed/fallback.

Rewrites the misc.routes tests: the key assertion is a REGRESSION GUARD — a non-Bean tenant with its own bot token still posts with the platform token (the assertion that would have caught 2b3b865).

Spec: docs/superpowers/specs/2026-07-13-discord-platform-vs-tenant-design.md
Tested: node --test lib/*.test.js routes/*.test.js green; local boot verifies mounts + auth gates.

@RandyCabbages tagging you since this supersedes your 2b3b865 token-resolution approach — please review before merge.
EOF
)"
```

- [ ] **Step 2: Report the PR URL and STOP**

Do not merge. Post the PR link back to the user; Cabbage reviews and merges. After it merges, `git checkout main && git pull --ff-only` and verify the merge-base (this repo has dropped commits in merge races before).

---

## Self-review notes

- **Spec coverage:** helper (Task 1); tickets + regression guard (Task 2); shop-requests + announcements + server wiring (Task 3); PR-for-review + no-self-merge (Task 4); onboarding runbook + Railway are documentation/ops in the spec (no code). Per-tenant paths explicitly untouched. Announcements-as-platform-level implemented (Task 3).
- **Placeholder scan:** none — every code step shows exact before/after; the PR body is fully written.
- **Type consistency:** `getPlatformBotToken()` (no args → trimmed string) defined in Task 1, injected via `deps.getPlatformBotToken` and called as `getPlatformBotToken()` in Tasks 2–3; server.js passes `tenants.getPlatformBotToken` at all three mounts. Test stub matches the same shape (`() => platformToken`).
- **Lib-test honesty:** Task 1's test covers the env/seed path + trim + export shape (what's testable without bootstrapping the tenant cache). The platform-token-over-tenant-token behavior is authoritatively proven by Task 2's route regression guard — not faked at the lib level.
