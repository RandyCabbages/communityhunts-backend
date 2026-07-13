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
