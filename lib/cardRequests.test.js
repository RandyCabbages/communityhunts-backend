const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const cardRequests = require('./cardRequests');

// With no pgPool configured the module persists to card_requests.json in the
// backend root (file fallback). Remove it after the run so tests leave no artifact.
after(() => {
  try { fs.unlinkSync(path.join(__dirname, '..', 'card_requests.json')); } catch {}
});

const USER = { id: '168055630916091904', displayName: 'Goofer', avatar: 'https://cdn.discordapp.com/a.png' };

test('validateInput rejects a missing idea', () => {
  assert.strictEqual(cardRequests.validateInput({}), 'Tell us your card idea');
  assert.strictEqual(cardRequests.validateInput({ idea: '   ' }), 'Tell us your card idea');
});

test('validateInput rejects an oversized idea', () => {
  assert.match(cardRequests.validateInput({ idea: 'x'.repeat(2001) }), /too long/i);
});

test('validateInput accepts a well-formed body', () => {
  assert.strictEqual(
    cardRequests.validateInput({ idea: 'A card with my dog on it', cardName: 'Doge', refLinks: ['https://i.imgur.com/x.png'], rainbetUsername: 'goof' }),
    null
  );
});

test('validateUpdate rejects an unknown status and oversized notes', () => {
  assert.strictEqual(cardRequests.validateUpdate({ status: 'archived' }), 'Invalid status');
  assert.match(cardRequests.validateUpdate({ adminNotes: 'x'.repeat(2001) }), /too long/i);
  assert.strictEqual(cardRequests.validateUpdate({ status: 'awaiting_tip', adminNotes: 'tip requested 7/13' }), null);
});

test('createRequest sanitizes links: drops non-http(s), caps at 5', () => {
  const r = cardRequests.createRequest({
    idea: 'Link test',
    refLinks: ['https://a.com/1', 'javascript:alert(1)', 'ftp://b.com', 'http://c.com/2',
               'https://d.com/3', 'https://e.com/4', 'https://f.com/5', 'https://g.com/6'],
  }, USER);
  assert.deepStrictEqual(r.refLinks, ['https://a.com/1', 'http://c.com/2', 'https://d.com/3', 'https://e.com/4', 'https://f.com/5']);
  cardRequests.deleteRequest(r.id);
});

test('createRequest snapshots the session user and defaults', () => {
  const r = cardRequests.createRequest({ idea: 'Snapshot test' }, USER);
  assert.strictEqual(r.userId, USER.id);
  assert.strictEqual(r.displayName, 'Goofer');
  assert.strictEqual(r.avatar, USER.avatar);
  assert.strictEqual(r.status, 'new');
  assert.strictEqual(r.adminNotes, '');
  assert.ok(r.id && r.createdAt && r.updatedAt);
  cardRequests.deleteRequest(r.id);
});

test('openCountFor counts only open statuses', () => {
  const a = cardRequests.createRequest({ idea: 'one' }, USER);
  const b = cardRequests.createRequest({ idea: 'two' }, USER);
  const c = cardRequests.createRequest({ idea: 'three' }, USER);
  assert.strictEqual(cardRequests.openCountFor(USER.id), 3);
  cardRequests.updateRequest(b.id, { status: 'done' });
  cardRequests.updateRequest(c.id, { status: 'declined' });
  assert.strictEqual(cardRequests.openCountFor(USER.id), 1);
  assert.strictEqual(cardRequests.openCountFor('999'), 0);
  [a, b, c].forEach(r => cardRequests.deleteRequest(r.id));
});

test('create → list → update → delete round trip', () => {
  const r = cardRequests.createRequest({ idea: 'Round trip', cardName: 'RT' }, USER);
  assert.ok(cardRequests.listRequests().some(x => x.id === r.id), 'appears in list');

  const updated = cardRequests.updateRequest(r.id, { status: 'awaiting_tip', adminNotes: 'approved, DMed for tip' });
  assert.strictEqual(updated.status, 'awaiting_tip');
  assert.strictEqual(updated.adminNotes, 'approved, DMed for tip');
  assert.strictEqual(updated.idea, 'Round trip', 'user content untouched');

  assert.strictEqual(cardRequests.updateRequest('cr_nope', { status: 'done' }), null, 'unknown id → null');
  assert.strictEqual(cardRequests.deleteRequest(r.id), true);
  assert.strictEqual(cardRequests.deleteRequest(r.id), false, 'second delete is a no-op');
});
