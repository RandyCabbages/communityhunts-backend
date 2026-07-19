const { test } = require('node:test');
const assert = require('node:assert');
const settings = require('./settings');

// These operate on the live module-level sets via the exported test seam.
test('isAnonymousName matches case/space-insensitively', () => {
  settings.__seedAnonForTest({ ids: ['111'], names: ['Big Bird'] });
  assert.equal(settings.isAnonymousName('big bird'), true);
  assert.equal(settings.isAnonymousName('  BIG BIRD '), true);
  assert.equal(settings.isAnonymousName('bigbird'), false); // spaces are normalized, not stripped
  assert.equal(settings.isAnonymousName('someone else'), false);
});

test('shouldMaskIdentity is true on id hit OR name hit, false otherwise', () => {
  settings.__seedAnonForTest({ ids: ['111'], names: ['big bird'] });
  assert.equal(settings.shouldMaskIdentity({ discordId: '111', name: 'whatever' }), true); // id
  assert.equal(settings.shouldMaskIdentity({ discordId: '999', name: 'Big Bird' }), true); // name
  assert.equal(settings.shouldMaskIdentity({ discordId: '999', name: 'Nobody' }), false);
  assert.equal(settings.shouldMaskIdentity({}), false);
});
