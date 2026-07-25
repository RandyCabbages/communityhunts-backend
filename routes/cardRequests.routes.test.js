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
// Discord GET /users/{id} — the id-existence probe. `throws` simulates an unreachable Discord.
const LOOKUP_OK = { status: 200, body: { id: '168055630916091904', username: 'goofer', global_name: 'Goofer', avatar: 'abc' } };
let userLookup = LOOKUP_OK;
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
beforeEach(() => { discordCalls = []; sendResponse = { ok: true, status: 200 }; userLookup = LOOKUP_OK; });

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
    setDmChannel: (id, { channelId, watermark } = {}) => {
      const r = list.find(x => x.id === id);
      if (!r) return null;
      if (channelId) r.dmChannelId = String(channelId);
      if (watermark) r.dmWatermark = String(watermark);
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

async function getRequests(app) {
  const server = await new Promise(resolve => { const s = app.listen(0, () => resolve(s)); });
  try {
    const r = await realFetch(`http://127.0.0.1:${server.address().port}/api/admin/card-requests`);
    return { status: r.status, body: await r.json().catch(() => null) };
  } finally {
    server.close();
  }
}

test('GET returns the card requests list', async () => {
  const app = appWith({ requests: [{ ...REQ }] });
  const r = await getRequests(app);
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.requests.length, 1, 'requests returned');
});

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

// --- POST /api/admin/card-requests — an owner files on behalf of a DM'd requester ------------
// The id must be PROVEN before anything is written; there is deliberately no placeholder path.

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
