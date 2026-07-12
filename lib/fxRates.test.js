// lib/fxRates.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const makeFxRates = require('./fxRates');

// Fake pg pool: records queries, returns canned rows by matcher.
function fakePool(handlers = []) {
  const calls = [];
  return {
    calls,
    query: async (sql, params = []) => {
      calls.push({ sql, params });
      for (const h of handlers) if (h.match.test(sql)) return h.rows(params);
      return { rows: [] };
    },
  };
}

test('USD short-circuits to 1.0 without HTTP or DB', async () => {
  let httpCalled = false;
  const fx = makeFxRates({ pgPool: fakePool(), httpGet: async () => { httpCalled = true; } });
  assert.strictEqual(await fx.getUsdRate('USD', '2026-07-12'), 1);
  assert.strictEqual(httpCalled, false);
});

test('cache hit returns stored rate without HTTP', async () => {
  let httpCalled = false;
  const pool = fakePool([{ match: /SELECT usd_rate FROM fx_rates/i, rows: () => ({ rows: [{ usd_rate: '0.00105' }] }) }]);
  const fx = makeFxRates({ pgPool: pool, httpGet: async () => { httpCalled = true; } });
  assert.strictEqual(await fx.getUsdRate('ARS', '2026-07-12'), 0.00105);
  assert.strictEqual(httpCalled, false);
});

test('cache miss fetches er-api, derives 1/table, caches, returns', async () => {
  const pool = fakePool([{ match: /SELECT usd_rate FROM fx_rates/i, rows: () => ({ rows: [] }) }]);
  const httpGet = async (url) => {
    assert.match(url, /open\.er-api\.com\/v6\/latest\/USD/);
    return { data: { result: 'success', rates: { USD: 1, ARS: 1000, GBP: 0.8 } } };
  };
  const fx = makeFxRates({ pgPool: pool, httpGet });
  const rate = await fx.getUsdRate('ARS', '2026-07-12');
  assert.ok(Math.abs(rate - 0.001) < 1e-9);                       // 1/1000
  assert.ok(pool.calls.some(c => /INSERT INTO fx_rates/i.test(c.sql))); // cached
});

test('HTTP failure returns null', async () => {
  const pool = fakePool([{ match: /SELECT usd_rate FROM fx_rates/i, rows: () => ({ rows: [] }) }]);
  const fx = makeFxRates({ pgPool: pool, httpGet: async () => { throw new Error('network'); } });
  assert.strictEqual(await fx.getUsdRate('ARS', '2026-07-12'), null);
});
