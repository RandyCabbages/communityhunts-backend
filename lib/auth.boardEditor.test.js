// requireBoardEditor — the gate for the two shared singleton hunts (affiliate + VIP).
//
// Those hunts have no owner Discord id to hang canEditHunt off, so every route on them was
// requireMod: "the mod crew, or nobody". This gate adds a per-hunt layer underneath it, so a
// host can invite a named helper to run the BOARD without handing them the mod role.
//
// The last test here is the load-bearing one: board editors live in their OWN field, because
// canEditHunt reads invitedEditors and is the gate on the generic /api/hunts/:userId/* family
// (full unsanitised hunt write, invite-more-people, share tokens). Reusing that field would have
// made "board only" silently mean "everything a hunt owner can do".
const { test } = require('node:test');
const assert = require('node:assert');
const auth = require('./auth');

const AFF_KEY = '__affiliate_hunt__:bean';
const hunts = {};

auth.initAuth({
  ADMIN_IDS: [], VIP_IDS: [], SESSION_SECRET: 'x', MULTI_TENANT: true,
  tenants: {
    isPlatformOwnerId: (id) => id === 'OWNER',
    isTenantAdmin: (u, t) => !!(u && t && (t.adminIds || []).includes(u.id)),
    isTenantMod:   (u, t) => !!(u && t && (t.modIds   || []).includes(u.id)),
    BEAN_TENANT: { id: 'bean' },
  },
  admins: { isDbAdmin: () => false },
  hunts, recordKnownUser() {},
});

const TENANT = { id: 'bean', adminIds: ['A1'], modIds: ['M1'] };
const gate = () => auth.requireBoardEditor(() => AFF_KEY);

function run(req) {
  let status = 200, called = false, body = null;
  const res = { status(c) { status = c; return this; }, json(b) { body = b; return this; } };
  gate()(req, res, () => { called = true; });
  return { status, called, body };
}

// Reset the shared slot before each scenario — these mutate a module-level map by reference.
function setHunt(h) {
  for (const k of Object.keys(hunts)) delete hunts[k];
  if (h) hunts[AFF_KEY] = h;
}

test('a mod passes — the existing crew keeps its access', () => {
  setHunt({ boardEditors: [] });
  assert.strictEqual(run({ user: { id: 'M1' }, tenant: TENANT }).called, true);
});

test('a platform owner passes even with no hunt in the slot', () => {
  setHunt(null);
  assert.strictEqual(run({ user: { id: 'OWNER' }, tenant: TENANT }).called, true);
});

test('an invited board editor passes without being a mod', () => {
  setHunt({ boardEditors: ['HELPER'] });
  assert.strictEqual(run({ user: { id: 'HELPER' }, tenant: TENANT }).called, true);
});

test('board editors match by id, never by display name', () => {
  setHunt({ boardEditors: ['HELPER'] });
  const r = run({ user: { id: 'imposter', displayName: 'HELPER' }, tenant: TENANT });
  assert.strictEqual(r.called, false);
  assert.strictEqual(r.status, 403);
});

// Both sides are String()-normalised so a non-string entry (a hand-written fixture, a JSON round
// trip) still matches. Note this can only ever rescue a SHORT id: a real Discord snowflake is a
// 64-bit number that loses precision as a JS number (110983319176384512 → …384500), so ids must
// be stored as strings. The routes below only ever write String(userId).
test('a non-string entry still matches a string user id', () => {
  setHunt({ boardEditors: [12345] });
  assert.strictEqual(run({ user: { id: '12345' }, tenant: TENANT }).called, true);
});

test('an unlisted user is refused (403)', () => {
  setHunt({ boardEditors: ['HELPER'] });
  const r = run({ user: { id: 'nobody' }, tenant: TENANT });
  assert.strictEqual(r.called, false);
  assert.strictEqual(r.status, 403);
});

test('a signed-out request is 401, not 403', () => {
  setHunt({ boardEditors: ['HELPER'] });
  assert.strictEqual(run({ user: null, tenant: TENANT }).status, 401);
});

// Invites live on the hunt object, so an empty slot has nobody to admit. A non-mod cannot be
// invited to a hunt that does not exist yet.
test('an empty slot refuses a non-mod (403) — there is no hunt to be invited to', () => {
  setHunt(null);
  const r = run({ user: { id: 'HELPER' }, tenant: TENANT });
  assert.strictEqual(r.called, false);
  assert.strictEqual(r.status, 403);
});

test('a hunt with no boardEditors field at all refuses a non-mod', () => {
  setHunt({ bonuses: [] });
  assert.strictEqual(run({ user: { id: 'HELPER' }, tenant: TENANT }).status, 403);
});

// ── The escalation guard ────────────────────────────────────────────────────
// canEditHunt is the gate on PUT /api/hunts/:userId, POST /api/hunts/:userId/invite and friends.
// A board editor must NOT satisfy it: those routes bypass the shared hunt's own sanitizers and
// would let a board-only helper invite more people.
test('a board editor does NOT satisfy canEditHunt — no reach into /api/hunts/:userId/*', () => {
  setHunt({ boardEditors: ['HELPER'], invitedEditors: [] });
  const req = { user: { id: 'HELPER' }, tenant: TENANT };
  assert.strictEqual(auth.canEditHunt(req, AFF_KEY), false);
});

test('invitedEditors still works on normal hunts — this change adds a field, it moves nothing', () => {
  setHunt(null);
  hunts.somebody = { invitedEditors: ['FRIEND'] };
  assert.strictEqual(auth.canEditHunt({ user: { id: 'FRIEND' }, tenant: TENANT }, 'somebody'), true);
});
