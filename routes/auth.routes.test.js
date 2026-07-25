// reconcileMembership is the load-bearing half of community membership: it runs on EVERY
// /auth/me call, so a mistake here silently rewrites the table for the whole user base.
//
// It is a closure inside the router factory, so these tests drive it through the real route
// rather than exporting it for testing — that way the coupling under test ("every /auth/me
// reconciles") is pinned too, not just the branching. Follows the app.listen(0) + stub-deps
// pattern from settings.routes.test.js.
const { test } = require('node:test');
const assert = require('node:assert');
const express = require('express');
const authRoutes = require('./auth.routes');

const TENANT = { id: 'partnerco', plan: 'partner' };

// Records every membership write so a test can assert not just WHAT was called but with which
// source scope — the scoping is the entire fix.
function makeMemberships() {
  const joins = [];
  const leaves = [];
  return {
    joins, leaves,
    joinCommunity: async (userId, tenantId, source) => { joins.push({ userId, tenantId, source }); return true; },
    leaveCommunity: async (userId, tenantId, opts) => { leaves.push({ userId, tenantId, opts }); return true; },
    getUserCommunities: async () => [],
  };
}

function appWith({ user, tenant = TENANT, gates = {}, memberships }) {
  const app = express();
  app.use((req, res, next) => {
    req.user = user ? { ...user } : undefined;
    req.tenant = tenant;
    req.session = {};
    next();
  });
  const no = () => false;
  app.use(authRoutes({
    passport: { authenticate: () => (req, res, next) => next() },
    FRONTEND_URL: 'http://frontend.test',
    requireAuth: (req, res, next) => next(),
    reqIsAdmin: gates.isAdmin || no,
    reqIsVipHost: gates.isVipHost || no,
    reqIsMod: gates.isMod || no,
    isPlatformAdmin: no,
    signToken: () => 'tok',
    // The real one: only present-and-determined flags survive, never a synthetic false.
    guildFlags: (src) => {
      const f = {};
      for (const k of ['isAffiliate', 'isDiscordVip', 'isDiscordMod', 'isGuildMember']) {
        if (src && k in src) f[k] = !!src[k];
      }
      return f;
    },
    recordKnownUser: () => {},
    memberships,
    tenants: { getTenantBySlug: () => tenant },
    pgPool: null,
    subscriptions: { getSubscription: async () => ({ tier: 'free' }) },
    // null = roles UNDETERMINED, so req.user's flags are left exactly as the test set them.
    refreshGuildRoles: async () => null,
    featureGrants: { getGrantsForUser: () => [] },
    auditLog: { record: () => {} },
    bans: { isBanned: () => false },
    activityFeed: { push: () => {} },
  }));
  return app;
}

async function hitAuthMe(app) {
  const server = await new Promise(r => { const s = app.listen(0, () => r(s)); });
  try {
    const r = await fetch(`http://127.0.0.1:${server.address().port}/auth/me`);
    return { status: r.status, body: await r.json().catch(() => null) };
  } finally {
    await new Promise(res => server.close(res));
  }
}

// Give reconcileMembership's async writes a tick to land — the route does not await them
// (deliberately: membership bookkeeping must never delay or fail /auth/me).
const settle = () => new Promise(r => setImmediate(r));

async function reconcile(opts) {
  const memberships = makeMemberships();
  const res = await hitAuthMe(appWith({ ...opts, memberships }));
  await settle();
  return { ...memberships, res };
}

// ── joins are scoped to 'role' ───────────────────────────────────────────────

test("an affiliate is joined with source='role', never as a deliberate join", async () => {
  const m = await reconcile({ user: { id: 'u1', isAffiliate: true } });
  assert.deepStrictEqual(m.joins, [{ userId: 'u1', tenantId: 'partnerco', source: 'role' }]);
  assert.deepStrictEqual(m.leaves, []);
});

test('every qualifying signal joins: guild VIP, guild mod, and the request gates', async () => {
  for (const user of [{ id: 'u1', isDiscordVip: true }, { id: 'u1', isDiscordMod: true }]) {
    const m = await reconcile({ user });
    assert.strictEqual(m.joins.length, 1, `expected a join for ${JSON.stringify(user)}`);
    assert.strictEqual(m.joins[0].source, 'role');
  }
  for (const gate of ['isAdmin', 'isVipHost', 'isMod']) {
    // Determined-and-false guild flags, so only the request gate can qualify them.
    const m = await reconcile({
      user: { id: 'u1', isAffiliate: false, isDiscordVip: false, isDiscordMod: false },
      gates: { [gate]: () => true },
    });
    assert.strictEqual(m.joins.length, 1, `expected ${gate} to qualify`);
    assert.deepStrictEqual(m.leaves, [], `${gate} must not be evicted`);
  }
});

// ── THE REGRESSION GUARD ─────────────────────────────────────────────────────
// An unscoped evict here deleted deliberate joins too, so the Settings Join button did nothing
// that lasted. If this assertion ever loosens, that bug is back.

test("a determined non-qualifier is evicted ONLY from their role row", async () => {
  const m = await reconcile({ user: { id: 'u1', isAffiliate: false } });
  assert.deepStrictEqual(m.joins, []);
  assert.strictEqual(m.leaves.length, 1);
  assert.deepStrictEqual(m.leaves[0].opts, { onlySource: 'role' },
    'an automatic eviction must never remove a deliberate self-join');
});

test('the automatic evict is never called unscoped, under any determined-negative shape', async () => {
  const shapes = [
    { id: 'u1', isAffiliate: false },
    { id: 'u1', isDiscordVip: false },
    { id: 'u1', isDiscordMod: false },
    { id: 'u1', isAffiliate: false, isDiscordVip: false, isDiscordMod: false },
  ];
  for (const user of shapes) {
    const m = await reconcile({ user });
    for (const l of m.leaves) {
      assert.deepStrictEqual(l.opts, { onlySource: 'role' },
        `unscoped evict for ${JSON.stringify(user)} would wipe deliberate joins`);
    }
  }
});

// ── undetermined must not churn the table ────────────────────────────────────

test('undetermined guild roles reconcile nothing — neither join nor evict', async () => {
  // No guild flags present at all: a transient Discord failure must not look like "no roles".
  const m = await reconcile({ user: { id: 'u1' } });
  assert.deepStrictEqual(m.joins, []);
  assert.deepStrictEqual(m.leaves, [],
    'an undetermined lookup must never evict — that is a mass-eviction on a Discord outage');
});

test('undetermined but otherwise qualified (request gate) still joins', async () => {
  const m = await reconcile({ user: { id: 'u1' }, gates: { isVipHost: () => true } });
  assert.strictEqual(m.joins.length, 1);
  assert.deepStrictEqual(m.leaves, []);
});

// ── guards ───────────────────────────────────────────────────────────────────

test('no tenant → no membership write at all', async () => {
  const m = await reconcile({ user: { id: 'u1', isAffiliate: false }, tenant: null });
  assert.deepStrictEqual(m.joins, []);
  assert.deepStrictEqual(m.leaves, []);
});

test('logged out → /auth/me answers null and touches nothing', async () => {
  const m = await reconcile({ user: null });
  assert.deepStrictEqual(m.res.body, { user: null });
  assert.deepStrictEqual(m.joins, []);
  assert.deepStrictEqual(m.leaves, []);
});

// ── the flag the Partner perk depends on ─────────────────────────────────────

test('isGuildMember reaches the client through /auth/me, so the extension can read it cached', async () => {
  const m = await reconcile({ user: { id: 'u1', isAffiliate: true, isGuildMember: true } });
  assert.strictEqual(m.res.body.user.isGuildMember, true);
});

test('an absent isGuildMember stays absent — never a synthetic false', async () => {
  const m = await reconcile({ user: { id: 'u1', isAffiliate: true } });
  assert.ok(!('isGuildMember' in m.res.body.user),
    'coercing undetermined to false would deny a real member the Partner perk');
});
