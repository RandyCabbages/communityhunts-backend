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

// ── sanitizeApiConfig (the admin editor's guard) ───────────────────────────────────────────────
// Paired with the resolvers above on purpose: what saves must be what publishes. A value accepted
// here and then rejected on read would look saved and serve something else.

test('a default-equal label is NOT stored — empty means inherit, and inherit stays live', () => {
  // The editor shows defaults as placeholders, so "left it alone" and "typed the default" are
  // indistinguishable at the keyboard. Storing the latter would pin this tenant to today's
  // wording and shadow any future change to DEFAULT_HUNT_TYPE_LABELS.
  const r = A.sanitizeApiConfig({ huntTypeLabels: { streamer: 'Streamer', vip: 'VIP' } });
  assert.ok(r.ok);
  assert.deepStrictEqual(r.value, {});
});

test('a real override is stored, and only that one', () => {
  const r = A.sanitizeApiConfig({ huntTypeLabels: { streamer: 'Mod', vip: 'VIP', solo: '' } });
  assert.deepStrictEqual(r.value, { huntTypeLabels: { streamer: 'Mod' } });
});

test('what sanitize stores is what resolve then publishes', () => {
  // The round trip that makes the editor's preview trustworthy.
  const r = A.sanitizeApiConfig({ huntTypeLabels: { streamer: 'Mod' }, houseHuntTypes: ['community'] });
  const tenant = { ...TENANT, branding: { api: r.value } };
  assert.strictEqual(A.resolveHuntTypeLabels(tenant).streamer, 'Mod');
  assert.deepStrictEqual(A.resolveHouseHuntTypes(tenant), ['community']);
});

test('a default-equal houseHuntTypes selection is not stored either', () => {
  const r = A.sanitizeApiConfig({ houseHuntTypes: ['streamer', 'vip', 'affiliate'] });
  assert.deepStrictEqual(r.value, {});
});

test('rejects loudly rather than quietly normalising', () => {
  for (const [body, why] of [
    [{ houseHuntTypes: 'streamer' }, 'not an array'],
    [{ houseHuntTypes: ['streamer', 'nope'] }, 'unknown type'],
    [{ houseHuntTypes: [] }, 'empty would silently fall back to the defaults on read'],
    [{ huntTypeLabels: [] }, 'array, not object'],
    [{ huntTypeLabels: { nope: 'X' } }, 'unknown type'],
    [{ huntTypeLabels: { vip: 42 } }, 'non-string label'],
  ]) {
    const r = A.sanitizeApiConfig(body);
    assert.strictEqual(r.ok, false, `should have been rejected (${why}): ${JSON.stringify(body)}`);
    assert.ok(r.error, 'a rejection must say why');
  }
});

test('the result is the FULL vocabulary state, so a save can also clear an override', () => {
  // PUT /api/admin/api-vocabulary replaces branding.api wholesale (jsonb_set on '{api}'), which
  // is what makes "reset to default" work at all: submitting the defaults yields {}, and {}
  // resolves back to the platform defaults. The editor therefore submits both fields every time.
  // A merge-on-write would make an override unclearable — sanitize drops default-equal values, so
  // there would be nothing left to overwrite the stored one with.
  const cleared = A.sanitizeApiConfig({
    houseHuntTypes: [...A.DEFAULT_HOUSE_HUNT_TYPES],
    huntTypeLabels: { streamer: 'Streamer' },
  });
  assert.deepStrictEqual(cleared.value, {});
  assert.deepStrictEqual(A.resolveHuntTypeLabels({ branding: { api: cleared.value } }),
    A.DEFAULT_HUNT_TYPE_LABELS);
});

test('a label is trimmed and length-capped, never stored raw', () => {
  const r = A.sanitizeApiConfig({ huntTypeLabels: { streamer: `  ${'M'.repeat(80)}  ` } });
  assert.strictEqual(r.value.huntTypeLabels.streamer.length, 40);
});
