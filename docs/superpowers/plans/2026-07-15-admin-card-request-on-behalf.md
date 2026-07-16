# Admin-filed Card Requests (On Behalf Of A User) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a platform owner file a custom-card commission request from the admin panel on behalf of someone who asked over Discord DM, instead of telling them to go fill in the Shop form.

**Architecture:** A new `POST /api/admin/card-requests` (platform-admin gated) creates the *same* record the public Shop form creates — status `new`, same Discord doorbell — plus a `createdBy` provenance field. The requester's Discord ID must be **proven to exist** before anything is written: a `known_users` hit is proof on its own, otherwise the Discord API decides, and a failure hard-fails with nothing written. The frontend adds a "+ New request" button on `/admin/shop-requests` opening a user-picker modal.

**Tech Stack:** Node 24 + Express (backend, `node:test`); React 18 CRA (frontend, no component tests).

## Global Constraints

- **Two repos, backend first.** `communityhunts-backend` merges and deploys to Railway *before* `communityhunts-frontend` — the frontend's create button 404s until the route is live.
- **Never gate on display name.** Discord IDs only. Platform owners: Cabbage `135203806676779008`, Goofer `168055630916091904`.
- **`userId` / `displayName` / `avatar` on a request always mean THE REQUESTER**, never the admin who filed it. This is what keeps the DM button, `exclusiveUserId`, and equip working unchanged.
- **No placeholder identities.** A request is never written with an unproven Discord ID.
- **Backend tests:** run captured to a **file, never a pipe** — route suites with `app.listen` hang on exit and piped exit codes mask failures.
- **Frontend:** `CI=true npm run build` must print "Compiled successfully" before any push (Vercel turns warnings into errors). No component tests (`@testing-library/react` is deliberately absent). Tokens via `useTheme()` only. New UI → new file.
- **Both repos:** work on a branch, never commit directly to `main` (shared + auto-deploys). No `Co-Authored-By` trailers.
- **Exact user-facing copy** (used verbatim in backend and asserted in tests):
  - `No Discord user with that ID — double-check the id`
  - `Couldn't verify the Discord ID right now — Discord may be down. Try again in a moment.`
  - `A valid Discord ID is required`

## File Structure

**Backend (`communityhunts-backend`)**

| File | Responsibility | Change |
| --- | --- | --- |
| `lib/cardRequests.js` | Record store + validation | Add `createdBy` to `createRequest`; add `validateAdminCreate` |
| `lib/cardRequests.test.js` | Unit tests for the above | Add tests |
| `lib/settings.js` | Owns `known_users` | Add + export `getKnownUser(userId)` |
| `routes/cardRequests.routes.js` | The HTTP surface | Extract `postDoorbell`; add `resolveRequester` + `POST /api/admin/card-requests`; add "Filed by" embed field |
| `routes/cardRequests.routes.test.js` | Route tests | Extend fetch stub + `appWith`; add tests |
| `server.js:456-461` | DI wiring | Inject `getKnownUser` + `recordKnownUser` |

**Frontend (`communityhunts-frontend`)**

| File | Responsibility | Change |
| --- | --- | --- |
| `src/admin/adminApi.js` | Admin API client | Add `createCardRequest(body)` |
| `src/admin/NewShopRequestModal.js` | **New** — the file-on-behalf form | Create |
| `src/admin/AdminShopRequests.js` | Board page | Add "+ New request" button + modal wiring |
| `src/admin/ShopRequestTile.js` | Board tile | Add "filed by" chip |
| `src/admin/ShopRequestModal.js` | Request editor | Add "filed by" line |

---

## Task 1: `createdBy` + `validateAdminCreate` in the record store

**Files:**
- Modify: `lib/cardRequests.js`
- Test: `lib/cardRequests.test.js`

**Interfaces:**
- Consumes: nothing (first task).
- Produces:
  - `validateAdminCreate(body) → string | null` — error message or null. Checks `body.userId` is a Discord snowflake (`/^\d{17,20}$/`), then delegates to the existing `validateInput(body)`.
  - `createRequest(body, user, opts?) → request` — `opts.createdBy` is `{ id, name }` or omitted. The returned record gains `createdBy: { id, name } | null`.

- [ ] **Step 1: Write the failing tests**

Append to `lib/cardRequests.test.js`:

```js
test('validateAdminCreate rejects a userId that is not a Discord snowflake', () => {
  assert.match(cardRequests.validateAdminCreate({ userId: 'abc', idea: 'x' }), /discord id/i);
  assert.match(cardRequests.validateAdminCreate({ userId: '123', idea: 'x' }), /discord id/i, 'too short');
  assert.match(cardRequests.validateAdminCreate({ userId: '1'.repeat(21), idea: 'x' }), /discord id/i, 'too long');
  assert.match(cardRequests.validateAdminCreate({ idea: 'x' }), /discord id/i, 'missing');
});

test('validateAdminCreate falls through to validateInput once the id is well-formed', () => {
  assert.strictEqual(cardRequests.validateAdminCreate({ userId: USER.id }), 'Tell us your card idea');
  assert.strictEqual(cardRequests.validateAdminCreate({ userId: USER.id, idea: 'A dog card' }), null);
});

test('createRequest records createdBy when filed on behalf, and null when self-submitted', () => {
  const admin = { id: '135203806676779008', name: 'Cabbage' };
  const onBehalf = cardRequests.createRequest({ idea: 'He DMed me this' }, USER, { createdBy: admin });
  assert.deepStrictEqual(onBehalf.createdBy, admin);
  // The requester is still the snapshot — createdBy must never displace who asked for the card.
  assert.strictEqual(onBehalf.userId, USER.id);
  assert.strictEqual(onBehalf.displayName, 'Goofer');
  assert.strictEqual(onBehalf.status, 'new', 'admin-filed requests still start at new');

  const selfServe = cardRequests.createRequest({ idea: 'from the shop' }, USER);
  assert.strictEqual(selfServe.createdBy, null);

  [onBehalf, selfServe].forEach(r => cardRequests.deleteRequest(r.id));
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd communityhunts-backend
node --test lib/cardRequests.test.js > /tmp/t.txt 2>&1; tail -30 /tmp/t.txt
```

Expected: FAIL — `cardRequests.validateAdminCreate is not a function`.

- [ ] **Step 3: Implement**

In `lib/cardRequests.js`, add next to the other constants (near `const STATUSES`):

```js
// Discord snowflake: 17–20 digits. Shape only — that the id EXISTS is proven at the route
// (known_users, else the Discord API), because a well-formed typo is still a typo.
const SNOWFLAKE = /^\d{17,20}$/;
```

Add after `validateInput`:

```js
// Validate an admin on-behalf create body: a requester Discord id, then the normal submit rules.
// Returns an error string or null.
function validateAdminCreate(body) {
  if (!body || typeof body !== 'object') return 'Invalid payload';
  if (typeof body.userId !== 'string' || !SNOWFLAKE.test(body.userId)) return 'A valid Discord ID is required';
  return validateInput(body);
}
```

In `createRequest`, change the signature and add one field:

```js
function createRequest(body, sessionUser, opts) {
```

and inside the record literal, directly after `avatar: sessionUser.avatar || null,`:

```js
    // Who FILED it: null when the user submitted from the Shop themselves, { id, name } when a
    // platform admin filed it on their behalf (a DM'd request). Never changes who the requester is
    // — userId/displayName/avatar above stay the requester, which is what the DM button and the
    // card's exclusiveUserId key off.
    createdBy: (opts && opts.createdBy) || null,
```

Add `validateAdminCreate` to `module.exports`.

- [ ] **Step 4: Run the tests to verify they pass**

```bash
node --test lib/cardRequests.test.js > /tmp/t.txt 2>&1; tail -30 /tmp/t.txt
```

Expected: PASS, all tests (the pre-existing `createRequest snapshots the session user and defaults` must still pass — `opts` is optional).

- [ ] **Step 5: Commit**

```bash
git add lib/cardRequests.js lib/cardRequests.test.js
git commit -m "feat(cardreq): createdBy provenance + validateAdminCreate

createRequest takes an optional { createdBy } so a platform admin can file
on behalf of a requester without displacing who the requester is.
validateAdminCreate checks the requester id is a snowflake -- shape only;
existence is proven at the route."
```

---

## Task 2: Extract the Discord doorbell to a shared helper

Pure refactor, no behavior change. Both the public submit and the new admin create post the same embed, so it gets extracted rather than copy-pasted. Locked down by a test of the *existing* public route, which has none today.

**Files:**
- Modify: `routes/cardRequests.routes.js:78-96`
- Test: `routes/cardRequests.routes.test.js`

**Interfaces:**
- Consumes: Task 1's `validateAdminCreate` (used by the test stub only).
- Produces: `postDoorbell(r) → Promise<'posted' | 'failed' | 'skipped'>` — defined inside the router factory (it closes over `getPlatformBotToken`, `channelId`, `cardRequests`). Posts `buildRequestEmbed(r)` to the shop-requests channel and calls `setDiscordMessage` on success. Never throws.

- [ ] **Step 1: Write the failing test**

In `routes/cardRequests.routes.test.js`, first **replace** `fakeCardRequests` with a version that also covers the submit path:

```js
// In-memory cardRequests stub. Validation delegates to the real (pure) lib functions — they are
// unit-tested in lib/cardRequests.test.js, and duplicating them here would let the two drift.
function fakeCardRequests(initial) {
  const list = initial.slice();
  const real = require('../lib/cardRequests');
  return {
    _list: list,
    listRequests: () => list,
    getRequest: (id) => list.find(x => x.id === id) || null,
    openCountFor: () => 0,
    validateInput: real.validateInput,
    validateAdminCreate: real.validateAdminCreate,
    createRequest: (body, user, opts) => {
      const r = {
        id: `cr_${list.length + 1}`, status: 'new',
        createdAt: '2026-07-15T00:00:00.000Z', updatedAt: '2026-07-15T00:00:00.000Z',
        userId: String(user.id), displayName: user.displayName, avatar: user.avatar || null,
        idea: body.idea, cardName: body.cardName || '', refLinks: body.refLinks || [],
        rainbetUsername: body.rainbetUsername || '', adminNotes: '', assignee: null,
        createdBy: (opts && opts.createdBy) || null,
      };
      list.unshift(r);
      return r;
    },
    setDiscordMessage: (id, { messageId, channelId }) => {
      const r = list.find(x => x.id === id);
      if (!r) return null;
      r.discordMessageId = messageId;
      r.discordChannelId = channelId;
      return r;
    },
    recordDm: (id, entry) => {
      const r = list.find(x => x.id === id);
      if (!r) return null;
      if (!Array.isArray(r.dmLog)) r.dmLog = [];
      r.dmLog.push({ at: 'stamped', ...entry });
      r.lastDmAt = 'stamped';
      return r;
    },
  };
}
```

Then add a generic POST helper next to `postDm`:

```js
async function postJson(app, path, body) {
  const server = await new Promise(resolve => { const s = app.listen(0, () => resolve(s)); });
  try {
    const r = await realFetch(`http://127.0.0.1:${server.address().port}${path}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    return { status: r.status, body: await r.json().catch(() => null) };
  } finally {
    server.close();
  }
}
```

And the test:

```js
test('a public submit posts the doorbell embed and stores the message ids', async () => {
  const app = appWith({ requests: [] });
  const r = await postJson(app, '/api/card-requests', { idea: 'A card with my dog on it', cardName: 'Doge' });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.discord, 'posted');
  const post = discordCalls.find(c => c.url.endsWith('/channels/999/messages'));
  assert.ok(post, 'posted to the shop-requests channel');
  assert.strictEqual(JSON.parse(post.opts.body).embeds[0].description, 'A card with my dog on it');
  // The ids are what lets a later status change PATCH this same message.
  const stored = app._cardRequests._list[0];
  assert.strictEqual(stored.discordMessageId, 'm-1');
  assert.strictEqual(stored.discordChannelId, '999');
});

test('a doorbell failure never fails the submit — the request is already saved', async () => {
  sendResponse = { ok: false, status: 500 };
  const app = appWith({ requests: [] });
  const r = await postJson(app, '/api/card-requests', { idea: 'Discord is down' });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.discord, 'failed');
  assert.strictEqual(app._cardRequests._list.length, 1, 'saved regardless');
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
node --test routes/cardRequests.routes.test.js > /tmp/t.txt 2>&1; tail -40 /tmp/t.txt
```

Expected: FAIL — the current `fakeCardRequests` lacks `createRequest`, so the submit route 500s (or the new tests error). This confirms the tests exercise the real path.

- [ ] **Step 3: Extract the helper**

In `routes/cardRequests.routes.js`, inside the router factory and **above** `router.post('/api/card-requests', ...)`, add:

```js
  // Post the request's embed to the shop-requests channel and store the message + channel ids, so a
  // later status change can PATCH that same message. Best-effort by contract: the request is already
  // saved, so a Discord failure is only logged. Shared by the public submit and the admin
  // on-behalf create — the embed is the queue's tracking artifact, so BOTH must post it.
  // Returns 'posted' | 'failed' | 'skipped'.
  async function postDoorbell(r) {
    const botToken = getPlatformBotToken();
    if (!botToken || !channelId) return 'skipped';
    try {
      const resp = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
        method: 'POST',
        headers: { Authorization: `Bot ${botToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ embeds: [buildRequestEmbed(r)] }),
      });
      if (!resp.ok) throw new Error(`Discord returned ${resp.status}`);
      const msg = await resp.json().catch(() => null);
      if (msg && msg.id) cardRequests.setDiscordMessage(r.id, { messageId: String(msg.id), channelId: String(channelId) });
      console.log(`[cardreq] request ${r.id} posted to Discord`);
      return 'posted';
    } catch (e) {
      console.error('[cardreq] Discord notify failed:', e.message);
      return 'failed';
    }
  }
```

Then in `POST /api/card-requests`, replace the whole inline block from `// Best-effort Discord doorbell` through the closing `}` of the `if (botToken && channelId) { … }` — i.e. the current lines building `botToken` / `let discord = 'skipped'` / the try-catch — with:

```js
    const discord = await postDoorbell(r);
    res.json({ ok: true, discord });
```

(Delete the now-duplicated `const botToken = getPlatformBotToken();` and `let discord = 'skipped';` lines and the old `res.json({ ok: true, discord });`.)

- [ ] **Step 4: Run to verify it passes**

```bash
node --test routes/cardRequests.routes.test.js > /tmp/t.txt 2>&1; tail -40 /tmp/t.txt
```

Expected: PASS — all tests including the pre-existing DM ones.

- [ ] **Step 5: Commit**

```bash
git add routes/cardRequests.routes.js routes/cardRequests.routes.test.js
git commit -m "refactor(cardreq): extract postDoorbell, cover the public submit

The doorbell embed is the queue's tracking artifact (its message id is what
later status changes PATCH), so the admin on-behalf create must post it too.
Extract rather than copy-paste, and pin the existing behavior with the public
submit's first route tests."
```

---

## Task 3: `getKnownUser` in the settings store

**Files:**
- Modify: `lib/settings.js`

**Interfaces:**
- Consumes: nothing.
- Produces: `getKnownUser(userId) → Promise<{ id, displayName, username, avatar } | null>` — one `known_users` row, or null when absent / no pgPool / on query error.

No test: this is a thin single-row query against Postgres with no branching logic worth pinning, matching the untested query already inline at `settings.routes.js:285`. It is covered indirectly by Task 4's route tests, which inject it.

- [ ] **Step 1: Implement**

In `lib/settings.js`, add after `recordKnownUser`:

```js
// Read one known_users row. The admin on-behalf card-request flow proves a Discord id with this
// BEFORE writing anything: a hit means the person signed in with that id, which is proof enough
// on its own and saves a Discord API round-trip. Returns null when absent — the caller decides
// what a miss means (it is not an error).
async function getKnownUser(userId) {
  if (!pgPool) return null;
  try {
    const r = await pgPool.query(
      'SELECT user_id, display_name, username, avatar FROM known_users WHERE user_id=$1',
      [String(userId)]
    );
    const row = r.rows[0];
    if (!row) return null;
    return { id: row.user_id, displayName: row.display_name, username: row.username, avatar: row.avatar };
  } catch (e) {
    console.error('[known_users] get failed:', e.message);
    return null;
  }
}
```

Add `getKnownUser,` to `module.exports` (after `recordKnownUser,`).

- [ ] **Step 2: Verify the module still loads**

```bash
node -e "const s=require('./lib/settings'); console.log(typeof s.getKnownUser)"
```

Expected: `function`

- [ ] **Step 3: Commit**

```bash
git add lib/settings.js
git commit -m "feat(settings): getKnownUser(userId) single-row read

Lets the card-request on-behalf flow prove a Discord id from the directory
before writing anything, without a Discord API call."
```

---

## Task 4: `POST /api/admin/card-requests` — verify, then create

The core of the feature. Identity is proven before anything is written; there is no placeholder path.

**Files:**
- Modify: `routes/cardRequests.routes.js`
- Modify: `server.js:456-461`
- Test: `routes/cardRequests.routes.test.js`

**Interfaces:**
- Consumes: `validateAdminCreate` + `createRequest(body, user, { createdBy })` (Task 1); `postDoorbell(r)` (Task 2); `getKnownUser(userId)` (Task 3).
- Produces: `POST /api/admin/card-requests` — body `{ userId, idea, cardName?, rainbetUsername?, refLinks? }`; `200` → the created request row; `400` → bad body or unknown Discord id; `403` → not a platform admin; `503` → Discord unverifiable. New router deps: `getKnownUser`, `recordKnownUser`.

- [ ] **Step 1: Write the failing tests**

In `routes/cardRequests.routes.test.js`, **replace** the `global.fetch` stub and `beforeEach` with a version that also serves the Discord user lookup:

```js
const realFetch = global.fetch;
let discordCalls = [];
let sendResponse = { ok: true, status: 200 };
// Discord GET /users/{id} — the id-existence probe. `throws` simulates an unreachable Discord.
let userLookup = { status: 200, body: { id: '168055630916091904', username: 'goofer', global_name: 'Goofer', avatar: 'abc' } };
global.fetch = async (url, opts) => {
  const u = String(url);
  discordCalls.push({ url: u, opts });
  if (u.endsWith('/users/@me/channels')) {
    return { ok: true, status: 200, json: async () => ({ id: 'dm-1' }), text: async () => '' };
  }
  if (/\/api\/v10\/users\/\d+$/.test(u)) {
    if (userLookup.throws) throw new Error('network down');
    return { ok: userLookup.status === 200, status: userLookup.status, json: async () => userLookup.body, text: async () => '' };
  }
  return { ok: sendResponse.ok, status: sendResponse.status, json: async () => ({ id: 'm-1' }), text: async () => '' };
};
after(() => { global.fetch = realFetch; });
beforeEach(() => {
  discordCalls = [];
  sendResponse = { ok: true, status: 200 };
  userLookup = { status: 200, body: { id: '168055630916091904', username: 'goofer', global_name: 'Goofer', avatar: 'abc' } };
});
```

**Replace** `appWith` to inject the two new deps:

```js
function appWith({ requests = [], admin = true, platformToken = 'ptok', getSettings, knownUser = null, onRecordKnownUser } = {}) {
  const app = express();
  app.use(express.json());
  const requireAuth = (req, res, next) => { req.user = { id: 'admin1', displayName: 'Cabbage' }; next(); };
  const requirePlatformAdmin = admin ? (req, res, next) => next() : (req, res, next) => res.status(403).json({ error: 'forbidden' });
  const cardRequests = fakeCardRequests(requests);
  const gs = getSettings || (async () => ({ rainbetName: '' }));
  app.use(cardRequestsRoutes({
    requireAuth, requirePlatformAdmin, cardRequests,
    getPlatformBotToken: () => platformToken, getSettings: gs, channelId: '999',
    getKnownUser: async () => knownUser,
    recordKnownUser: onRecordKnownUser || (() => {}),
  }));
  app._cardRequests = cardRequests;
  return app;
}
```

Add the tests:

```js
const ADMIN_BODY = { userId: '168055630916091904', idea: 'He DMed me a kangaroo card idea', cardName: 'Roo' };

test('admin create with a known_users hit files the request and makes NO Discord id lookup', async () => {
  const app = appWith({ knownUser: { id: '168055630916091904', displayName: 'Goofer', avatar: 'https://cdn/a.png' } });
  const r = await postJson(app, '/api/admin/card-requests', ADMIN_BODY);
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.userId, '168055630916091904', 'requester, not the admin');
  assert.strictEqual(r.body.displayName, 'Goofer');
  assert.strictEqual(r.body.status, 'new');
  assert.deepStrictEqual(r.body.createdBy, { id: 'admin1', name: 'Cabbage' });
  // A directory hit is proof on its own — they signed in with that id.
  assert.ok(!discordCalls.some(c => /\/users\/\d+$/.test(c.url)), 'no id lookup');
  assert.ok(discordCalls.some(c => c.url.endsWith('/channels/999/messages')), 'doorbell still posted');
});

test('admin create with a known_users miss resolves from Discord and backfills the directory', async () => {
  const recorded = [];
  const app = appWith({ knownUser: null, onRecordKnownUser: u => recorded.push(u) });
  const r = await postJson(app, '/api/admin/card-requests', ADMIN_BODY);
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.displayName, 'Goofer', 'global_name wins over username');
  assert.ok(discordCalls.some(c => /\/users\/168055630916091904$/.test(c.url)), 'probed the id');
  assert.strictEqual(recorded.length, 1, 'written to the directory for next time');
  assert.strictEqual(recorded[0].id, '168055630916091904');
});

test('a Discord 404 on the id → 400 and NOTHING is written', async () => {
  userLookup = { status: 404, body: {} };
  const app = appWith({ knownUser: null });
  const r = await postJson(app, '/api/admin/card-requests', ADMIN_BODY);
  assert.strictEqual(r.status, 400);
  assert.match(r.body.error, /no discord user with that id/i);
  // The regression that matters: a ghost row surviving a rejected create.
  assert.strictEqual(app._cardRequests._list.length, 0, 'no ghost row');
  assert.ok(!discordCalls.some(c => c.url.endsWith('/channels/999/messages')), 'no doorbell');
});

test('Discord unreachable → 503, nothing written, message distinct from the 404 case', async () => {
  userLookup = { throws: true };
  const app = appWith({ knownUser: null });
  const r = await postJson(app, '/api/admin/card-requests', ADMIN_BODY);
  assert.strictEqual(r.status, 503);
  assert.match(r.body.error, /try again in a moment/i);
  assert.doesNotMatch(r.body.error, /double-check/i, 'must not read as a typo — we do not know that');
  assert.strictEqual(app._cardRequests._list.length, 0);
});

test('no bot token and a directory miss → 503, nothing written', async () => {
  const app = appWith({ knownUser: null, platformToken: '' });
  const r = await postJson(app, '/api/admin/card-requests', ADMIN_BODY);
  assert.strictEqual(r.status, 503);
  assert.strictEqual(app._cardRequests._list.length, 0);
});

test('a non-snowflake userId → 400 before any Discord call', async () => {
  const app = appWith({});
  const r = await postJson(app, '/api/admin/card-requests', { userId: 'nope', idea: 'x' });
  assert.strictEqual(r.status, 400);
  assert.match(r.body.error, /valid discord id/i);
  assert.strictEqual(discordCalls.length, 0);
});

test('an empty idea → 400 even with a good id', async () => {
  const app = appWith({ knownUser: { id: '168055630916091904', displayName: 'Goofer' } });
  const r = await postJson(app, '/api/admin/card-requests', { userId: '168055630916091904', idea: '  ' });
  assert.strictEqual(r.status, 400);
  assert.match(r.body.error, /card idea/i);
});

test('a non-platform-admin cannot file on behalf (403)', async () => {
  const app = appWith({ admin: false });
  const r = await postJson(app, '/api/admin/card-requests', ADMIN_BODY);
  assert.strictEqual(r.status, 403);
});

test('the doorbell embed names who filed it', async () => {
  const app = appWith({ knownUser: { id: '168055630916091904', displayName: 'Goofer' } });
  await postJson(app, '/api/admin/card-requests', ADMIN_BODY);
  const post = discordCalls.find(c => c.url.endsWith('/channels/999/messages'));
  const fields = JSON.parse(post.opts.body).embeds[0].fields;
  const filedBy = fields.find(f => f.name === 'Filed by');
  assert.ok(filedBy, 'Filed by field present');
  assert.match(filedBy.value, /Cabbage/);
});
```

- [ ] **Step 2: Run to verify they fail**

```bash
node --test routes/cardRequests.routes.test.js > /tmp/t.txt 2>&1; tail -40 /tmp/t.txt
```

Expected: FAIL — `POST /api/admin/card-requests` 404s (no such route).

- [ ] **Step 3: Implement the route**

In `routes/cardRequests.routes.js`:

**(a)** Add the copy constants near `MAX_DM` at the top of the file:

```js
// The two id-verification failures are deliberately worded apart: a 404 means the id is WRONG, a
// transport failure means we DON'T KNOW. Same outcome (blocked, nothing written), but conflating
// them in the copy sends the admin hunting a typo in a good id while Discord is simply down.
const NO_SUCH_USER = 'No Discord user with that ID — double-check the id';
const CANT_VERIFY = "Couldn't verify the Discord ID right now — Discord may be down. Try again in a moment.";
```

**(b)** Add the "Filed by" field in `buildRequestEmbed`, directly after the `From` field in the `fields` array:

```js
  if (r.createdBy) fields.push({ name: 'Filed by', value: `${r.createdBy.name} (on their behalf)`.slice(0, 1024), inline: true });
```

**(c)** Destructure the new deps — change the first line of the exported factory to:

```js
  const { requireAuth, requirePlatformAdmin, cardRequests, getPlatformBotToken, getSettings, channelId, getKnownUser, recordKnownUser } = deps;
```

**(d)** Add `resolveRequester` next to `postDoorbell`:

```js
  // Resolve the requester behind an admin on-behalf create. The id must be PROVEN to exist before
  // anything is written: validateAdminCreate checks shape, not existence, so a typo'd snowflake
  // would otherwise file silently against a real-looking record and surface only when the DM
  // bounced or the card wouldn't equip — long after the context is gone. There is deliberately no
  // placeholder path. Throws { code, message } for the route to turn into a status.
  async function resolveRequester(userId) {
    // A directory hit is proof on its own (they signed in with that id) — skip the Discord call.
    try {
      const known = getKnownUser ? await getKnownUser(userId) : null;
      if (known && known.id) return known;
    } catch (e) {
      console.error('[cardreq] known_users lookup failed:', e.message);
      // Fall through to Discord — a directory outage is not evidence the id is bad.
    }

    const botToken = getPlatformBotToken();
    if (!botToken) throw { code: 503, message: CANT_VERIFY };

    let resp;
    try {
      resp = await fetch(`https://discord.com/api/v10/users/${userId}`, { headers: { Authorization: `Bot ${botToken}` } });
    } catch (e) {
      console.error('[cardreq] Discord id lookup failed:', e.message);
      throw { code: 503, message: CANT_VERIFY };
    }
    if (resp.status === 404) throw { code: 400, message: NO_SUCH_USER };
    if (!resp.ok) {
      console.error(`[cardreq] Discord id lookup → ${resp.status}`);
      throw { code: 503, message: CANT_VERIFY };
    }
    const u = await resp.json().catch(() => null);
    if (!u || !u.id) throw { code: 503, message: CANT_VERIFY };

    const resolved = {
      id: String(u.id),
      displayName: u.global_name || u.username || `User ${userId}`,
      username: u.username || null,
      avatar: u.avatar ? `https://cdn.discordapp.com/avatars/${u.id}/${u.avatar}.png` : null,
    };
    // Backfill the directory so the admin picker finds them next time (best-effort).
    if (recordKnownUser) {
      try { recordKnownUser(resolved); } catch (e) { console.error('[cardreq] recordKnownUser failed:', e.message); }
    }
    return resolved;
  }
```

**(e)** Add the route, directly after `POST /api/card-requests`:

```js
  // Admin files a request on behalf of someone who asked over DM/Discord, so they never have to be
  // told "go to the site". Produces the SAME record a public submit does — status 'new', same
  // doorbell — plus createdBy provenance. No IP throttle and no open-request cap: both exist to stop
  // strangers spamming the public form, and requirePlatformAdmin is the gate here.
  router.post('/api/admin/card-requests', requireAuth, requirePlatformAdmin, async (req, res) => {
    const err = cardRequests.validateAdminCreate(req.body);
    if (err) return res.status(400).json({ error: err });

    let requester;
    try {
      requester = await resolveRequester(String(req.body.userId));
    } catch (e) {
      if (e && e.code) return res.status(e.code).json({ error: e.message });
      console.error('[cardreq] resolve error:', e && e.message);
      return res.status(503).json({ error: CANT_VERIFY });
    }

    const createdBy = { id: String(req.user.id), name: req.user.displayName || req.user.username || 'admin' };
    const r = cardRequests.createRequest(req.body, requester, { createdBy });
    // Awaited (unlike the PUT's fire-after-respond) so the returned row carries the Discord message
    // ids — setDiscordMessage mutates this same object — and the board's new tile is complete.
    await postDoorbell(r);
    console.log(`[cardreq] ${createdBy.name} filed ${r.id} on behalf of ${requester.id}`);
    res.json(r);
  });
```

- [ ] **Step 4: Run to verify they pass**

```bash
node --test routes/cardRequests.routes.test.js > /tmp/t.txt 2>&1; tail -40 /tmp/t.txt
```

Expected: PASS, all tests.

- [ ] **Step 5: Wire the deps in `server.js`**

Replace the mount block at `server.js:456-461` with:

```js
app.use(require('./routes/cardRequests.routes')({
  requireAuth, requirePlatformAdmin, cardRequests,
  getPlatformBotToken: tenants.getPlatformBotToken,
  getSettings: settings.getSettings,
  // Prove a requester's Discord id before an admin on-behalf create writes anything; backfill the
  // directory when the id was only known to Discord.
  getKnownUser: settings.getKnownUser,
  recordKnownUser,
  channelId: (process.env.DISCORD_SHOP_REQUESTS_CHANNEL_ID || '').trim(),
}));
```

(`recordKnownUser` is already destructured from `settings` at `server.js:251`.)

- [ ] **Step 6: Verify the server boots**

```bash
node --test lib/*.test.js routes/*.test.js > /tmp/all.txt 2>&1; tail -15 /tmp/all.txt
```

Expected: the whole backend suite passes.

Then boot for real (dummy Discord creds; `npm start` ignores `.env`, and port 3101 avoids a stale 3001 listener):

```bash
PORT=3101 DISCORD_CLIENT_ID=x DISCORD_CLIENT_SECRET=x DISCORD_CALLBACK_URL=http://localhost:3101/cb SESSION_SECRET=x node server.js
```

Expected: `Server running on port 3101` with no crash on the new mount. Ctrl-C.

- [ ] **Step 7: Commit**

```bash
git add routes/cardRequests.routes.js routes/cardRequests.routes.test.js server.js
git commit -m "feat(cardreq): POST /api/admin/card-requests — file on behalf of a user

Lets an owner file a commission for someone who asked over DM instead of
sending them to the Shop form. Same record as a public submit (status 'new',
same doorbell) plus createdBy provenance, and the embed names who filed it.

The requester id is PROVEN before anything is written: a known_users hit is
proof on its own (no Discord call), a miss goes to GET /users/{id}, and 404 ->
400 while unreachable -> 503, both writing nothing. No placeholder path -- a
well-formed typo would otherwise file a ghost that only surfaced when the DM
bounced. Cap and throttle are skipped: requirePlatformAdmin is the gate."
```

---

## Task 5: Frontend — the API call + the create modal

**Files:**
- Modify: `communityhunts-frontend/src/admin/adminApi.js:83-87`
- Create: `communityhunts-frontend/src/admin/NewShopRequestModal.js`

**Interfaces:**
- Consumes: `POST /api/admin/card-requests` (Task 4); existing `fetchUsers({ q })` from `adminApi.js:5`.
- Produces:
  - `createCardRequest(body) → Promise<request>` in `adminApi.js`.
  - `<NewShopRequestModal C={theme} onClose={fn} onCreated={(request) => void} />` — default export.

- [ ] **Step 1: Add the API call**

In `src/admin/adminApi.js`, after `deleteCardRequest` (line 87):

```js
// Admin files a request on behalf of a user who asked over DM. Body: { userId, idea, cardName?,
// rainbetUsername?, refLinks? }. Returns the created row. Rejects with the backend's message when
// the Discord id can't be proven (400 unknown id / 503 Discord unreachable) — show it verbatim:
// the two read differently on purpose ("wrong id" vs "we couldn't check").
export const createCardRequest = (body) =>
  apiFetch('/api/admin/card-requests', { method: 'POST', body: JSON.stringify(body) });
```

- [ ] **Step 2: Create the modal**

Create `src/admin/NewShopRequestModal.js`:

```js
import { useState, useEffect } from 'react';
import { makeModalStyles } from '../hunt/modals/modalStyles';
import { fetchUsers, createCardRequest } from './adminApi';

// File a card commission on behalf of someone who asked over DM/Discord, so they never have to be
// told "go to the site and fill in the form". Mirrors the public Shop form's fields; the requester
// is chosen here instead of being the session user.
//
// The picker searches known_users (people who have signed in). Someone who only ever DMed won't be
// there — hence the raw Discord ID fallback, which is the whole point of this feature. The backend
// proves the id either way and hard-fails if it can't, so a typo is caught here, not months later
// when the DM bounces.
const SNOWFLAKE = /^\d{17,20}$/;

export default function NewShopRequestModal({ C, onClose, onCreated }) {
  const { modalBg } = makeModalStyles(C);
  const [q, setQ] = useState('');
  const [results, setResults] = useState([]);
  const [picked, setPicked] = useState(null);   // { id, displayName, avatar } from the directory
  const [rawId, setRawId] = useState('');       // fallback for someone who never signed in
  const [idea, setIdea] = useState('');
  const [cardName, setCardName] = useState('');
  const [rainbet, setRainbet] = useState('');
  const [links, setLinks] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  // Debounced directory search. Skipped once someone is picked — the list would just be noise.
  useEffect(() => {
    if (picked || !q.trim()) { setResults([]); return; }
    const t = setTimeout(() => {
      fetchUsers({ q: q.trim(), limit: 8 })
        .then(r => setResults((r && r.users) || []))
        .catch(() => setResults([]));
    }, 250);
    return () => clearTimeout(t);
  }, [q, picked]);

  const userId = picked ? picked.id : rawId.trim();
  const canSubmit = !busy && idea.trim() && SNOWFLAKE.test(userId);

  const submit = () => {
    setBusy(true);
    setError('');
    createCardRequest({
      userId,
      idea: idea.trim(),
      cardName: cardName.trim(),
      rainbetUsername: rainbet.trim(),
      refLinks: links.split('\n').map(s => s.trim()).filter(Boolean),
    })
      .then(created => { onCreated(created); onClose(); })
      // Stay open with every field intact: a failed create must never cost the admin the idea text
      // they just transcribed out of a DM. The backend's message is shown as-is.
      .catch(e => setError(e.message || 'Failed to create the request'))
      .finally(() => setBusy(false));
  };

  const inputStyle = {
    width: '100%', background: C.sur, color: C.t1, border: `1px solid ${C.bdr}`,
    borderRadius: C.rCtl, fontFamily: C.body, fontSize: 13, padding: '8px 10px', boxSizing: 'border-box',
  };
  const labelStyle = { display: 'block', color: C.t3, fontSize: 11, fontWeight: 700, letterSpacing: '.04em', marginBottom: 4, marginTop: 12 };

  return (
    <div style={modalBg} onClick={onClose}>
      <div onClick={e => e.stopPropagation()} style={{
        background: C.card, border: `1px solid ${C.bb}`, borderRadius: C.rCard, padding: '1.5rem',
        width: 520, maxWidth: '92vw', maxHeight: '88vh', overflowY: 'auto', animation: 'popIn .15s ease',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', marginBottom: 4 }}>
          <span style={{ fontFamily: C.display, fontWeight: 800, fontSize: 17, color: C.t1 }}>New request</span>
          <div style={{ flex: 1 }} />
          <button onClick={onClose} aria-label="Close" style={{ height: 28, width: 28, background: 'transparent', border: `1px solid ${C.bdr}`, borderRadius: C.rCtl, color: C.t3, fontSize: 14, cursor: 'pointer', lineHeight: 1 }}>×</button>
        </div>
        <div style={{ color: C.t4, fontSize: 12, marginBottom: 8 }}>
          File a commission for someone who asked over DM. It lands in New, exactly like a Shop submission.
        </div>

        {/* Requester */}
        <label style={labelStyle}>REQUESTER</label>
        {picked ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, background: C.sur, border: `1px solid ${C.bdr}`, borderRadius: C.rCtl, padding: '6px 8px' }}>
            {picked.avatar ? <img src={picked.avatar} alt="" style={{ width: 24, height: 24, borderRadius: '50%' }} />
                           : <span style={{ width: 24, height: 24, borderRadius: '50%', background: C.bdr, display: 'inline-block' }} />}
            <span style={{ color: C.t1, fontSize: 13, fontWeight: 700 }}>{picked.displayName}</span>
            <span style={{ color: C.t4, fontFamily: C.mono || C.body, fontSize: 11 }}>{picked.id}</span>
            <div style={{ flex: 1 }} />
            <button onClick={() => { setPicked(null); setQ(''); }} style={{ background: 'transparent', border: 'none', color: C.t3, fontSize: 12, cursor: 'pointer' }}>change</button>
          </div>
        ) : (
          <>
            <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search by name…" style={inputStyle} />
            {results.length > 0 && (
              <div style={{ border: `1px solid ${C.bdr}`, borderRadius: C.rCtl, marginTop: 4, maxHeight: 160, overflowY: 'auto' }}>
                {results.map(u => (
                  <div key={u.id} onClick={() => { setPicked(u); setRawId(''); }}
                    style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 8px', cursor: 'pointer' }}>
                    {u.avatar ? <img src={u.avatar} alt="" style={{ width: 22, height: 22, borderRadius: '50%' }} />
                              : <span style={{ width: 22, height: 22, borderRadius: '50%', background: C.bdr, display: 'inline-block' }} />}
                    <span style={{ color: C.t1, fontSize: 12, fontWeight: 600 }}>{u.displayName || u.username}</span>
                    <div style={{ flex: 1 }} />
                    <span style={{ color: C.t4, fontFamily: C.mono || C.body, fontSize: 10 }}>{u.id}</span>
                  </div>
                ))}
              </div>
            )}
            {/* The fallback that makes this feature work for people who never signed in. */}
            <div style={{ color: C.t4, fontSize: 11, marginTop: 8, marginBottom: 4 }}>
              Not in the list? They've never signed in — paste their Discord ID:
            </div>
            <input value={rawId} onChange={e => setRawId(e.target.value)} placeholder="e.g. 168055630916091904"
              style={{ ...inputStyle, fontFamily: C.mono || C.body }} />
          </>
        )}

        <label style={labelStyle}>THEIR IDEA *</label>
        <textarea value={idea} onChange={e => setIdea(e.target.value)} rows={4} maxLength={2000}
          placeholder="What they asked for, in their words where you can."
          style={{ ...inputStyle, resize: 'vertical' }} />

        <label style={labelStyle}>CARD NAME</label>
        <input value={cardName} onChange={e => setCardName(e.target.value)} maxLength={80} style={inputStyle} />

        <label style={labelStyle}>RAINBET USERNAME</label>
        <input value={rainbet} onChange={e => setRainbet(e.target.value)} maxLength={80} style={inputStyle} />

        <label style={labelStyle}>REFERENCE LINKS (one per line)</label>
        <textarea value={links} onChange={e => setLinks(e.target.value)} rows={2}
          placeholder="https://…" style={{ ...inputStyle, resize: 'vertical' }} />

        {error && <div style={{ color: C.red, fontSize: 12, fontWeight: 600, marginTop: 12 }}>{error}</div>}

        <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
          <div style={{ flex: 1 }} />
          <button onClick={onClose} style={{ height: 32, padding: '0 14px', background: 'transparent', border: `1px solid ${C.bdr}`, borderRadius: C.rCtl, color: C.t2, fontFamily: C.body, fontSize: 12, fontWeight: 700, cursor: 'pointer' }}>Cancel</button>
          <button onClick={submit} disabled={!canSubmit}
            style={{ height: 32, padding: '0 14px', background: canSubmit ? (C.accent || C.gold) : C.bdr, border: 'none', borderRadius: C.rCtl, color: canSubmit ? '#0a0710' : C.t4, fontFamily: C.body, fontSize: 12, fontWeight: 800, cursor: canSubmit ? 'pointer' : 'default' }}>
            {busy ? 'Filing…' : 'File request'}
          </button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Verify the build**

```bash
cd communityhunts-frontend
CI=true npm run build
```

Expected: `Compiled successfully.` (The modal is unreferenced at this point — that's fine; CRA doesn't warn on an unused module.)

- [ ] **Step 4: Commit**

```bash
git add src/admin/adminApi.js src/admin/NewShopRequestModal.js
git commit -m "feat(admin): NewShopRequestModal — file a card request on behalf

Picker over known_users, plus a raw Discord ID fallback for the people this
feature exists for: the ones who DMed and never signed in. Errors render
inline and the modal keeps its fields, so a rejected id never costs the idea
text transcribed out of the DM."
```

---

## Task 6: Frontend — wire the button into the board

**Files:**
- Modify: `communityhunts-frontend/src/admin/AdminShopRequests.js:1-8` (imports), `:19-28` (state), `:104-119` (header + render)

**Interfaces:**
- Consumes: `NewShopRequestModal` (Task 5).
- Produces: nothing downstream.

- [ ] **Step 1: Add the import**

In `src/admin/AdminShopRequests.js`, after the `ShopRequestModal` import (line 7):

```js
import NewShopRequestModal from './NewShopRequestModal';
```

- [ ] **Step 2: Add the state**

After the `openId` state declaration (line 27):

```js
  const [creating, setCreating] = useState(false); // "+ New request" modal open
```

- [ ] **Step 3: Add the button to the header**

Replace the header block (lines 106-110) with:

```js
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, marginBottom: 20 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontFamily: C.display, fontWeight: 800, fontSize: 20, color: C.t1, marginBottom: 4 }}>Shop Requests</div>
          <div style={{ color: C.t3, fontSize: 13 }}>
            Custom card commissions from the Shop. Flow: approve the idea → DM them for the $25 RB tip
            (Awaiting tip) → tip lands (In progress) → card ships (Done).
          </div>
        </div>
        <button onClick={() => setCreating(true)}
          style={{ height: 32, padding: '0 14px', background: C.accent || C.gold, border: 'none', borderRadius: C.rCtl, color: '#0a0710', fontFamily: C.body, fontSize: 12, fontWeight: 800, cursor: 'pointer', whiteSpace: 'nowrap', flexShrink: 0 }}>
          + New request
        </button>
      </div>
```

- [ ] **Step 4: Render the modal**

After the closing `)}` of the `{openId && …}` block (line 135), before the final `</div>`:

```js
      {creating && (
        <NewShopRequestModal
          C={C}
          onClose={() => setCreating(false)}
          onCreated={r => setRows(rs => [r, ...rs])}
        />
      )}
```

- [ ] **Step 5: Verify the build**

```bash
CI=true npm run build
```

Expected: `Compiled successfully.`

- [ ] **Step 6: Commit and push for a preview**

```bash
git add src/admin/AdminShopRequests.js
git commit -m "feat(admin): + New request button on the Shop Requests board"
git push -u origin feat/admin-card-request-on-behalf
```

- [ ] **Step 7: Drive it on the Vercel preview URL**

Backend must already be merged + deployed (Global Constraints). On the branch's preview URL, signed in as a platform owner, at `/admin/shop-requests`:

1. **+ New request** → pick a user from the search → fill the idea → **File request**. Expect a new tile at the top of the **New** column, and the embed in the shop-requests Discord channel with a **Filed by** field.
2. Reopen → paste a raw Discord ID of someone who has never signed in → file. Expect their real Discord name to resolve on the tile.
3. Reopen → paste `999999999999999999` (well-formed, nonexistent) → file. Expect `No Discord user with that ID — double-check the id` inline, **the modal still open with the idea text intact**, and **no new tile**.
4. Open the created request's modal → **DM** → confirm it DMs the requester, not you.

---

## Task 7: Show provenance on the board

Without this, an admin-filed request is indistinguishable from a self-submitted one, and "why is there no Shop submission for this?" becomes unanswerable six months out.

**Files:**
- Modify: `communityhunts-frontend/src/admin/ShopRequestTile.js:18` + `:46-62`
- Modify: `communityhunts-frontend/src/admin/ShopRequestModal.js:44-47`

**Interfaces:**
- Consumes: `r.createdBy` (`{ id, name } | null`) from Task 1.
- Produces: nothing downstream.

- [ ] **Step 1: Add the chip to the tile**

In `src/admin/ShopRequestTile.js`, after the `assigneeLabel` line (18):

```js
  // Filed by an owner on the requester's behalf (a DM'd ask) rather than submitted from the Shop.
  const filedBy = r.createdBy && r.createdBy.name;
```

Change the chip-row condition (line 46) from `{(assigneeLabel || linked) && (` to:

```js
      {(assigneeLabel || linked || filedBy) && (
```

and add inside that row, after the `{linked && (…)}` block:

```js
          {filedBy && (
            <span style={{ fontSize: 9, fontWeight: 800, letterSpacing: '.04em', padding: '2px 6px', borderRadius: 999, background: C.bg, border: `1px solid ${C.bdr}`, color: C.t3, whiteSpace: 'nowrap' }}>
              ✍ FILED BY {filedBy.toUpperCase()}
            </span>
          )}
```

- [ ] **Step 2: Add the line to the modal header**

In `src/admin/ShopRequestModal.js`, inside the header identity block, after the `{r.userId}` span (line 46):

```js
            {r.createdBy && (
              <span style={{ display: 'block', color: C.t4, fontSize: 11 }}>
                filed by {r.createdBy.name} on their behalf
              </span>
            )}
```

- [ ] **Step 3: Verify the build**

```bash
CI=true npm run build
```

Expected: `Compiled successfully.`

- [ ] **Step 4: Commit**

```bash
git add src/admin/ShopRequestTile.js src/admin/ShopRequestModal.js
git commit -m "feat(admin): mark admin-filed requests on the tile and in the modal

Without it an on-behalf request is indistinguishable from a Shop submission,
and 'why is there no submission for this?' has no answer later."
```

- [ ] **Step 5: Verify on the preview**

Reload `/admin/shop-requests` on the preview URL. The request filed in Task 6 shows a **✍ FILED BY …** chip; a self-submitted request shows none. Open it: the header reads *filed by … on their behalf*.

---

## Done

Backend PR merges first (Railway auto-deploys, ~1-3 min, everyone gets logged out — expected). Frontend PR merges after the backend is live.
