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

// Same defect the banger rail had: a shared VIP/Affiliate hunt's user.displayName is the tenant
// host, so every replay-backed hit from one was credited to Bean instead of the mod who ran it.
test('collectHallOfFame credits a shared hunt to its runner, not the tenant host', () => {
  const vip = {
    user: { id: '__vip_hunt__', displayName: 'Bean', avatar: 'https://cdn/bean.png' },
    tenantId: 'bean', huntType: 'vip',
    runner: { id: '102963341407838208', name: 'Mcflury', avatar: 'https://cdn/mcflury.png' },
    bonuses: [{ slot: 'Fury of Anubis', bet: 0.6, win: 572.16, replayUrl: 'https://replay.example/a' }],
  };
  const out = collectHallOfFame({}, [vip], 'bean', { isAnon: () => false });
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].username, 'Mcflury');
  assert.strictEqual(out[0].avatar, 'https://cdn/mcflury.png');
  assert.strictEqual(out[0].category, 'vip');
});

test('collectHallOfFame leaves a non-anonymous host untouched', () => {
  const out = collectHallOfFame({}, [hunt], 'bean', { isAnon: () => false });
  assert.equal(out[0].username, 'HostGuy');
});
