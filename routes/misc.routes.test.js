// POST /api/tickets — Discord bot token resolution + persistence.
// Tickets are PLATFORM-level: they post to communityhunts.gg's own channels and must always use
// the PLATFORM bot (getPlatformBotToken), NEVER req.tenant.discordBotToken — which, for a ticket
// from a streamer's hub, is that streamer's own community bot (→ 403 on our channels).
// The endpoint now persists the ticket FIRST, then posts to Discord best-effort (a Discord
// failure never fails the submit — the store is the source of truth).
process.env.DISCORD_TICKETS_CHANNEL_ID = '111';
process.env.DISCORD_SUGGESTIONS_CHANNEL_ID = '222';

const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert');
const express = require('express');

const miscRoutes = require('./misc.routes');

// Stub global fetch to capture the Discord call; keep the real one for local requests.
// `discordResponse` lets a test simulate Discord accepting (200 + message id) or rejecting (401).
const realFetch = global.fetch;
let discordCalls = [];
let discordResponse = { ok: true, status: 200, body: { id: 'disc-msg-1' } };
global.fetch = async (url, opts) => {
  discordCalls.push({ url: String(url), opts });
  return { ok: discordResponse.ok, status: discordResponse.status, json: async () => discordResponse.body, text: async () => '' };
};
after(() => { global.fetch = realFetch; });
beforeEach(() => {
  discordCalls = [];
  discordResponse = { ok: true, status: 200, body: { id: 'disc-msg-1' } };
});

// Minimal in-memory tickets stub recording createTicket / setDiscordMessage calls.
function fakeTickets() {
  const created = [];
  const msgs = [];
  return {
    created, msgs,
    createTicket: (fields, user) => {
      const t = { id: `tk_${created.length}`, ...fields, userId: user ? String(user.id) : null };
      created.push({ fields, user, t });
      return t;
    },
    setDiscordMessage: (id, ids) => { msgs.push({ id, ids }); },
  };
}

// Mount the router with an injectable platform-token resolver, tickets store, + optional req.tenant.
// trust proxy is on so each request can present a unique client IP via X-Forwarded-For — the
// per-IP ticket throttle is a module-level Map that would otherwise leak across tests.
function appWith({ tenant, platformToken = 'platform-token' } = {}) {
  const app = express();
  app.set('trust proxy', true);
  const tickets = fakeTickets();
  app.use(express.json());
  app.use((req, res, next) => { if (tenant) req.tenant = tenant; next(); });
  app.use(miscRoutes({ hunts: {}, archive: [], tickets, getPlatformBotToken: () => platformToken }));
  app._tickets = tickets;
  return app;
}

let ipCounter = 0;
async function postTicket(app, body) {
  const ip = `10.0.0.${++ipCounter}`; // unique per call → never trips the per-IP throttle
  const server = await new Promise(resolve => { const s = app.listen(0, () => resolve(s)); });
  try {
    const r = await realFetch(`http://127.0.0.1:${server.address().port}/api/tickets`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': ip },
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

test('a Bug submit persists the ticket, posts (discord: posted), and captures the message id', async () => {
  const app = appWith({ tenant: null });
  const r = await postTicket(app, { username: 'tester', issue: 'reel froze', type: 'Bug' });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.ok, true);
  assert.strictEqual(r.body.discord, 'posted');
  // Persisted first with the right routing.
  const created = app._tickets.created;
  assert.strictEqual(created.length, 1);
  assert.strictEqual(created[0].fields.type, 'Bug');
  assert.strictEqual(created[0].fields.discordChannel, 'tickets');
  assert.strictEqual(created[0].fields.issue, 'reel froze');
  // Message id captured for later phase edits.
  assert.strictEqual(app._tickets.msgs.length, 1);
  assert.strictEqual(app._tickets.msgs[0].ids.messageId, 'disc-msg-1');
  assert.strictEqual(app._tickets.msgs[0].ids.channelId, '111');
});

test('feature requests post with the platform token to the suggestions channel + persist as suggestions', async () => {
  const app = appWith({ tenant: null });
  const r = await postTicket(app, { username: 'tester', issue: 'idea', type: 'Feature Request' });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(discordCalls[0].opts.headers.Authorization, 'Bot platform-token');
  assert.match(discordCalls[0].url, /\/channels\/222\/messages$/); // Feature Request → suggestions
  assert.strictEqual(app._tickets.created[0].fields.discordChannel, 'suggestions');
});

test('BEST-EFFORT: a Discord 401 still stores the ticket and returns 200 (discord: failed)', async () => {
  discordResponse = { ok: false, status: 401, body: {} };
  const app = appWith({ tenant: null });
  const r = await postTicket(app, { username: 'tester', issue: 'hi', type: 'Bug' });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.discord, 'failed');
  assert.strictEqual(app._tickets.created.length, 1); // still persisted
  assert.strictEqual(app._tickets.msgs.length, 0);     // no message id captured
});

test('no platform bot token → stores the ticket and skips Discord (200, discord: skipped)', async () => {
  const app = appWith({ tenant: null, platformToken: '' });
  const r = await postTicket(app, { username: 'tester', issue: 'hi', type: 'Bug' });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.discord, 'skipped');
  assert.strictEqual(app._tickets.created.length, 1); // still persisted
  assert.strictEqual(discordCalls.length, 0);
});

test('a logged-out submit persists with a null userId', async () => {
  const app = appWith({ tenant: null });
  await postTicket(app, { username: 'Anonymous', issue: 'anon', type: 'Other' });
  assert.strictEqual(app._tickets.created[0].t.userId, null);
});

// --- Page context from the support launcher (lib/ticketContext.js) ---

test('POST /api/tickets sanitizes context and passes it to createTicket', async () => {
  const app = appWith({ tenant: null });
  const r = await postTicket(app, {
    username: 'Goofer', type: 'Bug', issue: 'bubble overlaps footer',
    context: { route: '/bean/hunt', viewport: { w: 390, h: 844 }, evil: 'drop me' },
  });
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(app._tickets.created[0].fields.context, {
    route: '/bean/hunt', viewport: { w: 390, h: 844 },
  });
});

test('POST /api/tickets without context stores null', async () => {
  const app = appWith({ tenant: null });
  await postTicket(app, { username: 'Goofer', type: 'Bug', issue: 'no ctx' });
  assert.strictEqual(app._tickets.created[0].fields.context, null);
});

test('Discord embed carries a Page field when context has a route', async () => {
  const app = appWith({ tenant: null });
  await postTicket(app, {
    username: 'Goofer', type: 'Bug', issue: 'x',
    context: { route: '/bean/hunt', viewport: { w: 1440, h: 900 } },
  });
  const body = JSON.parse(discordCalls[0].opts.body);
  const page = body.embeds[0].fields.find(f => f.name === 'Page');
  assert.ok(page, 'expected a Page field on the embed');
  assert.strictEqual(page.value, '/bean/hunt · 1440×900');
});

test('Discord embed has no Page field when no context was sent', async () => {
  const app = appWith({ tenant: null });
  await postTicket(app, { username: 'Goofer', type: 'Bug', issue: 'x' });
  const body = JSON.parse(discordCalls[0].opts.body);
  assert.strictEqual(body.embeds[0].fields.find(f => f.name === 'Page'), undefined);
});
