// requireTenantAdmin = platform owner OR this-tenant's admin, but NOT a mod. Unlike reqIsAdmin,
// it does not fold in reqIsMod. Middleware tested directly with a fake req/res/next.
const { test } = require('node:test');
const assert = require('node:assert');
const auth = require('./auth');

// Minimal DI: no env admins; owner + tenant-admin resolved via stubbed tenants.
auth.initAuth({
  ADMIN_IDS: [], VIP_IDS: [], SESSION_SECRET: 'x', MULTI_TENANT: true,
  tenants: {
    isPlatformOwnerId: (id) => id === 'OWNER',
    isTenantAdmin: (u, t) => !!(u && t && (t.adminIds || []).includes(u.id)),
    isTenantMod:   (u, t) => !!(u && t && (t.modIds   || []).includes(u.id)),
    BEAN_TENANT: {},
  },
  admins: { isDbAdmin: () => false },
  hunts: {}, recordKnownUser() {},
});

function run(req) {
  let status = 200, ended = false, called = false;
  const res = { status(c) { status = c; return this; }, json() { ended = true; return this; } };
  auth.requireTenantAdmin(req, res, () => { called = true; });
  return { status, ended, called };
}

const TENANT = { adminIds: ['A1'], modIds: ['M1'] };

test('tenant admin passes', () => {
  const r = run({ user: { id: 'A1' }, tenant: TENANT });
  assert.strictEqual(r.called, true);
});

test('platform owner passes', () => {
  const r = run({ user: { id: 'OWNER' }, tenant: TENANT });
  assert.strictEqual(r.called, true);
});

test('a mod is REJECTED (403) — this is the point', () => {
  const r = run({ user: { id: 'M1' }, tenant: TENANT });
  assert.strictEqual(r.called, false);
  assert.strictEqual(r.status, 403);
});

test('a random user is rejected (403)', () => {
  const r = run({ user: { id: 'nobody' }, tenant: TENANT });
  assert.strictEqual(r.status, 403);
});
