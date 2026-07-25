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
