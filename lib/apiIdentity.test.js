const { test } = require('node:test');
const assert = require('node:assert');

process.env.PUBLIC_ID_SECRET = process.env.PUBLIC_ID_SECRET || 'test-public-id-secret';

const A = require('./apiIdentity');
const { publicOwnerId } = require('./publicIds');
const { modHuntKey, vipHuntKey, affiliateHuntKey, PUBLIC_HUNT_CATEGORIES } = require('./hunts-core');
const { LIMITS, WRITE_LIMITS } = require('./rateLimit');

const TENANT = {
  id: 'acme', slug: 'acme', displayName: 'Acme Slots',
  hostDiscordId: '110983319176384512',
  branding: { hostName: 'Dave' },
};

const me = (over = {}) => A.buildApiMe({
  tenant: { ...TENANT, ...over }, tier: 'partner', scopes: ['read', 'write'],
  limits: LIMITS, writeLimits: WRITE_LIMITS,
});

test('reports the key, not the tenant row — tier, scopes and the limits actually enforced', () => {
  const out = me();
  assert.strictEqual(out.key.tier, 'partner');
  assert.deepStrictEqual(out.key.scopes, ['read', 'write']);
  assert.strictEqual(out.key.rateLimit.readPerMin, LIMITS.partner.perMin);
  assert.strictEqual(out.key.rateLimit.readPerHour, LIMITS.partner.perHour);
  assert.strictEqual(out.key.rateLimit.writePerMin, WRITE_LIMITS.partner.perMin);
  assert.strictEqual(out.key.rateLimit.writePerHour, WRITE_LIMITS.partner.perHour);
});

test('unknown tier falls back to the pro limits rather than serving nulls', () => {
  const out = A.buildApiMe({ tenant: TENANT, tier: 'nonsense', scopes: ['read'],
    limits: LIMITS, writeLimits: WRITE_LIMITS });
  assert.strictEqual(out.key.rateLimit.readPerMin, LIMITS.pro.perMin);
});

test('absent scopes default to read-only — never an implied write grant', () => {
  const out = A.buildApiMe({ tenant: TENANT, tier: 'pro', scopes: undefined,
    limits: LIMITS, writeLimits: WRITE_LIMITS });
  assert.deepStrictEqual(out.key.scopes, ['read']);
});

// The whole point of the endpoint: the value an integrator otherwise pastes into a config file.
test('streamer.id is the SAME opaque id the hunt endpoints publish for that owner', () => {
  const out = me();
  assert.strictEqual(out.streamer.id, publicOwnerId('acme', TENANT.hostDiscordId));
  assert.ok(out.streamer.id.startsWith('usr_'));
  // A raw Discord id must never leave this API, /me included.
  assert.ok(!JSON.stringify(out).includes(TENANT.hostDiscordId));
});

test('streamer.name follows the same host-name resolution as the rest of the codebase', () => {
  assert.strictEqual(me().streamer.name, 'Dave');
  assert.strictEqual(me({ branding: {} }).streamer.name, 'Acme Slots');
});

test('streamer is null when the community has no host configured', () => {
  assert.strictEqual(me({ hostDiscordId: null }).streamer, null);
});

// The correction that cost the first integration its wrong guess.
test('houseOwnerIds are the SHARED-RUN owners, all distinct from the streamer', () => {
  const out = me();
  assert.strictEqual(out.houseOwnerIds.streamer, publicOwnerId('acme', modHuntKey('acme')));
  assert.strictEqual(out.houseOwnerIds.vip, publicOwnerId('acme', vipHuntKey('acme')));
  assert.strictEqual(out.houseOwnerIds.affiliate, publicOwnerId('acme', affiliateHuntKey('acme')));
  const ids = Object.values(out.houseOwnerIds);
  assert.strictEqual(new Set(ids).size, 3, 'the three runs must not collide');
  assert.ok(!ids.includes(out.streamer.id), 'a house run is NOT owned by the host');
});

test('house owner ids are tenant-scoped — two communities never share one', () => {
  const acme = me().houseOwnerIds;
  const other = me({ id: 'other', slug: 'other' }).houseOwnerIds;
  assert.notStrictEqual(acme.streamer, other.streamer);
});

test('defaults: the three shared runs, and a label for every published hunt type', () => {
  const out = me();
  assert.deepStrictEqual(out.houseHuntTypes, ['streamer', 'vip', 'affiliate']);
  assert.deepStrictEqual(out.huntTypes, PUBLIC_HUNT_CATEGORIES);
  for (const t of PUBLIC_HUNT_CATEGORIES) {
    assert.strictEqual(typeof out.huntTypeLabels[t], 'string', `no label for ${t}`);
  }
});

test('per-tenant policy overrides both lists', () => {
  const out = me({ branding: { api: {
    houseHuntTypes: ['community'],
    huntTypeLabels: { streamer: 'Mod', community: 'Open Hunt' },
  } } });
  assert.deepStrictEqual(out.houseHuntTypes, ['community']);
  assert.strictEqual(out.huntTypeLabels.streamer, 'Mod');
  assert.strictEqual(out.huntTypeLabels.community, 'Open Hunt');
  // Untouched types keep the platform default — the map stays total.
  assert.strictEqual(out.huntTypeLabels.vip, 'VIP');
});

test('a misconfigured override falls back rather than publishing junk as API truth', () => {
  const bogus = me({ branding: { api: {
    houseHuntTypes: ['nope', 'alsonope'],
    huntTypeLabels: { nope: 'Nope', vip: 42, solo: '   ' },
  } } });
  assert.deepStrictEqual(bogus.houseHuntTypes, A.DEFAULT_HOUSE_HUNT_TYPES);
  assert.strictEqual(bogus.huntTypeLabels.nope, undefined);
  assert.strictEqual(bogus.huntTypeLabels.vip, 'VIP');
  assert.strictEqual(bogus.huntTypeLabels.solo, 'Solo');
});

test('override survives validation partially — the valid entries still apply', () => {
  const out = me({ branding: { api: { houseHuntTypes: ['streamer', 'bogus', 'streamer'] } } });
  assert.deepStrictEqual(out.houseHuntTypes, ['streamer']);
});

test('non-object branding.api is ignored, not thrown on', () => {
  for (const api of [null, 'nope', 42, []]) {
    const out = me({ branding: { api } });
    assert.deepStrictEqual(out.houseHuntTypes, A.DEFAULT_HOUSE_HUNT_TYPES);
  }
});

test('community identifies itself by slug and display name', () => {
  const out = me();
  assert.strictEqual(out.community.slug, 'acme');
  assert.strictEqual(out.community.name, 'Acme Slots');
  assert.strictEqual(me({ displayName: null }).community.name, 'acme');
});

// Guards the doc's reasoning: a tenant-level currency/timezone would be invented, and the one thing
// a consumer does with it is pick a formatter — which is how an ARS hunt renders as dollars.
test('does NOT invent a community-wide currency or timezone', () => {
  const out = me();
  assert.ok(!('defaultCurrency' in out.community));
  assert.ok(!('timezone' in out.community));
});
