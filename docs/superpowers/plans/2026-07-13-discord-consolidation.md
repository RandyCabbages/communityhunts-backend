# Discord Posting Consolidation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Point `/api/tickets` and `/api/card-requests` Discord posting at the single real bot (`DISCORD_BOT_TOKEN`), retire the dead `DISCORD_TICKETS_BOT_TOKEN`, and make the Shop Requests notification track the request's phase (emoji + color) by editing its own message on status change.

**Architecture:** Backend-only. Part A is a token-source swap in `routes/misc.routes.js`. Part B switches `routes/cardRequests.routes.js` to the community bot (announcements-style per-request token resolution), captures the posted message id, and PATCHes the embed on each `PUT` status change. A new `lib/cardRequests.js` setter stores the message/channel ids.

**Tech Stack:** Node/Express (no build step), node:test, Discord REST v10, Postgres `hunts_kv`.

**Spec:** `docs/superpowers/specs/2026-07-13-card-requests-discord-phase-design.md`.

## Global Constraints

- **Repo:** `communityhunts-backend/` only (the wrapper dir is NOT a git repo — run git inside the app dir).
- **Branch:** `feat/discord-consolidation`. `git pull --ff-only` before branching. Ship via PR (backend auto-deploys on merge to main; Railway restart logs everyone out — expected).
- **No `Co-Authored-By` / Claude attribution** in commits or the PR body.
- **Tests:** `node --test lib/*.test.js` must pass (Node 24 needs the glob form — `node --test lib/` errors with "Cannot find module ...lib").
- **One bot token everywhere:** all Discord posting resolves to `DISCORD_BOT_TOKEN` (per-request `req.tenant.discordBotToken` override where a tenant applies). `DISCORD_TICKETS_BOT_TOKEN` is retired — no code reads it after this.
- **Phase map (exact — colors are the frontend `STATUS_META` hexes as ints):** `new` 🆕 `0xa78bfa` · `awaiting_tip` 💰 `0xfbbf24` · `in_progress` 🔨 `0x22d3ee` · `done` ✅ `0x4ade80` · `declined` ❌ `0xff6b6b`.
- **Best-effort for card requests:** the request save + admin status update are the source of truth; any Discord post/edit failure only logs, never fails the API call. Tickets keep their existing 500-on-failure contract.
- **No new Railway vars.** `DISCORD_BOT_TOKEN` + the three channel IDs already exist.

---

### Task 1: Part A — tickets post via the community bot

**Files:**
- Modify: `communityhunts-backend/routes/misc.routes.js:13-20` (token source + comment), `:78`, `:112` (uses)
- Modify: `communityhunts-backend/.env.example` (tickets section)

**Interfaces:**
- Consumes: `process.env.DISCORD_BOT_TOKEN`.
- Produces: nothing other tasks depend on (self-contained route behavior change).

- [ ] **Step 1: Create the feature branch**

```bash
cd communityhunts-backend
git pull --ff-only
git checkout -b feat/discord-consolidation
```

- [ ] **Step 2: Swap the token source + fix the comment**

In `routes/misc.routes.js`, replace the config block (lines 13-20):

```js
// Ticket config is env-derived (config, not shared state) — read here so the router is self-sufficient.
// This is the CommunityHunts *business* Discord bot (App 1506278609445191800), distinct from the
// per-tenant DISCORD_BOT_TOKEN used for slot-call import / winner parsing in Bean's community server.
// Tickets split by type: "Feature Request" → suggestions channel; everything else → tickets channel.
const TICKETS_BOT_TOKEN = (process.env.DISCORD_TICKETS_BOT_TOKEN || '').trim();
const TICKETS_CHANNEL_ID = (process.env.DISCORD_TICKETS_CHANNEL_ID || '').trim();
const SUGGESTIONS_CHANNEL_ID = (process.env.DISCORD_SUGGESTIONS_CHANNEL_ID || '').trim();
const SUGGESTION_TYPES = new Set(['Feature Request']);
```

with:

```js
// Ticket config is env-derived (config, not shared state) — read here so the router is self-sufficient.
// Posts via the one shared community bot (DISCORD_BOT_TOKEN) — the same bot used for announcements
// and Shop Requests; there is exactly one bot in the single communityhunts.gg Discord. (The old
// DISCORD_TICKETS_BOT_TOKEN pointed at a bot that never existed → 401; it is retired.)
// Tickets split by type: "Feature Request" → suggestions channel; everything else → tickets channel.
const BOT_TOKEN = (process.env.DISCORD_BOT_TOKEN || '').trim();
const TICKETS_CHANNEL_ID = (process.env.DISCORD_TICKETS_CHANNEL_ID || '').trim();
const SUGGESTIONS_CHANNEL_ID = (process.env.DISCORD_SUGGESTIONS_CHANNEL_ID || '').trim();
const SUGGESTION_TYPES = new Set(['Feature Request']);
```

- [ ] **Step 3: Update the two `TICKETS_BOT_TOKEN` uses**

In the same file, line 78 — the guard:

```js
    if (!TICKETS_BOT_TOKEN) return res.status(500).json({error:'Discord ticket bot not configured on the server'});
```

becomes:

```js
    if (!BOT_TOKEN) return res.status(500).json({error:'Discord bot not configured on the server'});
```

And line 112 — the Authorization header:

```js
        headers: { Authorization: `Bot ${TICKETS_BOT_TOKEN}`, 'Content-Type': 'application/json' },
```

becomes:

```js
        headers: { Authorization: `Bot ${BOT_TOKEN}`, 'Content-Type': 'application/json' },
```

- [ ] **Step 4: Update `.env.example` tickets section**

In `.env.example`, replace the tickets block (the 4 comment lines + the three `DISCORD_TICKETS_*` / `DISCORD_SUGGESTIONS_*` lines, ending before `DISCORD_SHOP_REQUESTS_CHANNEL_ID`):

```
# POST /api/tickets posts inquiries + feature suggestions into the CommunityHunts *business*
# Discord (App 1506278609445191800, server 1521799868660711514) via its own bot — separate from
# the per-tenant DISCORD_BOT_TOKEN above. Type "Feature Request" → suggestions channel; Bug/Other/
# Community Request → tickets channel. Channel IDs: enable Developer Mode, right-click channel → Copy ID.
DISCORD_TICKETS_BOT_TOKEN=your_business_bot_token
DISCORD_TICKETS_CHANNEL_ID=your_inquiries_channel_id
DISCORD_SUGGESTIONS_CHANNEL_ID=your_suggestions_channel_id
# Optional: dedicated channel for custom-card commission requests ("Shop Requests").
# Falls back to DISCORD_TICKETS_CHANNEL_ID when unset.
DISCORD_SHOP_REQUESTS_CHANNEL_ID=
```

with:

```
# POST /api/tickets posts inquiries + feature suggestions into the communityhunts.gg Discord via
# the shared DISCORD_BOT_TOKEN bot (the same single bot used by announcements + Shop Requests).
# Type "Feature Request" → suggestions channel; Bug/Other/Community Request → tickets channel.
# Channel IDs: enable Developer Mode, right-click channel → Copy ID.
# NOTE: DISCORD_TICKETS_BOT_TOKEN is retired/unused — all Discord posting now uses DISCORD_BOT_TOKEN.
DISCORD_TICKETS_CHANNEL_ID=your_inquiries_channel_id
DISCORD_SUGGESTIONS_CHANNEL_ID=your_suggestions_channel_id
# Dedicated channel for custom-card commission requests ("Shop Requests"), served by DISCORD_BOT_TOKEN.
DISCORD_SHOP_REQUESTS_CHANNEL_ID=
```

- [ ] **Step 5: Syntax check + boot proof the swap**

```bash
node --check routes/misc.routes.js
```

Expected: silent (exit 0).

Boot with a DUMMY bot token + tickets channel to prove the route now reads `DISCORD_BOT_TOKEN` (a dummy token makes Discord return 401 → the handler's `Discord returned 401` path, which only fires if the token guard passed — i.e. it read the new var):

```bash
PORT=3101 DISCORD_CLIENT_ID=x DISCORD_CLIENT_SECRET=x SESSION_SECRET=x \
  DISCORD_BOT_TOKEN=dummy DISCORD_TICKETS_CHANNEL_ID=123 node server.js
```

In a second shell:

```bash
curl -s -X POST http://localhost:3101/api/tickets -H "Content-Type: application/json" \
  -d '{"username":"tester","issue":"smoke","type":"Bug"}'
```

Expected JSON contains `Discord returned 401` (NOT `Discord bot not configured` and NOT `No Discord tickets channel configured`) — proving it read `DISCORD_BOT_TOKEN` and attempted the post. Stop the server (Ctrl-C / TaskStop).

- [ ] **Step 6: Commit**

```bash
git add routes/misc.routes.js .env.example
git commit -m "fix: post tickets via the shared community bot (retire dead tickets-bot token)"
```

---

### Task 2: Part B — `setDiscordMessage` in the lib (TDD)

**Files:**
- Modify: `communityhunts-backend/lib/cardRequests.js` (add setter + export)
- Test: `communityhunts-backend/lib/cardRequests.test.js` (add one test)

**Interfaces:**
- Consumes: existing `createRequest`, `updateRequest`, `deleteRequest` (unchanged).
- Produces (Task 3 relies on this): `setDiscordMessage(id, { messageId, channelId })` → the request object (with `discordMessageId` / `discordChannelId` set) or `null` if id unknown. Does NOT change `status`, `adminNotes`, or `updatedAt`.

- [ ] **Step 1: Write the failing test**

Append to `lib/cardRequests.test.js` (before the final line):

```js
test('setDiscordMessage stores ids; a status update preserves them', () => {
  const r = cardRequests.createRequest({ idea: 'Discord fields' }, USER);
  const withMsg = cardRequests.setDiscordMessage(r.id, { messageId: '111', channelId: '222' });
  assert.strictEqual(withMsg.discordMessageId, '111');
  assert.strictEqual(withMsg.discordChannelId, '222');

  const afterStatus = cardRequests.updateRequest(r.id, { status: 'in_progress' });
  assert.strictEqual(afterStatus.discordMessageId, '111', 'message id survives a status edit');
  assert.strictEqual(afterStatus.discordChannelId, '222', 'channel id survives a status edit');
  assert.strictEqual(afterStatus.status, 'in_progress');

  assert.strictEqual(cardRequests.setDiscordMessage('cr_nope', { messageId: 'x', channelId: 'y' }), null, 'unknown id → null');
  cardRequests.deleteRequest(r.id);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test lib/cardRequests.test.js`
Expected: FAIL — `cardRequests.setDiscordMessage is not a function`.

- [ ] **Step 3: Add the setter**

In `lib/cardRequests.js`, add this function directly after `updateRequest` (before `deleteRequest`):

```js
// Attach the posted Discord message's ids so a later status change can PATCH that same message.
// Pure bookkeeping — does not touch status / adminNotes / updatedAt.
function setDiscordMessage(id, { messageId, channelId }) {
  const r = requests.find(x => x.id === id);
  if (!r) return null;
  r.discordMessageId = messageId;
  r.discordChannelId = channelId;
  persist();
  return r;
}
```

Then add it to `module.exports` (after `deleteRequest,`):

```js
  setDiscordMessage,
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test lib/cardRequests.test.js`
Expected: PASS (9 tests). Then `node --test lib/*.test.js` — full suite still green.

- [ ] **Step 5: Commit**

```bash
git add lib/cardRequests.js lib/cardRequests.test.js
git commit -m "feat: cardRequests.setDiscordMessage — store posted message/channel ids"
```

---

### Task 3: Part B — community bot + phase embed in the route + mount

**Files:**
- Modify: `communityhunts-backend/routes/cardRequests.routes.js` (PHASE_META, embed, DI, POST capture, PUT edit)
- Modify: `communityhunts-backend/server.js:380-389` (mount deps)

**Interfaces:**
- Consumes: `cardRequests.setDiscordMessage` (Task 2); `process.env.DISCORD_BOT_TOKEN`, `process.env.DISCORD_SHOP_REQUESTS_CHANNEL_ID`; per-request `req.tenant.discordBotToken`.
- Produces: the live-updating Discord notification (no downstream code depends on it).

- [ ] **Step 1: Replace the embed builder + color constant with the phase map**

In `routes/cardRequests.routes.js`, replace lines 11-31 (the `MAX_OPEN_PER_USER` const stays; the `EMBED_COLOR` const + `buildRequestEmbed`) — specifically replace:

```js
const MAX_OPEN_PER_USER = 2;
const EMBED_COLOR = 0xa78bfa; // community accent (violet)

// Discord embed caps mirror routes/misc.routes.js: title ≤256, description ≤4096
// (3900 for margin), field value ≤1024.
function buildRequestEmbed(r) {
  const fields = [
    { name: 'From', value: `${r.displayName} (${r.userId})`.slice(0, 1024), inline: false },
  ];
  if (r.cardName) fields.push({ name: 'Card name', value: r.cardName.slice(0, 1024), inline: true });
  if (r.rainbetUsername) fields.push({ name: 'Rainbet', value: r.rainbetUsername.slice(0, 1024), inline: true });
  if (r.refLinks.length) fields.push({ name: 'References', value: r.refLinks.join('\n').slice(0, 1024), inline: false });
  return {
    title: '🎨 Custom Card Request',
    description: r.idea.slice(0, 3900),
    color: EMBED_COLOR,
    fields,
    timestamp: r.createdAt,
    footer: { text: 'CommunityHunts — Shop Requests' },
  };
}
```

with:

```js
const MAX_OPEN_PER_USER = 2;

// Phase → title emoji + embed color. Colors mirror the frontend admin STATUS_META so the Discord
// message and the Shop Requests panel read the same. Unknown status falls back to 'new'.
const PHASE_META = {
  new:          { emoji: '🆕', color: 0xa78bfa },
  awaiting_tip: { emoji: '💰', color: 0xfbbf24 },
  in_progress:  { emoji: '🔨', color: 0x22d3ee },
  done:         { emoji: '✅', color: 0x4ade80 },
  declined:     { emoji: '❌', color: 0xff6b6b },
};

// Discord embed caps mirror routes/misc.routes.js: title ≤256, description ≤4096
// (3900 for margin), field value ≤1024. Rebuilt from the request each call, so an edit reflects
// current data + phase.
function buildRequestEmbed(r) {
  const phase = PHASE_META[r.status] || PHASE_META.new;
  const fields = [
    { name: 'From', value: `${r.displayName} (${r.userId})`.slice(0, 1024), inline: false },
  ];
  if (r.cardName) fields.push({ name: 'Card name', value: r.cardName.slice(0, 1024), inline: true });
  if (r.rainbetUsername) fields.push({ name: 'Rainbet', value: r.rainbetUsername.slice(0, 1024), inline: true });
  if (r.refLinks.length) fields.push({ name: 'References', value: r.refLinks.join('\n').slice(0, 1024), inline: false });
  return {
    title: `${phase.emoji} Custom Card Request`,
    description: r.idea.slice(0, 3900),
    color: phase.color,
    fields,
    timestamp: r.createdAt,
    footer: { text: 'CommunityHunts — Shop Requests' },
  };
}
```

- [ ] **Step 2: Swap the DI param name**

In the same file, the deps destructure (line 34):

```js
  const { requireAuth, requirePlatformAdmin, cardRequests, ticketsBotToken, channelId } = deps;
```

becomes:

```js
  const { requireAuth, requirePlatformAdmin, cardRequests, envBotToken, channelId } = deps;
```

- [ ] **Step 3: Resolve the token per-request + capture the message id on POST**

Replace the POST doorbell block (lines 56-73) — from the `// Best-effort Discord doorbell` comment through `res.json({ ok: true, discord });`:

```js
    // Best-effort Discord doorbell (announcements pattern: saved first, failure only logged).
    let discord = 'skipped';
    if (ticketsBotToken && channelId) {
      try {
        const resp = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
          method: 'POST',
          headers: { Authorization: `Bot ${ticketsBotToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ embeds: [buildRequestEmbed(r)] }),
        });
        if (!resp.ok) throw new Error(`Discord returned ${resp.status}`);
        discord = 'posted';
        console.log(`[cardreq] request ${r.id} posted to Discord`);
      } catch (e) {
        discord = 'failed';
        console.error('[cardreq] Discord notify failed:', e.message);
      }
    }
    res.json({ ok: true, discord });
```

with (token resolved per-request like announcements; capture the returned message id):

```js
    // Best-effort Discord doorbell (announcements pattern: saved first, failure only logged).
    // Token resolves per-request: tenant override, else the shared community bot.
    const botToken = (req.tenant && req.tenant.discordBotToken) || envBotToken;
    let discord = 'skipped';
    if (botToken && channelId) {
      try {
        const resp = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
          method: 'POST',
          headers: { Authorization: `Bot ${botToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ embeds: [buildRequestEmbed(r)] }),
        });
        if (!resp.ok) throw new Error(`Discord returned ${resp.status}`);
        // Store the message + channel ids so a later status change can PATCH this same message.
        const msg = await resp.json().catch(() => null);
        if (msg && msg.id) cardRequests.setDiscordMessage(r.id, { messageId: String(msg.id), channelId: String(channelId) });
        discord = 'posted';
        console.log(`[cardreq] request ${r.id} posted to Discord`);
      } catch (e) {
        discord = 'failed';
        console.error('[cardreq] Discord notify failed:', e.message);
      }
    }
    res.json({ ok: true, discord });
```

- [ ] **Step 4: PATCH the embed on status change (PUT)**

Replace the whole PUT handler (lines 80-86):

```js
  router.put('/api/admin/card-requests/:id', requireAuth, requirePlatformAdmin, (req, res) => {
    const err = cardRequests.validateUpdate(req.body);
    if (err) return res.status(400).json({ error: err });
    const r = cardRequests.updateRequest(String(req.params.id), req.body);
    if (!r) return res.status(404).json({ error: 'Request not found' });
    res.json(r);
  });
```

with (now `async`; responds first, then best-effort edits the message so the admin never waits on Discord):

```js
  router.put('/api/admin/card-requests/:id', requireAuth, requirePlatformAdmin, async (req, res) => {
    const err = cardRequests.validateUpdate(req.body);
    if (err) return res.status(400).json({ error: err });
    const r = cardRequests.updateRequest(String(req.params.id), req.body);
    if (!r) return res.status(404).json({ error: 'Request not found' });
    res.json(r);

    // Best-effort: reflect the new phase (emoji + color) on the request's Discord message.
    // Fire after responding — the admin action never blocks on Discord. Skips silently when the
    // request has no stored message id (post failed/skipped, or it predates this feature).
    const botToken = (req.tenant && req.tenant.discordBotToken) || envBotToken;
    if (r.discordMessageId && r.discordChannelId && botToken) {
      try {
        const resp = await fetch(`https://discord.com/api/v10/channels/${r.discordChannelId}/messages/${r.discordMessageId}`, {
          method: 'PATCH',
          headers: { Authorization: `Bot ${botToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ embeds: [buildRequestEmbed(r)] }),
        });
        if (!resp.ok) throw new Error(`Discord returned ${resp.status}`);
        console.log(`[cardreq] request ${r.id} embed updated → ${r.status}`);
      } catch (e) {
        console.error('[cardreq] Discord embed update failed:', e.message);
      }
    }
  });
```

- [ ] **Step 5: Update the mount in server.js**

In `server.js`, replace the card-requests block (lines 380-389):

```js
// Custom card commission requests ("Shop Requests") — signed-in submit, owner-only review.
// Discord doorbell uses the business tickets bot; dedicated channel env falls back to the
// tickets channel so it works with zero new Railway config.
const cardRequests = require('./lib/cardRequests');
cardRequests.initCardRequests({ pgPool }).catch(e => console.error('[cardreq] init error:', e.message));
app.use(require('./routes/cardRequests.routes')({
  requireAuth, requirePlatformAdmin, cardRequests,
  // .trim() the env values — Railway/paste can leave a trailing space/newline, which makes
  // the Discord "Bot <token>" header 401. The working /api/tickets flow trims for the same reason.
  ticketsBotToken: (process.env.DISCORD_TICKETS_BOT_TOKEN || '').trim(),
  channelId: (process.env.DISCORD_SHOP_REQUESTS_CHANNEL_ID || '').trim(),
}));
```

with:

```js
// Custom card commission requests ("Shop Requests") — signed-in submit, owner-only review.
// Posts + phase-updates via the one shared community bot (DISCORD_BOT_TOKEN), same as announcements.
const cardRequests = require('./lib/cardRequests');
cardRequests.initCardRequests({ pgPool }).catch(e => console.error('[cardreq] init error:', e.message));
app.use(require('./routes/cardRequests.routes')({
  requireAuth, requirePlatformAdmin, cardRequests,
  envBotToken: (process.env.DISCORD_BOT_TOKEN || '').trim(),
  channelId: (process.env.DISCORD_SHOP_REQUESTS_CHANNEL_ID || '').trim(),
}));
```

- [ ] **Step 6: Syntax + tests + boot smoke**

```bash
node --check routes/cardRequests.routes.js
node --check server.js
node --test lib/*.test.js
```

Expected: checks silent; lib suite green.

Boot (dummy creds, free port) and confirm the routes still mount + auth-gate:

```bash
PORT=3101 DISCORD_CLIENT_ID=x DISCORD_CLIENT_SECRET=x SESSION_SECRET=x node server.js
```

Second shell:

```bash
curl -s -o /dev/null -w "%{http_code}\n" -X POST http://localhost:3101/api/card-requests -H "Content-Type: application/json" -d '{"idea":"x"}'
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3101/api/admin/card-requests
```

Expected: `401` for both (mounted + gated, not 404). Boot log shows `[cardreq] Loaded ... card requests`. Stop the server.

- [ ] **Step 7: Commit**

```bash
git add routes/cardRequests.routes.js server.js
git commit -m "feat: shop requests post + phase-update via community bot (embed emoji/color per status)"
```

---

### Task 4: Ship — PR, deploy, end-to-end

**Files:** none (git + verification only)

**Interfaces:**
- Consumes: Tasks 1-3.
- Produces: merged to main → Railway deploy → live.

- [ ] **Step 1: Push the branch + open the PR**

```bash
git push -u origin feat/discord-consolidation
gh pr create --title "Consolidate Discord posting onto the one bot: tickets fix + shop-requests phase embed" --body "Points /api/tickets and /api/card-requests at the single real community bot (DISCORD_BOT_TOKEN), retiring the dead DISCORD_TICKETS_BOT_TOKEN that was 401ing. Shop Requests now also edit their own Discord message as the status changes — a phase emoji + embed color track new → awaiting_tip → in_progress → done/declined. Backend-only; no new Railway vars. Spec: docs/superpowers/specs/2026-07-13-card-requests-discord-phase-design.md. Tested: node --test lib/*.test.js green; local boot proves the token swap (tickets) + route mount/auth gates (card requests). Op note: ensure the bot can post in the tickets + suggestions channels (grant if private) — already done for shop-requests."
```

(PR body carries no Claude attribution.)

- [ ] **Step 2: Merge → Railway deploys**

Merge the PR to main. Railway auto-deploys (~1-3 min; sessions reset — log in again). Then verify the merge-base (this repo has dropped commits in merge races before):

```bash
git checkout main && git pull --ff-only
git log --oneline -5   # the three feature commits present under the merge
```

- [ ] **Step 3: Production E2E**

On the live site + Discord:
1. Submit a **ticket** (bug + a Feature Request) via the site form → each posts to its channel (inquiries vs suggestions), no 500.
2. Submit a **card request** from the Shop → embed posts to the shop-requests channel titled `🆕 Custom Card Request` (violet).
3. In Admin → Shop Requests, move that request through statuses → the SAME Discord message updates live: 💰 amber → 🔨 cyan → ✅ green (or ❌ red).
4. Delete the test request from the admin tab; the request row + panel behave regardless of Discord.

---

## Self-review notes

- **Spec coverage:** Part A token swap + comment + env (Task 1); `setDiscordMessage` + persistence + field-preserving update (Task 2); community-bot switch, channel var (no fallback), PHASE_META table, capture-on-post, edit-on-PUT, server.js mount (Task 3); env deprecation note (Task 1 for tickets block, Task 3 comment for shop-requests); tests + E2E (Tasks 2/4). Out-of-scope items untouched.
- **Type consistency:** `setDiscordMessage(id, { messageId, channelId })` signature identical in Task 2 (definition) and Task 3 (call). `envBotToken` / `channelId` deps match between the server.js mount (Task 3 step 5) and the route destructure (Task 3 step 2). `PHASE_META` keys equal the backend status enum + the frontend `STATUS_META` keys.
- **Deferred contract:** tickets keep the existing 500-on-failure behavior (spec: unchanged); only the token source changes.
