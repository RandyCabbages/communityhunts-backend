const test = require('node:test');
const assert = require('node:assert');
const {
  HUNT_KINDS, DEFAULT_HUNT_KIND_LABELS, resolveHuntKindLabels, sanitizeHuntMeta,
} = require('./huntKinds');

test('the four kinds are the stored vocabulary', () => {
  assert.deepStrictEqual(HUNT_KINDS, ['natty', 'standard', 'buy', 'hidden5']);
});

test('tenant overrides replace only known keys', () => {
  const tenant = { branding: { api: { huntKindLabels: { natty: 'Raw dog', bogus: 'x' } } } };
  const out = resolveHuntKindLabels(tenant);
  assert.strictEqual(out.natty, 'Raw dog');
  assert.strictEqual(out.standard, DEFAULT_HUNT_KIND_LABELS.standard);
  assert.strictEqual(out.bogus, undefined);
});

test('a tenant with no overrides gets the defaults', () => {
  assert.deepStrictEqual(resolveHuntKindLabels({}), DEFAULT_HUNT_KIND_LABELS);
});

test('an unknown kind is dropped, not stored', () => {
  assert.deepStrictEqual(sanitizeHuntMeta({ huntKind: 'megaways' }), {});
});

test('null clears the kind', () => {
  assert.deepStrictEqual(sanitizeHuntMeta({ huntKind: null }), { huntKind: null });
});

test('absent keys stay absent so a partial save cannot blank a field', () => {
  assert.deepStrictEqual(sanitizeHuntMeta({ huntKind: 'buy' }), { huntKind: 'buy' });
});

test('numbers are coerced and floored at zero', () => {
  assert.deepStrictEqual(
    sanitizeHuntMeta({ targetBonuses: '10', betSize: '2.50', buySpend: -5 }),
    { targetBonuses: 10, betSize: 2.5, buySpend: 0 },
  );
});

test('a non-numeric number field is dropped rather than stored as NaN', () => {
  assert.deepStrictEqual(sanitizeHuntMeta({ targetBonuses: 'ten' }), {});
});

test('tournament strings are trimmed and length-capped', () => {
  const out = sanitizeHuntMeta({ isTournament: 1, tournamentRound: '  Quarter final 2  ' });
  assert.strictEqual(out.isTournament, true);
  assert.strictEqual(out.tournamentRound, 'Quarter final 2');
  assert.strictEqual(sanitizeHuntMeta({ tournamentProvider: 'x'.repeat(200) }).tournamentProvider.length, 60);
});

test('an empty string clears a tournament field rather than storing whitespace', () => {
  assert.deepStrictEqual(sanitizeHuntMeta({ tournamentRound: '   ' }), { tournamentRound: null });
});
