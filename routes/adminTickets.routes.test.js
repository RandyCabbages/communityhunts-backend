// GET/PUT/DELETE /api/admin/tickets — platform-admin triage router.
// Tickets are PLATFORM-level: the phase-embed PATCH uses the platform bot (getPlatformBotToken).
const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert');
const express = require('express');

const adminTicketsRoutes = require('./adminTickets.routes');

// Stub global fetch to capture the Discord PATCH; keep the real one for local requests.
const realFetch = global.fetch;
let discordCalls = [];
global.fetch = async (url, opts) => {
  discordCalls.push({ url: String(url), opts });
  return { ok: true, json: async () => ({}), text: async () => '' };
};
after(() => { global.fetch = realFetch; });
beforeEach(() => { discordCalls = []; });

function fakeTickets(initial) {
  const list = initial.slice();
  return {
    listTickets: () => list,
    validateUpdate: (patch) =>
      (patch.status !== undefined && !['new', 'in_progress', 'resolved', 'closed'].includes(patch.status))
        ? 'Invalid status' : null,
    updateTicket: (id, patch) => {
      const t = list.find(x => x.id === id);
      if (!t) return null;
      Object.assign(t, patch);
      return t;
    },
    deleteTicket: (id) => {
      const i = list.findIndex(x => x.id === id);
      if (i === -1) return false;
      list.splice(i, 1);
      return true;
    },
  };
}

function appWith({ tickets, admin = true, platformToken = 'ptok' } = {}) {
  const app = express();
  app.use(express.json());
  const requireAuth = (req, res, next) => next();
  const requirePlatformAdmin = admin ? (req, res, next) => next() : (req, res, next) => res.status(403).json({ error: 'forbidden' });
  app.use(adminTicketsRoutes({ requireAuth, requirePlatformAdmin, tickets, getPlatformBotToken: () => platformToken }));
  return app;
}

async function req(app, method, pathname, body) {
  const server = await new Promise(resolve => { const s = app.listen(0, () => resolve(s)); });
  try {
    const r = await realFetch(`http://127.0.0.1:${server.address().port}${pathname}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    const out = { status: r.status, body: await r.json().catch(() => null) };
    await new Promise(res => setImmediate(res)); // let the post-response embed PATCH fire
    return out;
  } finally {
    server.close();
  }
}

test('GET /api/admin/tickets returns the stored list', async () => {
  const app = appWith({ tickets: fakeTickets([{ id: 't1', type: 'Bug', issue: 'x', status: 'new' }]) });
  const r = await req(app, 'GET', '/api/admin/tickets');
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.tickets.length, 1);
  assert.strictEqual(r.body.tickets[0].id, 't1');
});

test('PUT updates status and PATCHes the Discord embed when a message id exists', async () => {
  const app = appWith({ tickets: fakeTickets([
    { id: 't1', type: 'Bug', issue: 'x', status: 'new', displayName: 'A', userId: '1',
      discordMessageId: 'm1', discordChannelId: 'c1' },
  ]) });
  const r = await req(app, 'PUT', '/api/admin/tickets/t1', { status: 'in_progress' });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.status, 'in_progress');
  assert.strictEqual(discordCalls.length, 1);
  assert.strictEqual(discordCalls[0].opts.method, 'PATCH');
  assert.match(discordCalls[0].url, /\/channels\/c1\/messages\/m1$/);
  assert.strictEqual(discordCalls[0].opts.headers.Authorization, 'Bot ptok');
});

test('PUT skips Discord when the ticket has no stored message id', async () => {
  const app = appWith({ tickets: fakeTickets([{ id: 't1', type: 'Bug', issue: 'x', status: 'new' }]) });
  const r = await req(app, 'PUT', '/api/admin/tickets/t1', { status: 'resolved' });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(discordCalls.length, 0);
});

test('PUT with an invalid status → 400', async () => {
  const app = appWith({ tickets: fakeTickets([{ id: 't1', status: 'new' }]) });
  const r = await req(app, 'PUT', '/api/admin/tickets/t1', { status: 'bogus' });
  assert.strictEqual(r.status, 400);
});

test('PUT on a missing ticket → 404', async () => {
  const app = appWith({ tickets: fakeTickets([]) });
  const r = await req(app, 'PUT', '/api/admin/tickets/nope', { status: 'closed' });
  assert.strictEqual(r.status, 404);
});

test('DELETE removes; missing → 404', async () => {
  const app = appWith({ tickets: fakeTickets([{ id: 't1' }]) });
  assert.strictEqual((await req(app, 'DELETE', '/api/admin/tickets/t1')).status, 200);
  assert.strictEqual((await req(app, 'DELETE', '/api/admin/tickets/t1')).status, 404);
});

test('non-platform-admin is blocked (403)', async () => {
  const app = appWith({ tickets: fakeTickets([{ id: 't1' }]), admin: false });
  assert.strictEqual((await req(app, 'GET', '/api/admin/tickets')).status, 403);
});
