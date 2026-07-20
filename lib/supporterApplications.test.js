const { test } = require('node:test');
const assert = require('node:assert');
const lib = require('./supporterApplications');

test('validateInput requires an amount', () => {
  assert.equal(lib.validateInput({ amount: '', message: 'hi' }), 'Enter a donation amount');
  assert.equal(lib.validateInput({ amount: '$25' }), null);
});

test('validateInput caps message length', () => {
  assert.equal(lib.validateInput({ amount: '10', message: 'x'.repeat(2001) }), 'Message too long (max 2000 characters)');
});

test('createApplication snapshots the user and defaults to new', () => {
  const r = lib.createApplication({ amount: '25', message: 'love it' }, { id: 'u1', displayName: 'Kyle', avatar: 'a.png' });
  assert.equal(r.status, 'new');
  assert.equal(r.userId, 'u1');
  assert.equal(r.displayName, 'Kyle');
  assert.equal(r.amount, '25');
  assert.equal(r.message, 'love it');
  assert.ok(r.id.startsWith('sa_'));
});

test('openCountFor counts only open statuses', () => {
  const r = lib.createApplication({ amount: '5' }, { id: 'u2' });
  assert.equal(lib.openCountFor('u2'), 1);
  lib.updateApplication(r.id, { status: 'declined' });
  assert.equal(lib.openCountFor('u2'), 0);
});

test('validateUpdate rejects a bad status', () => {
  assert.equal(lib.validateUpdate({ status: 'bogus' }), 'Invalid status');
  assert.equal(lib.validateUpdate({ status: 'granted' }), null);
});
