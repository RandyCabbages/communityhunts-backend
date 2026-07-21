const { test } = require('node:test');
const assert = require('node:assert');
const bans = require('./bans');

// Fake pgPool: records queries, returns canned rows for SELECT, [] otherwise. No real DB.
function makeFakePgPool(selectRows) {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql, params });
      if (/^\s*SELECT\b/i.test(sql)) return { rows: selectRows || [] };
      return { rows: [] };
    },
  };
}

test('no DB: isBanned is false and mutations are safe no-ops', async () => {
  await bans.initBans({}); // no pgPool
  assert.equal(bans.isBanned('693694981457838140'), false);
  assert.equal(bans.getBan('693694981457838140'), null);
  await bans.addBan('693694981457838140', { bannedBy: 'admin1' }); // must not throw
  await bans.removeBan('693694981457838140'); // must not throw
  assert.deepEqual(await bans.listBans(), []);
});

test('with DB: cache loads from SELECT and isBanned matches (string-coerced)', async () => {
  const pool = makeFakePgPool([
    { discord_id: '693694981457838140', reason: 'scamming', message: 'custom msg', banned_by: 'admin1', banned_at: 't' },
    { discord_id: 222, reason: null, message: null, banned_by: null, banned_at: 't' },
  ]);
  await bans.initBans({ pgPool: pool });
  assert.equal(bans.isBanned('693694981457838140'), true);
  assert.equal(bans.isBanned(222), true, 'numeric id coerces to string');
  assert.equal(bans.isBanned('999'), false);
  assert.ok(pool.calls.some(c => /CREATE TABLE/i.test(c.sql)));
});

test('getBan returns record and falls back to defaults for missing reason/message', async () => {
  const pool = makeFakePgPool([
    { discord_id: '111', reason: 'scamming', message: 'pay up', banned_by: 'a', banned_at: 't' },
    { discord_id: '222', reason: null, message: null, banned_by: null, banned_at: 't' },
  ]);
  await bans.initBans({ pgPool: pool });
  assert.deepEqual(bans.getBan('111'), { reason: 'scamming', message: 'pay up', bannedBy: 'a', bannedAt: 't' });
  const fallback = bans.getBan('222');
  assert.equal(fallback.reason, bans.DEFAULT_BAN_REASON);
  assert.equal(fallback.message, bans.DEFAULT_BAN_MESSAGE);
  assert.equal(bans.getBan('999'), null);
});

test('addBan upserts with defaults and reloads; removeBan deletes', async () => {
  const pool = makeFakePgPool([]);
  await bans.initBans({ pgPool: pool });
  await bans.addBan('555', { bannedBy: 'admin9' });
  const add = pool.calls.find(c => /INSERT INTO banned_users/i.test(c.sql));
  assert.ok(add, 'issued an INSERT');
  assert.equal(add.params[0], '555');
  assert.equal(add.params[1], bans.DEFAULT_BAN_REASON, 'reason defaulted');
  assert.equal(add.params[2], bans.DEFAULT_BAN_MESSAGE, 'message defaulted');
  assert.equal(add.params[3], 'admin9');
  await bans.removeBan('555');
  assert.ok(pool.calls.some(c => /DELETE FROM banned_users/i.test(c.sql)));
});
