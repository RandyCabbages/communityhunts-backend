const { test } = require('node:test');
const assert = require('node:assert');
const { checkCreatorsLive, getCreatorLive } = require('./integrations');

function fakeIo(emitted) {
  return { to(room) { return { emit(event, payload) { emitted.push({ room, event, payload }); } }; } };
}

const tenants = [{ id: 'bean', slug: 'bean', hostDiscordId: '110983319176384512', twitchChannel: 'bean' }];

test('creator with twitchName resolves (lowercased) and reports live', async () => {
  const emitted = [];
  await checkCreatorsLive(fakeIo(emitted), {
    getAllTenants: () => tenants,
    getPublicHunts: () => [{ userId: 'u1' }],
    getSettings: async () => ({ twitchName: 'GooferG' }),
    fetchStreams: async (logins) => new Map(logins.map(l => [l, { title: 'x' }])),
  });
  assert.deepStrictEqual(getCreatorLive('u1'), { isLive: true, login: 'gooferg' });
  assert.strictEqual(emitted.length, 1);
  assert.strictEqual(emitted[0].room, 'hub:bean');
  assert.strictEqual(emitted[0].event, 'hunts:twitchlive');
  assert.deepStrictEqual(emitted[0].payload, { u1: { isLive: true, login: 'gooferg' } });
});

test('host without twitchName falls back to tenant twitchChannel', async () => {
  const emitted = [];
  await checkCreatorsLive(fakeIo(emitted), {
    getAllTenants: () => tenants,
    getPublicHunts: () => [{ userId: '110983319176384512' }],
    getSettings: async () => ({ twitchName: '' }),
    fetchStreams: async () => new Map(), // nobody live
  });
  assert.deepStrictEqual(getCreatorLive('110983319176384512'), { isLive: false, login: 'bean' });
  assert.deepStrictEqual(emitted[0].payload, { '110983319176384512': { isLive: false, login: 'bean' } });
});

test('creator with no twitchName and not host is skipped entirely', async () => {
  const emitted = [];
  await checkCreatorsLive(fakeIo(emitted), {
    getAllTenants: () => tenants,
    getPublicHunts: () => [{ userId: 'u2' }],
    getSettings: async () => ({ twitchName: '' }),
    fetchStreams: async () => new Map(),
  });
  assert.deepStrictEqual(getCreatorLive('u2'), { isLive: false, login: null });
  assert.strictEqual(emitted.length, 0); // no resolvable creator → nothing to emit
});

test('getSettings failure is tolerated (falls back / skips, never throws)', async () => {
  const emitted = [];
  await checkCreatorsLive(fakeIo(emitted), {
    getAllTenants: () => tenants,
    getPublicHunts: () => [{ userId: 'u3' }],
    getSettings: async () => { throw new Error('pg down'); },
    fetchStreams: async () => new Map(),
  });
  assert.deepStrictEqual(getCreatorLive('u3'), { isLive: false, login: null });
});
