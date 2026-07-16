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

test('validateUpdate accepts a valid/null assignee and rejects an unknown one', () => {
  const validId = cardRequests.ASSIGNEES[0].id;
  assert.strictEqual(cardRequests.validateUpdate({ assignee: validId }), null);
  assert.strictEqual(cardRequests.validateUpdate({ assignee: null }), null, 'null clears assignee');
  assert.strictEqual(cardRequests.validateUpdate({ assignee: '000000000000000000' }), 'Invalid assignee');
});

test('createRequest defaults assignee to null; updateRequest sets and clears it', () => {
  const validId = cardRequests.ASSIGNEES[1].id;
  const r = cardRequests.createRequest({ idea: 'Assign me' }, USER);
  assert.strictEqual(r.assignee, null, 'unassigned on create');

  assert.strictEqual(cardRequests.updateRequest(r.id, { assignee: validId }).assignee, validId);
  // A status-only edit leaves assignee untouched.
  assert.strictEqual(cardRequests.updateRequest(r.id, { status: 'in_progress' }).assignee, validId);
  // null clears it back to unassigned.
  assert.strictEqual(cardRequests.updateRequest(r.id, { assignee: null }).assignee, null);
  cardRequests.deleteRequest(r.id);
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

test('setDiscordMessage stores ids; a status update preserves them', () => {
  const r = cardRequests.createRequest({ idea: 'Discord fields' }, USER);
  const withMsg = cardRequests.setDiscordMessage(r.id, { messageId: '111', channelId: '222' });
  assert.strictEqual(withMsg.discordMessageId, '111');
  assert.strictEqual(withMsg.discordChannelId, '222');

  const afterStatus = cardRequests.updateRequest(r.id, { status: 'in_progress' });
  assert.strictEqual(afterStatus.discordMessageId, '111', 'message id survives a status edit');
  assert.strictEqual(afterStatus.discordChannelId, '222', 'channel id survives a status edit');
  assert.strictEqual(afterStatus.status, 'in_progress');

  assert.strictEqual(cardRequests.setDiscordMessage('cr_nope', { messageId: 'x', channelId: 'y' }), null, 'unknown id → null');
  cardRequests.deleteRequest(r.id);
});

test('getRequest returns the request by id, or null', () => {
  const r = cardRequests.createRequest({ idea: 'find me' }, USER);
  assert.strictEqual(cardRequests.getRequest(r.id).id, r.id);
  assert.strictEqual(cardRequests.getRequest('cr_nope'), null);
  cardRequests.deleteRequest(r.id);
});

test('recordDm appends a capped log entry and stamps lastDmAt without touching status/notes', () => {
  const r = cardRequests.createRequest({ idea: 'dm me' }, USER);
  cardRequests.updateRequest(r.id, { status: 'awaiting_tip', adminNotes: 'keep me' });

  const after1 = cardRequests.recordDm(r.id, { template: 'awaiting_payment', ok: true });
  assert.strictEqual(after1.dmLog.length, 1);
  assert.strictEqual(after1.dmLog[0].template, 'awaiting_payment');
  assert.strictEqual(after1.dmLog[0].ok, true);
  assert.ok(after1.lastDmAt, 'lastDmAt stamped');
  assert.strictEqual(after1.status, 'awaiting_tip', 'status untouched');
  assert.strictEqual(after1.adminNotes, 'keep me', 'notes untouched');

  const after2 = cardRequests.recordDm(r.id, { template: 'awaiting_payment', ok: false, error: 'DMs disabled' });
  assert.strictEqual(after2.dmLog.length, 2);
  assert.strictEqual(after2.dmLog[1].ok, false);
  assert.strictEqual(after2.dmLog[1].error, 'DMs disabled');

  for (let i = 0; i < 12; i++) cardRequests.recordDm(r.id, { template: `t${i}`, ok: true });
  const capped = cardRequests.getRequest(r.id);
  assert.strictEqual(capped.dmLog.length, 10, 'capped at 10');
  assert.strictEqual(capped.dmLog[9].template, 't11', 'newest entry kept');

  assert.strictEqual(cardRequests.recordDm('cr_nope', { template: 'x', ok: true }), null, 'unknown id → null');
  cardRequests.deleteRequest(r.id);
});

test('recordDm stores the message text and sender', () => {
  const r = cardRequests.createRequest({ idea: 'store text' }, USER);
  const after = cardRequests.recordDm(r.id, {
    template: 'awaiting_payment', ok: true,
    message: 'Great news — tip RandyCabbage $25 on Rainbet',
    by: { id: '135203806676779008', name: 'Cabbage' },
  });
  assert.strictEqual(after.dmLog[0].message, 'Great news — tip RandyCabbage $25 on Rainbet');
  assert.deepStrictEqual(after.dmLog[0].by, { id: '135203806676779008', name: 'Cabbage' });
  // Omitting message/by is still valid (legacy-shaped entry).
  const after2 = cardRequests.recordDm(r.id, { template: 'card_ready', ok: true });
  assert.strictEqual(after2.dmLog[1].message, undefined);
  assert.strictEqual(after2.dmLog[1].by, undefined);
  cardRequests.deleteRequest(r.id);
});

test('validateUpdate accepts an itemId string, null to clear, and undefined', () => {
  assert.strictEqual(cardRequests.validateUpdate({ itemId: 'card_cook' }), null);
  assert.strictEqual(cardRequests.validateUpdate({ itemId: null }), null);
  assert.strictEqual(cardRequests.validateUpdate({ status: 'done' }), null);
});

test('validateUpdate rejects a non-string itemId', () => {
  assert.match(cardRequests.validateUpdate({ itemId: 42 }), /invalid item/i);
  assert.match(cardRequests.validateUpdate({ itemId: {} }), /invalid item/i);
});

test('updateRequest links and clears itemId without touching user content', () => {
  const r = cardRequests.createRequest({ idea: 'a flag card' }, USER);
  const linked = cardRequests.updateRequest(r.id, { itemId: 'card_cook' });
  assert.strictEqual(linked.itemId, 'card_cook');
  assert.strictEqual(linked.idea, 'a flag card', 'user content untouched');
  const cleared = cardRequests.updateRequest(r.id, { itemId: null });
  assert.strictEqual(cleared.itemId, null);
});

test('updateRequest leaves itemId alone when the patch omits it', () => {
  const r = cardRequests.createRequest({ idea: 'another card' }, USER);
  cardRequests.updateRequest(r.id, { itemId: 'card_cook' });
  const after = cardRequests.updateRequest(r.id, { status: 'done' });
  assert.strictEqual(after.itemId, 'card_cook', 'a status write must not clear the link');
  assert.strictEqual(after.status, 'done');
});

test('validateAdminCreate rejects a userId that is not a Discord snowflake', () => {
  assert.match(cardRequests.validateAdminCreate({ userId: 'abc', idea: 'x' }), /discord id/i);
  assert.match(cardRequests.validateAdminCreate({ userId: '123', idea: 'x' }), /discord id/i, 'too short');
  assert.match(cardRequests.validateAdminCreate({ userId: '1'.repeat(21), idea: 'x' }), /discord id/i, 'too long');
  assert.match(cardRequests.validateAdminCreate({ idea: 'x' }), /discord id/i, 'missing');
});

test('validateAdminCreate falls through to validateInput once the id is well-formed', () => {
  assert.strictEqual(cardRequests.validateAdminCreate({ userId: USER.id }), 'Tell us your card idea');
  assert.strictEqual(cardRequests.validateAdminCreate({ userId: USER.id, idea: 'A dog card' }), null);
});

test('createRequest records createdBy when filed on behalf, and null when self-submitted', () => {
  const admin = { id: '135203806676779008', name: 'Cabbage' };
  const onBehalf = cardRequests.createRequest({ idea: 'He DMed me this' }, USER, { createdBy: admin });
  assert.deepStrictEqual(onBehalf.createdBy, admin);
  // The requester is still the snapshot — createdBy must never displace who asked for the card.
  assert.strictEqual(onBehalf.userId, USER.id);
  assert.strictEqual(onBehalf.displayName, 'Goofer');
  assert.strictEqual(onBehalf.status, 'new', 'admin-filed requests still start at new');

  const selfServe = cardRequests.createRequest({ idea: 'from the shop' }, USER);
  assert.strictEqual(selfServe.createdBy, null);

  [onBehalf, selfServe].forEach(r => cardRequests.deleteRequest(r.id));
});
