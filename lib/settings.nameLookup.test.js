// resolveUserIdByName backed the "who is this equity member?" lookup by pulling EVERY user_settings
// row and filtering in JS. Measured on the live database 2026-07-27:
//
//   user_settings   seq_scan = 1,796,471   seq_tup_read = 132,706,276   n_live_tup = 87
//
// 1.8 million full scans; ~74 rows read per scan. Free at 87 rows and linear in user count, so this
// is the one with no natural ceiling — at 50k users each call reads tens of MB.
//
// The fix pushes the predicate into SQL. The DANGER is a prefilter that misses a row the JS matcher
// would have accepted: a silent false negative means an equity member stops resolving to their
// account. So the SQL is deliberately a SUPERSET — SQL narrows, JS decides — and the superset
// property is proven below rather than asserted.

const { test } = require('node:test');
const assert = require('node:assert');

const MOD = require.resolve('./settings');
function freshModule() { delete require.cache[MOD]; return require('./settings'); }

function fakePool(rows = []) {
  const queries = [];
  return {
    queries,
    query: async (sql, params) => {
      queries.push({ sql, params });
      if (/FROM user_settings/i.test(sql)) return { rows };
      return { rows: [], rowCount: 1 };
    },
  };
}
const row = (userId, s) => ({ user_id: userId, settings: s });

function wire(rows) {
  const S = freshModule();
  const pool = fakePool(rows);
  S.initSettings({ pgPool: pool, hunts: {} });
  return { S, pool };
}
const lookupQueries = (pool) => pool.queries.filter(q => /FROM user_settings/i.test(q.sql));

test('the name lookup does NOT read every settings row', async () => {
  const { S, pool } = wire([row('111', { discordUsername: 'alice' })]);
  await S.resolveUserIdByName('alice');

  const q = lookupQueries(pool);
  assert.strictEqual(q.length, 1, 'exactly one lookup query');
  assert.match(q[0].sql, /WHERE/i,
    'the 1.8M-seq-scan path: an unfiltered SELECT over user_settings');
  assert.ok((q[0].params || []).length > 0, 'the search term must be bound, not inlined');
});

// ── Behaviour must be identical. These pass before AND after; they are the regression net. ──

test('an exact username match still resolves', async () => {
  const { S } = wire([row('111', { discordUsername: 'alice' })]);
  assert.strictEqual(await S.resolveUserIdByName('Alice'), '111');
});

test('a >=4-char prefix still resolves (walker -> WalkerGames)', async () => {
  const { S } = wire([row('111', { discordDisplayName: 'WalkerGames' })]);
  assert.strictEqual(await S.resolveUserIdByName('walker'), '111');
});

test('a <4-char prefix still does NOT resolve', async () => {
  const { S } = wire([row('111', { discordDisplayName: 'WalkerGames' })]);
  assert.strictEqual(await S.resolveUserIdByName('wal'), null,
    'short fragments must not latch onto unrelated users');
});

test('a space-insensitive match still resolves both directions', async () => {
  const a = wire([row('111', { discordDisplayName: 'Walker Games' })]);
  assert.strictEqual(await a.S.resolveUserIdByName('walkergames'), '111', 'stored has the space');
  const b = wire([row('222', { discordDisplayName: 'WalkerGames' })]);
  assert.strictEqual(await b.S.resolveUserIdByName('walker games'), '222', 'typed has the space');
});

test('a real Discord id still wins over a synthetic manual: row', async () => {
  const { S } = wire([
    row('manual:alice', { discordUsername: 'alice' }),
    row('123456789012345678', { discordUsername: 'alice' }),
  ]);
  assert.strictEqual(await S.resolveUserIdByName('alice'), '123456789012345678');
});

test('no match still returns null', async () => {
  const { S } = wire([row('111', { discordUsername: 'alice' })]);
  assert.strictEqual(await S.resolveUserIdByName('zzzz'), null);
});

test('an empty name short-circuits without querying at all', async () => {
  const { S, pool } = wire([]);
  assert.strictEqual(await S.resolveUserIdByName('  '), null);
  assert.strictEqual(lookupQueries(pool).length, 0);
});

// ── The superset proof ──────────────────────────────────────────────────────────
// The SQL cannot be executed here (no Postgres), so `sqlPrefilterAccepts` models its semantics as
// a small, reviewable mirror. The property: for every (row, search) pair the JS matcher accepts,
// the SQL prefilter must ALSO accept — otherwise the row never reaches JS and the name silently
// stops resolving. A LIKE-escape bug or a wrong prefix length shows up here.
test('SQL prefilter accepts everything nameMatchesSettings accepts', () => {
  const S = freshModule();
  const names = [
    'alice', 'Alice', 'WalkerGames', 'Walker Games', 'walker  games', ' Bean ', 'bob',
    'jo', 'x', 'Mr. Null', '100%Real', 'under_score', 'a b c', 'ÅngstrÖm', "O'Brien",
  ];
  const searches = names.concat(['walker', 'walkergames', 'wal', 'BEAN', '100%real', 'a b c', 'abc', 'zzzz']);

  let accepted = 0;
  for (const stored of names) {
    for (const field of ['discordUsername', 'discordDisplayName']) {
      const s = { [field]: stored };
      for (const raw of searches) {
        const search = raw.toLowerCase().trim();
        if (!search) continue;
        const searchNoSp = search.replace(/\s+/g, '');
        if (!S.nameMatchesSettings(s, search, searchNoSp)) continue;
        accepted++;
        assert.ok(S.sqlPrefilterAccepts(s, search, searchNoSp),
          `SQL prefilter would DROP a row JS accepts: stored=${JSON.stringify(stored)} search=${JSON.stringify(search)}`);
      }
    }
  }
  assert.ok(accepted > 20, `the corpus must actually exercise matches (got ${accepted})`);
});

test('the prefilter is a filter, not a pass-through', () => {
  const S = freshModule();
  assert.strictEqual(S.sqlPrefilterAccepts({ discordUsername: 'alice' }, 'zzzz', 'zzzz'), false,
    'an unrelated name must be excluded, or the query is doing nothing');
});
