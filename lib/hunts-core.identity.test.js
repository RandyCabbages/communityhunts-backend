// Identity must survive a client save. See preserveRowIdentity in hunts-core.js for the round
// trip that was silently deleting it.
const test = require('node:test');
const assert = require('node:assert');
const { preserveRowIdentity, publicHuntView, initialEquity } = require('./hunts-core');

const HOST = '168055630916091904';

test('THE BUG: a masked round trip no longer clears a seeded host identity', () => {
  // 1. Server seeds the hunt. The creator row carries a real, authenticated id.
  const hunt = {
    equity: initialEquity('community', { id: HOST, displayName: 'Goofer' }, null, 0),
    calls: [], bonuses: [],
  };
  assert.strictEqual(hunt.equity[0].discordId, HOST, 'seed must stamp the creator');

  // 2. It goes out over the socket, where publicHuntView strips internal linkage.
  const asClientSeesIt = publicHuntView(hunt);
  assert.strictEqual(asClientSeesIt.equity[0].discordId, undefined, 'masking drops the id');

  // 3. The client adopts those rows and saves them straight back. Before the fix this assignment
  //    was `hunt.equity = incoming`, which destroyed the id the server itself had established.
  const saved = preserveRowIdentity(hunt.equity, asClientSeesIt.equity, 'discordId');
  assert.strictEqual(saved[0].discordId, HOST, 'a blank must never clear a known identity');
});

test('a client MAY still add an identity to a row that had none', () => {
  const prev = [{ id: 'r1', name: 'Cabbage' }];
  const next = [{ id: 'r1', name: 'Cabbage', discordId: '135203806676779008' }];
  assert.strictEqual(preserveRowIdentity(prev, next, 'discordId')[0].discordId, '135203806676779008');
});

test('a client MAY change an identity — an explicit pick is a correction, not a clear', () => {
  const prev = [{ id: 'r1', name: 'Cabbage', discordId: '111111111111111111' }];
  const next = [{ id: 'r1', name: 'Bean', discordId: '110983319176384512' }];
  assert.strictEqual(preserveRowIdentity(prev, next, 'discordId')[0].discordId, '110983319176384512');
});

test('rows are matched on id, so a reorder still preserves the right identity', () => {
  const prev = [
    { id: 'a', name: 'Cabbage', discordId: '135203806676779008' },
    { id: 'b', name: 'Bean', discordId: '110983319176384512' },
  ];
  const next = [{ id: 'b', name: 'Bean' }, { id: 'a', name: 'Cabbage' }];
  const out = preserveRowIdentity(prev, next, 'discordId');
  assert.strictEqual(out[0].discordId, '110983319176384512');
  assert.strictEqual(out[1].discordId, '135203806676779008');
});

test('a genuinely removed row stays removed — this restores ids, it does not resurrect rows', () => {
  const prev = [{ id: 'a', name: 'Cabbage', discordId: '135203806676779008' }, { id: 'b', name: 'Bean' }];
  const next = [{ id: 'b', name: 'Bean' }];
  const out = preserveRowIdentity(prev, next, 'discordId');
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].id, 'b');
});

test('calls and bonuses keep callerId through the same round trip', () => {
  const prev = [{ id: 'c1', user: 'Cabbage', callerId: '135203806676779008' }];
  const next = [{ id: 'c1', user: 'Cabbage' }];   // masked: maskCallerEntry drops callerId
  assert.strictEqual(preserveRowIdentity(prev, next, 'callerId')[0].callerId, '135203806676779008');
});

test('a new row with no prior counterpart passes through untouched', () => {
  const prev = [{ id: 'a', name: 'Cabbage', discordId: '135203806676779008' }];
  const next = [{ id: 'a', name: 'Cabbage' }, { id: 'new', name: 'Typed Name' }];
  const out = preserveRowIdentity(prev, next, 'discordId');
  assert.strictEqual(out[0].discordId, '135203806676779008');
  assert.strictEqual(out[1].discordId, undefined, 'a typed name must NOT acquire an id');
});

test('degenerate inputs are safe', () => {
  assert.deepStrictEqual(preserveRowIdentity(null, [{ id: 'a' }], 'discordId'), [{ id: 'a' }]);
  assert.deepStrictEqual(preserveRowIdentity([], [{ id: 'a' }], 'discordId'), [{ id: 'a' }]);
  assert.strictEqual(preserveRowIdentity([{ id: 'a' }], undefined, 'discordId'), undefined);
  assert.deepStrictEqual(preserveRowIdentity([{ id: 'a', discordId: '1' }], [null], 'discordId'), [null]);
});
