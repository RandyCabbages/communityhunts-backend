// Public Developer API — key-authed, tier-gated, rate-limited, stable serializers.
// Mounted AFTER resolveTenant in server.js (with the other DI routers): requireApiKey derives
// the tenant from the KEY and overrides req.tenant, so tenant never comes from a header here.

const express = require('express');
// Anonymous-host masking, required by collectBangers. Required directly rather than injected,
// matching routes/misc.routes.js — the twin call site for the same rail.
const { shouldMaskIdentity } = require('../lib/settings');
const { validateImport, buildImportedHunt } = require('../lib/huntImport');
const { vetEquityIdentity } = require('../lib/identityWrites');

function paginate(req) {
  let limit = parseInt(req.query.limit, 10); if (!Number.isFinite(limit) || limit <= 0) limit = 25;
  limit = Math.min(limit, 100);
  let offset = parseInt(req.query.offset, 10); if (!Number.isFinite(offset) || offset < 0) offset = 0;
  return { limit, offset };
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

  router.get('/api/public/v1/hunts', requireApiFeature('developer_api'), (req, res) => {
    const tid = req.apiTenantId;
    const status = req.query.status === undefined ? 'all' : String(req.query.status);
    if (!['live', 'archived', 'all'].includes(status)) {
      return res.status(400).json({ error: { code: 'invalid_status', message: 'status must be one of: live, archived, all' } });
    }
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
    list.sort((a, b) => new Date(b.archivedAt || b.startedAt || 0) - new Date(a.archivedAt || a.startedAt || 0));
    const { limit, offset } = paginate(req);
    const page = list.slice(offset, offset + limit).map(serializers.publicHunt);
    res.set('Cache-Control', 'no-store');
    res.json({ data: page, pagination: { limit, offset, total: list.length } });
  });

  router.get('/api/public/v1/hunts/:id', requireApiFeature('developer_api'), (req, res) => {
    const tid = req.apiTenantId, id = req.params.id;
    const found = [...Object.values(hunts), ...archive].find(h => h.huntId === id && tenantOf(h) === tid);
    if (!found) return res.status(404).json({ error: { code: 'not_found', message: 'Hunt not found' } });
    // Explicit, not absent: with no directive a shared cache may heuristically cache a 200 GET,
    // and this body is per-tenant. A live hunt also changes constantly.
    res.set('Cache-Control', 'no-store');
    res.json({ data: serializers.publicHunt(found) });
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

  router.get('/api/public/v1/stats', requireApiFeature('developer_api'), (req, res) => {
    const stats = getHuntStats(req.apiTenantId);
    res.set('Cache-Control', 'private, max-age=60'); // private: per-tenant, never shared-cacheable
    res.json({ data: serializers.publicStats(stats) });
  });

  // Premium tier (developer_api_premium): got-in event log + banger rail, same selection
  // logic as the session-authed admin export / public /api/bangers route respectively.
  router.get('/api/public/v1/got-in', requireApiFeature('developer_api_premium'), (req, res) => {
    const rows = getGotInLog(req.apiTenantId);
    const { limit, offset } = paginate(req);
    const page = serializers.publicGotIn(rows.slice(offset, offset + limit));
    res.set('Cache-Control', 'no-store');
    res.json({ data: page, pagination: { limit, offset, total: rows.length } });
  });

  router.get('/api/public/v1/bangers', requireApiFeature('developer_api_premium'), (req, res) => {
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
