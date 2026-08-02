const { test } = require('node:test');
const assert = require('node:assert/strict');
const { partitionGrants, isGrandfathered } = require('./grandfatherRevoke');

const row = (id, by) => ({ discord_id: id, granted_by: by });

test('grandfathered rows are the only revocation candidates', () => {
  const p = partitionGrants([
    row('1', 'grandfather'),
    row('2', 'grandfather-by-135203806676779008'),
    row('3', 'stripe-sub'),
    row('4', '135203806676779008'),   // deliberate admin comp
    row('5', null),                   // predates granted_by
  ]);
  assert.deepStrictEqual(p.grandfathered.map(r => r.discord_id), ['1', '2']);
  assert.deepStrictEqual(p.stripeRows.map(r => r.discord_id), ['3']);
  assert.deepStrictEqual(p.comps.map(r => r.discord_id), ['4']);
  assert.deepStrictEqual(p.ambiguous.map(r => r.discord_id), ['5']);
});

// THE WHOLE POINT. A grandfathered row belonging to someone Stripe says is paying must be
// re-stamped, never deleted — the webhook's ON CONFLICT DO NOTHING means their row still reads
// 'grandfather-by-…' even though they subscribed.
test('a grandfathered row for an ACTIVE PAYER is protected, not deleted', () => {
  const p = partitionGrants(
    [row('payer', 'grandfather-by-admin'), row('freeloader', 'grandfather-by-admin')],
    new Set(['payer']));
  assert.deepStrictEqual(p.atRisk.map(r => r.discord_id), ['payer']);
  assert.deepStrictEqual(p.toDelete.map(r => r.discord_id), ['freeloader']);
});

test('atRisk and toDelete never overlap, and together cover every grandfathered row', () => {
  const rows = [row('a', 'grandfather'), row('b', 'grandfather'), row('c', 'grandfather')];
  const p = partitionGrants(rows, new Set(['b']));
  const ids = new Set([...p.atRisk, ...p.toDelete].map(r => r.discord_id));
  assert.strictEqual(p.atRisk.length + p.toDelete.length, p.grandfathered.length);
  assert.strictEqual(ids.size, rows.length, 'a row must not land in both buckets');
});

// Ids arrive from Postgres as strings and from Stripe metadata as strings, but a caller building
// the payer set from JSON could hand over numbers. A type mismatch here silently deletes a payer.
test('payer matching is not defeated by a numeric id', () => {
  const p = partitionGrants([row(123, 'grandfather')], new Set(['123']));
  assert.deepStrictEqual(p.atRisk.map(r => String(r.discord_id)), ['123']);
  assert.strictEqual(p.toDelete.length, 0);
});

// Nothing outside the grandfather set may ever be deleted, whatever the payer set says.
test('stripe, comp and NULL rows are never revocation candidates', () => {
  const rows = [row('s', 'stripe-sub'), row('c', 'someadminid'), row('n', null)];
  for (const payers of [new Set(), new Set(['s', 'c', 'n'])]) {
    const p = partitionGrants(rows, payers);
    assert.strictEqual(p.toDelete.length, 0);
    assert.strictEqual(p.grandfathered.length, 0);
  }
});

test('an empty table is a clean no-op', () => {
  const p = partitionGrants([], new Set());
  assert.strictEqual(p.grandfathered.length, 0);
  assert.strictEqual(p.toDelete.length, 0);
});

test('isGrandfathered matches both writers and nothing else', () => {
  assert.ok(isGrandfathered('grandfather'));
  assert.ok(isGrandfathered('grandfather-by-135203806676779008'));
  assert.ok(!isGrandfathered('stripe-sub'));
  assert.ok(!isGrandfathered('135203806676779008'));
  assert.ok(!isGrandfathered(null));
  assert.ok(!isGrandfathered(undefined));
});
