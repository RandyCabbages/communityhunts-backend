// Public Developer API — key-authed, tier-gated, rate-limited, stable serializers.
// Mounted AFTER resolveTenant in server.js (with the other DI routers): requireApiKey derives
// the tenant from the KEY and overrides req.tenant, so tenant never comes from a header here.

const express = require('express');
const crypto = require('crypto');
// Anonymous-host masking, required by collectBangers. Required directly rather than injected,
// matching routes/misc.routes.js — the twin call site for the same rail.
const { shouldMaskIdentity } = require('../lib/settings');
const { validateImport, buildImportedHunt } = require('../lib/huntImport');
// The public `huntType` vocabulary + the function that derives it. Required directly rather than
// injected for the same reason shouldMaskIdentity above is: the filter must use the very same
// derivation the serializer does, and a second copy is how a filter starts disagreeing with the
// field it filters on.
const { PUBLIC_HUNT_CATEGORIES, huntCategoryOf } = require('../lib/hunts-core');
const { vetEquityIdentity } = require('../lib/identityWrites');
// The self-description payload + the rate-limit tables it reports. Required directly rather than
// injected for the same reason as the two above: `/me` must describe the limits this router
// actually enforces, and a second copy is how the documented ceiling drifts from the real one.
const { buildApiMe } = require('../lib/apiIdentity');
const { LIMITS, WRITE_LIMITS } = require('../lib/rateLimit');

// ── Query parameters ──────────────────────────────────────────────────────────────────────────
// Unknown params used to be ignored in silence, which is the worst of the three options: a
// consumer writing the obvious `?huntType=community` filter got a confident 200 carrying every
// hunt in the community, shipped it, and displayed the wrong data. There was no error, no warning,
// and the response looked right. `?huntType=bogus` did the same. A 400 costs one integration one
// clear message; silence costs every integration a wrong board.
//
// Applied per route with that route's own allowlist, so a param can never be accepted on an
// endpoint that doesn't read it.
function allowParams(...allowed) {
  const ok = new Set(allowed);
  return (req, res, next) => {
    const unknown = Object.keys(req.query).filter(k => !ok.has(k));
    if (unknown.length) {
      return res.status(400).json({ error: { code: 'unknown_param',
        message: `Unknown query parameter(s): ${unknown.join(', ')}. This endpoint accepts: ${allowed.join(', ') || '(none)'}` } });
    }
    next();
  };
}

// A single value or a comma-separated list. Empty entries are dropped rather than treated as a
// value, so a trailing comma is forgiving; an unrecognised value is not.
function parseList(raw) {
  return String(raw).split(',').map(s => s.trim()).filter(Boolean);
}

function paginate(req) {
  let limit = parseInt(req.query.limit, 10); if (!Number.isFinite(limit) || limit <= 0) limit = 25;
  limit = Math.min(limit, 100);
  let offset = parseInt(req.query.offset, 10); if (!Number.isFinite(offset) || offset < 0) offset = 0;
  return { limit, offset };
}

// ── Conditional GET ───────────────────────────────────────────────────────────────────────────
// A live board has to stay current, and the only way to do that here was to re-fetch the whole
// hunt on a timer. Roughly 12-20x of those fetches return bytes identical to the last one.
//
// The validator is derived from the CONTENT, not from a timestamp. Several write paths mutate a
// hunt without stamping `updatedAt` — the admin currency backfill rewrites archived entries in
// place, for one — and a timestamp validator would serve a 304 for a hunt that really did change.
// Hashing costs one sha1 over one already-serialized hunt; being wrong costs a stale board on
// stream.
function etagOf(body) {
  return `"${crypto.createHash('sha1').update(body).digest('base64url')}"`;
}

// RFC 9110: If-None-Match is a comma-separated list, and entries may carry the `W/` weak marker.
// We only ever mint our own tags, so comparing the opaque part is enough.
function ifNoneMatchHits(header, etag) {
  if (!header) return false;
  if (header.trim() === '*') return true;
  const bare = t => t.trim().replace(/^W\//, '');
  return header.split(',').some(t => bare(t) === bare(etag));
}

// Send JSON under a revalidation contract: 304 (no body) when the caller already holds this exact
// representation.
//
// `private, no-cache` is what makes this work AT ALL, and it replaced `no-store` here. `no-store`
// forbids the client from keeping the copy it would later revalidate, so an ETag under it is
// inert. `no-cache` means "keep it, but always revalidate before use" — which is the actual
// requirement. `private` is retained from the old header for the same reason it was set: these
// bodies are per-tenant and must never be held by a shared cache (with `Vary: Authorization`
// as the belt to that suspenders).
function sendRevalidatable(req, res, payload) {
  const body = JSON.stringify(payload);
  const etag = etagOf(body);
  res.set('ETag', etag);
  res.set('Cache-Control', 'private, no-cache');
  if (ifNoneMatchHits(req.headers['if-none-match'], etag)) return res.status(304).end();
  return res.type('application/json').send(body);
}

// Find one hunt by public id within a tenant. Scans in place rather than building
// `[...Object.values(hunts), ...archive]` per request, which copied every live hunt AND the whole
// archive (283 entries in production) to locate one id. First match wins; no index to keep in
// sync with the ~25 call sites that mutate those two containers.
function findHunt(hunts, archive, tenantOf, id, tid) {
  for (const k of Object.keys(hunts)) {
    const h = hunts[k];
    if (h && h.huntId === id && tenantOf(h) === tid) return h;
  }
  for (const h of archive) {
    if (h && h.huntId === id && tenantOf(h) === tid) return h;
  }
  return null;
}

module.exports = function publicRoutes(deps) {
  const {
    requireApiKey, requireApiFeature, requireApiScope, rateLimit, writeRateLimit, ipFloor,
    serializers, getHuntStats, hunts, archive, tenantOf,
    huntHasContent, huntCompleted,
    getGotInLog, collectBangers,
    archiveHunt, auditLog, isKnownAccount,
  } = deps;
  const router = express.Router();

  // Own CORS: open to any origin, NO credentials (Bearer-key auth, no cookies). Path-scoped —
  // this router is mounted app-wide (server.js), so an unscoped `router.use` would run on every
  // request in the app and clobber the global cors() headers on unrelated routes.
  router.use('/api/public/v1', (req, res, next) => {
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Authorization,Content-Type');
    // ACAO:* + ACAC:true is an invalid combination (browsers reject it). The global CORS
    // middleware now skips /api/public/* entirely (server.js), but strip defensively in case
    // something upstream ever sets it again.
    res.removeHeader('Access-Control-Allow-Credentials');
    // Every response here varies by the KEY, and the key is the Authorization header — so the
    // URL alone is NOT a safe cache key. Without this, a shared cache (a CDN or gateway in front
    // of the service, a customer's reverse proxy) can store one community's /stats or /bangers
    // and serve it to another community's request. Set once here so no future route can forget.
    res.set('Vary', 'Authorization');
    if (req.method === 'OPTIONS') return res.status(204).end();
    next();
  });

  // Every route: key → rate limit → (tier) → handler.
  // ipFloor runs BEFORE requireApiKey deliberately: rateLimit keys off the tenant resolved from
  // the key, so without this a request carrying an invalid key is metered by nothing at all.
  router.use('/api/public/v1', ipFloor, requireApiKey, rateLimit);

  // Who am I, and what is this community? Deliberately NOT behind requireApiFeature: every other
  // endpoint answers `403 forbidden_tier` on a plan that doesn't include the API, and the one
  // moment a consumer most needs to be told their tier is exactly then. It exposes nothing the
  // key holder doesn't already hold.
  router.get('/api/public/v1/me', allowParams(), (req, res) => {
    return sendRevalidatable(req, res, { data: buildApiMe({
      tenant: req.apiTenant,
      tier: req.apiTier,
      scopes: req.apiScopes,
      limits: LIMITS,
      writeLimits: WRITE_LIMITS,
    }) });
  });

  router.get('/api/public/v1/hunts', requireApiFeature('developer_api'),
    allowParams('status', 'huntType', 'ownerId', 'view', 'limit', 'offset'), (req, res) => {
    const tid = req.apiTenantId;
    const status = req.query.status === undefined ? 'all' : String(req.query.status);
    if (!['live', 'archived', 'all'].includes(status)) {
      return res.status(400).json({ error: { code: 'invalid_status', message: 'status must be one of: live, archived, all' } });
    }
    let types = null;
    if (req.query.huntType !== undefined) {
      types = parseList(req.query.huntType);
      const bad = types.filter(t => !PUBLIC_HUNT_CATEGORIES.includes(t));
      if (!types.length || bad.length) {
        return res.status(400).json({ error: { code: 'invalid_hunt_type',
          message: `huntType must be one or more of: ${PUBLIC_HUNT_CATEGORIES.join(', ')} (comma-separated)` } });
      }
    }
    const view = req.query.view === undefined ? 'full' : String(req.query.view);
    if (!['full', 'summary'].includes(view)) {
      return res.status(400).json({ error: { code: 'invalid_view', message: 'view must be one of: full, summary' } });
    }
    const ownerId = req.query.ownerId === undefined ? null : String(req.query.ownerId);
    let list = [];
    // Mirrors lib/hunts-core.js getPublicHunts/getArchivedHunts, applied to the raw hunt objects
    // (not huntSummary — serializers.publicHunt needs the full hunt), with ONE deliberate
    // difference: the hub filter also excludes the shared Mod/Affiliate hunts, and this does not.
    //
    // Those two are hidden from the PUBLIC hub because it's an open web page. The API is not:
    // requireApiKey derives the tenant from the key and overwrites req.tenant, so a key can only
    // ever reach its own community's hunts. A host asking their own API for their own affiliate
    // hunt is exactly the intended use — that was the streaming team's ask.
    //
    // Keep the rest in sync with hunts-core.js by hand; do not call getPublicHunts/
    // getArchivedHunts directly here.
    if (status === 'live' || status === 'all') {
      list = list.concat(Object.values(hunts).filter(h =>
        h.isLive && huntHasContent(h) && !huntCompleted(h) && tenantOf(h) === tid));
    }
    if (status === 'archived' || status === 'all') {
      list = list.concat(archive.filter(h => tenantOf(h) === tid && huntCompleted(h)));
    }
    // Filters run BEFORE pagination, so `pagination.total` counts what matched rather than what
    // existed — a consumer paging an owner's hunts would otherwise walk mostly-empty pages.
    // Both compare against the same serializer the response uses, so "what you filter on" and
    // "what you read back" cannot disagree.
    if (types) {
      const want = new Set(types);
      // huntCategoryOf, not `serializers.publicHunt(h).huntType` — the latter would serialize every
      // bonus, call and equity row of every hunt in the community to read one string off the result.
      list = list.filter(h => want.has(huntCategoryOf(h) || 'community'));
    }
    if (ownerId) {
      list = list.filter(h => {
        const o = serializers.publicOwner(h);
        return o && o.id === ownerId;
      });
    }
    list.sort((a, b) => new Date(b.archivedAt || b.startedAt || 0) - new Date(a.archivedAt || a.startedAt || 0));
    const { limit, offset } = paginate(req);
    const shape = view === 'summary' ? serializers.publicHuntSummary : serializers.publicHunt;
    const page = list.slice(offset, offset + limit).map(shape);
    // Every entry carries `updatedAt`, so the intended cheap pattern is: poll THIS endpoint, then
    // re-fetch only the hunts whose stamp moved. The conditional GET makes the poll itself nearly
    // free when nothing moved at all.
    return sendRevalidatable(req, res, { data: page, pagination: { limit, offset, total: list.length } });
  });

  router.get('/api/public/v1/hunts/:id', requireApiFeature('developer_api'), allowParams(), (req, res) => {
    const tid = req.apiTenantId, id = req.params.id;
    const found = findHunt(hunts, archive, tenantOf, id, tid);
    if (!found) return res.status(404).json({ error: { code: 'not_found', message: 'Hunt not found' } });
    return sendRevalidatable(req, res, { data: serializers.publicHunt(found) });
  });

  // ── Live change stream (SSE) ────────────────────────────────────────────────────────────────
  // A thin change PING, never hunt state. The consumer receives the ping and re-fetches
  // GET /hunts/:id itself.
  //
  // Carrying state here would be the classic failure: if ping B overtook ping A, a live board
  // would go BACKWARDS, on stream. With a bare ping there is nothing to reorder — the consumer
  // always fetches current truth, so a duplicate, late or replayed ping is harmless.
  //
  // Change detection is an in-process tick that re-derives the payload ETag, NOT a hook on
  // emitHuntUpdate. Deliberate: hunts also change through paths that never reach the socket
  // fanout — the write endpoint below, admin edits, the archive janitor — and a hook would go
  // silent on exactly those. Cost is one sha1 over one hunt per second per connection, and
  // connections are capped below.
  //
  // NOT reachable from a browser `EventSource`: that API cannot set an Authorization header, and
  // the key must never travel in a query string (it lands in access logs and Referer). This is a
  // server-to-server channel — fan out to your viewers over your own socket.
  const STREAM_TICK_MS = 1000;
  const STREAM_HEARTBEAT_MS = 25000;
  // A held-open connection is a timer plus a socket for as long as it lasts, so it is a resource
  // a key can accumulate. Partner-scale is a handful; this is the abuse ceiling, not a product
  // limit.
  const STREAM_MAX_PER_TENANT = 20;
  // Bounded lifetime. `req.on('close')` is the normal cleanup and fires reliably, but a
  // half-open connection that never emits it would otherwise hold its timer forever. The client
  // reconnects on its own (see the `retry:` hint below), so ending is invisible to them.
  const STREAM_MAX_MS = 30 * 60 * 1000;
  const openStreams = new Map(); // tenantId -> currently open count

  router.get('/api/public/v1/hunts/:id/stream', requireApiFeature('developer_api'), allowParams(), (req, res) => {
    const tid = req.apiTenantId, id = req.params.id;
    const first = findHunt(hunts, archive, tenantOf, id, tid);
    if (!first) return res.status(404).json({ error: { code: 'not_found', message: 'Hunt not found' } });

    const open = openStreams.get(tid) || 0;
    if (open >= STREAM_MAX_PER_TENANT) {
      res.set('Retry-After', '30');
      return res.status(429).json({ error: { code: 'too_many_streams',
        message: `At most ${STREAM_MAX_PER_TENANT} concurrent streams per community` } });
    }
    openStreams.set(tid, open + 1);

    res.status(200).set({
      'Content-Type': 'text/event-stream; charset=utf-8',
      // Correct here, unlike on the GETs above: an event stream is not a representation anyone
      // revalidates.
      'Cache-Control': 'no-store',
      'Connection': 'keep-alive',
      // nginx-class proxies buffer a response body by default, which would hold every ping until
      // the connection closed — i.e. exactly invert the point of this endpoint.
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders();

    const snapshot = h => etagOf(JSON.stringify(serializers.publicHunt(h)));
    const send = (event, huntId) =>
      res.write(`event: ${event}\ndata: ${JSON.stringify({ event, huntId, occurredAt: Date.now() })}\n\n`);

    let tick = null, beat = null, life = null, closed = false;
    const stop = () => {
      if (closed) return;
      closed = true;
      clearInterval(tick); clearInterval(beat); clearTimeout(life);
      const n = (openStreams.get(tid) || 1) - 1;
      if (n > 0) openStreams.set(tid, n); else openStreams.delete(tid);
      res.end();
    };

    // Reconnect hint for EventSource-compatible clients, then an immediate ping so a consumer
    // syncs on connect instead of waiting for the first change.
    res.write('retry: 5000\n\n');
    let last = snapshot(first);
    send('hunt.changed', id);

    tick = setInterval(() => {
      const h = findHunt(hunts, archive, tenantOf, id, tid);
      // Deleted by an admin, or reaped by the janitor. Say so once and close rather than
      // silently going quiet, which a consumer cannot distinguish from an idle hunt.
      if (!h) { send('hunt.gone', id); return stop(); }
      const now = snapshot(h);
      if (now === last) return;
      last = now;
      send('hunt.changed', id);
    }, STREAM_TICK_MS);

    // A comment line. Keeps an idle proxy from reaping a stream between bonuses.
    beat = setInterval(() => res.write(': heartbeat\n\n'), STREAM_HEARTBEAT_MS);
    life = setTimeout(stop, STREAM_MAX_MS);

    req.on('close', stop);
    res.on('close', stop);
  });

  // Write a completed hunt. FOUR independent gates, all of which must pass:
  //   plan (developer_api) → key scope (write) → write rate bucket → payload validation.
  // Plan and scope are deliberately separate questions: one is what the community bought, the
  // other is what THIS key was trusted with.
  router.post('/api/public/v1/hunts',
    requireApiFeature('developer_api'), requireApiScope('write'), writeRateLimit,
    async (req, res, next) => {
      try {
        const tid = req.apiTenantId;
        const parsed = validateImport(req.body, { now: Date.now() });
        if (!parsed.ok) return res.status(400).json({ error: { code: parsed.code, message: parsed.message } });

        const hunt = buildImportedHunt(parsed.value, {
          tenantId: tid,
          hostDiscordId: req.apiTenant && req.apiTenant.hostDiscordId,
        });

        // Client-asserted discordIds are vetted against real accounts and STRIPPED when they
        // fail. An API key is a less trusted caller than a logged-in host, so this is not
        // optional — skipping it would reopen, from a machine endpoint at volume, exactly the
        // hole backend PR #88 closed. vetEquityIdentity already fails CLOSED when the
        // isKnownAccount predicate is missing, so a wiring mistake rejects rather than admits.
        const vetted = await vetEquityIdentity([], hunt.equity, { isKnownAccount });
        hunt.equity = vetted.rows;

        // Read before writing: archiveHunt upserts, so this is what distinguishes 201 from 200.
        const existing = archive.some(h => h.huntId === hunt.huntId);
        archiveHunt(hunt);

        auditLog.record({
          category: 'api', action: existing ? 'hunt.import.update' : 'hunt.import.create',
          actorId: `apikey:${tid}`, actorName: 'Developer API', tenantId: tid,
          targetId: hunt.huntId,
          summary: `${existing ? 'Updated' : 'Imported'} hunt ${parsed.value.externalId} (${hunt.bonuses.length} bonuses)`,
          detail: { externalId: parsed.value.externalId, huntType: parsed.value.huntType,
                    rejectedIdentities: vetted.rejected.length },
          ip: req.ip,
        });

        res.set('Cache-Control', 'no-store');
        res.status(existing ? 200 : 201).json({
          data: serializers.publicHunt(hunt),
          // Surfaced, not silent: a row whose discordId was refused will not roll up into
          // payouts or caller leaderboards, and the caller needs to know that happened.
          rejectedIdentities: vetted.rejected.length,
        });
      } catch (e) { next(e); }
    });

  router.get('/api/public/v1/stats', requireApiFeature('developer_api'), allowParams(), (req, res) => {
    const stats = getHuntStats(req.apiTenantId);
    res.set('Cache-Control', 'private, max-age=60'); // private: per-tenant, never shared-cacheable
    res.json({ data: serializers.publicStats(stats) });
  });

  // Premium tier (developer_api_premium): got-in event log + banger rail, same selection
  // logic as the session-authed admin export / public /api/bangers route respectively.
  router.get('/api/public/v1/got-in', requireApiFeature('developer_api_premium'),
    allowParams('limit', 'offset'), (req, res) => {
    const rows = getGotInLog(req.apiTenantId);
    const { limit, offset } = paginate(req);
    const page = serializers.publicGotIn(rows.slice(offset, offset + limit));
    res.set('Cache-Control', 'no-store');
    res.json({ data: page, pagination: { limit, offset, total: rows.length } });
  });

  router.get('/api/public/v1/bangers', requireApiFeature('developer_api_premium'), allowParams(), (req, res) => {
    // isAnon is REQUIRED here — without it a host who opted into anonymous mode is returned by
    // real name to every holder of this community's API key, while the public hub masks them.
    const list = collectBangers(hunts, archive, req.apiTenantId, { isAnon: shouldMaskIdentity })
      .map(serializers.publicBanger);
    res.set('Cache-Control', 'private, max-age=60'); // private: per-tenant, never shared-cacheable
    res.json({ data: list, pagination: { limit: list.length, offset: 0, total: list.length } });
  });

  // The Discord bot's shared-hunt endpoints — separate feature, separate plan gate
  // (`discord_hunts`), own file. Mounted HERE rather than in server.js so it inherits the CORS +
  // `ipFloor → requireApiKey → rateLimit` chain above and the error envelope below, instead of
  // carrying a second copy of both that can drift.
  router.use(require('./publicDiscordHunts.routes')(deps));

  // Public-scoped error envelope (the global handler returns a bare string — wrong shape).
  // MUST stay path-scoped. Unscoped, this caught errors from every router mounted BEFORE this
  // one in server.js (auth, hunts, mod-hunt, mods, announcements, ledger): Express propagates
  // errors forward through the stack, so those routes returned the public API's error shape and
  // their stack traces were swallowed — the global handler at the bottom of server.js, which is
  // what logs `err.stack`, never ran.
  router.use('/api/public/v1', (err, req, res, next) => {
    console.error('[public-api] error:', err && err.message);
    res.status(500).json({ error: { code: 'server_error', message: 'Internal error' } });
  });

  return router;
};
