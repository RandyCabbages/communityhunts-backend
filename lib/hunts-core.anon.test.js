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
