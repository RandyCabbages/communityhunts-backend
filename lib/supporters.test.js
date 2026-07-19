const { test } = require('node:test');
const assert = require('node:assert');
const supporters = require('./supporters');

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

test('no DB: isSupporter is false and mutations are safe no-ops', async () => {
  await supporters.initSupporters({}); // no pgPool
  assert.equal(supporters.isSupporter('123'), false);
  await supporters.addSupporter('123', 'admin1'); // must not throw
  assert.deepEqual(supporters.getSupporterIds(), []);
});

test('with DB: cache loads from SELECT and isSupporter matches (string-coerced)', async () => {
  const pool = makeFakePgPool([{ discord_id: '111' }, { discord_id: 222 }]);
  await supporters.initSupporters({ pgPool: pool });
  assert.equal(supporters.isSupporter('111'), true);
  assert.equal(supporters.isSupporter(222), true, 'numeric id coerces to string');
  assert.equal(supporters.isSupporter('999'), false);
  // CREATE TABLE + SELECT ran during init.
  assert.ok(pool.calls.some(c => /CREATE TABLE/i.test(c.sql)));
});
