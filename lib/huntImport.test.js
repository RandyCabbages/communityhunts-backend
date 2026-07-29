// Everything deciding whether an imported hunt is acceptable lives here as pure functions.
// The 48h guard is the single most important control in the write path: archiveHunt upserts by
// hunt identity, so without it a leaked key can OVERWRITE real history in place, and that history
// feeds Hall of Fame, the ProofBand, caller leaderboards and payout attribution at once.
const { test } = require('node:test');
const assert = require('node:assert');
const { importedHuntId, validateImport, buildImportedHunt, MAX_AGE_MS } = require('./huntImport');
const { modHuntKey, affiliateHuntKey } = require('./hunts-core');

const NOW = Date.parse('2026-07-24T12:00:00.000Z');
const ok = (over = {}) => ({
  externalId: 'stream-1',
  huntType: 'vip',
  currency: 'USD',
  startedAt: '2026-07-24T09:00:00.000Z',
  endedAt: '2026-07-24T11:00:00.000Z',
  bonuses: [{ slot: 'Sugar Rush 1000', bet: 2, win: 431.2 }],
  equity: [{ name: 'Bean', amount: 1000 }],
  ...over,
});

test('the id is deterministic, prefixed, and tenant-scoped', () => {
  assert.strictEqual(importedHuntId('acme', 'x1'), importedHuntId('acme', 'x1'));
  assert.notStrictEqual(importedHuntId('acme', 'x1'), importedHuntId('other', 'x1'));
  assert.notStrictEqual(importedHuntId('acme', 'x1'), importedHuntId('acme', 'x2'));
  assert.match(importedHuntId('acme', 'x1'), /^ext_[0-9a-f]{12}$/);
});

test('a well-formed payload is accepted', () => {
  const r = validateImport(ok(), { now: NOW });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.value.huntType, 'vip');
});

test('externalId is required and bounded', () => {
  assert.strictEqual(validateImport(ok({ externalId: '' }), { now: NOW }).code, 'invalid_external_id');
  assert.strictEqual(validateImport(ok({ externalId: 42 }), { now: NOW }).code, 'invalid_external_id');
  assert.strictEqual(validateImport(ok({ externalId: 'x'.repeat(201) }), { now: NOW }).code, 'invalid_external_id');
});

test('a hunt older than 48h is refused', () => {
  const old = ok({ endedAt: new Date(NOW - MAX_AGE_MS - 1000).toISOString(),
                   startedAt: new Date(NOW - MAX_AGE_MS - 7200_000).toISOString() });
  const r = validateImport(old, { now: NOW });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.code, 'too_old');
});

test('a hunt just inside 48h is allowed', () => {
  const edge = ok({ endedAt: new Date(NOW - MAX_AGE_MS + 60_000).toISOString(),
                    startedAt: new Date(NOW - MAX_AGE_MS).toISOString() });
  assert.strictEqual(validateImport(edge, { now: NOW }).ok, true);
});

test('a future endedAt is refused', () => {
  assert.strictEqual(validateImport(ok({ endedAt: new Date(NOW + 3600_000).toISOString() }), { now: NOW }).code, 'invalid_dates');
});

test('endedAt before startedAt is refused', () => {
  assert.strictEqual(validateImport(ok({ startedAt: '2026-07-24T11:30:00.000Z' }), { now: NOW }).code, 'invalid_dates');
});

test('an empty bonuses array is refused, because archiveHunt would silently no-op', () => {
  assert.strictEqual(validateImport(ok({ bonuses: [] }), { now: NOW }).code, 'no_bonuses');
  assert.strictEqual(validateImport(ok({ bonuses: 'nope' }), { now: NOW }).code, 'no_bonuses');
});

test('only the five public categories are accepted', () => {
  for (const t of ['vip', 'community', 'solo', 'affiliate', 'streamer']) {
    assert.strictEqual(validateImport(ok({ huntType: t }), { now: NOW }).ok, true, t);
  }
  assert.strictEqual(validateImport(ok({ huntType: 'host' }), { now: NOW }).code, 'invalid_hunt_type');
});

test('an unknown currency is refused', () => {
  assert.strictEqual(validateImport(ok({ currency: 'XYZ' }), { now: NOW }).code, 'invalid_currency');
});

test('bonus rows are coerced to numbers, unopened win stays null', () => {
  const r = validateImport(ok({ bonuses: [
    { slot: 'A', bet: '2', win: '10' },
    { slot: 'B', bet: 2 },
  ] }), { now: NOW });
  assert.deepStrictEqual(r.value.bonuses[0], { slot: 'A', bet: 2, win: 10 });
  assert.deepStrictEqual(r.value.bonuses[1], { slot: 'B', bet: 2, win: null });
});

test('win of 0 is preserved, not collapsed into null', () => {
  const r = validateImport(ok({ bonuses: [{ slot: 'Dud', bet: 2, win: 0 }] }), { now: NOW });
  assert.strictEqual(r.value.bonuses[0].win, 0);
});

test('a bonus with no slot name is refused', () => {
  assert.strictEqual(validateImport(ok({ bonuses: [{ bet: 1, win: 2 }] }), { now: NOW }).code, 'invalid_bonus');
});

test('affiliate and streamer build onto the tenant shared-hunt keys', () => {
  const aff = buildImportedHunt(validateImport(ok({ huntType: 'affiliate' }), { now: NOW }).value,
    { tenantId: 'acme', hostDiscordId: '111' });
  assert.strictEqual(aff.user.id, affiliateHuntKey('acme'));
  assert.strictEqual(aff.huntType, 'vip'); // internal behaviour key

  const mod = buildImportedHunt(validateImport(ok({ huntType: 'streamer' }), { now: NOW }).value,
    { tenantId: 'acme', hostDiscordId: '111' });
  assert.strictEqual(mod.user.id, modHuntKey('acme'));
  assert.strictEqual(mod.huntType, 'solo');
});

// The ok() fixture defaults to huntType 'vip', which is no longer a REGULAR hunt — 'vip' is the
// tenant's shared VIP Hunt and now resolves to its key, like affiliate and streamer. This test is
// about the non-shared path, so it has to ask for a non-shared category. The assertion is
// unchanged; only the fixture was wrong for what it claimed to test.
test('a regular hunt is owned by the tenant host', () => {
  const h = buildImportedHunt(validateImport(ok({ huntType: 'community' }), { now: NOW }).value,
    { tenantId: 'acme', hostDiscordId: '111' });
  assert.strictEqual(h.user.id, '111');
  assert.strictEqual(h.huntType, 'community');
});

test('the built hunt is archive-ready and flagged approximate', () => {
  const h = buildImportedHunt(validateImport(ok(), { now: NOW }).value, { tenantId: 'acme', hostDiscordId: '111' });
  assert.strictEqual(h.huntId, importedHuntId('acme', 'stream-1'));
  assert.strictEqual(h.tenantId, 'acme');
  assert.strictEqual(h.isLive, false);
  assert.strictEqual(h.archivedAt, '2026-07-24T11:00:00.000Z');
  // FX is latest-only, so an imported hunt must never claim a rate it does not have.
  assert.strictEqual(h._approxRate, true);
  assert.strictEqual(h.externalId, 'stream-1');
});

test('equity rows are coerced and a non-array becomes empty', () => {
  const h = buildImportedHunt(validateImport(ok({ equity: [
    { name: 'A', amount: '50', discordId: 12345 },
    { name: 42, amount: 'x' },
  ] }), { now: NOW }).value, { tenantId: 'acme', hostDiscordId: '111' });
  assert.strictEqual(h.equity[0].name, 'A');
  assert.strictEqual(h.equity[0].amount, 50);
  assert.strictEqual(h.equity[0].discordId, '12345');
  assert.strictEqual(h.equity[1].name, '');
  assert.strictEqual(h.equity[1].amount, 0);
  const none = buildImportedHunt(validateImport(ok({ equity: 'nope' }), { now: NOW }).value, { tenantId: 'acme', hostDiscordId: '111' });
  assert.deepStrictEqual(none.equity, []);
});

test('validateImport age gate: default rejects >48h, maxAgeMs Infinity accepts', () => {
  const now = Date.parse('2026-07-23T00:00:00Z');
  const oldHunt = {
    externalId: 'm-old-1', huntType: 'streamer', currency: 'USD',
    startedAt: '2026-01-02T20:00:00Z', endedAt: '2026-01-02T22:00:00Z',
    bonuses: [{ slot: 'Gates of Olympus', bet: 2, win: 184.5 }],
  };
  // Default (Track A) — six months old, refused.
  const def = validateImport(oldHunt, { now });
  assert.strictEqual(def.ok, false);
  assert.strictEqual(def.code, 'too_old');
  // Backfill — same payload, age gate lifted.
  const back = validateImport(oldHunt, { now, maxAgeMs: Infinity });
  assert.strictEqual(back.ok, true);
  // A future hunt is STILL rejected regardless of maxAgeMs.
  const future = validateImport({ ...oldHunt, startedAt: '2026-08-01T20:00:00Z', endedAt: '2026-08-01T22:00:00Z' },
    { now, maxAgeMs: Infinity });
  assert.strictEqual(future.ok, false);
  assert.strictEqual(future.code, 'invalid_dates');
});

// ── Every public category must round-trip through import ──────────────────────────────────
// buildImportedHunt turns a public category into a stored hunt; huntCategoryOf turns a stored
// hunt back into a public category. Those two are inverses or the import API is lying about what
// it created. `affiliate` and `streamer` resolve to the tenant's shared-hunt KEY; `vip` did not,
// so importing a VIP hunt silently produced a regular hunt owned by the tenant host that merely
// carried huntType 'vip' — the one public category the API could not actually create.
const { huntCategoryOf, vipHuntKey } = require('./hunts-core');

const PUBLIC_CATEGORIES = ['solo', 'community', 'vip', 'affiliate', 'streamer'];

test('every public category round-trips through import', () => {
  for (const category of PUBLIC_CATEGORIES) {
    const built = buildImportedHunt(
      { externalId: `x-${category}`, huntType: category, currency: 'USD',
        startedAt: Date.parse('2026-07-01T00:00:00Z'), endedAt: Date.parse('2026-07-01T01:00:00Z'),
        bonuses: [], equity: [] },
      { tenantId: 'bean', hostDiscordId: '135203806676779008' });
    assert.strictEqual(huntCategoryOf(built), category,
      `category "${category}" did not survive the round trip`);
  }
});

test('importing a vip hunt targets the tenant\'s shared VIP hunt key', () => {
  const built = buildImportedHunt(
    { externalId: 'x1', huntType: 'vip', currency: 'USD',
      startedAt: Date.parse('2026-07-01T00:00:00Z'), endedAt: Date.parse('2026-07-01T01:00:00Z'),
      bonuses: [], equity: [] },
    { tenantId: 'acme', hostDiscordId: '999' });

  assert.strictEqual(built.user.id, vipHuntKey('acme'));
  assert.strictEqual(built.huntType, 'vip', 'the internal behaviour flag is still vip-shaped');
});
