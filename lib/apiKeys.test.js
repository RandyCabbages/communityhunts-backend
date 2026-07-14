const { test, after } = require('node:test');
const assert = require('node:assert');
const apiKeys = require('./apiKeys');

// Tests 1-5 below never call initApiKeys() → module operates on its in-memory fallback Map
// (pgPool stays null, see initApiKeys). The Postgres-path tests at the end of this file DO call
// initApiKeys({ pgPool: fake }) with a fake stub (no real DB) — pgPool is a module-level
// singleton, so once set it persists for the rest of this file's process. That's harmless here:
// `mem` remains authoritative either way, and the fake's query() never rejects, so it can't
// break the tests above (which all run first, in file order, before pgPool is ever set).
after(() => {});

// Fake pgPool stub: records every query, resolves { rows: [...] } for SELECTs (canned rows) and
// { rows: [] } for everything else (INSERT/UPDATE/DELETE/CREATE). No real database involved.
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

test('hashKey is deterministic and never equals the raw key', () => {
  const raw = 'ch_live_abc123';
  assert.strictEqual(apiKeys.hashKey(raw), apiKeys.hashKey(raw));
  assert.notStrictEqual(apiKeys.hashKey(raw), raw);
});

test('generate → lookup round trip; prefix masks the middle', () => {
  const { rawKey, prefix } = apiKeys.generateKey('acme', '135203806676779008');
  assert.ok(rawKey.startsWith('ch_live_'));
  assert.match(prefix, /^ch_live_.+….+$/);
  assert.deepStrictEqual(apiKeys.lookupByRawKey(rawKey), { slug: 'acme' });
  assert.strictEqual(apiKeys.lookupByRawKey('ch_live_wrong'), null);
});

test('generate again = roll: old key stops working, new key works', () => {
  const first = apiKeys.generateKey('roller', 'u1').rawKey;
  const second = apiKeys.generateKey('roller', 'u1').rawKey;
  assert.notStrictEqual(first, second);
  assert.strictEqual(apiKeys.lookupByRawKey(first), null);
  assert.deepStrictEqual(apiKeys.lookupByRawKey(second), { slug: 'roller' });
});

test('revoke deletes the key; lookup then fails; getKeyMeta null', () => {
  const { rawKey } = apiKeys.generateKey('gone', 'u1');
  assert.strictEqual(apiKeys.revokeKey('gone'), true);
  assert.strictEqual(apiKeys.lookupByRawKey(rawKey), null);
  assert.strictEqual(apiKeys.getKeyMeta('gone'), null);
  assert.strictEqual(apiKeys.revokeKey('gone'), false);
});

test('getKeyMeta returns masked prefix, never the hash or raw key', () => {
  apiKeys.generateKey('meta', 'creator-9');
  const m = apiKeys.getKeyMeta('meta');
  assert.ok(m.prefix.includes('…'));
  assert.ok(!('keyHash' in m) && !('rawKey' in m));
  assert.strictEqual(m.createdBy, undefined); // meta is display-only; createdBy not exposed here
});

// --- Postgres-backed path (fake pgPool stub; no real database) ---

test('initApiKeys boot-load (fake pgPool): populates mem with ISO-string timestamps; lookupByRawKey + getKeyMeta resolve', async () => {
  const seededRawKey = 'ch_live_seededknownkey';
  const seededHash = apiKeys.hashKey(seededRawKey);
  const createdAt = new Date('2026-01-01T00:00:00.000Z');
  const lastUsedAt = new Date('2026-01-02T00:00:00.000Z');
  const fake = makeFakePgPool([
    {
      tenant_slug: 'pgseeded',
      key_hash: seededHash,
      key_prefix: 'ch_live_seeded…nkey',
      created_by: 'u-seed',
      created_at: createdAt, // Postgres driver shape: real Date objects, not strings.
      last_used_at: lastUsedAt,
    },
  ]);

  await apiKeys.initApiKeys({ pgPool: fake });

  // Boot-load ran the CREATE TABLE / CREATE UNIQUE INDEX / SELECT sequence against the fake.
  assert.ok(fake.calls.some(c => /CREATE TABLE IF NOT EXISTS tenant_api_keys/i.test(c.sql)));
  assert.ok(fake.calls.some(c => /CREATE UNIQUE INDEX/i.test(c.sql) && /tenant_api_keys/i.test(c.sql)));
  assert.ok(fake.calls.some(c => /^\s*SELECT/i.test(c.sql) && /FROM tenant_api_keys/i.test(c.sql)));

  // Timestamps were coerced from Date objects to ISO strings (assert before any lookup, since
  // lookupByRawKey → touchLastUsed mutates lastUsedAt as a side effect).
  const metaBeforeLookup = apiKeys.getKeyMeta('pgseeded');
  assert.strictEqual(metaBeforeLookup.prefix, 'ch_live_seeded…nkey');
  assert.strictEqual(metaBeforeLookup.createdAt, createdAt.toISOString());
  assert.strictEqual(metaBeforeLookup.lastUsedAt, lastUsedAt.toISOString());

  // The boot-load populated `mem` (not just a fresh generateKey) — proven by resolving a raw key
  // this test process never generated, only seeded via the fake SELECT row.
  assert.deepStrictEqual(apiKeys.lookupByRawKey(seededRawKey), { slug: 'pgseeded' });
  assert.strictEqual(apiKeys.getKeyMeta('pgseeded').prefix, 'ch_live_seeded…nkey');
});

test('with a fake pgPool set, generateKey issues an upsert INSERT and revokeKey issues a DELETE', async () => {
  const fake = makeFakePgPool([]);
  await apiKeys.initApiKeys({ pgPool: fake });

  apiKeys.generateKey('pgdevapi', 'creator-pg');
  const insertCall = fake.calls.find(c => /INSERT INTO tenant_api_keys/i.test(c.sql));
  assert.ok(insertCall, 'expected an INSERT INTO tenant_api_keys call');
  assert.match(insertCall.sql, /ON CONFLICT/i);
  assert.strictEqual(insertCall.params[0], 'pgdevapi');

  apiKeys.revokeKey('pgdevapi');
  const deleteCall = fake.calls.find(c => /DELETE FROM tenant_api_keys/i.test(c.sql));
  assert.ok(deleteCall, 'expected a DELETE FROM tenant_api_keys call');
  assert.deepStrictEqual(deleteCall.params, ['pgdevapi']);

  // In-memory effect of the roll/revoke still holds even with pgPool set (mem is authoritative).
  assert.strictEqual(apiKeys.getKeyMeta('pgdevapi'), null);
});
