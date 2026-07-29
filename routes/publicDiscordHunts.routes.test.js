// The Discord bot's three public endpoints, driven through routes/public.routes.js — the router
// they are actually mounted inside — so the shared CORS/auth/rate-limit chain and the public error
// envelope are exercised the same way production exercises them.
//
// The plan gate uses the REAL lib/features canUse(), not a stub. That gate is the entire reason
// `discord_hunts` had to be listed in FEATURES: canUse() returns true for a name it does not
// recognise, so a stubbed gate here would pass while production admitted every key on every plan.

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const express = require('express');

const publicRoutes = require('./public.routes');
const makeSharedHunts = require('../lib/sharedHunts');
const makeShareLinks = require('../lib/shareLinks');
const { canUse } = require('../lib/features');

const BEAN = '135203806676779008';
const CABBAGE = '197365493516992512';
const STRANGER = '222000222000222000';

const tenants = {
  getTenantBySlug: () => ({
    slug: 'bean', displayName: 'Bean', hostDiscordId: BEAN, branding: { hostName: 'Bean' },
  }),
};

function harness({ plan = 'partner', scopes = ['read', 'write'], known = [CABBAGE],
                   knownThrows = false, hunts = {} } = {}) {
  const state = {
    hunts, archive: [], shareTokens: {}, audit: [], emitted: [], persists: 0, asked: [],
  };
  let n = 0;
  const uid = () => `uid${++n}`;

  const isKnownAccount = async (id) => {
    state.asked.push(id);
    if (knownThrows) throw new Error('database is down');
    return known.includes(id) ? { id } : null;
  };

  const pass = (req, res, next) => next();
  const app = express();
  app.use(express.json());
  app.use(publicRoutes({
    // Mirrors lib/apiKeys.js requireApiKey: the KEY resolves the tenant, tier and scopes.
    requireApiKey: (req, res, next) => {
      req.apiTenantId = 'bean'; req.apiTier = plan; req.apiScopes = scopes; next();
    },
    requireApiFeature: (name) => (req, res, next) => (canUse(name, null, req.apiTier)
      ? next()
      : res.status(403).json({ error: { code: 'forbidden_tier', message: 'Upgrade required' } })),
    requireApiScope: (scope) => (req, res, next) => ((req.apiScopes || []).includes(scope)
      ? next()
      : res.status(403).json({ error: { code: 'insufficient_scope', message: 'no write scope' } })),
    rateLimit: pass, writeRateLimit: pass, ipFloor: pass,

    // Developer-API deps this suite does not drive.
    serializers: { publicHunt: (h) => h }, getHuntStats: () => ({}), tenantOf: (h) => h.tenantId,
    huntHasContent: () => true, huntCompleted: () => false, getGotInLog: () => [],
    collectBangers: () => [],

    hunts: state.hunts,
    archive: state.archive,
    archiveHunt: (h) => { state.archive.push(h); },
    persistHunts: () => { state.persists += 1; },
    emitHuntUpdate: (key) => { state.emitted.push(key); },
    auditLog: { record: (entry) => state.audit.push(entry) },
    isKnownAccount,
    affiliateHuntKey: (t) => `__affiliate_hunt__:${t}`,
    vipHuntKey: (t) => `__vip_hunt__:${t}`,
    sharedHunts: makeSharedHunts({ tenants, uid }),
    shareLinks: makeShareLinks({
      shareTokens: state.shareTokens,
      tokenForOwner: (o) => Object.keys(state.shareTokens).find(t => state.shareTokens[t] === o) || null,
      persistShareTokens: () => {},
      hunts: state.hunts,
      uid,
      frontendUrl: 'https://communityhunts.gg',
    }),
    uid,
  }));

  return { app, state };
}

async function call(app, method, path, body) {
  const server = await new Promise(r => { const s = app.listen(0, () => r(s)); });
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, headers: res.headers, body: await res.json().catch(() => null) };
  } finally {
    // closeAllConnections FIRST — close() alone waits forever on fetch's idle keep-alive socket.
    server.closeAllConnections();
    await new Promise(r => server.close(r));
  }
}

const open = (app, body) => call(app, 'POST', '/api/public/v1/hunts/shared/open', body);
const equity = (app, body) => call(app, 'POST', '/api/public/v1/hunts/shared/equity', body);

describe('GET /accounts/known', () => {
  it('answers with the ids it knows, and nothing else', async () => {
    // Ids only. No names, no avatars, nothing about the people it does not know.
    const { app } = harness();
    const res = await call(app, 'GET', `/api/public/v1/accounts/known?discordIds=${CABBAGE},${STRANGER}`);

    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { known: [CABBAGE] });
  });

  it('never looks up something that is not a Discord id', async () => {
    const { app, state } = harness();
    await call(app, 'GET', '/api/public/v1/accounts/known?discordIds=creator_auto,manual:Bean,1234');

    assert.deepEqual(state.asked, [], 'shape check happens before any database round trip');
  });

  it('asks once for a repeated id', async () => {
    const { app, state } = harness();
    await call(app, 'GET', `/api/public/v1/accounts/known?discordIds=${CABBAGE},${CABBAGE}`);

    assert.deepEqual(state.asked, [CABBAGE]);
  });

  it('fails closed when the lookup throws', async () => {
    // "Not known" writes a name-only equity row, which the next sweep repairs. Claiming an
    // identity we could not verify does not repair.
    const { app } = harness({ knownThrows: true });
    const res = await call(app, 'GET', `/api/public/v1/accounts/known?discordIds=${CABBAGE}`);

    assert.equal(res.status, 200);
    assert.deepEqual(res.body.known, []);
  });

  it('refuses an oversized list rather than doing the work', async () => {
    const ids = Array.from({ length: 101 }, (_, i) => String(100000000000000000 + i)).join(',');
    const { app, state } = harness();
    const res = await call(app, 'GET', `/api/public/v1/accounts/known?discordIds=${ids}`);

    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'too_many_ids');
    assert.deepEqual(state.asked, []);
  });

  it('handles an empty ask', async () => {
    const { app } = harness();
    assert.deepEqual((await call(app, 'GET', '/api/public/v1/accounts/known')).body, { known: [] });
  });

  it('is refused on a Pro community', async () => {
    // Partner-only, deliberately: this endpoint sits beside two that write to a live equity sheet.
    const { app } = harness({ plan: 'pro' });
    const res = await call(app, 'GET', `/api/public/v1/accounts/known?discordIds=${CABBAGE}`);

    assert.equal(res.status, 403);
    assert.equal(res.body.error.code, 'forbidden_tier');
  });

  it('inherits the parent router: Vary: Authorization is set', async () => {
    // The reason this router is mounted inside public.routes rather than beside it. Without Vary,
    // a shared cache can serve one community's answer to another community's key.
    const { app } = harness();
    const res = await call(app, 'GET', '/api/public/v1/accounts/known');

    assert.match(res.headers.get('vary') || '', /Authorization/);
  });
});

describe('POST /hunts/shared/open', () => {
  it('opens the affiliate run and says where to send people', async () => {
    const { app, state } = harness();
    const res = await open(app, { category: 'affiliate', title: 'Friday $2,500' });

    assert.equal(res.status, 201);
    assert.equal(res.body.key, '__affiliate_hunt__:bean');
    assert.match(res.body.shareUrl, /^https:\/\/communityhunts\.gg\/bean\/share\/.+/);
    assert.equal(state.hunts['__affiliate_hunt__:bean'].title, 'Friday $2,500');
    assert.equal(state.hunts['__affiliate_hunt__:bean'].huntType, 'vip');
    assert.deepEqual(state.emitted, ['__affiliate_hunt__:bean']);
  });

  it('sends VIP to its own hunt, not the affiliate one', async () => {
    const { app, state } = harness();
    const res = await open(app, { category: 'vip', title: 'VIP night' });

    assert.equal(res.body.key, '__vip_hunt__:bean');
    assert.equal(state.hunts['__affiliate_hunt__:bean'], undefined);
  });

  it('hands back the same share url on the next run', async () => {
    // Stable per owner. A second token would break every link already posted in Discord.
    const { app } = harness();
    const first = await open(app, { category: 'affiliate' });
    const second = await open(app, { category: 'affiliate' });

    assert.equal(second.body.shareUrl, first.body.shareUrl);
    assert.notEqual(second.body.huntId, first.body.huntId, 'but it is a genuinely new run');
  });

  it('refuses a run with a mod\'s work in it — and leaves it alone', async () => {
    const live = {
      huntId: 'in-progress', bonuses: [{ slot: 'Gates of Olympus', bet: 5 }], calls: [],
      equity: [{ id: 'bean_auto', name: 'Bean', amount: 1000 }], archivedAt: null,
    };
    const { app, state } = harness({ hunts: { '__affiliate_hunt__:bean': live } });
    const res = await open(app, { category: 'affiliate' });

    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, 'hunt_in_progress');
    // The refusal is only worth anything if the run really is untouched.
    assert.equal(state.hunts['__affiliate_hunt__:bean'], live);
    assert.deepEqual(state.archive, [], 'and nothing was archived on the way out');
    assert.deepEqual(state.emitted, []);
  });

  it('opens over a run that has ended, archiving what it held', async () => {
    const ended = {
      huntId: 'finished', bonuses: [{ slot: 'Gates', win: 100 }], calls: [], equity: [],
      archivedAt: '2026-07-28T00:00:00.000Z',
    };
    const { app, state } = harness({ hunts: { '__vip_hunt__:bean': ended } });
    const res = await open(app, { category: 'vip' });

    assert.equal(res.status, 201);
    assert.deepEqual(state.archive.map(h => h.huntId), ['finished']);
    assert.notEqual(state.hunts['__vip_hunt__:bean'].huntId, 'finished');
  });

  it('refuses topLb, which has no hunt of its own', async () => {
    // Top-LB giveaways run in the VIP hunt; the bot maps that before it calls.
    const { app } = harness();
    const res = await open(app, { category: 'topLb' });

    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'invalid_category');
  });

  it('refuses a read-only key', async () => {
    const { app, state } = harness({ scopes: ['read'] });
    const res = await open(app, { category: 'affiliate' });

    assert.equal(res.status, 403);
    assert.equal(res.body.error.code, 'insufficient_scope');
    assert.deepEqual(Object.keys(state.hunts), []);
  });

  it('is refused on a Pro community', async () => {
    const { app } = harness({ plan: 'pro' });
    assert.equal((await open(app, { category: 'affiliate' })).status, 403);
  });

  it('leaves an audit line naming the bot', async () => {
    const { app, state } = harness();
    await open(app, { category: 'affiliate', title: 'Friday' });

    assert.equal(state.audit.length, 1);
    assert.equal(state.audit[0].action, 'hunt.shared.open');
    assert.equal(state.audit[0].actorId, 'apikey:bean');
    assert.equal(state.audit[0].tenantId, 'bean');
  });
});

describe('POST /hunts/shared/equity', () => {
  async function opened(opts) {
    const h = harness(opts);
    const res = await open(h.app, { category: 'affiliate' });
    return { ...h, key: res.body.key, huntId: res.body.huntId };
  }

  const winners = [
    { name: 'Cabbage', discordId: CABBAGE, amount: 50, isRollWinner: true },
    { name: 'thacker_gb', amount: 50, isRollWinner: true },
  ];

  it('merges the winners onto the sheet', async () => {
    const { app, state, key } = await opened();
    const res = await equity(app, { category: 'affiliate', key, members: winners });

    assert.equal(res.status, 200);
    assert.equal(res.body.added, 2);
    assert.deepEqual(state.hunts[key].equity.map(r => r.name), ['Bean', 'Cabbage', 'thacker_gb']);
  });

  it('never deletes a row a mod added by hand', async () => {
    // The reason this is a merge endpoint at all: the plain PUT would replace the array, and a
    // short array through it deletes everyone the bot did not send.
    const { app, state, key } = await opened();
    state.hunts[key].equity.push({ id: 'typed', name: 'Goofer', amount: 50, isRollWinner: true });

    await equity(app, { category: 'affiliate', key, members: [{ name: 'Cabbage', amount: 50 }] });

    assert.deepEqual(state.hunts[key].equity.map(r => r.name), ['Bean', 'Goofer', 'Cabbage']);
  });

  it('is idempotent — the bot re-sends the same winners every sweep', async () => {
    const { app, state, key } = await opened();
    await equity(app, { category: 'affiliate', key, members: winners });
    const second = await equity(app, { category: 'affiliate', key, members: winners });

    assert.equal(second.body.added, 0);
    assert.equal(state.hunts[key].equity.length, 3);
  });

  it('strips a discordId that belongs to nobody, and says so', async () => {
    // vetEquityIdentity, same as the editor save path. An API key is a LESS trusted caller than
    // a signed-in host, so it is not optional here.
    const { app, state, key } = await opened();
    const res = await equity(app, {
      category: 'affiliate', key,
      members: [{ name: 'Nobody', discordId: STRANGER, amount: 50 }],
    });

    assert.equal(res.body.rejectedIdentities, 1);
    const row = state.hunts[key].equity.find(r => r.name === 'Nobody');
    assert.equal(row.discordId, undefined, 'the row lands, the unverified identity does not');
    assert.equal(row.amount, 50);
  });

  it('keeps an id CH does know', async () => {
    const { app, state, key } = await opened();
    await equity(app, { category: 'affiliate', key, members: winners });

    assert.equal(state.hunts[key].equity.find(r => r.name === 'Cabbage').discordId, CABBAGE);
  });

  it('refuses a key that is not this category\'s hunt', async () => {
    const { app, state, key } = await opened();
    const res = await equity(app, {
      category: 'affiliate', key: '__vip_hunt__:bean', members: winners,
    });

    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, 'stale_key');
    assert.equal(state.hunts[key].equity.length, 1, 'nothing was written');
  });

  it('refuses a run that has been reset since the giveaway opened', async () => {
    // `key` is stable across runs, so it cannot see a reset. The huntId can, and that is the
    // difference between winners landing on their own sheet and on a stranger\'s.
    const { app, state, key, huntId } = await opened();
    await open(app, { category: 'affiliate' });                     // a mod restarts the run

    const res = await equity(app, { category: 'affiliate', key, huntId, members: winners });

    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, 'stale_run');
    assert.equal(state.hunts[key].equity.length, 1);
  });

  it('accepts the write when the run is still the one that was opened', async () => {
    const { app, key, huntId } = await opened();
    const res = await equity(app, { category: 'affiliate', key, huntId, members: winners });

    assert.equal(res.status, 200);
  });

  it('refuses to write onto a run a mod has ended', async () => {
    // It is already archived as its own snapshot; merging into the live object now would leave
    // the archived copy — what the ledger and hunt history read — missing these winners.
    const { app, state, key } = await opened();
    state.hunts[key].archivedAt = '2026-07-29T00:00:00.000Z';

    const res = await equity(app, { category: 'affiliate', key, members: winners });

    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, 'run_ended');
    assert.equal(state.hunts[key].equity.length, 1);
  });

  it('404s when nobody has opened that hunt', async () => {
    const { app } = harness();
    const res = await equity(app, { category: 'vip', members: winners });

    assert.equal(res.status, 404);
    assert.equal(res.body.error.code, 'no_hunt');
  });

  it('refuses members that are not an array', async () => {
    const { app } = await opened();
    const res = await equity(app, { category: 'affiliate', members: 'Cabbage' });

    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'invalid_members');
  });

  it('refuses a read-only key', async () => {
    const { app } = harness({ scopes: ['read'] });
    const res = await equity(app, { category: 'affiliate', members: winners });

    assert.equal(res.status, 403);
    assert.equal(res.body.error.code, 'insufficient_scope');
  });

  it('persists and broadcasts the change', async () => {
    const { app, state, key } = await opened();
    const before = state.persists;
    await equity(app, { category: 'affiliate', key, members: winners });

    assert.ok(state.persists > before, 'the sheet was written, not just held in memory');
    assert.deepEqual(state.emitted.filter(k => k === key).length, 2, 'open + equity');
  });

  it('does not write an audit line for a sweep that changed nothing', async () => {
    // The bot re-sends every sweep. One line per sweep would bury the ones that mean something.
    const { app, state } = await opened();
    const key = '__affiliate_hunt__:bean';
    await equity(app, { category: 'affiliate', key, members: winners });
    const after = state.audit.length;
    await equity(app, { category: 'affiliate', key, members: winners });

    assert.equal(state.audit.length, after);
  });

  it('does write one when an existing row\'s amount really moved', async () => {
    // The other half of the rule above: quiet on a no-op sweep, never quiet on a real change.
    const { app, state } = await opened();
    const key = '__affiliate_hunt__:bean';
    await equity(app, { category: 'affiliate', key, members: [{ name: 'Cabbage', amount: 50 }] });
    const after = state.audit.length;
    await equity(app, { category: 'affiliate', key, members: [{ name: 'Cabbage', amount: 75 }] });

    assert.equal(state.audit.length, after + 1);
    assert.equal(state.audit.at(-1).action, 'hunt.shared.equity');
  });
});
