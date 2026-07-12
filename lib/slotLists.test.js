const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const slotLists = require('./slotLists');

// The module persists to slot_lists.json in the backend root when no pgPool is set.
// Remove it after the run so tests leave no artifact.
after(() => {
  try { fs.unlinkSync(path.join(__dirname, '..', 'slot_lists.json')); } catch {}
});

test('validateInput rejects missing name', () => {
  assert.strictEqual(
    slotLists.validateInput({ slots: [{ name: 'Slot' }] }),
    'Name required'
  );
});

test('validateInput rejects empty slots', () => {
  assert.strictEqual(
    slotLists.validateInput({ name: 'Hidden 5 Scatters', slots: [] }),
    'At least one slot required'
  );
});

test('validateInput rejects a slot with no name', () => {
  assert.strictEqual(
    slotLists.validateInput({ name: 'X', slots: [{ slug: 'a' }] }),
    'Each slot needs a name'
  );
});

test('validateInput accepts a well-formed list', () => {
  assert.strictEqual(
    slotLists.validateInput({ name: 'Hidden 5', description: 'd', provider: 'hacksaw',
      slots: [{ name: 'Le Bandit', slug: 'le-bandit', provider: 'hacksaw', thumb: null, rainbetSlug: 'hacksaw-le-bandit' }] }),
    null
  );
});

test('create → list → update → delete round trip', () => {
  const created = slotLists.createSlotList(
    { name: 'Hidden 5', slots: [{ name: 'Le Bandit', slug: 'le-bandit', provider: 'hacksaw' }] },
    '135203806676779008'
  );
  assert.ok(created.id, 'has id');
  assert.strictEqual(created.name, 'Hidden 5');
  assert.strictEqual(created.slots.length, 1);
  assert.strictEqual(created.slots[0].name, 'Le Bandit');
  assert.strictEqual(created.createdBy, '135203806676779008');

  assert.ok(slotLists.listSlotLists().some(l => l.id === created.id), 'appears in list');

  const updated = slotLists.updateSlotList(created.id, {
    name: 'Hidden 5 Scatters', slots: [{ name: 'RIP City', slug: 'rip-city', provider: 'hacksaw' }],
  });
  assert.strictEqual(updated.name, 'Hidden 5 Scatters');
  assert.strictEqual(updated.slots[0].name, 'RIP City');

  assert.strictEqual(slotLists.deleteSlotList(created.id), true);
  assert.strictEqual(slotLists.deleteSlotList(created.id), false, 'second delete is a no-op');
});
