# Shop Request DM Replies Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let admins read what requesters send back when the bot DMs them about a custom-card commission, and get pinged in Discord when a reply lands.

**Architecture:** The backend has no Discord gateway connection — DMs go out over plain REST. So replies come back the same way: a background timer polls each open request's DM channel, filters to the requester's own messages, and appends them to the same `dmLog` the outbound sends already use. A ping goes to the existing shop-requests channel; the admin panel renders the log as one interleaved thread.

**Tech Stack:** Node.js + Express (backend, no build step, `node:test`), React CRA (frontend), Discord REST API v10, Postgres-backed `hunts_kv` store with a JSON file fallback.

**Spec:** [`docs/superpowers/specs/2026-07-25-shop-request-dm-replies-design.md`](../specs/2026-07-25-shop-request-dm-replies-design.md)

## Global Constraints

- **Never commit to `main` in either repo.** Branch + PR, even for one line. `git fetch origin && git pull --ff-only` before branching — two people push to both remotes in tandem.
- **No `Co-Authored-By` or any Claude authorship trailer** in commit messages or PR bodies.
- **Never `git add -A`** — explicit paths only. Parallel sessions share this worktree and foreign commits can land on your branch.
- Backend test command is `node --test lib/*.test.js`. **`node --test lib/` is broken on Node 24** (bogus `test at lib:1:1` failure). Route suites run separately: `node --test routes/cardRequests.routes.test.js`.
- Frontend has no `test` script and `@testing-library/react` is not installed — **no component tests**. Verification is `CI=true npm run build` printing "Compiled successfully" (Vercel turns warnings into errors).
- **Backend ships and is verified live on Railway before the frontend merges.** The frontend reads `dir` and `lastReplyAt`, which do not exist until the backend is deployed.
- **No new env var, no new bot.** Reuse `getPlatformBotToken()` and `DISCORD_SHOP_REQUESTS_CHANNEL_ID`.
- Bookkeeping helpers (`setDmChannel`, `recordReply`, `recordDm`) **never touch** `status` / `adminNotes` / `updatedAt` — this mirrors the existing `setDiscordMessage` contract.
- Frontend theme tokens are `C.gold`, `C.sur`, `C.bdr`, `C.green`, `C.red`, `C.t1`–`C.t5`, `C.rCtl`. There is no `C.surface` or `C.border`. `ShopRequestDm.js` already uses a `C.accent || C.gold` fallback — keep that pattern.
- Backend repo is **public**. Do not add secrets or internal security notes to it.
- Time the backend deploy **outside a live hunt** — a Railway restart clears OverDrop state.

---

## File Structure

| File | Repo | Responsibility |
| --- | --- | --- |
| `lib/cardRequests.js` | backend | **Modify.** Add `setDmChannel` + `recordReply`, direction-tag `dmLog` entries, raise the cap to 40, export `OPEN_STATUSES`. |
| `lib/cardRequests.test.js` | backend | **Modify.** Cover the new helpers; fix the existing cap-10 assertion. |
| `lib/dmPoller.js` | backend | **Create.** The polling loop, reply filtering, watermark advance, and the channel ping. One responsibility: turning Discord DM history into `recordReply` calls. |
| `lib/dmPoller.test.js` | backend | **Create.** Stubbed-`fetch` unit tests for the poller. |
| `routes/cardRequests.routes.js` | backend | **Modify.** Persist the DM channel id + seed the watermark on send. |
| `routes/cardRequests.routes.test.js` | backend | **Modify.** Add `setDmChannel` to the fake store; assert the send path persists the channel. |
| `server.js` | backend | **Modify.** One call to start the poller. |
| `src/admin/ShopRequestDm.js` | frontend | **Modify.** Render the log as a two-direction thread + an "awaiting your reply" badge. |

---

### Task 1: Data model — `dmLog` becomes a two-direction thread

**Files:**
- Modify: `communityhunts-backend/lib/cardRequests.js:19` (`MAX_DM_LOG`), `:191-205` (`recordDm`), `:215-230` (exports)
- Test: `communityhunts-backend/lib/cardRequests.test.js`

**Interfaces:**
- Consumes: nothing (first task).
- Produces:
  - `setDmChannel(id, { channelId, watermark }) → request | null` — both fields optional; a falsy value leaves that field untouched.
  - `recordReply(id, { messageId, content, at }) → request | null` — appends `{ at, dir:'in', message, messageId }`, stamps `lastReplyAt`, deduped on `messageId`.
  - `recordDm(id, { template, ok, error, message, by, messageId })` — now also writes `dir:'out'` and `messageId`.
  - `OPEN_STATUSES` — the exported `Set(['new','awaiting_tip','in_progress'])`.
  - `MAX_DM_LOG` is 40.

- [ ] **Step 1: Fix the existing cap assertion, which currently hard-codes 10**

In `lib/cardRequests.test.js`, inside `test('recordDm appends a capped log entry and stamps lastDmAt without touching status/notes', ...)`, replace this block (currently at lines 144-147):

```js
  for (let i = 0; i < 12; i++) cardRequests.recordDm(r.id, { template: `t${i}`, ok: true });
  const capped = cardRequests.getRequest(r.id);
  assert.strictEqual(capped.dmLog.length, 10, 'capped at 10');
  assert.strictEqual(capped.dmLog[9].template, 't11', 'newest entry kept');
```

with:

```js
  for (let i = 0; i < 45; i++) cardRequests.recordDm(r.id, { template: `t${i}`, ok: true });
  const capped = cardRequests.getRequest(r.id);
  assert.strictEqual(capped.dmLog.length, 40, 'capped at 40 — the log now carries both directions');
  assert.strictEqual(capped.dmLog[39].template, 't44', 'newest entry kept');
```

- [ ] **Step 2: Write the failing tests for the new helpers**

Append to `lib/cardRequests.test.js`:

```js
test('recordDm marks entries outbound and stores the sent messageId', () => {
  const r = cardRequests.createRequest({ idea: 'dir test' }, USER);
  const after = cardRequests.recordDm(r.id, { template: 'need_info', ok: true, messageId: '900' });
  assert.strictEqual(after.dmLog[0].dir, 'out');
  assert.strictEqual(after.dmLog[0].messageId, '900');
  cardRequests.deleteRequest(r.id);
});

test('setDmChannel stores the channel + watermark and survives a status edit', () => {
  const r = cardRequests.createRequest({ idea: 'chan test' }, USER);
  const set = cardRequests.setDmChannel(r.id, { channelId: 'dm1', watermark: '900' });
  assert.strictEqual(set.dmChannelId, 'dm1');
  assert.strictEqual(set.dmWatermark, '900');

  const afterStatus = cardRequests.updateRequest(r.id, { status: 'in_progress' });
  assert.strictEqual(afterStatus.dmChannelId, 'dm1', 'channel survives a status edit');
  assert.strictEqual(afterStatus.dmWatermark, '900', 'watermark survives a status edit');

  // The poller advances the watermark alone — omitting channelId must not clear it.
  cardRequests.setDmChannel(r.id, { watermark: '950' });
  assert.strictEqual(cardRequests.getRequest(r.id).dmWatermark, '950');
  assert.strictEqual(cardRequests.getRequest(r.id).dmChannelId, 'dm1');

  assert.strictEqual(cardRequests.setDmChannel('cr_nope', { channelId: 'x' }), null, 'unknown id → null');
  cardRequests.deleteRequest(r.id);
});

test('recordReply appends an inbound entry and stamps lastReplyAt without touching status/notes', () => {
  const r = cardRequests.createRequest({ idea: 'reply test' }, USER);
  cardRequests.updateRequest(r.id, { status: 'awaiting_tip', adminNotes: 'keep me' });

  const after = cardRequests.recordReply(r.id, {
    messageId: '1001', content: 'here is my ref image', at: '2026-07-25T10:00:00.000Z',
  });
  assert.strictEqual(after.dmLog[0].dir, 'in');
  assert.strictEqual(after.dmLog[0].message, 'here is my ref image');
  assert.strictEqual(after.dmLog[0].messageId, '1001');
  assert.strictEqual(after.dmLog[0].at, '2026-07-25T10:00:00.000Z', 'uses the Discord timestamp, not now');
  assert.strictEqual(after.lastReplyAt, '2026-07-25T10:00:00.000Z');
  assert.strictEqual(after.status, 'awaiting_tip', 'status untouched');
  assert.strictEqual(after.adminNotes, 'keep me', 'notes untouched');

  assert.strictEqual(cardRequests.recordReply('cr_nope', { messageId: 'x', content: 'y' }), null, 'unknown id → null');
  cardRequests.deleteRequest(r.id);
});

test('recordReply dedupes on messageId so a re-polled window never double-appends', () => {
  const r = cardRequests.createRequest({ idea: 'dedupe' }, USER);
  cardRequests.recordReply(r.id, { messageId: '1001', content: 'first', at: '2026-07-25T10:00:00.000Z' });
  const again = cardRequests.recordReply(r.id, { messageId: '1001', content: 'first', at: '2026-07-25T10:00:00.000Z' });
  assert.strictEqual(again.dmLog.length, 1, 'same Discord message ingested twice = one entry');

  cardRequests.recordReply(r.id, { messageId: '1002', content: 'second', at: '2026-07-25T10:01:00.000Z' });
  assert.strictEqual(cardRequests.getRequest(r.id).dmLog.length, 2);
  cardRequests.deleteRequest(r.id);
});

test('dmLog caps at 40 across both directions', () => {
  const r = cardRequests.createRequest({ idea: 'mixed cap' }, USER);
  for (let i = 0; i < 25; i++) cardRequests.recordDm(r.id, { template: `t${i}`, ok: true });
  for (let i = 0; i < 25; i++) {
    cardRequests.recordReply(r.id, { messageId: `m${i}`, content: `c${i}`, at: '2026-07-25T10:00:00.000Z' });
  }
  const capped = cardRequests.getRequest(r.id);
  assert.strictEqual(capped.dmLog.length, 40);
  assert.strictEqual(capped.dmLog[39].message, 'c24', 'newest entry kept');
  cardRequests.deleteRequest(r.id);
});

test('OPEN_STATUSES is exported for the DM poller', () => {
  assert.ok(cardRequests.OPEN_STATUSES instanceof Set);
  assert.ok(cardRequests.OPEN_STATUSES.has('awaiting_tip'));
  assert.ok(!cardRequests.OPEN_STATUSES.has('done'));
  assert.ok(!cardRequests.OPEN_STATUSES.has('declined'));
});
```

- [ ] **Step 3: Run the tests to verify they fail**

```bash
cd communityhunts-backend
node --test lib/cardRequests.test.js
```

Expected: FAIL — `cardRequests.setDmChannel is not a function`, `cardRequests.recordReply is not a function`, and the cap-40 assertions report 14/50 entries.

- [ ] **Step 4: Raise the log cap**

In `lib/cardRequests.js`, replace line 19:

```js
const MAX_DM_LOG = 10; // per-request DM history cap (newest kept)
```

with:

```js
const MAX_DM_LOG = 40; // per-request DM thread cap (newest kept) — carries BOTH directions now
```

- [ ] **Step 5: Tag outbound entries and store the sent message id**

Replace `recordDm` (lines 189-205) with:

```js
// Append a best-effort DM outcome to the request's capped dmLog + stamp lastDmAt. Pure
// bookkeeping — never touches status / adminNotes / updatedAt (mirrors setDiscordMessage).
// `messageId` is the id Discord assigned our send; it seeds the poller's read cursor.
function recordDm(id, { template, ok, error, message, by, messageId } = {}) {
  const r = requests.find(x => x.id === id);
  if (!r) return null;
  if (!Array.isArray(r.dmLog)) r.dmLog = [];
  const at = new Date().toISOString();
  const entry = { at, dir: 'out', template: String(template || ''), ok: !!ok };
  if (error) entry.error = String(error).slice(0, 300);
  if (message) entry.message = String(message).slice(0, 2000);
  if (by && by.id) entry.by = { id: String(by.id), name: String(by.name || '') };
  if (messageId) entry.messageId = String(messageId);
  r.dmLog.push(entry);
  if (r.dmLog.length > MAX_DM_LOG) r.dmLog = r.dmLog.slice(-MAX_DM_LOG);
  r.lastDmAt = at;
  persist();
  return r;
}
```

- [ ] **Step 6: Add the two new helpers**

Insert directly after `recordDm` in `lib/cardRequests.js`:

```js
// Attach the requester's DM channel + the read cursor used by lib/dmPoller.js. Both fields are
// optional so the poller can advance the watermark without restating the channel. Pure
// bookkeeping — never touches status / adminNotes / updatedAt.
function setDmChannel(id, { channelId, watermark } = {}) {
  const r = requests.find(x => x.id === id);
  if (!r) return null;
  if (channelId) r.dmChannelId = String(channelId);
  if (watermark) r.dmWatermark = String(watermark);
  persist();
  return r;
}

// Append an inbound DM from the requester to the same dmLog thread as our outbound sends, so the
// admin panel renders one conversation. Deduped on messageId: the poller can re-read a window
// after a failure, and that must never double-append. `at` is Discord's timestamp, not now —
// the thread must read in the order things were actually said. Pure bookkeeping.
function recordReply(id, { messageId, content, at } = {}) {
  const r = requests.find(x => x.id === id);
  if (!r) return null;
  if (!Array.isArray(r.dmLog)) r.dmLog = [];
  const mid = String(messageId || '');
  if (mid && r.dmLog.some(e => e.dir === 'in' && e.messageId === mid)) return r;
  const stamp = at || new Date().toISOString();
  const entry = { at: stamp, dir: 'in', message: String(content || '').slice(0, 2000) };
  if (mid) entry.messageId = mid;
  r.dmLog.push(entry);
  if (r.dmLog.length > MAX_DM_LOG) r.dmLog = r.dmLog.slice(-MAX_DM_LOG);
  r.lastReplyAt = stamp;
  persist();
  return r;
}
```

- [ ] **Step 7: Export the new helpers and `OPEN_STATUSES`**

In the `module.exports` block (lines 215-230), add three entries — after `recordDm,` add:

```js
  setDmChannel,
  recordReply,
```

and after `STATUSES,` add:

```js
  OPEN_STATUSES,
```

- [ ] **Step 8: Run the tests to verify they pass**

```bash
node --test lib/cardRequests.test.js
```

Expected: PASS, all tests. Check the exit code directly — piping the output masks it.

- [ ] **Step 9: Commit**

```bash
git add lib/cardRequests.js lib/cardRequests.test.js
git commit -m "feat(cardreq): dmLog carries inbound replies as a two-direction thread"
```

---

### Task 2: The poller — `lib/dmPoller.js`

**Files:**
- Create: `communityhunts-backend/lib/dmPoller.js`
- Test: `communityhunts-backend/lib/dmPoller.test.js`

**Interfaces:**
- Consumes: `cardRequests.OPEN_STATUSES`, `.listRequests()`, `.getRequest(id)`, `.setDmChannel(id, {channelId, watermark})`, `.recordReply(id, {messageId, content, at})` — all from Task 1.
- Produces: `startDmPolling({ cardRequests, getPlatformBotToken, channelId, intervalMs }) → { tick, stop }`. `tick()` is the async one-shot pass, exposed so tests drive it directly instead of waiting on the timer. `stop()` clears the interval.

- [ ] **Step 1: Write the failing tests**

Create `lib/dmPoller.test.js`:

```js
// lib/dmPoller.js — polls each open Shop Request's DM channel for requester replies.
// Every test drives poller.tick() directly; the timer itself is never awaited.
const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert');

const { startDmPolling } = require('./dmPoller');

const REQUESTER = '168055630916091904';
const BOT = '999999999999999999';
const realFetch = global.fetch;
after(() => { global.fetch = realFetch; });

let calls = [];
beforeEach(() => { calls = []; });

// Record every Discord call and delegate the response to `handler(url)`.
function stubFetch(handler) {
  global.fetch = async (url, opts = {}) => {
    const u = String(url);
    calls.push({ url: u, method: opts.method || 'GET', body: opts.body ? JSON.parse(opts.body) : null });
    return handler(u);
  };
}
const ok = (json) => ({ ok: true, status: 200, json: async () => json });
const fail = (status) => ({ ok: false, status, json: async () => ({}) });

// Minimal in-memory stand-in for lib/cardRequests — the real module persists to disk.
function fakeStore(rows) {
  const map = new Map(rows.map(r => [r.id, r]));
  return {
    OPEN_STATUSES: new Set(['new', 'awaiting_tip', 'in_progress']),
    listRequests: () => [...map.values()],
    getRequest: (id) => map.get(id) || null,
    setDmChannel(id, { channelId, watermark } = {}) {
      const r = map.get(id);
      if (!r) return null;
      if (channelId) r.dmChannelId = String(channelId);
      if (watermark) r.dmWatermark = String(watermark);
      return r;
    },
    recordReply(id, { messageId, content, at } = {}) {
      const r = map.get(id);
      if (!r) return null;
      r.dmLog = r.dmLog || [];
      if (r.dmLog.some(e => e.dir === 'in' && e.messageId === String(messageId))) return r;
      r.dmLog.push({ at, dir: 'in', message: content, messageId: String(messageId) });
      r.lastReplyAt = at;
      return r;
    },
  };
}

function row(over = {}) {
  return {
    id: 'cr_1', userId: REQUESTER, displayName: 'Goofer', cardName: 'Doge',
    status: 'awaiting_tip', dmChannelId: 'dm1', dmWatermark: '100',
    lastDmAt: '2026-07-25T10:00:00.000Z',
    dmLog: [{ at: '2026-07-25T10:00:00.000Z', dir: 'out', ok: true, template: 'need_info' }],
    ...over,
  };
}

function poller(store, channelId = 'chan') {
  return startDmPolling({
    cardRequests: store, getPlatformBotToken: () => 'tok', channelId, intervalMs: 999999,
  });
}

test('ingests only the requester messages, never the bot own sends', async () => {
  const store = fakeStore([row()]);
  stubFetch(u => u.includes('/channels/dm1/messages')
    ? ok([
        { id: '103', author: { id: BOT }, content: 'our follow-up', timestamp: '2026-07-25T10:03:00.000000+00:00' },
        { id: '102', author: { id: REQUESTER }, content: 'here is the ref', timestamp: '2026-07-25T10:02:00.000000+00:00' },
      ])
    : ok({ id: 'posted' }));

  const p = poller(store);
  await p.tick();
  p.stop();

  const r = store.getRequest('cr_1');
  const inbound = r.dmLog.filter(e => e.dir === 'in');
  assert.strictEqual(inbound.length, 1, 'only the requester message counts as a reply');
  assert.strictEqual(inbound[0].message, 'here is the ref');
  assert.strictEqual(r.dmWatermark, '103', 'cursor ends on the newest id seen, bot message included');
});

test('advances the watermark even when every message is filtered out', async () => {
  const store = fakeStore([row()]);
  stubFetch(u => u.includes('/channels/dm1/messages')
    ? ok([{ id: '150', author: { id: BOT }, content: 'ours', timestamp: '2026-07-25T10:05:00.000000+00:00' }])
    : ok({ id: 'posted' }));

  const p = poller(store);
  await p.tick();
  p.stop();

  const r = store.getRequest('cr_1');
  assert.strictEqual(r.dmWatermark, '150', 'otherwise the same window refetches forever');
  assert.strictEqual(r.dmLog.filter(e => e.dir === 'in').length, 0);
});

test('posts exactly one channel notification per request per tick', async () => {
  const store = fakeStore([row()]);
  stubFetch(u => u.includes('/channels/dm1/messages')
    ? ok([
        { id: '101', author: { id: REQUESTER }, content: 'one', timestamp: '2026-07-25T10:01:00.000000+00:00' },
        { id: '102', author: { id: REQUESTER }, content: 'two', timestamp: '2026-07-25T10:02:00.000000+00:00' },
        { id: '103', author: { id: REQUESTER }, content: 'three', timestamp: '2026-07-25T10:03:00.000000+00:00' },
      ])
    : ok({ id: 'posted' }));

  const p = poller(store);
  await p.tick();
  p.stop();

  assert.strictEqual(store.getRequest('cr_1').dmLog.filter(e => e.dir === 'in').length, 3);
  const posts = calls.filter(c => c.method === 'POST' && c.url.includes('/channels/chan/messages'));
  assert.strictEqual(posts.length, 1, 'three replies, one ping — not three');
  assert.match(posts[0].body.embeds[0].title, /Reply from Goofer/);
});

test('a failed read leaves the watermark intact so the next tick retries', async () => {
  const store = fakeStore([row()]);
  stubFetch(u => u.includes('/channels/dm1/messages') ? fail(500) : ok({ id: 'posted' }));

  const p = poller(store);
  await p.tick();
  p.stop();

  assert.strictEqual(store.getRequest('cr_1').dmWatermark, '100', 'unchanged');
});

test('one failing request does not stop the others', async () => {
  const store = fakeStore([row({ id: 'cr_bad', dmChannelId: 'dmBad' }), row({ id: 'cr_good' })]);
  stubFetch(u => {
    if (u.includes('/channels/dmBad/messages')) return fail(403);
    if (u.includes('/channels/dm1/messages')) {
      return ok([{ id: '105', author: { id: REQUESTER }, content: 'still works', timestamp: '2026-07-25T10:05:00.000000+00:00' }]);
    }
    return ok({ id: 'posted' });
  });

  const p = poller(store);
  await p.tick();
  p.stop();

  assert.strictEqual(store.getRequest('cr_good').dmLog.filter(e => e.dir === 'in').length, 1);
  assert.strictEqual(store.getRequest('cr_bad').dmWatermark, '100');
});

test('skips closed requests and requests that were never DMed', async () => {
  const store = fakeStore([
    row({ id: 'cr_done', status: 'done' }),
    row({ id: 'cr_declined', status: 'declined' }),
    row({ id: 'cr_nodm', dmLog: [] }),
  ]);
  stubFetch(() => ok([]));

  const p = poller(store);
  await p.tick();
  p.stop();

  assert.strictEqual(calls.length, 0, 'no Discord traffic at all');
});

test('no bot token configured is a silent no-op', async () => {
  const store = fakeStore([row()]);
  stubFetch(() => ok([]));

  const p = startDmPolling({ cardRequests: store, getPlatformBotToken: () => '', channelId: 'chan', intervalMs: 999999 });
  await p.tick();
  p.stop();

  assert.strictEqual(calls.length, 0);
});

test('bootstrap with no watermark resolves the channel and ingests only post-DM messages', async () => {
  const store = fakeStore([row({ dmWatermark: undefined, dmChannelId: undefined })]);
  stubFetch(u => {
    if (u.endsWith('/users/@me/channels')) return ok({ id: 'dm1' });
    if (u.includes('/channels/dm1/messages')) {
      return ok([
        { id: '090', author: { id: REQUESTER }, content: 'old chatter', timestamp: '2026-07-25T09:00:00.000000+00:00' },
        { id: '110', author: { id: REQUESTER }, content: 'the answer', timestamp: '2026-07-25T10:30:00.000000+00:00' },
      ]);
    }
    return ok({ id: 'posted' });
  });

  const p = poller(store);
  await p.tick();
  p.stop();

  const r = store.getRequest('cr_1');
  assert.strictEqual(r.dmChannelId, 'dm1', 'channel lazily resolved and stored');
  const inbound = r.dmLog.filter(e => e.dir === 'in');
  assert.strictEqual(inbound.length, 1, 'pre-DM history is not replayed into the channel');
  assert.strictEqual(inbound[0].message, 'the answer');
  assert.ok(calls.some(c => c.url.endsWith('/users/@me/channels') && c.body.recipient_id === REQUESTER));
});

test('bootstrap on a row with no lastDmAt ingests nothing and just sets the cursor', async () => {
  const store = fakeStore([row({ dmWatermark: undefined, lastDmAt: undefined })]);
  stubFetch(u => u.includes('/channels/dm1/messages')
    ? ok([{ id: '200', author: { id: REQUESTER }, content: 'who knows how old', timestamp: '2026-07-25T09:00:00.000000+00:00' }])
    : ok({ id: 'posted' }));

  const p = poller(store);
  await p.tick();
  p.stop();

  const r = store.getRequest('cr_1');
  assert.strictEqual(r.dmLog.filter(e => e.dir === 'in').length, 0, 'a corrupt row can never flood the channel');
  assert.strictEqual(r.dmWatermark, '200');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
node --test lib/dmPoller.test.js
```

Expected: FAIL — `Cannot find module './dmPoller'`.

- [ ] **Step 3: Write the poller**

Create `lib/dmPoller.js`:

```js
// Reads requester replies to Shop Request DMs and folds them into the request's dmLog thread.
//
// The backend holds no Discord gateway connection — DMs are SENT over plain REST from
// routes/cardRequests.routes.js, so replies land in the bot's inbox where nothing observes them.
// This module polls each open request's DM channel instead. Reading DM history over REST needs
// no gateway intent: intents govern gateway events, and we subscribe to none.
//
// DI: startDmPolling({ cardRequests, getPlatformBotToken, channelId }).

const API = 'https://discord.com/api/v10';
const DEFAULT_INTERVAL_MS = 120000; // 2 min — a commission queue, not a chat client
const PAGE = 50;                    // messages read per request per tick

// Discord snowflakes are numeric strings too long for Number. Longer string = larger id, and
// equal-length ids compare correctly lexicographically. Avoids BigInt throwing on a malformed id.
function cmpSnowflake(a, b) {
  if (a.length !== b.length) return a.length - b.length;
  return a < b ? -1 : a > b ? 1 : 0;
}

// Announce a reply in the shop-requests channel. Best-effort by contract: the replies are already
// recorded on the request, so a failure here costs only the ping.
async function notify(botToken, channelId, r, replies) {
  if (!channelId) return;
  const body = replies.map(m => m.content).filter(Boolean).join('\n\n').slice(0, 3900);
  const fields = [{ name: 'Request', value: r.id, inline: true }];
  if (r.cardName) fields.push({ name: 'Card', value: r.cardName.slice(0, 1024), inline: true });
  try {
    const resp = await fetch(`${API}/channels/${channelId}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bot ${botToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        embeds: [{
          title: `💬 Reply from ${r.displayName}`,
          description: body || '(no text — attachment only)',
          color: 0xa78bfa,
          fields,
          footer: { text: 'CommunityHunts — Shop Requests' },
        }],
      }),
    });
    if (!resp.ok) throw new Error(`Discord returned ${resp.status}`);
  } catch (e) {
    console.error(`[dmpoll] notify failed for ${r.id}: ${e.message}`);
  }
}

// Poll one request's DM channel. THROWS on a Discord failure so the caller skips this request
// without advancing its watermark — the same window is then retried on the next tick.
async function pollOne({ cardRequests, botToken, channelId }, r) {
  let dmChannelId = r.dmChannelId;

  // A request DM'd before this shipped has no stored channel. Opening one is idempotent —
  // Discord returns the existing DM channel for the same recipient.
  if (!dmChannelId) {
    const resp = await fetch(`${API}/users/@me/channels`, {
      method: 'POST',
      headers: { Authorization: `Bot ${botToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ recipient_id: r.userId }),
    });
    if (!resp.ok) throw new Error(`open DM channel → ${resp.status}`);
    const dm = await resp.json().catch(() => null);
    if (!dm || !dm.id) throw new Error('no DM channel id');
    dmChannelId = String(dm.id);
    cardRequests.setDmChannel(r.id, { channelId: dmChannelId });
  }

  const qs = r.dmWatermark ? `?limit=${PAGE}&after=${r.dmWatermark}` : `?limit=${PAGE}`;
  const resp = await fetch(`${API}/channels/${dmChannelId}/messages${qs}`, {
    headers: { Authorization: `Bot ${botToken}` },
  });
  if (!resp.ok) throw new Error(`read DM channel → ${resp.status}`);
  const msgs = await resp.json().catch(() => null);
  if (!Array.isArray(msgs) || !msgs.length) return 0;

  // Discord returns newest-first. Sort ascending so the thread reads in order and the cursor
  // lands on the true newest id.
  const asc = msgs.slice().sort((a, b) => cmpSnowflake(String(a.id), String(b.id)));
  const newest = String(asc[asc.length - 1].id);

  // Only the requester's own messages are replies. This one filter drops our bot's sends with
  // no bot-user-id lookup.
  let inbound = asc.filter(m => m.author && String(m.author.id) === String(r.userId));

  // Bootstrap (no cursor yet): the window is the channel's whole recent history, so keep only
  // what arrived after our last DM. Date.parse both sides — Discord stamps look like
  // "…+00:00" and lastDmAt like "…Z", which do NOT compare correctly as raw strings.
  if (!r.dmWatermark) {
    inbound = r.lastDmAt
      ? inbound.filter(m => m.timestamp && Date.parse(m.timestamp) > Date.parse(r.lastDmAt))
      : []; // a row with a dmLog always has lastDmAt; if it somehow doesn't, ingest nothing
  }

  for (const m of inbound) {
    cardRequests.recordReply(r.id, { messageId: String(m.id), content: m.content || '', at: m.timestamp });
  }

  // Advance even when everything was filtered out — otherwise the same window refetches forever.
  cardRequests.setDmChannel(r.id, { watermark: newest });

  // One ping per request per tick, not one per message.
  if (inbound.length) await notify(botToken, channelId, cardRequests.getRequest(r.id) || r, inbound);
  return inbound.length;
}

function startDmPolling({ cardRequests, getPlatformBotToken, channelId, intervalMs = DEFAULT_INTERVAL_MS }) {
  let running = false;

  async function tick() {
    if (running) return; // never stack ticks behind a slow Discord call
    const botToken = getPlatformBotToken && getPlatformBotToken();
    if (!botToken) return;
    running = true;
    try {
      // Closed requests are done conversations; a request never DM'd has no channel to read.
      const open = cardRequests.listRequests().filter(
        r => cardRequests.OPEN_STATUSES.has(r.status) && Array.isArray(r.dmLog) && r.dmLog.length
      );
      for (const r of open) {
        try {
          await pollOne({ cardRequests, botToken, channelId }, r);
        } catch (e) {
          console.error(`[dmpoll] ${r.id}: ${e.message}`);
        }
      }
    } finally {
      running = false;
    }
  }

  const timer = setInterval(tick, intervalMs);
  if (timer.unref) timer.unref(); // never hold a test run or a maintenance script open
  console.log(`[dmpoll] Shop Request DM reply polling every ${Math.round(intervalMs / 1000)}s`);
  return { tick, stop: () => clearInterval(timer) };
}

module.exports = { startDmPolling };
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
node --test lib/dmPoller.test.js
```

Expected: PASS, 9 tests. Then confirm nothing else regressed:

```bash
node --test lib/*.test.js
```

- [ ] **Step 5: Commit**

```bash
git add lib/dmPoller.js lib/dmPoller.test.js
git commit -m "feat(dmpoll): poll Shop Request DM channels for requester replies"
```

---

### Task 3: Send path persists the DM channel and seeds the cursor

**Files:**
- Modify: `communityhunts-backend/routes/cardRequests.routes.js:250-265` (inside the `POST /api/admin/card-requests/:id/dm` handler)
- Test: `communityhunts-backend/routes/cardRequests.routes.test.js:57-72` (fake store) and a new test case

**Interfaces:**
- Consumes: `cardRequests.setDmChannel(id, { channelId, watermark })` and `recordDm(..., { messageId })` from Task 1.
- Produces: after a successful send, the request carries `dmChannelId` and — on the **first** send only — `dmWatermark`. Task 2's poller reads both.

- [ ] **Step 1: Teach the route test's fake store about `setDmChannel`**

Without this the new route code throws `cardRequests.setDmChannel is not a function` and every DM test fails. In `routes/cardRequests.routes.test.js`, inside `fakeCardRequests`, add after the `setDiscordMessage` entry (line 63):

```js
    setDmChannel: (id, { channelId, watermark } = {}) => {
      const r = list.find(x => x.id === id);
      if (!r) return null;
      if (channelId) r.dmChannelId = String(channelId);
      if (watermark) r.dmWatermark = String(watermark);
      return r;
    },
```

- [ ] **Step 2: Write the failing test**

Append to `routes/cardRequests.routes.test.js`:

```js
test('a successful DM stores the channel and seeds the watermark only on the first send', async () => {
  const app = appWith({ requests: [{ ...REQ }] });
  await postDm(app, 'cr_1', { message: 'need more info please', template: 'need_info' });

  const stored = app._cardRequests._list[0];
  assert.strictEqual(stored.dmChannelId, 'dm-1', 'channel persisted for the poller');
  assert.strictEqual(stored.dmWatermark, 'm-1', 'cursor seeded from our own send');
  assert.strictEqual(stored.dmLog[0].messageId, 'm-1', 'send id recorded on the entry');

  // A second send must NOT advance the cursor: a reply that arrived between the last poll and
  // this send would be skipped. Only the poller advances it after the first send.
  await postDm(app, 'cr_1', { message: 'following up', template: 'need_info' });
  assert.strictEqual(stored.dmWatermark, 'm-1', 'unchanged by the second send');
});
```

- [ ] **Step 3: Run the test to verify it fails**

```bash
node --test routes/cardRequests.routes.test.js
```

Expected: FAIL — `stored.dmChannelId` is `undefined`.

- [ ] **Step 4: Persist the channel and seed the cursor**

In `routes/cardRequests.routes.js`, find this line inside the DM handler (line 263):

```js
      const updated = cardRequests.recordDm(r.id, { template, ok: true, message, by });
```

Replace it with:

```js
      const sent = await msgResp.json().catch(() => null);
      const sentId = sent && sent.id ? String(sent.id) : null;

      // Persist the DM channel so lib/dmPoller.js can read replies off it. The watermark is
      // seeded from this send ONLY when unset — advancing it on every send would skip a reply
      // that arrived between the last poll and this send. After the first send the poller owns it.
      const seedWatermark = !r.dmWatermark && sentId ? sentId : undefined;
      cardRequests.setDmChannel(r.id, { channelId: String(dm.id), watermark: seedWatermark });

      const updated = cardRequests.recordDm(r.id, { template, ok: true, message, by, messageId: sentId });
```

- [ ] **Step 5: Run the tests to verify they pass**

```bash
node --test routes/cardRequests.routes.test.js
node --test lib/*.test.js
```

Expected: PASS for both. The pre-existing DM tests must still pass unchanged — they assert exactly two Discord calls, and this adds none.

- [ ] **Step 6: Commit**

```bash
git add routes/cardRequests.routes.js routes/cardRequests.routes.test.js
git commit -m "feat(cardreq): store the DM channel + read cursor on send"
```

---

### Task 4: Start the poller and verify it live

**Files:**
- Modify: `communityhunts-backend/server.js:548-557` (after the card-requests router mount)

**Interfaces:**
- Consumes: `startDmPolling` from Task 2; the `cardRequests` store already constructed at `server.js:541`.
- Produces: a running poller in production. Nothing else imports this.

- [ ] **Step 1: Wire the poller into the composition root**

In `server.js`, directly after the closing `}));` of the `app.use(require('./routes/cardRequests.routes')({ ... }))` block (line 557), insert:

```js
// Read requester REPLIES to those DMs (lib/dmPoller.js). The backend holds no Discord gateway,
// so replies are polled off each open request's DM channel and folded into its dmLog, with a
// ping to the same shop-requests channel. Same bot, same channel id — no new env var.
require('./lib/dmPoller').startDmPolling({
  cardRequests,
  getPlatformBotToken: tenants.getPlatformBotToken,
  channelId: (process.env.DISCORD_SHOP_REQUESTS_CHANNEL_ID || '').trim(),
});
```

- [ ] **Step 2: Boot the server locally and confirm the poller announces itself**

```bash
npm run dev
```

Expected in the log: `[dmpoll] Shop Request DM reply polling every 120s`.

Note `npm start` does **not** load `.env` — use `npm run dev`. Stop the server once you see the line.

- [ ] **Step 3: Run the full backend suite one more time**

```bash
node --test lib/*.test.js
node --test routes/cardRequests.routes.test.js
```

Expected: PASS.

- [ ] **Step 4: Commit and open the PR**

```bash
git add server.js
git commit -m "feat(server): start Shop Request DM reply polling"
git push -u origin feat/shop-request-dm-replies
```

Open the PR against `RandyCabbages/communityhunts-backend`. No Claude attribution in the body.

- [ ] **Step 5: Merge and verify end-to-end on production**

Merge only when the hunt tracker is idle — a Railway restart clears OverDrop state. Railway auto-deploys `main` in ~1-3 min. Verify the merge-base after merging; merge races have dropped commits in this repo before.

Then, against production:

1. Open `/admin/shop-requests`, pick a request whose requester is you, send the **Need more info** template.
2. Reply to that DM from your own Discord account.
3. Within ~2 min, confirm a `💬 Reply from <you>` embed appears in the shop-requests channel.
4. Confirm the Railway logs show no `[dmpoll]` errors.
5. Reload the admin panel and confirm the reply is in the request's `dmLog` (it will render as a plain entry until Task 5 ships — that is expected).

**Do not start Task 5 until this passes.** The frontend reads fields that only exist once this is live.

---

### Task 5: Render the thread in the admin panel

**Files:**
- Modify: `communityhunts-frontend/src/admin/ShopRequestDm.js:44-45` (last-entry derivation), `:50-68` (header), `:79` (call site), `:87-107` (`DmHistory`)

**Interfaces:**
- Consumes: `r.dmLog[].dir`, `r.dmLog[].message`, `r.lastReplyAt`, `r.lastDmAt` — all produced by Tasks 1-3 and live in production.
- Produces: nothing other tasks depend on. Final task.

Work in the **frontend** repo, on its own branch:

```bash
cd ../communityhunts-frontend
git fetch origin && git pull --ff-only
git checkout -b feat/shop-request-dm-replies
```

- [ ] **Step 1: Derive the send status from outbound entries only**

This is a real bug if skipped: `last` currently takes the newest entry of any kind, so once an inbound reply is the newest, `last.ok` is `undefined` and the header renders `✗ DM failed: unknown` for a DM that succeeded.

In `src/admin/ShopRequestDm.js`, replace lines 44-45:

```js
  const log = Array.isArray(r.dmLog) ? r.dmLog : [];
  const last = log.length ? log[log.length - 1] : null;
```

with:

```js
  const log = Array.isArray(r.dmLog) ? r.dmLog : [];
  // The ✓/✗ line reports the last thing WE sent — an inbound reply has no `ok` and would
  // otherwise render a successful DM as failed. Entries with no `dir` are legacy outbound.
  const outbound = log.filter(e => e.dir !== 'in');
  const last = outbound.length ? outbound[outbound.length - 1] : null;
  // They answered more recently than we wrote → the ball is in our court. Derived, not stored.
  const awaitingReply = !!r.lastReplyAt && (!r.lastDmAt || new Date(r.lastReplyAt) > new Date(r.lastDmAt));
```

- [ ] **Step 2: Add the "awaiting your reply" badge**

In the same file, inside the header `<div>`, immediately after the `{last && ( ... )}` block (ends line 61), insert:

```js
        {awaitingReply && (
          <button onClick={() => setShowHistory(true)}
            style={{ background: 'none', border: `1px solid ${C.accent || C.gold}`, borderRadius: C.rCtl, color: C.accent || C.gold, fontFamily: C.body, fontWeight: 700, fontSize: 11, padding: '2px 8px', cursor: 'pointer' }}>
            💬 Awaiting your reply
          </button>
        )}
```

It is a button, not a label — one click opens the thread instead of leaving you hunting for it.

- [ ] **Step 3: Pass the requester name into the history view**

Replace line 79:

```js
      {showHistory && <DmHistory log={log} C={C} />}
```

with:

```js
      {showHistory && <DmHistory log={log} C={C} name={r.displayName} />}
```

- [ ] **Step 4: Render inbound and outbound entries distinctly**

Replace the whole `DmHistory` function (lines 85-107) with:

```js
// Newest-first view of one request's DM thread — our sends and their replies interleaved.
// Legacy entries predate the `dir` flag and are always outbound.
function DmHistory({ log, C, name }) {
  const LABEL = Object.fromEntries(DM_TEMPLATES.map(t => [t.key, t.label]));
  return (
    <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 8 }}>
      {log.slice().reverse().map((e, i) => {
        const inbound = e.dir === 'in';
        const edge = inbound ? (C.accent || C.gold) : (e.ok ? C.green : C.red);
        return (
          <div key={i} style={{ fontSize: 11, borderLeft: `2px solid ${edge}`, paddingLeft: 8 }}>
            <div style={{ color: C.t3 }}>
              {inbound ? (
                <><span style={{ color: edge, fontWeight: 700 }}>↩</span> {name} replied</>
              ) : (
                <>
                  <span style={{ color: edge, fontWeight: 700 }}>{e.ok ? '✓' : '✗'}</span>{' '}
                  {LABEL[e.template] || 'Message'}
                </>
              )}
              {e.at ? ` · ${new Date(e.at).toLocaleString()}` : ''}
              {!inbound && e.by && e.by.name ? ` · sent by ${e.by.name}` : ''}
            </div>
            {!inbound && !e.ok && e.error && <div style={{ color: C.red, marginTop: 2 }}>{e.error}</div>}
            <div style={{ color: C.t2, whiteSpace: 'pre-wrap', marginTop: 2 }}>
              {e.message ? e.message : (
                <span style={{ color: C.t4, fontStyle: 'italic' }}>
                  {inbound ? '(no text — attachment only)' : '(message not recorded)'}
                </span>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
```

- [ ] **Step 5: Build**

```bash
CI=true npm run build
```

Expected: `Compiled successfully`. Anything less fails on Vercel — warnings are errors there.

- [ ] **Step 6: Commit and push to a branch**

```bash
git add src/admin/ShopRequestDm.js
git commit -m "feat(admin): render Shop Request DMs as a two-way thread"
git push -u origin feat/shop-request-dm-replies
```

- [ ] **Step 7: Verify on the Vercel preview URL, then merge**

Do **not** test on `main` — it is the live site. On the preview URL, open `/admin/shop-requests` and confirm against the request you replied to in Task 4:

- The reply renders with the `↩ <name> replied` label and an accent left border.
- The `💬 Awaiting your reply` badge is present, and clicking it opens the history.
- The `✓ DM sent` line still reads as sent — **not** `✗ DM failed: unknown` (that is the Step 1 bug).
- A request with only old, pre-`dir` entries still renders them as outbound with the correct ✓/✗.

Then open the PR against `GooferG/communityhunts-frontend` and merge.

---

## Rollback

`git revert <merge-sha>` in whichever repo. Never force-push. The added request fields (`dmChannelId`, `dmWatermark`, `lastReplyAt`) and `dir`-tagged log entries are additive — reverting the code leaves them in the store harmlessly, and re-applying picks up where it left off.
