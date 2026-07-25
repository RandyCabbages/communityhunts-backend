const { test } = require('node:test');
const assert = require('node:assert');
const ca = require('./confirmedAliases');

const REAL = '110983319176384512';
const REAL2 = '135203806676779008';

// Fake pgPool: records queries, returns canned rows for SELECT.
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

test('it loads ONLY admin-confirmed aliases, never login-sourced ones', async () => {
  const pg = makeFakePgPool([{ alias: 'SpinSage', user_id: REAL }]);
  await ca.initConfirmedAliases(pg);
  const select = pg.calls.find(c => /FROM user_aliases/i.test(c.sql));
  assert.ok(/WHERE\s+source\s*=/i.test(select.sql), 'the load must filter on source');
  assert.deepStrictEqual(select.params, ['admin-link']);
  assert.strictEqual(ca.resolve('SpinSage'), REAL);
});

test('resolve matches case- and whitespace-insensitively', () => {
  ca._seed([['Spin Sage', REAL]]);
  assert.strictEqual(ca.resolve('  spinsage '), REAL);
  assert.strictEqual(ca.resolve('SPINSAGE'), REAL);
});

test('a name confirmed for two different accounts resolves to nothing', () => {
  ca._seed([['Sage', REAL], ['Sage', REAL2]]);
  assert.strictEqual(ca.resolve('Sage'), null, 'ambiguity must never be guessed');
});

test('the same account confirmed twice is not ambiguous', () => {
  ca._seed([['Sage', REAL], ['sage', REAL]]);
  assert.strictEqual(ca.resolve('Sage'), REAL);
});

test('an unknown or blank name resolves to null', () => {
  ca._seed([['SpinSage', REAL]]);
  assert.strictEqual(ca.resolve('Nobody'), null);
  assert.strictEqual(ca.resolve(''), null);
  assert.strictEqual(ca.resolve(null), null);
});

test('a synthetic id is never indexed', () => {
  ca._seed([['Ghost', 'manual:ghost'], ['Auto', 'creator_auto']]);
  assert.strictEqual(ca.resolve('Ghost'), null);
  assert.strictEqual(ca.resolve('Auto'), null);
  assert.strictEqual(ca.size(), 0);
});

test('remember takes effect immediately, without a reload', () => {
  ca._seed([]);
  assert.strictEqual(ca.resolve('SpinSage'), null);
  ca.remember('SpinSage', REAL);
  assert.strictEqual(ca.resolve('SpinSage'), REAL);
});

test('forget removes the decision so an unlink actually sticks', () => {
  ca._seed([['SpinSage', REAL]]);
  ca.forget('SpinSage', REAL);
  assert.strictEqual(ca.resolve('SpinSage'), null, 'otherwise the next save re-links it');
  assert.strictEqual(ca.size(), 0);
  assert.doesNotThrow(() => ca.forget('Nobody', REAL));
});

test('forget only drops the id it was given', () => {
  ca._seed([['Sage', REAL], ['Sage', REAL2]]);
  ca.forget('Sage', REAL2);
  assert.strictEqual(ca.resolve('Sage'), REAL, 'the surviving decision still resolves');
});

test('a failed load keeps the previous index instead of blanking it', async () => {
  ca._seed([['SpinSage', REAL]]);
  await ca.initConfirmedAliases({ async query() { throw new Error('db down'); } });
  assert.strictEqual(ca.resolve('SpinSage'), REAL);
});

test('with no pgPool it is an inert no-op rather than a crash', async () => {
  ca._seed([]);
  await ca.initConfirmedAliases(null);
  assert.strictEqual(ca.resolve('SpinSage'), null);
  assert.strictEqual(ca.size(), 0);
});
