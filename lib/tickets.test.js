// lib/tickets.js — persistence store for bug-tickets / feature-suggestions.
// File-fallback only here (pgPool: null); we delete the JSON file around the run so module
// state starts empty and deterministic.
const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'tickets.json');
const rmFile = () => { try { fs.unlinkSync(FILE); } catch {} };

const tickets = require('./tickets');

beforeEach(async () => {
  rmFile();
  await tickets.initTickets({ pgPool: null }); // resets in-memory list to []
});
after(rmFile);

test('createTicket (anonymous) — status new, userId null, snapshots fields', () => {
  const t = tickets.createTicket(
    { type: 'Bug', issue: 'reel froze', username: 'Anonymous', discordChannel: 'tickets' },
    null
  );
  assert.strictEqual(t.status, 'new');
  assert.strictEqual(t.userId, null);
  assert.strictEqual(t.displayName, null);
  assert.strictEqual(t.avatar, null);
  assert.strictEqual(t.type, 'Bug');
  assert.strictEqual(t.issue, 'reel froze');
  assert.strictEqual(t.username, 'Anonymous');
  assert.strictEqual(t.discordChannel, 'tickets');
  assert.strictEqual(t.adminNotes, '');
  assert.ok(t.id && t.createdAt && t.updatedAt);
});

test('createTicket (logged in) — snapshots identity', () => {
  const t = tickets.createTicket(
    { type: 'Feature Request', issue: 'dark mode', username: 'Bean', discordChannel: 'suggestions' },
    { id: '123', displayName: 'Bean', avatar: 'http://x/a.png' }
  );
  assert.strictEqual(t.userId, '123');
  assert.strictEqual(t.displayName, 'Bean');
  assert.strictEqual(t.avatar, 'http://x/a.png');
});

test('listTickets is newest-first', () => {
  tickets.createTicket({ type: 'Bug', issue: 'first', username: 'a', discordChannel: 'tickets' }, null);
  const b = tickets.createTicket({ type: 'Bug', issue: 'second', username: 'a', discordChannel: 'tickets' }, null);
  const list = tickets.listTickets();
  assert.strictEqual(list.length, 2);
  assert.strictEqual(list[0].id, b.id); // newest first
  assert.strictEqual(list[0].issue, 'second');
});

test('store caps at 500 newest', () => {
  for (let i = 0; i < 501; i++)
    tickets.createTicket({ type: 'Bug', issue: `n${i}`, username: 'a', discordChannel: 'tickets' }, null);
  const list = tickets.listTickets();
  assert.strictEqual(list.length, 500);
  assert.strictEqual(list[0].issue, 'n500');   // newest kept
  assert.ok(!list.some(t => t.issue === 'n0')); // oldest dropped
});

test('validateUpdate: rejects bad status + long notes, accepts good', () => {
  assert.ok(tickets.validateUpdate({ status: 'nope' }));            // error string
  assert.ok(tickets.validateUpdate({ adminNotes: 'x'.repeat(2001) }));
  assert.strictEqual(tickets.validateUpdate({ status: 'resolved' }), null);
  assert.strictEqual(tickets.validateUpdate({ adminNotes: 'ok' }), null);
});

test('updateTicket patches status + adminNotes, leaves issue', () => {
  const t = tickets.createTicket({ type: 'Bug', issue: 'keep me', username: 'a', discordChannel: 'tickets' }, null);
  const u = tickets.updateTicket(t.id, { status: 'in_progress', adminNotes: 'looking' });
  assert.strictEqual(u.status, 'in_progress');
  assert.strictEqual(u.adminNotes, 'looking');
  assert.strictEqual(u.issue, 'keep me');
  assert.strictEqual(tickets.updateTicket('missing', { status: 'closed' }), null);
});

test('setDiscordMessage attaches ids without touching status', () => {
  const t = tickets.createTicket({ type: 'Bug', issue: 'x', username: 'a', discordChannel: 'tickets' }, null);
  const u = tickets.setDiscordMessage(t.id, { messageId: 'm1', channelId: 'c1' });
  assert.strictEqual(u.discordMessageId, 'm1');
  assert.strictEqual(u.discordChannelId, 'c1');
  assert.strictEqual(u.status, 'new'); // unchanged
});

test('deleteTicket removes and reports', () => {
  const t = tickets.createTicket({ type: 'Bug', issue: 'x', username: 'a', discordChannel: 'tickets' }, null);
  assert.strictEqual(tickets.deleteTicket(t.id), true);
  assert.strictEqual(tickets.deleteTicket(t.id), false);
  assert.strictEqual(tickets.listTickets().length, 0);
});

test('STATUSES enumerates the 4 phases', () => {
  assert.deepStrictEqual(tickets.STATUSES, ['new', 'in_progress', 'resolved', 'closed']);
});

test('createTicket stores a context object when provided', () => {
  const ctx = { route: '/bean/hunt', viewport: { w: 1440, h: 900 } };
  const t = tickets.createTicket(
    { type: 'Bug', issue: 'layout broke', username: 'Anonymous', discordChannel: 'tickets', context: ctx },
    null
  );
  assert.deepStrictEqual(t.context, ctx);
});

test('createTicket sets context null when absent (pre-existing tickets)', () => {
  const t = tickets.createTicket(
    { type: 'Bug', issue: 'no context', username: 'Anonymous', discordChannel: 'tickets' },
    null
  );
  assert.strictEqual(t.context, null);
});
