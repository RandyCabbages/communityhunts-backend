// huntCategoryOf is the PUBLIC product label. `huntType` is an internal BEHAVIOUR key —
// it drives equity injection, call-limit defaults and theming, which is why the Affiliate
// Hunt is huntType 'vip' and the streamer's Mod Hunt is 'solo'. What actually distinguishes
// those two is the synthetic user.id key, not the type.
//
// The shared-hunt checks MUST come first: an affiliate hunt satisfies both branches.
const { test } = require('node:test');
const assert = require('node:assert');
const { huntCategoryOf, modHuntKey, affiliateHuntKey } = require('./hunts-core');

test('affiliate hunt is affiliate, not vip', () => {
  const h = { user: { id: affiliateHuntKey('acme') }, tenantId: 'acme', huntType: 'vip' };
  assert.strictEqual(huntCategoryOf(h), 'affiliate');
});

test('mod hunt is streamer, not solo', () => {
  const h = { user: { id: modHuntKey('acme') }, tenantId: 'acme', huntType: 'solo' };
  assert.strictEqual(huntCategoryOf(h), 'streamer');
});

test("bean's legacy unnamespaced shared-hunt keys still resolve", () => {
  assert.strictEqual(huntCategoryOf({ user: { id: affiliateHuntKey('bean') }, tenantId: 'bean', huntType: 'vip' }), 'affiliate');
  assert.strictEqual(huntCategoryOf({ user: { id: modHuntKey('bean') }, tenantId: 'bean', huntType: 'solo' }), 'streamer');
});

test('an untagged hunt is treated as bean (back-compat with tenantOf)', () => {
  assert.strictEqual(huntCategoryOf({ user: { id: modHuntKey('bean') }, huntType: 'solo' }), 'streamer');
});

test("one tenant's shared key does NOT match another tenant's hunt", () => {
  // A regular hunt in tenant 'acme' whose owner id happens to be beans's mod-hunt key
  // must not be relabelled: tenantOf(h) is what selects the expected key.
  const h = { user: { id: modHuntKey('bean') }, tenantId: 'acme', huntType: 'solo' };
  assert.strictEqual(huntCategoryOf(h), 'solo');
});

test('regular hunts fall through to their huntType', () => {
  assert.strictEqual(huntCategoryOf({ user: { id: 'u1' }, huntType: 'community' }), 'community');
  assert.strictEqual(huntCategoryOf({ user: { id: 'u1' }, huntType: 'solo' }), 'solo');
});

// 'vip' is the VIP HUNT, full stop — the per-tenant shared hunt run by mods. It is NOT a label a
// regular hunt can wear. huntType 'vip' remains an internal BEHAVIOUR flag (equity injection,
// call limits, theming) that a mod may set on their own hunt, but that must not surface publicly
// as a VIP hunt: it is a community hunt that happens to be VIP-shaped underneath.
//
// This also means a hunt cannot talk its way into the label. Until 2026-07-29 three routes wrote
// huntType and only two checked reqIsMod, so a regular user could set 'vip' on their own hunt and
// have the Developer API report it as a VIP hunt. The write gate is closed now; this makes the
// READ side stop trusting the field regardless of how it got there.
test('a regular hunt cannot claim the vip label, however its huntType got set', () => {
  assert.strictEqual(huntCategoryOf({ user: { id: 'u1' }, huntType: 'vip' }), 'community');
});

test('an unknown or missing huntType falls back to community', () => {
  assert.strictEqual(huntCategoryOf({ user: { id: 'u1' } }), 'community');
  assert.strictEqual(huntCategoryOf({ user: { id: 'u1' }, huntType: 'nonsense' }), 'community');
});

test('tolerates a malformed hunt', () => {
  assert.strictEqual(huntCategoryOf(null), null);
  assert.strictEqual(huntCategoryOf({}), 'community');
});

const { vipHuntKey, VIP_HUNT_ID } = require('./hunts-core');
test('vipHuntKey mirrors affiliate/mod key shape', () => {
  assert.strictEqual(vipHuntKey('bean'), '__vip_hunt__');
  assert.strictEqual(vipHuntKey('acme'), '__vip_hunt__:acme');
  assert.strictEqual(VIP_HUNT_ID, '__vip_hunt__');
});
// The shared VIP hunt is identified by its KEY, exactly like affiliate and streamer. It used to
// fall through to the huntType branch instead, which is why it was indistinguishable from any
// hunt carrying huntType 'vip' — the one shared hunt of the three with no label of its own.
test('the shared VIP hunt categorizes as vip', () => {
  const h = { user: { id: vipHuntKey('bean') }, tenantId: 'bean', huntType: 'vip' };
  assert.strictEqual(huntCategoryOf(h), 'vip');
});

test('the shared VIP hunt is identified by its KEY, not its huntType', () => {
  const h = { user: { id: vipHuntKey('bean') }, tenantId: 'bean', huntType: 'solo' };
  assert.strictEqual(huntCategoryOf(h), 'vip', 'the key decides, as it does for affiliate/streamer');
});

test("one tenant's vip key does not match another tenant's hunt", () => {
  const h = { user: { id: vipHuntKey('bean') }, tenantId: 'acme', huntType: 'solo' };
  assert.strictEqual(huntCategoryOf(h), 'solo');
});

// The whole point: all three shared hunts are now distinguishable from each other AND from a
// regular hunt. Five public categories, one per product surface.
test('the five public categories are exactly one per product surface', () => {
  const seen = new Set([
    huntCategoryOf({ user: { id: 'u1' }, huntType: 'solo' }),
    huntCategoryOf({ user: { id: 'u1' }, huntType: 'community' }),
    huntCategoryOf({ user: { id: vipHuntKey('bean') }, tenantId: 'bean', huntType: 'vip' }),
    huntCategoryOf({ user: { id: affiliateHuntKey('bean') }, tenantId: 'bean', huntType: 'vip' }),
    huntCategoryOf({ user: { id: modHuntKey('bean') }, tenantId: 'bean', huntType: 'solo' }),
  ]);
  assert.deepStrictEqual([...seen].sort(),
    ['affiliate', 'community', 'solo', 'streamer', 'vip']);
});
