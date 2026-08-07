// Public call rows carry the two ordering hints `callerId` would have supplied — see
// publicCallRows in hunts-core.js. Both were previously zipped on in routes/share.routes.js,
// which covered the share page and MISSED the live watcher on /hunt/:userId entirely (same
// masked calls, over REST and over the hunt:update socket, neither passing through that route).
const test = require('node:test');
const assert = require('node:assert');
const { publicHuntView, initHuntsCore } = require('./hunts-core');

const SUP = '135203806676779008';
const roster = { owners: [], king: null, mods: [], supporters: [SUP] };
initHuntsCore({ hunts: {}, archive: [], viewers: {}, io: null, badgeRosterFor: () => roster });

// One human, three writers, three different `user` strings: the backend stamps user.displayName
// for share-link/bot calls, Pull List and Preferred Slots write the equity row name.
const hunt = () => ({
  equity: [], bonuses: [],
  calls: [
    { id: 'a', user: 'RandyCabbages', callerId: SUP, slot: 's1' },
    { id: 'b', user: 'Ana',           callerId: '999', slot: 's2' },
    { id: 'c', user: 'Randy',         callerId: SUP, slot: 's3' },
    { id: 'd', user: ' randy ',       slot: 's4' },   // never linked — falls back to the name
  ],
});

test('one person gets ONE callerKey across different display names', () => {
  const calls = publicHuntView(hunt()).calls;
  assert.strictEqual(calls[0].callerKey, calls[2].callerKey, 'same id = same caller');
  assert.notStrictEqual(calls[0].callerKey, calls[1].callerKey, 'different people stay apart');
});

test('an unlinked row groups by the normalized name, not the raw string', () => {
  const calls = publicHuntView({ equity: [], bonuses: [], calls: [
    { id: 'a', user: 'Randy' }, { id: 'b', user: ' randy ' }, { id: 'c', user: 'Ana' },
  ] }).calls;
  assert.strictEqual(calls[0].callerKey, calls[1].callerKey);
  assert.notStrictEqual(calls[0].callerKey, calls[2].callerKey);
});

test('badged callers are flagged, unbadged rows are left alone', () => {
  const calls = publicHuntView(hunt()).calls;
  assert.strictEqual(calls[0].priority, true);
  assert.strictEqual(calls[2].priority, true);
  assert.strictEqual(calls[1].priority, undefined, 'only `true` is ever written');
});

test('the callerId is never re-attached by either hint', () => {
  const calls = publicHuntView(hunt()).calls;
  assert.strictEqual(calls[0].callerId, undefined);
  assert.ok(!JSON.stringify(calls).includes(SUP), 'no raw Discord id crosses the wire');
});

test('a roster that throws degrades to an unprioritized queue, never a broken payload', () => {
  initHuntsCore({ hunts: {}, archive: [], viewers: {}, io: null,
    badgeRosterFor: () => { throw new Error('tenant lookup exploded'); } });
  const calls = publicHuntView(hunt()).calls;
  assert.strictEqual(calls.length, 4, 'rows still ship');
  assert.strictEqual(calls[0].priority, undefined);
  assert.ok(calls[0].callerKey, 'grouping does not depend on the roster');
  initHuntsCore({ hunts: {}, archive: [], viewers: {}, io: null, badgeRosterFor: () => roster });
});

test('tolerates a hunt with no calls array', () => {
  assert.strictEqual(publicHuntView({ equity: [], bonuses: [] }).calls, undefined);
  assert.deepStrictEqual(publicHuntView({ equity: [], bonuses: [], calls: [] }).calls, []);
});
