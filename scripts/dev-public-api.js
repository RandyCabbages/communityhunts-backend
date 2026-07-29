#!/usr/bin/env node
// A local public API, for developing against the Discord bot's endpoints without Postgres and
// without pointing anything at production.
//
//   node scripts/dev-public-api.js            # http://localhost:3101, key ch_live_dev
//   DEV_API_PORT=3999 DEV_API_KEY=... node scripts/dev-public-api.js
//
// **It mounts the REAL routes/public.routes.js.** Only two things are faked: the API key (there is
// no database to look one up in) and the socket broadcast (there are no sockets). Everything the
// bot actually exercises — the merge, `vetEquityIdentity`, the 409s, the plan and scope gates, the
// rate limiters, the share-url shape — is the same code that runs in production. A hand-written
// stub would only ever prove the bot agrees with my idea of the contract, which is the one thing
// a stub cannot check.
//
// Why it exists at all: `requireApiKey` reads from Postgres, local dev deliberately has no
// DATABASE_URL (docs/local-dev-setup.md — that is what keeps you off the real database), so
// without this there is no way to get past the first middleware locally.
//
// Nothing here writes to the repo: state goes to a temp directory and is gone on exit.

const express = require('express');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = Number(process.env.DEV_API_PORT || 3101);
const KEY = process.env.DEV_API_KEY || 'ch_live_dev';
const TENANT = process.env.DEV_API_TENANT || 'bean';
const PLAN = process.env.DEV_API_PLAN || 'partner';          // set 'pro' to watch the gate refuse
const HOST_ID = '135203806676779008';
// Ids the fake CommunityHunts "knows". Everyone else gets a name-only equity row, which is the
// identity rule the bot is built around — worth being able to drive both sides of it locally.
const KNOWN = new Set((process.env.DEV_API_KNOWN || HOST_ID).split(',').map(s => s.trim()).filter(Boolean));

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-dev-api-'));

const persistence = require('../lib/persistence');
const huntsCore = require('../lib/hunts-core');
const rateLimitLib = require('../lib/rateLimit');
const serializers = require('../lib/publicSerializers');
const makeSharedHunts = require('../lib/sharedHunts');
const makeShareLinks = require('../lib/shareLinks');

const { hunts, archive, shareTokens, persistHunts, persistShareTokens, tokenForOwner,
        archiveHunt } = persistence;

// No pool: file-backed, in a temp directory. The clobber guard only arms when a pool is present,
// so this stays writable.
persistence.initPersistence({ pgPool: null, dataDir });
serializers._setPublicHuntView(huntsCore.publicHuntView);

const tenants = {
  getTenantBySlug: () => ({
    slug: TENANT, id: TENANT, displayName: 'Bean', plan: PLAN,
    hostDiscordId: HOST_ID, branding: { hostName: 'Bean' },
  }),
};

const shareLinks = makeShareLinks({
  shareTokens, tokenForOwner, persistShareTokens, hunts, uid: huntsCore.uid,
  frontendUrl: process.env.FRONTEND_URL || 'http://localhost:3000',
});

const app = express();
app.use(express.json());
app.use(require('../routes/public.routes')({
  // The one real fake. Mirrors lib/apiKeys.js requireApiKey: the KEY resolves the tenant, the
  // tier and the scopes — nothing is read from a header.
  requireApiKey: (req, res, next) => {
    const raw = String(req.get('authorization') || '').replace(/^Bearer\s+/i, '').trim();
    if (raw !== KEY) {
      return res.status(401).json({ error: { code: 'unauthorized', message: 'Missing API key' } });
    }
    req.apiTenant = tenants.getTenantBySlug();
    req.apiTenantId = TENANT;
    req.apiTier = PLAN;
    req.apiScopes = ['read', 'write'];
    next();
  },
  requireApiFeature: (name) => (req, res, next) => (
    require('../lib/features').canUse(name, null, req.apiTier)
      ? next()
      : res.status(403).json({ error: { code: 'forbidden_tier', message: `Plan ${req.apiTier} does not include ${name}` } })),
  requireApiScope: (scope) => (req, res, next) => (req.apiScopes.includes(scope)
    ? next()
    : res.status(403).json({ error: { code: 'insufficient_scope', message: `needs ${scope}` } })),
  rateLimit: rateLimitLib.rateLimit,
  writeRateLimit: rateLimitLib.writeRateLimit,
  ipFloor: rateLimitLib.ipFloor,

  serializers,
  getHuntStats: huntsCore.getHuntStats,
  hunts, archive,
  tenantOf: huntsCore.tenantOf,
  huntHasContent: huntsCore.huntHasContent,
  huntCompleted: huntsCore.huntCompleted,
  getGotInLog: huntsCore.getGotInLog,
  collectBangers: require('../lib/bangers').collectBangers,
  archiveHunt,
  auditLog: { record: (e) => console.log(`[audit] ${e.action} — ${e.summary}`) },
  isKnownAccount: (id) => (KNOWN.has(String(id)) ? { id } : null),

  affiliateHuntKey: huntsCore.affiliateHuntKey,
  vipHuntKey: huntsCore.vipHuntKey,
  sharedHunts: makeSharedHunts({ tenants, uid: huntsCore.uid }),
  shareLinks,
  persistHunts,
  // No socket server here. Logged rather than swallowed so a missing broadcast is visible.
  emitHuntUpdate: (key) => console.log(`[emit] hunt:update ${key}`),
  uid: huntsCore.uid,
}));

// Read the current state of a shared hunt without an API key — for eyeballing what a merge did.
app.get('/dev/hunts', (req, res) => res.json(hunts));

// Stand in for a mod resetting the run from the console, which is the situation the stale-run
// guard exists for and the one thing a caller cannot set up through the API it is testing.
app.post('/dev/reset', (req, res) => {
  for (const key of Object.keys(hunts)) delete hunts[key];
  persistHunts();
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`dev public API on http://localhost:${PORT}`);
  console.log(`  key    ${KEY}   (Authorization: Bearer ${KEY})`);
  console.log(`  tenant ${TENANT}, plan ${PLAN}`);
  console.log(`  knows  ${[...KNOWN].join(', ') || '(nobody)'}`);
  console.log(`  state  ${dataDir}   (temporary — deleted on exit)`);
  console.log('  GET /dev/hunts to see the sheets. Point the bot here with CH_API_URL.');
});

// The temp directory is the whole sandbox — leaving it behind would slowly fill %TEMP% with
// half-written hunts that look real to anyone who finds them.
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
    process.exit(0);
  });
}
