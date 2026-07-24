// Revocation must survive more than one replica.
//
// `mem` is loaded from Postgres once at boot and mutated only in-process, so before this change a
// key revoked on replica 1 kept working on replica 2 until the next deploy — silently, because
// nothing errors. Tolerable for a read key; not for a write key, which mutates the hunt record.
//
// So when a pgPool exists, Postgres is AUTHORITATIVE on a hashCache miss and `mem` is never
// consulted for lookup. The 45s positive cache is therefore the real revocation ceiling.
//
// Own file: pgPool is a module-level singleton and `node --test` gives each file its own process.
const { test } = require('node:test');
const assert = require('node:assert');
const apiKeys = require('./apiKeys');

// Fake pool that answers a key_hash lookup from a mutable table, so a "revocation on another
// replica" is just deleting the row without touching this process's memory.
const rows = new Map(); // key_hash -> { tenant_slug, scopes }
let selectCount = 0;
const fakePool = {
  async query(sql, params) {
    if (/FROM tenant_api_keys WHERE key_hash/i.test(sql)) {
      selectCount++;
      const r = rows.get(params[0]);
      return { rows: r ? [r] : [] };
    }
    if (/^\s*SELECT/i.test(sql)) return { rows: [] }; // boot-load
    return { rows: [] };
  },
};

test('setup: init with the fake pool', async () => {
  await apiKeys.initApiKeys({ pgPool: fakePool, getTenantBySlug: () => ({}), canUse: () => true });
});

test('a key present in Postgres resolves, with its scopes', async () => {
  const { rawKey } = apiKeys.generateKey('acme', 'owner', ['read', 'write']);
  rows.set(apiKeys.hashKey(rawKey), { tenant_slug: 'acme', scopes: ['read', 'write'] });
  const hit = await apiKeys.lookupByRawKey(rawKey);
  assert.deepStrictEqual(hit, { slug: 'acme', scopes: ['read', 'write'] });
});

test('a key revoked on ANOTHER replica stops working here', async () => {
  const { rawKey } = apiKeys.generateKey('bravo', 'owner');
  const hash = apiKeys.hashKey(rawKey);
  rows.set(hash, { tenant_slug: 'bravo', scopes: ['read'] });
  assert.ok(await apiKeys.lookupByRawKey(rawKey), 'should resolve while the row exists');

  // Another replica revokes: the DB row disappears, this process's `mem` is untouched.
  rows.delete(hash);
  // Expire this process's positive cache the way 45s of wall-clock would.
  apiKeys._expireHashCache();

  assert.strictEqual(await apiKeys.lookupByRawKey(rawKey), null,
    'mem must NOT be able to serve a key Postgres no longer has');
});

test('scopes narrowed on another replica take effect here', async () => {
  const { rawKey } = apiKeys.generateKey('charlie', 'owner', ['read', 'write']);
  const hash = apiKeys.hashKey(rawKey);
  rows.set(hash, { tenant_slug: 'charlie', scopes: ['read', 'write'] });
  assert.deepStrictEqual((await apiKeys.lookupByRawKey(rawKey)).scopes, ['read', 'write']);

  rows.set(hash, { tenant_slug: 'charlie', scopes: ['read'] }); // downgraded elsewhere
  apiKeys._expireHashCache();
  assert.deepStrictEqual((await apiKeys.lookupByRawKey(rawKey)).scopes, ['read'],
    'a write key downgraded to read-only elsewhere must lose write here');
});

test('the positive cache still spares Postgres on a repeat hit', async () => {
  const { rawKey } = apiKeys.generateKey('delta', 'owner');
  rows.set(apiKeys.hashKey(rawKey), { tenant_slug: 'delta', scopes: ['read'] });
  await apiKeys.lookupByRawKey(rawKey);
  const before = selectCount;
  await apiKeys.lookupByRawKey(rawKey);
  await apiKeys.lookupByRawKey(rawKey);
  assert.strictEqual(selectCount, before, 'cached hits must not re-query');
});

test('an unknown key is null and does not throw', async () => {
  assert.strictEqual(await apiKeys.lookupByRawKey('ch_live_neverissued'), null);
  assert.strictEqual(await apiKeys.lookupByRawKey('not-a-key'), null);
});

test('a database failure fails CLOSED rather than falling back to memory', async () => {
  const { rawKey } = apiKeys.generateKey('echo', 'owner');
  rows.set(apiKeys.hashKey(rawKey), { tenant_slug: 'echo', scopes: ['read'] });
  apiKeys._expireHashCache();
  const orig = fakePool.query;
  fakePool.query = async () => { throw new Error('connection terminated'); };
  await assert.rejects(() => apiKeys.lookupByRawKey(rawKey), /connection terminated/,
    'must propagate so requireApiKey answers 503, not serve from a stale mirror');
  fakePool.query = orig;
});
