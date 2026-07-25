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

// ── guildFlags ───────────────────────────────────────────────────────────────
// The flags travel in the session AND the signed token, so the extension hot path
// (reqHasFullExtension) can read them without a live Discord call. Only
// present-and-determined flags are carried — a synthetic `false` would turn "we couldn't ask
// Discord" into a definite "no", which is how an entitlement quietly becomes wrong.

test('guildFlags carries isGuildMember through when present', () => {
  assert.deepStrictEqual(
    auth.guildFlags({ isAffiliate: true, isDiscordVip: false, isGuildMember: true }),
    { isAffiliate: true, isDiscordVip: false, isGuildMember: true });
});

test('guildFlags omits isGuildMember when undetermined — never a synthetic false', () => {
  assert.deepStrictEqual(auth.guildFlags({ isAffiliate: true }), { isAffiliate: true });
  assert.ok(!('isGuildMember' in auth.guildFlags({})));
  assert.ok(!('isGuildMember' in auth.guildFlags(null)));
});

// A 404 from the guild lookup is a DETERMINATE "not a member", distinct from undetermined —
// so an explicit false must survive.
test('guildFlags preserves an explicit isGuildMember: false', () => {
  assert.deepStrictEqual(auth.guildFlags({ isGuildMember: false }), { isGuildMember: false });
});
