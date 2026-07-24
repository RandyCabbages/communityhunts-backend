const { test } = require('node:test');
const assert = require('node:assert');
const { migrateInMemoryHunts, OLD, NEW } = require('./migrateSharedHuntKeys');

test('re-keys the bare tenant hunt and updates its user.id', () => {
  const hunts = { [OLD]: { user: { id: OLD }, bonuses: [{ win: 1 }] } };
  const moved = migrateInMemoryHunts(hunts);
  assert.equal(moved, 1);
  assert.ok(!hunts[OLD], 'old key removed');
  assert.ok(hunts[NEW], 'new key present');
  assert.equal(hunts[NEW].user.id, NEW, 'user.id (embedded in the OBS URL) updated');
  assert.deepEqual(hunts[NEW].bonuses, [{ win: 1 }], 'state carried over intact');
});

test('re-keys namespaced tenant hunts (__mod_hunt__:<id>)', () => {
  const hunts = { [`${OLD}:acme`]: { user: { id: `${OLD}:acme` } } };
  migrateInMemoryHunts(hunts);
  assert.ok(hunts[`${NEW}:acme`]);
  assert.equal(hunts[`${NEW}:acme`].user.id, `${NEW}:acme`);
});

test('leaves affiliate / vip / regular hunts untouched', () => {
  const hunts = {
    '__affiliate_hunt__': { user: { id: '__affiliate_hunt__' } },
    '__vip_hunt__': { user: { id: '__vip_hunt__' } },
    '135203806676779008': { user: { id: '135203806676779008' } },
  };
  const before = JSON.stringify(hunts);
  const moved = migrateInMemoryHunts(hunts);
  assert.equal(moved, 0);
  assert.equal(JSON.stringify(hunts), before, 'no other keys mutated');
});

test('is idempotent and never clobbers an existing new key', () => {
  const hunts = {
    [OLD]: { user: { id: OLD }, bonuses: [{ win: 'old' }] },
    [NEW]: { user: { id: NEW }, bonuses: [{ win: 'new' }] },
  };
  const moved = migrateInMemoryHunts(hunts);
  assert.equal(moved, 0, 'skips when target already exists');
  assert.equal(hunts[NEW].bonuses[0].win, 'new', 'existing new key preserved');
  assert.ok(hunts[OLD], 'old key left in place when target occupied');
  // A second pass on already-migrated data is a no-op.
  const clean = { [NEW]: { user: { id: NEW } } };
  assert.equal(migrateInMemoryHunts(clean), 0);
});
