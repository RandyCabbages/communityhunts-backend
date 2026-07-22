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
