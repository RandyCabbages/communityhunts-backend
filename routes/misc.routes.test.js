// POST /api/tickets — Discord bot token resolution.
// The Railway DISCORD_BOT_TOKEN env var has gone stale twice (announcements 2026-07-08,
// tickets 2026-07-13 → prod 401s); the live community-bot token is per-tenant in the DB.
// These tests pin the resolution order: req.tenant.discordBotToken first, env fallback.
process.env.DISCORD_BOT_TOKEN = 'env-fallback-token';
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

// One app per tenant shape; listen on an ephemeral port and hit it with the REAL fetch.
function appWithTenant(tenant) {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { if (tenant) req.tenant = tenant; next(); });
  app.use(miscRoutes({ hunts: {}, archive: [] }));
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

test('tickets post with the tenant DB bot token when present', async () => {
  const app = appWithTenant({ id: 'bean', discordBotToken: 'tenant-db-token' });
  const r = await postTicket(app, { username: 'tester', issue: 'hello', type: 'Bug' });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(discordCalls.length, 1);
  assert.strictEqual(discordCalls[0].opts.headers.Authorization, 'Bot tenant-db-token');
  assert.match(discordCalls[0].url, /\/channels\/111\/messages$/);
});

test('tickets fall back to the env bot token when the tenant has none', async () => {
  const app = appWithTenant(null);
  const r = await postTicket(app, { username: 'tester', issue: 'hello', type: 'Feature Request' });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(discordCalls.length, 1);
  assert.strictEqual(discordCalls[0].opts.headers.Authorization, 'Bot env-fallback-token');
  assert.match(discordCalls[0].url, /\/channels\/222\/messages$/);
});
