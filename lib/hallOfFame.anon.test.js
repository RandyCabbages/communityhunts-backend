const { test } = require('node:test');
const assert = require('node:assert');
const { collectHallOfFame } = require('./hallOfFame');

const bigHit = { slot: 'Gates', bet: 1, win: 400, replayUrl: 'https://x/y' };
const hunt = { user: { id: 'h1', displayName: 'HostGuy', avatar: 'a.png' }, tenantId: 'bean',
               isLive: false, archivedAt: '2026-07-01', bonuses: [bigHit] };

test('collectHallOfFame masks an anonymous host name', () => {
  const isAnon = ({ discordId, name }) => discordId === 'h1' || name === 'HostGuy';
  const out = collectHallOfFame({}, [hunt], 'bean', { isAnon });
  assert.equal(out.length, 1);
  assert.equal(out[0].username, 'Anonymous');
  assert.equal(out[0].avatar, null);
});

test('collectHallOfFame leaves a non-anonymous host untouched', () => {
  const out = collectHallOfFame({}, [hunt], 'bean', { isAnon: () => false });
  assert.equal(out[0].username, 'HostGuy');
});
