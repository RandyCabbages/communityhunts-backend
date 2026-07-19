// P1 security-audit regression (2026-07-18 #1): cross-tenant hunt admin authority.
// reqCanAdminHunt/canEditHunt must honor the TARGET hunt's tenant, not the caller's own
// tenant context. Platform owners span every tenant; a tenant admin/mod only their own.
// Pure unit test over lib/auth.js with stub tenants/admins — run with:
//   node --test lib/auth.p1.test.js         (NOT `node --test lib/` — broken on node24)
const { test } = require('node:test');
const assert = require('node:assert');
const auth = require('./auth');

// mallory is a tenant admin of 'evilco' only; owner is a hardcoded platform owner.
const tenants = {
  BEAN_TENANT: { id: 'bean' },
  isPlatformOwnerId: id => id === 'owner',
  isTenantMod: () => false,
  isTenantAdmin: (u, t) => !!(u && t && u.adminOf === t.id),
};
const admins = { isDbAdmin: () => false };

auth.initAuth({
  ADMIN_IDS: [], VIP_IDS: [], SESSION_SECRET: 'x', MULTI_TENANT: true,
  tenants, admins,
  hunts: {
    beanHunt:  { tenantId: 'bean' },
    evilHunt:  { tenantId: 'evilco' },
    legacyHunt: {},               // untagged → belongs to 'bean' (back-compat)
  },
});

const mallory = { id: 'mallory', adminOf: 'evilco' };
const owner   = { id: 'owner' };
const req = (user, tenantId) => ({ user, tenant: { id: tenantId } });

test('#1: tenant admin CANNOT admin a hunt in another tenant', () => {
  assert.strictEqual(auth.reqCanAdminHunt(req(mallory, 'evilco'), 'beanHunt'), false);
  assert.strictEqual(auth.canEditHunt(req(mallory, 'evilco'), 'beanHunt'), false);
});

test('#1: tenant admin CAN admin a hunt in their own tenant', () => {
  assert.strictEqual(auth.reqCanAdminHunt(req(mallory, 'evilco'), 'evilHunt'), true);
  assert.strictEqual(auth.canEditHunt(req(mallory, 'evilco'), 'evilHunt'), true);
});

test('#1: tenant admin CANNOT reach an untagged (Bean) hunt from another tenant', () => {
  assert.strictEqual(auth.reqCanAdminHunt(req(mallory, 'evilco'), 'legacyHunt'), false);
});

test('#1: platform owner spans every tenant', () => {
  assert.strictEqual(auth.reqCanAdminHunt(req(owner, 'evilco'), 'beanHunt'), true);
  assert.strictEqual(auth.reqCanAdminHunt(req(owner, 'evilco'), 'legacyHunt'), true);
  assert.strictEqual(auth.canEditHunt(req(owner, 'evilco'), 'beanHunt'), true);
});

test('#1: a hunt owner always edits their OWN hunt regardless of tenant header', () => {
  // beanHunt's owner id is the map key 'beanHunt' here; not admin anywhere.
  assert.strictEqual(auth.canEditHunt(req({ id: 'beanHunt' }, 'evilco'), 'beanHunt'), true);
});

test('#1: invited editor (by id) still edits; a stranger does not', () => {
  auth.initAuth({
    ADMIN_IDS: [], VIP_IDS: [], SESSION_SECRET: 'x', MULTI_TENANT: true,
    tenants, admins,
    hunts: { h: { tenantId: 'bean', invitedEditors: ['friend'] } },
  });
  assert.strictEqual(auth.canEditHunt(req({ id: 'friend' }, 'bean'), 'h'), true);
  assert.strictEqual(auth.canEditHunt(req({ id: 'stranger' }, 'bean'), 'h'), false);
});
