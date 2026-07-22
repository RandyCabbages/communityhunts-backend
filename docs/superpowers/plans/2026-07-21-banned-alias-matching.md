# Site-wide alias directory + banned-member name matching — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a site-wide `user_aliases` directory (names each user is known by, captured for all users) and use it so a hunt runner is warned when a member typed in by name matches a banned user's alias — not just when matched by Discord ID.

**Architecture:** A new `user_aliases` table in `lib/settings.js` (alongside `known_users`) accumulates every distinct name seen per user, populated at login (via `recordKnownUser`), by a best-effort Discord fetch at ban time, and by manual admin entry. `POST /api/banned-status` gains a `names` input, resolves names→user_ids via the directory, intersects with the in-memory banned set, and returns a conditional response shape (legacy flat map when `names` is omitted, `{ids, names}` when present). The frontend collects unlinked-row names, consumes both maps via a pure `deriveBannedMembers` helper, and shows distinct copy for certain (ID) vs possible (name) matches.

**Tech Stack:** Node/Express + Postgres (backend), React 18 CRA (frontend). Backend tests: `node:test` run with `node --test <file>`. Frontend tests: CRA jest via `CI=true npx react-scripts test`.

## Global Constraints

- **No `Co-Authored-By` / AI-attribution trailers** on any commit (Kyle's repos).
- **Backend repo:** `C:\Users\kylew\communityhunts-backend`, branch `banned-alias-matching` (already created, spec committed there).
- **Frontend repo:** `C:\Users\kylew\communityhunts-frontend` — create branch `banned-alias-matching`; NEVER push to `main` to test (main auto-deploys to prod). `CI=true npm run build` must print "Compiled successfully" (Vercel treats warnings as errors).
- **Matching is exact after normalization only** — `normalizeName` = lowercase, collapse internal whitespace to single spaces, trim. No fuzzy/substring.
- **`recordAlias` and the ban-time Discord fetch are strictly best-effort** — no-op without pgPool, never throw, never block or fail a ban.
- **Never use `process.env.DISCORD_BOT_TOKEN`** — it is stale (401s). Use `getPlatformBotToken()`.
- **Deploy order: backend first, frontend second.** The `/api/banned-status` response shape is conditional on `names` presence so the old frontend keeps working during the gap.
- Backend tests run per-file: `node --test <path>`. Frontend pure-logic modules get a `.test.js`; components do not.

---

## Task 1: Alias directory primitives in `lib/settings.js`

**Files:**
- Modify: `C:\Users\kylew\communityhunts-backend\lib\settings.js` (add `normalizeName`, `recordAlias`, `findAliasOwners`, `user_aliases` table in `initSettings`, exports)
- Test: `C:\Users\kylew\communityhunts-backend\lib\settings.alias.test.js` (create)

**Interfaces:**
- Produces:
  - `normalizeName(s: string) -> string`
  - `recordAlias(userId: string, name: string, source: string) -> void` (fire-and-forget)
  - `async findAliasOwners(names: string[]) -> Map<rawName: string, Set<userId: string>>`

- [ ] **Step 1: Write the failing test**

Create `lib/settings.alias.test.js` (mirrors the fake-pgPool pattern in `lib/bans.test.js`):

```js
const { test } = require('node:test');
const assert = require('node:assert');
const settings = require('./settings');

// Fake pgPool: records queries; returns canned rows for SELECT, {rows:[]} otherwise.
function makeFakePgPool(selectRows) {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql, params });
      if (/^\s*SELECT\b/i.test(sql)) return { rows: selectRows || [] };
      return { rows: [] };
    },
  };
}

test('normalizeName lowercases, trims, collapses whitespace', () => {
  assert.strictEqual(settings.normalizeName('  Raph '), 'raph');
  assert.strictEqual(settings.normalizeName('Big   Raph'), 'big raph');
  assert.strictEqual(settings.normalizeName(null), '');
});

test('recordAlias upserts normalized alias with ON CONFLICT DO NOTHING', () => {
  const pg = makeFakePgPool();
  settings.initSettings({ pgPool: pg, hunts: {} });
  const before = pg.calls.length;
  settings.recordAlias('123', ' Raph ', 'manual');
  const insert = pg.calls.slice(before).find(c => /INSERT INTO user_aliases/i.test(c.sql));
  assert.ok(insert, 'expected an INSERT INTO user_aliases');
  assert.ok(/ON CONFLICT .*DO NOTHING/is.test(insert.sql));
  assert.deepStrictEqual(insert.params, ['123', 'raph', 'Raph', 'manual']);
});

test('recordAlias is a no-op for blank names', () => {
  const pg = makeFakePgPool();
  settings.initSettings({ pgPool: pg, hunts: {} });
  const before = pg.calls.length;
  settings.recordAlias('123', '   ', 'login');
  const inserts = pg.calls.slice(before).filter(c => /INSERT INTO user_aliases/i.test(c.sql));
  assert.strictEqual(inserts.length, 0);
});

test('findAliasOwners maps raw names to owner id sets', async () => {
  const pg = makeFakePgPool([
    { alias_norm: 'raph', user_id: '693' },
    { alias_norm: 'raph', user_id: '999' },
  ]);
  settings.initSettings({ pgPool: pg, hunts: {} });
  const map = await settings.findAliasOwners(['Raph', 'Nobody']);
  assert.deepStrictEqual([...(map.get('Raph') || [])].sort(), ['693', '999']);
  assert.ok(!map.has('Nobody'));
});

test('findAliasOwners returns empty map with no pgPool', async () => {
  settings.initSettings({ pgPool: null, hunts: {} });
  const map = await settings.findAliasOwners(['Raph']);
  assert.strictEqual(map.size, 0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test lib/settings.alias.test.js`
Expected: FAIL — `settings.normalizeName`/`recordAlias`/`findAliasOwners` are not functions.

- [ ] **Step 3: Implement the primitives**

In `lib/settings.js`, add the `user_aliases` table creation inside `initSettings`, right after the `known_users` `CREATE TABLE` block (near line 83):

```js
    // Site-wide alias directory: accumulates every distinct name seen per user (name history),
    // reverse-indexed by normalized alias for name→id lookups (banned-member warning + future).
    pgPool.query(`
      CREATE TABLE IF NOT EXISTS user_aliases (
        user_id    TEXT NOT NULL,
        alias_norm TEXT NOT NULL,
        alias      TEXT NOT NULL,
        source     TEXT,
        seen_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (user_id, alias_norm)
      )
    `).then(() => pgPool.query(
      `CREATE INDEX IF NOT EXISTS idx_user_aliases_norm ON user_aliases (alias_norm)`
    )).then(() => console.log('[user_aliases] Postgres table ready'))
      .catch(e => console.error('[user_aliases] init failed:', e.message));
```

Add these functions (place them just above `recordKnownUser`, near line 95):

```js
// Normalize a human name for alias matching: lowercase, collapse internal whitespace, trim.
// Deliberately NOT the slot normalizer (which strips punctuation + trailing 's') — wrong for names.
// (Mirrors normAnonName; kept as its own exported name for the alias directory.)
function normalizeName(s) {
  return (s || '').toString().toLowerCase().replace(/\s+/g, ' ').trim();
}

// Append a name we've seen for a user into the alias directory. Accumulates; first-seen wins on
// conflict. Best-effort: no-op without pgPool or a blank name, never throws.
function recordAlias(userId, name, source) {
  if (!pgPool || !userId) return;
  const norm = normalizeName(name);
  if (!norm) return;
  pgPool.query(
    `INSERT INTO user_aliases (user_id, alias_norm, alias, source)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (user_id, alias_norm) DO NOTHING`,
    [String(userId), norm, String(name).trim(), source || null]
  ).catch(e => console.error('[user_aliases] record failed:', e.message));
}

// Reverse lookup: given raw names, return Map<rawName, Set<userId>> for names that have >=1 owner.
// Keyed by the ORIGINAL raw string the caller passed, so consumers need no normalizer of their own.
async function findAliasOwners(names) {
  const out = new Map();
  if (!pgPool || !Array.isArray(names) || !names.length) return out;
  const normToRaw = new Map(); // alias_norm -> [rawName,...]
  for (const raw of names) {
    const norm = normalizeName(raw);
    if (!norm) continue;
    if (!normToRaw.has(norm)) normToRaw.set(norm, []);
    normToRaw.get(norm).push(raw);
  }
  if (!normToRaw.size) return out;
  try {
    const r = await pgPool.query(
      `SELECT alias_norm, user_id FROM user_aliases WHERE alias_norm = ANY($1)`,
      [Array.from(normToRaw.keys())]
    );
    for (const row of r.rows) {
      for (const raw of (normToRaw.get(row.alias_norm) || [])) {
        if (!out.has(raw)) out.set(raw, new Set());
        out.get(raw).add(String(row.user_id));
      }
    }
  } catch (e) { console.error('[user_aliases] find failed:', e.message); }
  return out;
}
```

Add to `module.exports` (near line 288):

```js
  normalizeName,
  recordAlias,
  findAliasOwners,
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test lib/settings.alias.test.js`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
cd C:/Users/kylew/communityhunts-backend
git add lib/settings.js lib/settings.alias.test.js
git commit -m "feat(bans): user_aliases directory primitives"
```

---

## Task 2: Capture aliases on login via `recordKnownUser`

**Files:**
- Modify: `C:\Users\kylew\communityhunts-backend\lib\settings.js` (`recordKnownUser`, near line 96)
- Test: `C:\Users\kylew\communityhunts-backend\lib\settings.alias.test.js` (add a test)

**Interfaces:**
- Consumes: `recordAlias` (Task 1).

- [ ] **Step 1: Write the failing test**

Append to `lib/settings.alias.test.js`:

```js
test('recordKnownUser also records display name and username aliases', () => {
  const pg = makeFakePgPool();
  settings.initSettings({ pgPool: pg, hunts: {} });
  const before = pg.calls.length;
  settings.recordKnownUser({ id: '693', displayName: 'Raph', username: 'raph_ttv' });
  const aliasInserts = pg.calls.slice(before)
    .filter(c => /INSERT INTO user_aliases/i.test(c.sql))
    .map(c => c.params[2]); // display form
  assert.ok(aliasInserts.includes('Raph'), 'display name recorded as alias');
  assert.ok(aliasInserts.includes('raph_ttv'), 'username recorded as alias');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test lib/settings.alias.test.js`
Expected: FAIL — no `INSERT INTO user_aliases` produced by `recordKnownUser`.

- [ ] **Step 3: Implement the hook**

In `recordKnownUser` (`lib/settings.js`), inside the `if (pgPool) {` block, after the existing `known_users` insert `.catch(...)` (line 108), add:

```js
    // Also accumulate into the alias directory (name history for all users).
    recordAlias(user.id, user.displayName, 'login');
    if (user.username) recordAlias(user.id, user.username, 'login');
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test lib/settings.alias.test.js`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
cd C:/Users/kylew/communityhunts-backend
git add lib/settings.js lib/settings.alias.test.js
git commit -m "feat(bans): capture login names into alias directory"
```

---

## Task 3: `/api/banned-status` name matching + conditional shape

**Files:**
- Modify: `C:\Users\kylew\communityhunts-backend\routes\hunts.routes.js:33-44` (the `/api/banned-status` handler + deps destructure at line 24-26)
- Modify: `C:\Users\kylew\communityhunts-backend\server.js:414-424` (add `findAliasOwners` to hunts.routes deps)
- Test: `C:\Users\kylew\communityhunts-backend\routes\hunts.routes.test.js` (add tests)

**Interfaces:**
- Consumes: `findAliasOwners` (Task 1); `bans.isBanned`, `bans.getBan` (existing).
- Produces: `POST /api/banned-status` accepts `{ ids?, names? }`; returns legacy `{ "<id>": {banned,reason} }` when `names` omitted, else `{ ids: {...}, names: { "<rawName>": {banned,reason} } }`.

- [ ] **Step 1: Write the failing test**

Open `routes/hunts.routes.test.js`. It has an `appWith({tenantId})` builder and a GET-only `get()` helper (lines 14-40), but the builder omits `bans`/`findAliasOwners` and there is no `express.json()` (existing tests are GET). Add a POST-capable builder + helper and two tests:

```js
function bannedApp({ bans, findAliasOwners }) {
  const app = express();
  app.use(express.json()); // banned-status reads req.body
  app.use((req, res, next) => { req.tenant = { id: 'bean' }; req.user = { id: 'runner' }; next(); });
  app.use(huntsRoutes({
    requireAuth: (req, res, next) => next(),
    canEditHunt: () => false, isEquityMember: () => false, reqIsMod: () => false,
    hunts: {}, archive: [], getPublicHunts: () => [], getArchivedHunts: () => [],
    emitHubUpdate() {}, emitHuntUpdate() {}, publicHuntView: h => h,
    uid: () => 'x', touch() {}, persistHunts() {}, archiveHunt() {}, unarchiveHunt() {},
    io: { emit() {} }, rejectBadHuntInput: () => null,
    resolveUserIdByName: async () => null, getCreatorLive: () => ({ isLive: false }), refreshCreatorsLive() {},
    bans, findAliasOwners,
  }));
  return app;
}

async function post(app, pathname, body) {
  const server = await new Promise(r => { const s = app.listen(0, () => r(s)); });
  try {
    const r = await fetch(`http://127.0.0.1:${server.address().port}${pathname}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    return { status: r.status, body: await r.json().catch(() => null) };
  } finally { await new Promise(res => server.close(res)); }
}

test('/api/banned-status: names omitted → legacy flat shape', async () => {
  const app = bannedApp({
    bans: { isBanned: (id) => id === '693', getBan: () => ({ reason: 'scamming' }) },
    findAliasOwners: async () => new Map(),
  });
  const res = await post(app, '/api/banned-status', { ids: ['693', '111'] });
  assert.deepStrictEqual(res.body, { '693': { banned: true, reason: 'scamming' } });
});

test('/api/banned-status: names present → {ids,names} and matches a banned alias', async () => {
  const app = bannedApp({
    bans: { isBanned: (id) => id === '693', getBan: () => ({ reason: 'scamming' }) },
    findAliasOwners: async (names) => {
      const m = new Map();
      if (names.includes('rap')) m.set('rap', new Set(['693']));
      return m;
    },
  });
  const res = await post(app, '/api/banned-status', { ids: [], names: ['rap', 'Legit'] });
  assert.deepStrictEqual(res.body, { ids: {}, names: { rap: { banned: true, reason: 'scamming' } } });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test routes/hunts.routes.test.js`
Expected: FAIL — handler ignores `names`, returns flat map (second test fails on shape).

- [ ] **Step 3: Implement the handler**

In `routes/hunts.routes.js`, add `findAliasOwners` to the deps destructure (the `const { ... } = deps;` block ending near line 26):

```js
    resolveUserIdByName, getCreatorLive, refreshCreatorsLive, getKnownUser, auditLog, bans,
    findAliasOwners,
  } = deps;
```

Replace the handler (lines 33-44) with:

```js
  router.post('/api/banned-status', requireAuth, async (req, res) => {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
    const names = Array.isArray(req.body?.names) ? req.body.names : null;

    const idOut = {};
    for (const raw of ids.slice(0, 100)) {
      const id = String(raw || '').trim();
      if (id && bans && bans.isBanned(id)) {
        const b = bans.getBan(id) || {};
        idOut[id] = { banned: true, reason: b.reason };
      }
    }

    // Legacy clients omit `names` → keep the old flat { <id>: {...} } shape (deploy safety).
    if (names === null) return res.json(idOut);

    const nameOut = {};
    const owners = findAliasOwners ? await findAliasOwners(names.slice(0, 100)) : new Map();
    for (const [rawName, userIds] of owners) {
      for (const uid of userIds) {
        if (bans && bans.isBanned(uid)) {
          const b = bans.getBan(uid) || {};
          nameOut[rawName] = { banned: true, reason: b.reason };
          break;
        }
      }
    }
    res.json({ ids: idOut, names: nameOut });
  });
```

In `server.js`, add `findAliasOwners` to the hunts.routes deps object (near line 422):

```js
  getKnownUser: settings.getKnownUser,
  findAliasOwners: settings.findAliasOwners,
  auditLog, bans,
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test routes/hunts.routes.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd C:/Users/kylew/communityhunts-backend
git add routes/hunts.routes.js routes/hunts.routes.test.js server.js
git commit -m "feat(bans): name matching in /api/banned-status via alias directory"
```

---

## Task 4: Admin ban — manual aliases + Discord enrich + dep wiring

**Files:**
- Modify: `C:\Users\kylew\communityhunts-backend\routes\admin.routes.js:29-36` (deps), `:259-276` (POST handler)
- Modify: `C:\Users\kylew\communityhunts-backend\server.js:642-649` (admin.routes deps)
- Test: `C:\Users\kylew\communityhunts-backend\routes\admin.routes.test.js` (add tests)

**Interfaces:**
- Consumes: `recordAlias`, `recordKnownUser` (settings), `getPlatformBotToken` (tenants), global `fetch`, `bans.addBan` (existing).
- Produces: `POST /api/admin/banned-users` accepts optional `aliases: string[]`; records them (`source:'manual'`) and best-effort enriches the directory from Discord. Ban succeeds regardless of Discord outcome.

- [ ] **Step 1: Write the failing test**

`routes/admin.routes.test.js` already has a `banApp({ platformAdmin, bansImpl, audit })` builder (lines 116-132) and a `req(app, method, pathname, body)` helper (134-143). **First, extend `banApp`** to accept and pass the three new deps (defaulting to no-ops), by editing its signature and the `adminRoutes({...})` call:

```js
function banApp({ platformAdmin = true, bansImpl, audit, recordAlias, recordKnownUser, getPlatformBotToken } = {}) {
  // ...existing body...
  app.use(adminRoutes({
    // ...existing deps...
    subscriptions: {}, auditLog: audit || { record() {} },
    recordAlias: recordAlias || (() => {}),
    recordKnownUser: recordKnownUser || (() => {}),
    getPlatformBotToken: getPlatformBotToken || (() => null),
  }));
  return app;
}
```

Then add:

```js
test('add-ban records manual aliases and survives a failing Discord fetch', async () => {
  const recorded = [];
  const origFetch = global.fetch;
  global.fetch = async () => { throw new Error('network down'); }; // enrich fails
  try {
    const app = banApp({
      bansImpl: { addBan: async () => {} },
      recordAlias: (id, alias, source) => recorded.push({ id, alias, source }),
      getPlatformBotToken: () => 'tok',
    });
    const res = await req(app, 'POST', '/api/admin/banned-users',
      { discordId: '693694981457838140', aliases: ['rap', 'Raph'] });
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(
      recorded.filter(r => r.source === 'manual').map(r => r.alias).sort(),
      ['Raph', 'rap']);
  } finally { global.fetch = origFetch; }
});

test('add-ban enriches aliases from a successful Discord fetch', async () => {
  const recorded = [];
  const origFetch = global.fetch;
  global.fetch = async () => ({ ok: true, status: 200,
    json: async () => ({ id: '693694981457838140', username: 'raph_ttv', global_name: 'Raph' }) });
  try {
    const app = banApp({
      bansImpl: { addBan: async () => {} },
      recordAlias: (id, alias, source) => recorded.push({ id, alias, source }),
      getPlatformBotToken: () => 'tok',
    });
    const res = await req(app, 'POST', '/api/admin/banned-users', { discordId: '693694981457838140' });
    assert.strictEqual(res.status, 200);
    const discordAliases = recorded.filter(r => r.source === 'discord').map(r => r.alias).sort();
    assert.deepStrictEqual(discordAliases, ['Raph', 'raph_ttv']);
  } finally { global.fetch = origFetch; }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test routes/admin.routes.test.js`
Expected: FAIL — handler ignores `aliases` and does no enrich; `recorded` is empty.

- [ ] **Step 3: Implement**

In `routes/admin.routes.js`, add to the deps destructure (lines 29-36):

```js
    subscriptions, auditLog, getPlatformBotToken, recordAlias, recordKnownUser,
```

In the POST `/api/admin/banned-users` handler (after `await bans.addBan(...)` at line 266, before the `auditLog.record(...)`), add:

```js
      // Manual aliases → directory (best-effort).
      const aliases = Array.isArray(req.body?.aliases) ? req.body.aliases : [];
      for (const a of aliases.slice(0, 20)) {
        if (recordAlias) recordAlias(discordId, a, 'manual');
      }
      // Best-effort Discord enrich — must NEVER block or fail the ban.
      try {
        const botToken = getPlatformBotToken && getPlatformBotToken();
        if (botToken) {
          const resp = await fetch(`https://discord.com/api/v10/users/${discordId}`,
            { headers: { Authorization: `Bot ${botToken}` } });
          if (resp.ok) {
            const u = await resp.json().catch(() => null);
            if (u && u.id) {
              if (recordAlias && u.username) recordAlias(discordId, u.username, 'discord');
              if (recordAlias && u.global_name) recordAlias(discordId, u.global_name, 'discord');
              if (recordKnownUser) recordKnownUser({
                id: String(u.id),
                displayName: u.global_name || u.username || `User ${discordId}`,
                username: u.username || null,
                avatar: u.avatar || null,
              });
            }
          }
        }
      } catch (e) { console.error('[admin] ban discord enrich failed:', e.message); }
```

In `server.js`, add to the `admin.routes` deps object (line 648):

```js
  subscriptions, auditLog,
  getPlatformBotToken: tenants.getPlatformBotToken,
  recordAlias: settings.recordAlias,
  recordKnownUser: settings.recordKnownUser,
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test routes/admin.routes.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd C:/Users/kylew/communityhunts-backend
git add routes/admin.routes.js routes/admin.routes.test.js server.js
git commit -m "feat(bans): admin ban records manual + Discord aliases"
```

---

## Task 5: Frontend `deriveBannedMembers` pure helper

**Files:**
- Create: `C:\Users\kylew\communityhunts-frontend\src\hunt\deriveBannedMembers.js`
- Test: `C:\Users\kylew\communityhunts-frontend\src\hunt\deriveBannedMembers.test.js`

> First: `cd C:/Users/kylew/communityhunts-frontend && git checkout -b banned-alias-matching` (if not already on it).

**Interfaces:**
- Produces: `deriveBannedMembers(equity, idMap, nameMap, dismissed) -> Array<{discordId?, name, reason, matchType:'id'|'name'}>`. `idMap` keyed by discordId, `nameMap` by raw member name, `dismissed` is a `Set` of `id:<discordId>` / `name:<rawName>` keys.

- [ ] **Step 1: Write the failing test**

Create `src/hunt/deriveBannedMembers.test.js`:

```js
import { deriveBannedMembers } from './deriveBannedMembers';

const idMap = { '693': { banned: true, reason: 'scamming' } };
const nameMap = { rap: { banned: true, reason: 'scamming' } };

test('flags an id-linked banned member as an id match', () => {
  const eq = [{ id: 'a', discordId: '693', name: 'Raph' }];
  const out = deriveBannedMembers(eq, idMap, nameMap, new Set());
  expect(out).toEqual([{ discordId: '693', name: 'Raph', reason: 'scamming', matchType: 'id' }]);
});

test('flags a name-only banned member as a name match', () => {
  const eq = [{ id: 'a', name: 'rap' }];
  const out = deriveBannedMembers(eq, idMap, nameMap, new Set());
  expect(out).toEqual([{ name: 'rap', reason: 'scamming', matchType: 'name' }]);
});

test('a linked row is NOT name-matched (id check is authoritative)', () => {
  // Row has a discordId that is NOT banned but a name that IS a banned alias → no warning.
  const eq = [{ id: 'a', discordId: '000', name: 'rap' }];
  const out = deriveBannedMembers(eq, idMap, nameMap, new Set());
  expect(out).toEqual([]);
});

test('id match takes precedence over name for the same row', () => {
  const eq = [{ id: 'a', discordId: '693', name: 'rap' }];
  const out = deriveBannedMembers(eq, idMap, nameMap, new Set());
  expect(out).toEqual([{ discordId: '693', name: 'rap', reason: 'scamming', matchType: 'id' }]);
});

test('dismissed rows are filtered out', () => {
  const eq = [{ id: 'a', name: 'rap' }, { id: 'b', discordId: '693', name: 'Raph' }];
  const out = deriveBannedMembers(eq, idMap, nameMap, new Set(['name:rap', 'id:693']));
  expect(out).toEqual([]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `CI=true npx react-scripts test --testPathPattern="deriveBannedMembers" --watchAll=false`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `src/hunt/deriveBannedMembers.js`:

```js
// Pure derivation of the banned-member warning list from the current equity + the ban maps
// returned by POST /api/banned-status. `idMap` is keyed by discordId, `nameMap` by the raw member
// name (exactly as sent). Rules:
//  - A row WITH a discordId is checked ONLY by id (the id check is authoritative) — never
//    name-matched, so a legit linked member who happens to share a banned alias is not flagged.
//  - A row WITHOUT a discordId is checked by name.
//  - `dismissed` is a Set of keys: `id:<discordId>` or `name:<rawName>`.
export function deriveBannedMembers(equity, idMap, nameMap, dismissed) {
  const out = [];
  const dis = dismissed || new Set();
  for (const e of equity || []) {
    if (!e) continue;
    const id = e.discordId ? String(e.discordId) : null;
    if (id) {
      if (idMap && idMap[id] && !dis.has('id:' + id)) {
        out.push({ discordId: id, name: e.name, reason: idMap[id].reason, matchType: 'id' });
      }
      continue; // linked rows are never name-matched
    }
    const name = e.name != null ? String(e.name) : '';
    if (name && nameMap && nameMap[name] && !dis.has('name:' + name)) {
      out.push({ name, reason: nameMap[name].reason, matchType: 'name' });
    }
  }
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `CI=true npx react-scripts test --testPathPattern="deriveBannedMembers" --watchAll=false`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
cd C:/Users/kylew/communityhunts-frontend
git add src/hunt/deriveBannedMembers.js src/hunt/deriveBannedMembers.test.js
git commit -m "feat(bans): deriveBannedMembers pure helper"
```

---

## Task 6: Rewrite `useBannedEquityWarning` to send/consume ids+names

**Files:**
- Modify: `C:\Users\kylew\communityhunts-frontend\src\hunt\useBannedEquityWarning.js` (full rewrite)

**Interfaces:**
- Consumes: `deriveBannedMembers` (Task 5); backend `{ ids, names }` response (Task 3).
- Produces: unchanged public shape `{ bannedMembers, dismiss }` for `HuntTracker`.

- [ ] **Step 1: Rewrite the hook**

Replace the entire body of `src/hunt/useBannedEquityWarning.js` with:

```js
import { useEffect, useRef, useState } from 'react';
import { apiFetch } from '../api';
import { deriveBannedMembers } from './deriveBannedMembers';

// Warns a hunt runner when a banned user is in their equity list. Adding is NEVER blocked — this
// only informs. Two match paths:
//  - by Discord ID: rows that carry a linked `discordId` (certain match).
//  - by name: rows added by name with NO discordId, matched against the site-wide alias directory
//    (possible match — a heads-up to verify).
// The fetch keys on the SET of ids AND the SET of names (editing amounts doesn't refetch). Names
// are sent raw and echoed back raw by the backend, so no normalization is needed here.
export function useBannedEquityWarning(equity, enabled) {
  const [idMap, setIdMap] = useState({});
  const [nameMap, setNameMap] = useState({});
  const dismissedRef = useRef(new Set());
  const [, setTick] = useState(0);

  const rows = (equity || []).filter(Boolean);
  const ids = rows.map(e => (e.discordId ? String(e.discordId) : null)).filter(Boolean);
  const names = rows.filter(e => !e.discordId && e.name).map(e => String(e.name));
  const idKey = enabled ? Array.from(new Set(ids)).sort().join(',') : '';
  const nameKey = enabled ? Array.from(new Set(names)).sort().join(',') : '';

  useEffect(() => {
    if (!enabled || (!idKey && !nameKey)) { setIdMap({}); setNameMap({}); return undefined; }
    let cancelled = false;
    apiFetch('/api/banned-status', {
      method: 'POST',
      body: JSON.stringify({
        ids: idKey ? idKey.split(',') : [],
        names: nameKey ? nameKey.split(',') : [],
      }),
    })
      .then((res) => {
        if (cancelled) return;
        setIdMap((res && res.ids) || {});
        setNameMap((res && res.names) || {});
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [idKey, nameKey, enabled]);

  const bannedMembers = deriveBannedMembers(equity, idMap, nameMap, dismissedRef.current);

  const dismiss = () => {
    bannedMembers.forEach((b) => dismissedRef.current.add(
      b.matchType === 'id' ? 'id:' + b.discordId : 'name:' + b.name));
    setTick((n) => n + 1);
  };

  return { bannedMembers, dismiss };
}
```

- [ ] **Step 2: Verify the build compiles**

Run: `CI=true npm run build`
Expected: "Compiled successfully".

- [ ] **Step 3: Run the derive tests (regression)**

Run: `CI=true npx react-scripts test --testPathPattern="deriveBannedMembers" --watchAll=false`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
cd C:/Users/kylew/communityhunts-frontend
git add src/hunt/useBannedEquityWarning.js
git commit -m "feat(bans): warn on id and name matches in equity"
```

---

## Task 7: Dual-copy warning in `BannedMemberWarning`

**Files:**
- Modify: `C:\Users\kylew\communityhunts-frontend\src\hunt\BannedMemberWarning.js` (full rewrite)

**Interfaces:**
- Consumes: `members` items now carry `matchType:'id'|'name'` (Task 5/6).

- [ ] **Step 1: Rewrite the component**

Replace `src/hunt/BannedMemberWarning.js` with (keeps the existing modal chrome; splits copy by match type):

```js
import React from 'react';

// Runner-facing warning: one or more banned users are in this hunt's equity. Informational — it
// does NOT block or remove anyone. ID matches are certain ("is banned"); name matches are only
// possible ("matches a known scammer's alias — verify"), so they read as a heads-up to check.
export default function BannedMemberWarning({ members, onDismiss }) {
  if (!members || !members.length) return null;
  const idMatches = members.filter(m => m.matchType === 'id');
  const nameMatches = members.filter(m => m.matchType !== 'id');
  const label = (m) => m.name || m.discordId;

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 99990, background: 'rgba(6,4,12,0.85)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20,
      fontFamily: "'Inter','Sora',sans-serif" }}>
      <div style={{ maxWidth: 440, width: '100%', background: '#17121f', border: '1px solid rgba(251,191,36,0.55)',
        borderRadius: 14, padding: '26px 24px', textAlign: 'center', boxShadow: '0 20px 60px rgba(0,0,0,0.6)' }}>
        <div style={{ fontSize: 38, marginBottom: 8 }}>⚠️</div>
        <h2 style={{ color: '#fbbf24', margin: '0 0 12px', fontSize: 19, fontWeight: 800 }}>
          {idMatches.length ? 'Banned user in this hunt' : 'Possible banned user'}
        </h2>

        {idMatches.length > 0 && (
          <p style={{ color: '#e8e4f0', margin: '0 0 14px', fontSize: 14, lineHeight: 1.6 }}>
            <strong style={{ color: '#fff' }}>{idMatches.map(label).join(', ')}</strong>{' '}
            {idMatches.length > 1 ? 'have' : 'has'} been banned from CommunityHunts for{' '}
            {idMatches[0].reason || 'scamming'}. Handing them a spot is at your own risk.
          </p>
        )}

        {nameMatches.length > 0 && (
          <p style={{ color: '#e8e4f0', margin: '0 0 14px', fontSize: 14, lineHeight: 1.6 }}>
            A member named <strong style={{ color: '#fff' }}>{nameMatches.map(label).join(', ')}</strong>{' '}
            matches a known scammer's alias (banned for {nameMatches[0].reason || 'scamming'}) —{' '}
            verify their Discord before giving them a spot.
          </p>
        )}

        <button onClick={onDismiss} style={{ marginTop: 6, height: 40, padding: '0 22px', background: '#fbbf24',
          color: '#231a04', border: 'none', borderRadius: 9, fontWeight: 800, fontSize: 14, cursor: 'pointer' }}>
          I understand
        </button>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Verify the build compiles**

Run: `CI=true npm run build`
Expected: "Compiled successfully".

- [ ] **Step 3: Commit**

```bash
cd C:/Users/kylew/communityhunts-frontend
git add src/hunt/BannedMemberWarning.js
git commit -m "feat(bans): distinct copy for id vs name matches"
```

---

## Task 8: Admin Aliases field (frontend)

**Files:**
- Modify: `C:\Users\kylew\communityhunts-frontend\src\admin\adminApi.js:72` (`banUser` passes `aliases`)
- Modify: `C:\Users\kylew\communityhunts-frontend\src\admin\AdminBans.js` (aliases input + display)

**Interfaces:**
- Consumes: backend `POST /api/admin/banned-users` accepting `aliases` (Task 4).

- [ ] **Step 1: Thread `aliases` through `banUser`**

In `src/admin/adminApi.js`, replace the `banUser` line (72):

```js
export const banUser = ({ discordId, reason, message, aliases } = {}) =>
  apiFetch('/api/admin/banned-users', {
    method: 'POST',
    body: JSON.stringify({ discordId, reason, message, aliases }),
  });
```

- [ ] **Step 2: Add the aliases input to `AdminBans.js`**

In `src/admin/AdminBans.js`: add state near the others (line ~15):

```js
  const [aliases, setAliases] = React.useState('');
```

Update the ban call in the add handler (line ~23) to include parsed aliases:

```js
    banUser({
      discordId: newId.trim(),
      reason: reason.trim() || undefined,
      aliases: aliases.split(',').map(s => s.trim()).filter(Boolean),
    })
```

After the handler resets other fields on success, also `setAliases('')` (match the existing reset).

Add an input next to the reason input (after line ~49), same styling as the `reason` input:

```jsx
          <input value={aliases} onChange={e => setAliases(e.target.value)}
            placeholder="Extra aliases, comma-separated (e.g. rap, raph)"
            style={/* copy the style object used by the reason input above */} />
```

Show any stored aliases on each ban row — inside the row's text block (after the reason `<span>`, line ~66), when `r.aliases?.length`:

```jsx
              {r.aliases?.length ? (
                <span style={{ display: 'block', color: C.t4, fontFamily: C.body, fontSize: 11 }}>
                  aka {r.aliases.join(', ')}
                </span>
              ) : null}
```

> `r.aliases` will be undefined until the backend list endpoint returns it — this render guards on
> `?.length`, so it's harmless now and lights up if/when the list is extended. (Listing aliases per
> ban is optional polish; the add-path is what matters for this feature.)

- [ ] **Step 3: Verify the build compiles**

Run: `CI=true npm run build`
Expected: "Compiled successfully".

- [ ] **Step 4: Commit**

```bash
cd C:/Users/kylew/communityhunts-frontend
git add src/admin/adminApi.js src/admin/AdminBans.js
git commit -m "feat(bans): admin aliases field on ban form"
```

---

## Post-implementation (manual, after both deploys)

1. Deploy **backend** (Railway, push branch → merge to `main`) FIRST, then **frontend** (Vercel; test on the branch preview URL before merging `main`).
2. In the admin **Banned** tool, re-save Raph's ban (`693694981457838140`) — this triggers the Discord enrich — and/or add manual aliases `raph`, `rap`.
3. Verify: on a hunt you can edit, add a member named `rap` (no linked Discord) → the "matches a known scammer's alias — verify" warning should appear.

## Self-Review notes

- **Spec coverage:** directory table + primitives (T1) ✓; capture at login (T2) ✓; name matching + conditional shape (T3) ✓; manual aliases + Discord enrich + wiring (T4) ✓; frontend derive (T5) + hook (T6) + dual copy (T7) + admin field (T8) ✓. Guild-nick enrich from the spec is intentionally deferred as optional polish (platform bot may not be in the tenant guild); `username`+`global_name` cover the reliable case — noted here rather than silently dropped.
- **Type consistency:** `findAliasOwners` returns `Map<rawName, Set<userId>>` (T1) and is iterated as `[rawName, userIds]` (T3) ✓. `deriveBannedMembers(equity, idMap, nameMap, dismissed)` signature identical in T5/T6 ✓. Dismissal keys `id:`/`name:` identical in T5/T6 ✓. Response `{ids, names}` produced in T3, consumed in T6 ✓.
