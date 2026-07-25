const { test } = require('node:test');
const assert = require('node:assert');
const settings = require('./settings');

// Fake pgPool: records queries; returns canned rows for SELECT, {rows:[]} otherwise.
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

test('normalizeName lowercases, trims, collapses whitespace', () => {
  assert.strictEqual(settings.normalizeName('  Raph '), 'raph');
  assert.strictEqual(settings.normalizeName('Big   Raph'), 'big raph');
  assert.strictEqual(settings.normalizeName(null), '');
});

test('recordAlias upserts normalized alias with ON CONFLICT DO NOTHING', () => {
  const pg = makeFakePgPool();
  settings.initSettings({ pgPool: pg, hunts: {} });
  const before = pg.calls.length;
  settings.recordAlias('123', ' Raph ', 'manual');
  const insert = pg.calls.slice(before).find(c => /INSERT INTO user_aliases/i.test(c.sql));
  assert.ok(insert, 'expected an INSERT INTO user_aliases');
  assert.ok(/ON CONFLICT .*DO NOTHING/is.test(insert.sql));
  assert.deepStrictEqual(insert.params, ['123', 'raph', 'Raph', 'manual']);
});

test('recordAlias is a no-op for blank names', () => {
  const pg = makeFakePgPool();
  settings.initSettings({ pgPool: pg, hunts: {} });
  const before = pg.calls.length;
  settings.recordAlias('123', '   ', 'login');
  const inserts = pg.calls.slice(before).filter(c => /INSERT INTO user_aliases/i.test(c.sql));
  assert.strictEqual(inserts.length, 0);
});

test('findAliasOwners maps raw names to owner id sets', async () => {
  const pg = makeFakePgPool([
    { alias_norm: 'raph', user_id: '693' },
    { alias_norm: 'raph', user_id: '999' },
  ]);
  settings.initSettings({ pgPool: pg, hunts: {} });
  const map = await settings.findAliasOwners(['Raph', 'Nobody']);
  assert.deepStrictEqual([...(map.get('Raph') || [])].sort(), ['693', '999']);
  assert.ok(!map.has('Nobody'));
});

test('findAliasOwners returns empty map with no pgPool', async () => {
  settings.initSettings({ pgPool: null, hunts: {} });
  const map = await settings.findAliasOwners(['Raph']);
  assert.strictEqual(map.size, 0);
});

test('recordKnownUser also records display name and username aliases', () => {
  const pg = makeFakePgPool();
  settings.initSettings({ pgPool: pg, hunts: {} });
  const before = pg.calls.length;
  settings.recordKnownUser({ id: '693', displayName: 'Raph', username: 'raph_ttv' });
  const aliasInserts = pg.calls.slice(before)
    .filter(c => /INSERT INTO user_aliases/i.test(c.sql))
    .map(c => c.params[2]); // display form
  assert.ok(aliasInserts.includes('Raph'), 'display name recorded as alias');
  assert.ok(aliasInserts.includes('raph_ttv'), 'username recorded as alias');
});

// ── Whitespace-insensitive lookup ───────────────────────────────────────────
// The review queue groups rows with identityLink's normName, which strips ALL whitespace, while
// alias_norm only collapses it. Looking names up under the strict key left anyone whose typed name
// spaced differently from their Discord name stranded in "No matching account".

test('findAliasOwnersLoose matches across a whitespace difference', async () => {
  const pg = makeFakePgPool([{ alias: 'Big Cabbage', user_id: '135203806676779008' }]);
  settings.initSettings({ pgPool: pg, hunts: {} });
  const map = await settings.findAliasOwnersLoose(['bigcabbage']);
  assert.deepStrictEqual([...(map.get('bigcabbage') || [])], ['135203806676779008']);
});

test('findAliasOwnersLoose queries on the whitespace-stripped key', async () => {
  const pg = makeFakePgPool([]);
  settings.initSettings({ pgPool: pg, hunts: {} });
  await settings.findAliasOwnersLoose(['Big  Cabbage']);
  const q = pg.calls.find(c => /FROM user_aliases/i.test(c.sql));
  assert.deepStrictEqual(q.params[0], ['bigcabbage']);
});

test('findAliasOwnersLoose keys the result by the RAW name it was given', async () => {
  const pg = makeFakePgPool([{ alias: 'spin sage', user_id: '110983319176384512' }]);
  settings.initSettings({ pgPool: pg, hunts: {} });
  const map = await settings.findAliasOwnersLoose(['  SpinSage  ']);
  assert.ok(map.has('  SpinSage  '), 'consumers need no normalizer of their own');
});

test('findAliasOwnersLoose collapses two accounts onto one name as ambiguity', async () => {
  const pg = makeFakePgPool([
    { alias: 'Big Cabbage', user_id: '110983319176384512' },
    { alias: 'BigCabbage',  user_id: '135203806676779008' },
  ]);
  settings.initSettings({ pgPool: pg, hunts: {} });
  const map = await settings.findAliasOwnersLoose(['BigCabbage']);
  assert.strictEqual(map.get('BigCabbage').size, 2, 'ambiguous, so Tier 2 will not offer it');
});

test('findAliasOwnersLoose is empty without a pgPool or names', async () => {
  settings.initSettings({ pgPool: null, hunts: {} });
  assert.strictEqual((await settings.findAliasOwnersLoose(['Raph'])).size, 0);
  const pg = makeFakePgPool([]);
  settings.initSettings({ pgPool: pg, hunts: {} });
  assert.strictEqual((await settings.findAliasOwnersLoose([])).size, 0);
});

test('deleteAlias removes one alias for one user', async () => {
  const pg = makeFakePgPool([]);
  settings.initSettings({ pgPool: pg, hunts: {} });
  const before = pg.calls.length;
  await settings.deleteAlias('123', ' Raph ');
  const del = pg.calls.slice(before).find(c => /DELETE FROM user_aliases/i.test(c.sql));
  assert.ok(del, 'expected a DELETE');
  assert.deepStrictEqual(del.params, ['123', 'raph']);
});

test('deleteAlias is a no-op for a blank name and never throws', async () => {
  const pg = makeFakePgPool([]);
  settings.initSettings({ pgPool: pg, hunts: {} });
  const before = pg.calls.length;
  await settings.deleteAlias('123', '   ');
  // Count only DELETEs — initSettings runs its own async queries against this same fake pool.
  const deletes = pg.calls.slice(before).filter(c => /DELETE FROM user_aliases/i.test(c.sql));
  assert.deepStrictEqual(deletes, []);
  await assert.doesNotReject(() => settings.deleteAlias(null, 'Raph'));
});
