const test = require('node:test');
const assert = require('node:assert');
const { planImport } = require('./huntBackfill');

const NOW = Date.parse('2026-07-23T00:00:00Z');

// Six months old — Track A would refuse on age; the backfill must accept.
const OLD = () => ({
  externalId: 'm-1', huntType: 'streamer', currency: 'USD',
  startedAt: '2026-01-02T20:00:00Z', endedAt: '2026-01-02T22:00:00Z',
  bonuses: [{ slot: 'Gates of Olympus', bet: 2, win: 184.5 }],
  equity: [{ name: 'Bean', amount: 500 }],
});

const ctx = (over = {}) => ({
  tenantId: 'bean', hostDiscordId: '110983319176384512', now: NOW,
  existingIds: new Set(), isKnownAccount: async () => false, ...over,
});

test('an old hunt is a CREATE (age gate lifted) and carries _approxRate', async () => {
  const plan = await planImport([OLD()], ctx());
  assert.strictEqual(plan.creates.length, 1);
  assert.strictEqual(plan.updates.length, 0);
  assert.strictEqual(plan.rejects.length, 0);
  assert.strictEqual(plan.hunts.length, 1);
  assert.strictEqual(plan.hunts[0]._approxRate, true);
  assert.ok(plan.hunts[0].huntId.startsWith('ext_'));
});

test('a huntId already in existingIds is an UPDATE, not a create', async () => {
  const first = await planImport([OLD()], ctx());
  const id = first.creates[0].huntId;
  const plan = await planImport([OLD()], ctx({ existingIds: new Set([id]) }));
  assert.strictEqual(plan.creates.length, 0);
  assert.strictEqual(plan.updates.length, 1);
  assert.strictEqual(plan.updates[0].huntId, id);
});

test('an invalid row is rejected with its validation code, others still process', async () => {
  const bad = { ...OLD(), externalId: 'm-2', bonuses: [] }; // no_bonuses
  const plan = await planImport([OLD(), bad], ctx());
  assert.strictEqual(plan.creates.length, 1);
  assert.strictEqual(plan.rejects.length, 1);
  assert.strictEqual(plan.rejects[0].index, 1);
  assert.strictEqual(plan.rejects[0].code, 'no_bonuses');
});

test('two rows with the same externalId: second is rejected as a duplicate', async () => {
  const plan = await planImport([OLD(), OLD()], ctx());
  assert.strictEqual(plan.creates.length, 1);
  assert.strictEqual(plan.rejects.length, 1);
  assert.strictEqual(plan.rejects[0].code, 'duplicate_external_id');
  assert.strictEqual(plan.rejects[0].index, 1);
});

test('an unknown equity discordId is stripped and counted; a known one is kept', async () => {
  const withId = () => ({ ...OLD(), equity: [{ name: 'X', amount: 100, discordId: '123456789012345678' }] });
  // isKnownAccount=false → stripped
  const stripped = await planImport([withId()], ctx());
  assert.strictEqual(stripped.creates[0].rejectedIdentities, 1);
  assert.strictEqual(stripped.hunts[0].equity[0].discordId, undefined);
  // isKnownAccount true for that id → kept
  const kept = await planImport([withId()], ctx({ isKnownAccount: async (id) => id === '123456789012345678' }));
  assert.strictEqual(kept.creates[0].rejectedIdentities, 0);
  assert.strictEqual(kept.hunts[0].equity[0].discordId, '123456789012345678');
});
