const { test } = require('node:test');
const assert = require('node:assert');
const core = require('./hunts-core');

function wire() {
  core.initHuntsCore({
    hunts: {}, archive: [], viewers: {}, io: { to: () => ({ emit() {} }) }, persistHunts() {},
    isAnonymousUser: id => id === 'idAnon',
    isPrivilegedViewer: (vid) => vid === 'runner',
    shouldMaskIdentity: ({ discordId, name }) =>
      discordId === 'idAnon' || (name || '').toLowerCase().trim() === 'anon guy',
  });
}

test('maskEquityMember masks a name-only anonymous row for the public', () => {
  wire();
  const row = { id: 'm1', name: 'Anon Guy', amount: 100, avatar: 'a.png' }; // no discordId
  const pub = core.publicHuntView({ equity: [row] }); // no viewerId = unprivileged
  assert.equal(pub.equity[0].name, 'Anonymous');
  assert.equal(pub.equity[0].avatar, null);
  assert.equal(pub.equity[0].anonymous, true);
});

test('privileged viewer keeps the real name + anonymous flag', () => {
  wire();
  const row = { id: 'm1', name: 'Anon Guy', amount: 100 };
  const pv = core.publicHuntView({ user: { id: 'x' }, equity: [row] }, 'runner');
  assert.equal(pv.equity[0].name, 'Anon Guy');
  assert.equal(pv.equity[0].anonymous, true);
});

test('linked boolean is surfaced to privileged/self but never the raw discordId', () => {
  wire();
  const row = { id: 'm1', name: 'Someone', amount: 10, discordId: '555' }; // linked, not anonymous
  const pub = core.publicHuntView({ equity: [row] }); // unprivileged
  assert.equal('discordId' in pub.equity[0], false); // never leaked
  assert.equal(pub.equity[0].linked, undefined);      // non-privileged don't learn linkage
  const pv = core.publicHuntView({ user: { id: 'x' }, equity: [row] }, 'runner');
  assert.equal('discordId' in pv.equity[0], false);   // still no raw id
  assert.equal(pv.equity[0].linked, true);            // privileged see the state
});

test('publicHuntView masks calls[].user and bonuses[].caller for the public', () => {
  wire();
  const h = {
    equity: [],
    calls: [{ id: 'c1', slot: 'Gates', user: 'Anon Guy', status: 'pending' }],
    bonuses: [{ id: 'b1', slot: 'Gates', caller: 'Anon Guy', callerId: 'idAnon' }],
  };
  const pub = core.publicHuntView(h); // unprivileged
  assert.equal(pub.calls[0].user, 'Anonymous');
  assert.equal(pub.calls[0].anonymous, true);
  assert.equal(pub.bonuses[0].caller, 'Anonymous');
  assert.equal('callerId' in pub.bonuses[0], false); // linkage stripped
});

test('huntHasAnon detects a caller-only anonymous hunt (no anon equity)', () => {
  wire();
  const h = { equity: [{ id: 'm', name: 'Someone', amount: 5 }],
              calls: [{ id: 'c', slot: 'X', user: 'Anon Guy' }], bonuses: [] };
  assert.equal(core.huntHasAnon(h), true);
});

test('publicHuntView strips callerId from calls[] (never reaches the public)', () => {
  wire();
  const h = { equity: [], bonuses: [],
    calls: [{ id: 'c1', slot: 'X', user: 'Someone', callerId: '123', status: 'pending' }] };
  const pub = core.publicHuntView(h);
  assert.equal('callerId' in pub.calls[0], false);
  assert.equal(pub.calls[0].user, 'Someone'); // not anonymous → unchanged
});

// The undo history is PREVIOUS copies of rows, so it carries the callerId/discordId that the
// masking above strips from the live arrays. It must never reach a viewer.
test('publicHuntView strips the undo log and exposes only its count', () => {
  const h = {
    user: { id: 'owner' }, bonuses: [], equity: [], calls: [],
    undoLog: [
      { at: 'x', actorName: 'Mod', rows: { bonuses: { prev: [{ i: 0, row: { id: 'b1', caller: 'someone', callerId: '123456789' } }] } } },
      { at: 'y', rows: {} },
    ],
  };
  const view = core.publicHuntView(h, 'someone-else');
  assert.equal(view.undoLog, undefined);
  assert.equal(view.undoCount, 2);
  assert.ok(!JSON.stringify(view).includes('123456789'), 'a recorded callerId leaked to a viewer');
});

test('publicHuntView reports undoCount 0 when there is no history', () => {
  const view = core.publicHuntView({ user: { id: 'o' }, bonuses: [], equity: [], calls: [] }, null);
  assert.equal(view.undoCount, 0);
});