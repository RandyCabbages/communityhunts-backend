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
  assert.strictEqual(huntCategoryOf({ user: { id: 'u1' }, huntType: 'vip' }), 'vip');
  assert.strictEqual(huntCategoryOf({ user: { id: 'u1' }, huntType: 'community' }), 'community');
  assert.strictEqual(huntCategoryOf({ user: { id: 'u1' }, huntType: 'solo' }), 'solo');
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
// The shared VIP hunt categorizes as plain 'vip' (huntType), unlike affiliate which needs its key.
test('shared vip hunt categorizes as vip', () => {
  const h = { user: { id: vipHuntKey('bean') }, tenantId: 'bean', huntType: 'vip' };
  assert.strictEqual(huntCategoryOf(h), 'vip');
});
