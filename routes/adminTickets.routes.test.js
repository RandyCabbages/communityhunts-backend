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

// Records every audit write so tests can assert the triage action is logged. The router calls
// auditLog.recordFromReq unconditionally on a successful PUT — omitting it from deps threw
// "Cannot read properties of undefined (reading 'recordFromReq')" and failed both PUT tests for
// a reason that had nothing to do with what they were testing.
function fakeAuditLog() {
  const entries = [];
  return { entries, recordFromReq: (req, entry) => { entries.push(entry); } };
}

function appWith({ tickets, admin = true, platformToken = 'ptok', auditLog = fakeAuditLog() } = {}) {
  const app = express();
  app.use(express.json());
  // The router reads req.user.displayName when writing the audit entry, so the stub has to
  // populate req.user the way the real requireAuth does.
  const requireAuth = (req, res, next) => { req.user = { id: '135203806676779008', displayName: 'admin' }; next(); };
  const requirePlatformAdmin = admin ? (req, res, next) => next() : (req, res, next) => res.status(403).json({ error: 'forbidden' });
  app.use(adminTicketsRoutes({ requireAuth, requirePlatformAdmin, tickets, getPlatformBotToken: () => platformToken, auditLog }));
  app.auditLog = auditLog;
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
    // fetch() keeps its sockets alive, and server.close() only stops NEW connections — it waits
    // forever for idle keep-alive ones to drain. That is why this suite hung and made the whole
    // `node --test routes/*.test.js` run look broken; every other route suite is fine.
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
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
