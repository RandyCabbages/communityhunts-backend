const { test, after } = require('node:test');
const assert = require('node:assert');
const apiKeys = require('./apiKeys');

// No pgPool → module operates on its in-memory fallback Map (see initApiKeys).
after(() => {});

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
