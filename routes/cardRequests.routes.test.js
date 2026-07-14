// POST /api/admin/card-requests/:id/dm — manual, best-effort DM to the requester.
// Two Discord calls per send: open the DM channel (POST /users/@me/channels) → post the message.
// A Discord failure is best-effort: HTTP 200 { ok:false }, the outcome recorded via recordDm.
const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert');
const express = require('express');

const cardRequestsRoutes = require('./cardRequests.routes');

// Stub global fetch: first call (open DM channel) returns a channel id; the message POST's
// result is configurable via `sendResponse`. Keep realFetch for the local test server.
const realFetch = global.fetch;
let discordCalls = [];
let sendResponse = { ok: true, status: 200 };
global.fetch = async (url, opts) => {
  const u = String(url);
  discordCalls.push({ url: u, opts });
  if (u.endsWith('/users/@me/channels')) {
    return { ok: true, status: 200, json: async () => ({ id: 'dm-1' }), text: async () => '' };
  }
  return { ok: sendResponse.ok, status: sendResponse.status, json: async () => ({ id: 'm-1' }), text: async () => '' };
};
after(() => { global.fetch = realFetch; });
beforeEach(() => { discordCalls = []; sendResponse = { ok: true, status: 200 }; });

// In-memory cardRequests stub exposing only what the DM route uses.
function fakeCardRequests(initial) {
  const list = initial.slice();
  return {
    _list: list,
    getRequest: (id) => list.find(x => x.id === id) || null,
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

function appWith({ requests = [], admin = true, platformToken = 'ptok' } = {}) {
  const app = express();
  app.use(express.json());
  const requireAuth = (req, res, next) => { req.user = { id: 'admin1', displayName: 'Cabbage' }; next(); };
  const requirePlatformAdmin = admin ? (req, res, next) => next() : (req, res, next) => res.status(403).json({ error: 'forbidden' });
  const cardRequests = fakeCardRequests(requests);
  app.use(cardRequestsRoutes({ requireAuth, requirePlatformAdmin, cardRequests, getPlatformBotToken: () => platformToken, channelId: '999' }));
  app._cardRequests = cardRequests;
  return app;
}

async function postDm(app, id, body) {
  const server = await new Promise(resolve => { const s = app.listen(0, () => resolve(s)); });
  try {
    const r = await realFetch(`http://127.0.0.1:${server.address().port}/api/admin/card-requests/${id}/dm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: r.status, body: await r.json().catch(() => null) };
  } finally {
    server.close();
  }
}

const REQ = { id: 'cr_1', userId: '168055630916091904', displayName: 'Goofer', cardName: 'Doge' };

test('a successful DM opens the channel then posts the message, and records ok:true', async () => {
  const app = appWith({ requests: [{ ...REQ }] });
  const r = await postDm(app, 'cr_1', { message: 'hello there', template: 'awaiting_payment' });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.ok, true);
  // Two Discord calls, in order.
  assert.strictEqual(discordCalls.length, 2);
  assert.match(discordCalls[0].url, /\/users\/@me\/channels$/);
  assert.strictEqual(JSON.parse(discordCalls[0].opts.body).recipient_id, REQ.userId);
  assert.match(discordCalls[1].url, /\/channels\/dm-1\/messages$/);
  assert.strictEqual(JSON.parse(discordCalls[1].opts.body).content, 'hello there');
  assert.strictEqual(discordCalls[1].opts.headers.Authorization, 'Bot ptok');
  // Outcome recorded on the request.
  const stored = app._cardRequests._list[0];
  assert.strictEqual(stored.dmLog.length, 1);
  assert.strictEqual(stored.dmLog[0].ok, true);
  assert.strictEqual(r.body.request.dmLog[0].ok, true);
  // Message text + sender are recorded on the entry.
  assert.strictEqual(stored.dmLog[0].message, 'hello there');
  assert.deepStrictEqual(stored.dmLog[0].by, { id: 'admin1', name: 'Cabbage' });
});

test('a Discord 403 on the message post is best-effort: 200 { ok:false } + recorded failure', async () => {
  sendResponse = { ok: false, status: 403 };
  const app = appWith({ requests: [{ ...REQ }] });
  const r = await postDm(app, 'cr_1', { message: 'hi', template: 'awaiting_payment' });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.ok, false);
  assert.match(r.body.error, /DMs disabled|left the server/i);
  const stored = app._cardRequests._list[0];
  assert.strictEqual(stored.dmLog[0].ok, false);
});

test('an empty message → 400 and makes zero Discord calls', async () => {
  const app = appWith({ requests: [{ ...REQ }] });
  const r = await postDm(app, 'cr_1', { message: '   ' });
  assert.strictEqual(r.status, 400);
  assert.strictEqual(discordCalls.length, 0);
});

test('a message over 2000 chars → 400', async () => {
  const app = appWith({ requests: [{ ...REQ }] });
  const r = await postDm(app, 'cr_1', { message: 'x'.repeat(2001) });
  assert.strictEqual(r.status, 400);
  assert.strictEqual(discordCalls.length, 0);
});

test('an unknown request id → 404, zero Discord calls', async () => {
  const app = appWith({ requests: [] });
  const r = await postDm(app, 'cr_nope', { message: 'hi' });
  assert.strictEqual(r.status, 404);
  assert.strictEqual(discordCalls.length, 0);
});

test('no bot token → 200 { ok:false } "not configured", zero Discord calls', async () => {
  const app = appWith({ requests: [{ ...REQ }], platformToken: '' });
  const r = await postDm(app, 'cr_1', { message: 'hi' });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.ok, false);
  assert.match(r.body.error, /not configured/i);
  assert.strictEqual(discordCalls.length, 0);
});

test('a non-platform-admin is blocked (403)', async () => {
  const app = appWith({ requests: [{ ...REQ }], admin: false });
  const r = await postDm(app, 'cr_1', { message: 'hi' });
  assert.strictEqual(r.status, 403);
});
