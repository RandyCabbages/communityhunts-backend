// Public Developer API — freshness contract: conditional GET (ETag/304) and the SSE change stream.
//
// The auth/tier/rate-limit middleware is stubbed to pass-through here on purpose; those gates have
// their own suites (lib/apiKeys.test.js, lib/rateLimit.test.js). What is pinned below is the part
// a consumer's live board depends on and that is easy to break silently:
//   - `Cache-Control: private, no-cache` — reverting it to `no-store` leaves the ETag INERT
//     (no-store forbids keeping the copy you would revalidate) with no test failing and no error.
//   - the ETag tracking CONTENT, so a write path that forgets to stamp `updatedAt` still busts it.
//   - the stream emitting a bare ping and nothing else.

const { test } = require('node:test');
const assert = require('node:assert');
const express = require('express');

const publicRoutes = require('./public.routes');
const serializers = require('../lib/publicSerializers');

// The real masker is wired in server.js; here it only has to be non-destructive.
serializers._setPublicHuntView(h => ({ ...h }));

const pass = (req, res, next) => next();
const TENANT = 'acme';

function liveHunt(over = {}) {
  return {
    huntId: 'h_live', tenantId: TENANT, user: { id: '111', displayName: 'Runner' },
    huntType: 'community', isLive: true, currency: 'USD',
    createdAt: '2026-07-20T10:00:00.000Z', startedAt: '2026-07-20T10:00:00.000Z',
    updatedAt: '2026-07-20T10:05:00.000Z', archivedAt: null,
    bonuses: [{ slot: 'Le Bandit', bet: 2, win: null }], equity: [], calls: [], ...over,
  };
}

function makeApp({ hunts = {}, archive = [] } = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    req.apiTenant = { id: TENANT, slug: TENANT };
    req.apiTenantId = TENANT;
    req.apiTier = 'pro';
    req.apiScopes = ['read', 'write'];
    next();
  });
  app.use(publicRoutes({
    requireApiKey: pass, requireApiFeature: () => pass, requireApiScope: () => pass,
    rateLimit: pass, writeRateLimit: pass, ipFloor: pass,
    serializers,
    getHuntStats: () => ({ currencies: [], byCurrency: {}, tz: 'UTC' }),
    hunts, archive,
    tenantOf: h => h.tenantId || 'bean',
    huntHasContent: () => true,
    huntCompleted: h => !!h.archivedAt,
    getGotInLog: () => [], collectBangers: () => [],
    archiveHunt: () => {}, auditLog: { record() {} }, isKnownAccount: () => null,
  }));
  return app;
}

// One server per test, torn down in a finally. closeAllConnections() FIRST: fetch keeps its
// sockets alive and server.close() waits forever for idle keep-alive ones to drain — the hang
// documented in adminTickets.routes.test.js.
async function withServer(app, fn) {
  const server = await new Promise(resolve => { const s = app.listen(0, () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    return await fn(base);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
}

const get = (base, path, headers) => fetch(`${base}${path}`, { headers: headers || {} });

// ── conditional GET ───────────────────────────────────────────────────────────────────────────

test('GET /hunts/:id serves an ETag under private,no-cache — NOT no-store', async () => {
  const hunts = { '111': liveHunt() };
  await withServer(makeApp({ hunts }), async base => {
    const r = await get(base, '/api/public/v1/hunts/h_live');
    assert.strictEqual(r.status, 200);
    assert.ok(r.headers.get('etag'), 'no ETag header');
    // The whole point. `no-store` forbids the client from keeping what it would revalidate.
    assert.strictEqual(r.headers.get('cache-control'), 'private, no-cache');
    assert.strictEqual(r.headers.get('vary'), 'Authorization');
  });
});

test('GET /hunts/:id returns 304 with an empty body when If-None-Match matches', async () => {
  const hunts = { '111': liveHunt() };
  await withServer(makeApp({ hunts }), async base => {
    const first = await get(base, '/api/public/v1/hunts/h_live');
    const etag = first.headers.get('etag');
    await first.json();

    const again = await get(base, '/api/public/v1/hunts/h_live', { 'If-None-Match': etag });
    assert.strictEqual(again.status, 304);
    assert.strictEqual(again.headers.get('etag'), etag);
    assert.strictEqual((await again.text()).length, 0);
  });
});

test('a weak or multi-valued If-None-Match still matches', async () => {
  const hunts = { '111': liveHunt() };
  await withServer(makeApp({ hunts }), async base => {
    const etag = (await get(base, '/api/public/v1/hunts/h_live')).headers.get('etag');
    for (const header of [`W/${etag}`, `"stale-one", ${etag}`, '*']) {
      const r = await get(base, '/api/public/v1/hunts/h_live', { 'If-None-Match': header });
      assert.strictEqual(r.status, 304, `expected 304 for If-None-Match: ${header}`);
    }
  });
});

test('the ETag tracks CONTENT, so a change that never stamps updatedAt still busts it', async () => {
  const hunt = liveHunt();
  const hunts = { '111': hunt };
  await withServer(makeApp({ hunts }), async base => {
    const etag = (await get(base, '/api/public/v1/hunts/h_live')).headers.get('etag');

    // Exactly the shape of the admin currency backfill and the janitor: mutate in place, leave
    // `updatedAt` alone. A timestamp-derived validator would 304 here and freeze the board.
    hunt.bonuses.push({ slot: 'Sugar Rush', bet: 2, win: 400 });

    const r = await get(base, '/api/public/v1/hunts/h_live', { 'If-None-Match': etag });
    assert.strictEqual(r.status, 200);
    assert.notStrictEqual(r.headers.get('etag'), etag);
    assert.strictEqual((await r.json()).data.bonuses.length, 2);
  });
});

test('GET /hunts list carries updatedAt per hunt and revalidates as a whole', async () => {
  const hunt = liveHunt();
  await withServer(makeApp({ hunts: { '111': hunt } }), async base => {
    const first = await get(base, '/api/public/v1/hunts?status=live');
    const body = await first.json();
    assert.strictEqual(body.data.length, 1);
    // The cheap polling pattern: one list fetch, then re-fetch only the hunts whose stamp moved.
    assert.strictEqual(body.data[0].updatedAt, '2026-07-20T10:05:00.000Z');

    const etag = first.headers.get('etag');
    assert.strictEqual((await get(base, '/api/public/v1/hunts?status=live', { 'If-None-Match': etag })).status, 304);

    hunt.updatedAt = '2026-07-20T10:06:00.000Z';
    assert.strictEqual((await get(base, '/api/public/v1/hunts?status=live', { 'If-None-Match': etag })).status, 200);
  });
});

test('updatedAt reports the ARCHIVE moment for a hunt that just ended', async () => {
  // archiveHunt() snapshots the hunt and stamps archivedAt on the copy, leaving updatedAt behind.
  // Reporting the stale one would hide the single transition a consumer most needs to see.
  const archived = liveHunt({
    huntId: 'h_done', isLive: false,
    updatedAt: '2026-07-20T10:05:00.000Z', archivedAt: '2026-07-20T11:30:00.000Z',
  });
  await withServer(makeApp({ archive: [archived] }), async base => {
    const body = await (await get(base, '/api/public/v1/hunts/h_done')).json();
    assert.strictEqual(body.data.status, 'archived');
    assert.strictEqual(body.data.updatedAt, '2026-07-20T11:30:00.000Z');
  });
});

test('another tenant\'s hunt is 404 on both the read and the stream', async () => {
  const hunts = { '999': liveHunt({ huntId: 'h_other', tenantId: 'someone-else' }) };
  await withServer(makeApp({ hunts }), async base => {
    assert.strictEqual((await get(base, '/api/public/v1/hunts/h_other')).status, 404);
    assert.strictEqual((await get(base, '/api/public/v1/hunts/h_other/stream')).status, 404);
  });
});

// ── SSE change stream ─────────────────────────────────────────────────────────────────────────

// Read SSE frames until `want` events have arrived (or the stream ends), then abort.
async function readEvents(base, path, want, onFirst) {
  const ac = new AbortController();
  const r = await fetch(`${base}${path}`, { signal: ac.signal });
  assert.strictEqual(r.status, 200);
  assert.match(r.headers.get('content-type'), /^text\/event-stream/);

  const reader = r.body.getReader();
  const dec = new TextDecoder();
  const events = [];
  let buf = '', fired = false;
  try {
    while (events.length < want) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      for (const frame of buf.split('\n\n')) {
        const m = /^event: (\S+)\ndata: (.+)$/m.exec(frame);
        if (m && !events.some(e => e._raw === frame)) events.push({ name: m[1], data: JSON.parse(m[2]), _raw: frame });
      }
      buf = buf.slice(buf.lastIndexOf('\n\n') + 2);
      if (!fired && events.length && onFirst) { fired = true; await onFirst(); }
    }
  } finally {
    ac.abort();
    // Let the server observe the client hang-up and clear its interval before the suite exits.
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  return { events, headers: r.headers };
}

test('the stream pings on connect and again when the hunt changes — ping only, no state', async () => {
  const hunt = liveHunt();
  await withServer(makeApp({ hunts: { '111': hunt } }), async base => {
    const { events, headers } = await readEvents(base, '/api/public/v1/hunts/h_live/stream', 2,
      () => { hunt.bonuses.push({ slot: 'Sugar Rush', bet: 2, win: 400 }); });

    assert.strictEqual(headers.get('x-accel-buffering'), 'no'); // or a proxy buffers every ping
    assert.strictEqual(events.length, 2);
    for (const e of events) {
      assert.strictEqual(e.name, 'hunt.changed');
      assert.strictEqual(e.data.huntId, 'h_live');
      assert.strictEqual(typeof e.data.occurredAt, 'number');
      // Thin by construction: no hunt state means nothing can arrive out of order, which is what
      // makes a duplicate or late ping harmless. Do not enrich this payload.
      assert.deepStrictEqual(Object.keys(e.data).sort(), ['event', 'huntId', 'occurredAt']);
    }
  });
});

test('the stream says hunt.gone and closes when the hunt is deleted', async () => {
  const hunts = { '111': liveHunt() };
  await withServer(makeApp({ hunts }), async base => {
    const { events } = await readEvents(base, '/api/public/v1/hunts/h_live/stream', 2,
      () => { delete hunts['111']; });
    // Silence is indistinguishable from an idle hunt, so the close is announced.
    assert.strictEqual(events[1].name, 'hunt.gone');
  });
});
