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

function makeApp({ hunts = {}, archive = [], tenant, requireApiFeature } = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    req.apiTenant = tenant || { id: TENANT, slug: TENANT };
    req.apiTenantId = TENANT;
    req.apiTier = 'pro';
    req.apiScopes = ['read', 'write'];
    next();
  });
  app.use(publicRoutes({
    requireApiKey: pass, requireApiFeature: requireApiFeature || (() => pass), requireApiScope: () => pass,
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

// ── selection: owner, huntType, view ──────────────────────────────────────────────────────────
// A consumer showing ONE streamer's hunts had no way to select them: nothing on a hunt identified
// an owner, and `?huntType=` was silently ignored — including `?huntType=bogus`, which answered
// 200 with the entire community's hunts. The filter looked like it worked and the board was wrong.

function archivedHunt(over = {}) {
  return { ...liveHunt(), huntId: 'h_arch', isLive: false,
    archivedAt: '2026-07-20T12:00:00.000Z', ...over };
}

const ownerIdOf = h => serializers.publicOwner(h).id;

test('GET /hunts filters by huntType, and counts only what matched', async () => {
  const hunts = {
    '111': liveHunt({ huntId: 'h_a', huntType: 'community' }),
    '222': liveHunt({ huntId: 'h_b', huntType: 'solo', user: { id: '222', displayName: 'Solo' } }),
  };
  await withServer(makeApp({ hunts }), async base => {
    const r = await get(base, '/api/public/v1/hunts?huntType=solo');
    const body = await r.json();
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(body.data.map(h => h.id), ['h_b']);
    // total is what MATCHED, not what existed — otherwise a consumer pages through empty results.
    assert.strictEqual(body.pagination.total, 1);
  });
});

test('GET /hunts accepts a comma-separated huntType list', async () => {
  const hunts = {
    '111': liveHunt({ huntId: 'h_a', huntType: 'community' }),
    '222': liveHunt({ huntId: 'h_b', huntType: 'solo', user: { id: '222', displayName: 'Solo' } }),
  };
  await withServer(makeApp({ hunts }), async base => {
    const body = await (await get(base, '/api/public/v1/hunts?huntType=solo,community')).json();
    assert.strictEqual(body.data.length, 2);
  });
});

test('GET /hunts REJECTS an unrecognised huntType instead of returning everything', async () => {
  // The exact reported failure: `?huntType=bogus` used to answer 200 with all 322 hunts.
  const hunts = { '111': liveHunt() };
  await withServer(makeApp({ hunts }), async base => {
    const r = await get(base, '/api/public/v1/hunts?huntType=bogus');
    assert.strictEqual(r.status, 400);
    assert.strictEqual((await r.json()).error.code, 'invalid_hunt_type');
  });
});

test('GET /hunts REJECTS an unknown query parameter instead of ignoring it', async () => {
  const hunts = { '111': liveHunt() };
  await withServer(makeApp({ hunts }), async base => {
    // `type` is the plausible near-miss a consumer actually wrote.
    const r = await get(base, '/api/public/v1/hunts?type=community');
    assert.strictEqual(r.status, 400);
    const body = await r.json();
    assert.strictEqual(body.error.code, 'unknown_param');
    assert.ok(body.error.message.includes('type'), 'the message must name the offending param');
  });
});

test('GET /hunts filters by ownerId, and an unknown owner is an empty list not an error', async () => {
  const mine = liveHunt({ huntId: 'h_a' });
  const theirs = liveHunt({ huntId: 'h_b', user: { id: '999', displayName: 'Someone Else' } });
  await withServer(makeApp({ hunts: { '111': mine, '999': theirs } }), async base => {
    const body = await (await get(base, `/api/public/v1/hunts?ownerId=${ownerIdOf(mine)}`)).json();
    assert.deepStrictEqual(body.data.map(h => h.id), ['h_a']);
    assert.strictEqual(body.data[0].owner.id, ownerIdOf(mine));

    const none = await get(base, '/api/public/v1/hunts?ownerId=usr_nosuchowner');
    assert.strictEqual(none.status, 200);
    assert.deepStrictEqual((await none.json()).data, []);
  });
});

test('the ownerId a consumer filters on is the one the response hands back', async () => {
  // Round-trip: read an owner off a hunt, feed it straight back as the filter. If these two ever
  // derive the id differently, filtering silently returns nothing and looks like "no hunts".
  const hunts = { '111': liveHunt() };
  await withServer(makeApp({ hunts }), async base => {
    const first = (await (await get(base, '/api/public/v1/hunts')).json()).data[0];
    const again = await (await get(base, `/api/public/v1/hunts?ownerId=${first.owner.id}`)).json();
    assert.strictEqual(again.data.length, 1);
    assert.strictEqual(again.data[0].id, first.id);
  });
});

test('GET /hunts?view=summary omits bonuses, calls and equity', async () => {
  const hunts = { '111': liveHunt({ calls: [{ slot: 'A', user: 'x', status: 'in' }] }) };
  await withServer(makeApp({ hunts }), async base => {
    const body = await (await get(base, '/api/public/v1/hunts?view=summary')).json();
    const row = body.data[0];
    assert.ok(!('bonuses' in row) && !('calls' in row) && !('equity' in row));
    assert.strictEqual(row.bonusCount, 1);   // the count survives; the array does not
    assert.ok(row.owner.id);
  });
});

test('the default view is still full — summary is opt-in', async () => {
  const hunts = { '111': liveHunt() };
  await withServer(makeApp({ hunts }), async base => {
    const row = (await (await get(base, '/api/public/v1/hunts')).json()).data[0];
    assert.ok(Array.isArray(row.bonuses) && Array.isArray(row.calls) && Array.isArray(row.equity));
  });
});

test('GET /hunts rejects an unrecognised view', async () => {
  await withServer(makeApp({ hunts: { '111': liveHunt() } }), async base => {
    const r = await get(base, '/api/public/v1/hunts?view=tiny');
    assert.strictEqual(r.status, 400);
    assert.strictEqual((await r.json()).error.code, 'invalid_view');
  });
});

test('filters compose with status, and the summary ETag still revalidates', async () => {
  const hunts = { '111': liveHunt({ huntId: 'h_a' }) };
  const archive = [archivedHunt({ user: { id: '111', displayName: 'Runner' } })];
  await withServer(makeApp({ hunts, archive }), async base => {
    const path = '/api/public/v1/hunts?status=archived&huntType=community&view=summary';
    const r1 = await get(base, path);
    const body = await r1.json();
    assert.deepStrictEqual(body.data.map(h => h.id), ['h_arch']);

    const r2 = await get(base, path, { 'If-None-Match': r1.headers.get('etag') });
    assert.strictEqual(r2.status, 304);
    assert.strictEqual((await r2.text()).length, 0);
  });
});

test('GET /hunts/:id rejects an unknown param too', async () => {
  await withServer(makeApp({ hunts: { '111': liveHunt() } }), async base => {
    const r = await get(base, '/api/public/v1/hunts/h_live?expand=all');
    assert.strictEqual(r.status, 400);
    assert.strictEqual((await r.json()).error.code, 'unknown_param');
  });
});

// ── GET /me ───────────────────────────────────────────────────────────────────────────────────
// The endpoint that replaces the conversation every new tenant currently needs. What matters here
// is the WIRING (the payload itself is pinned in lib/apiIdentity.test.js): that it is reachable on
// a plan the rest of the API refuses, that it revalidates like the other reads, and that it still
// rejects a stray parameter.

const RICH_TENANT = {
  id: TENANT, slug: TENANT, displayName: 'Acme Slots',
  hostDiscordId: '110983319176384512', branding: { hostName: 'Dave' },
};

test('GET /me answers the questions an integrator otherwise has to ask a human', async () => {
  await withServer(makeApp({ tenant: RICH_TENANT }), async base => {
    const r = await get(base, '/api/public/v1/me');
    assert.strictEqual(r.status, 200);
    const { data } = await r.json();
    assert.strictEqual(data.community.slug, TENANT);
    assert.strictEqual(data.community.name, 'Acme Slots');
    assert.strictEqual(data.streamer.name, 'Dave');
    assert.ok(data.streamer.id.startsWith('usr_'));
    assert.deepStrictEqual(data.houseHuntTypes, ['streamer', 'vip', 'affiliate']);
    assert.strictEqual(Object.keys(data.houseOwnerIds).length, 3);
    assert.strictEqual(data.key.tier, 'pro');
    // The limits reported must be the ones this router actually enforces.
    const { LIMITS } = require('../lib/rateLimit');
    assert.strictEqual(data.key.rateLimit.readPerMin, LIMITS.pro.perMin);
    // A raw Discord id must never leave this API — /me included.
    assert.ok(!JSON.stringify(data).includes('110983319176384512'));
  });
});

test('GET /me is NOT tier-gated — the moment you most need to be told your tier', async () => {
  const deny = () => (req, res) =>
    res.status(403).json({ error: { code: 'forbidden_tier', message: 'nope' } });
  await withServer(makeApp({ tenant: RICH_TENANT, requireApiFeature: deny }), async base => {
    assert.strictEqual((await get(base, '/api/public/v1/hunts')).status, 403);
    assert.strictEqual((await get(base, '/api/public/v1/me')).status, 200);
  });
});

test('GET /me revalidates and rejects an unknown param', async () => {
  await withServer(makeApp({ tenant: RICH_TENANT }), async base => {
    const r1 = await get(base, '/api/public/v1/me');
    assert.strictEqual(r1.headers.get('cache-control'), 'private, no-cache');
    const r2 = await get(base, '/api/public/v1/me', { 'If-None-Match': r1.headers.get('etag') });
    assert.strictEqual(r2.status, 304);

    const r3 = await get(base, '/api/public/v1/me?verbose=1');
    assert.strictEqual(r3.status, 400);
    assert.strictEqual((await r3.json()).error.code, 'unknown_param');
  });
});
