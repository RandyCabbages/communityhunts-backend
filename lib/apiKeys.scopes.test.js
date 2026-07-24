// A key is read-only unless write was deliberately granted. Before scopes existed, a key was
// read-only only because no write route did; adding a POST without this would have silently
// promoted every key already in the wild — including any pasted into a third-party overlay tool.
const { test } = require('node:test');
const assert = require('node:assert');
const apiKeys = require('./apiKeys');

function res() {
  const r = { code: 0, body: null };
  r.status = c => { r.code = c; return r; };
  r.json = b => { r.body = b; return r; };
  return r;
}

test('a key defaults to read-only', () => {
  const { scopes } = apiKeys.generateKey('acme-default', 'owner1');
  assert.deepStrictEqual(scopes, ['read']);
  assert.deepStrictEqual(apiKeys.getKeyMeta('acme-default').scopes, ['read']);
});

test('write can be granted explicitly', () => {
  const { scopes } = apiKeys.generateKey('acme-write', 'owner1', ['read', 'write']);
  assert.deepStrictEqual(scopes, ['read', 'write']);
});

test('unknown scope names are dropped, read is always present', () => {
  const { scopes } = apiKeys.generateKey('acme-junk', 'owner1', ['write', 'root', 'admin']);
  assert.deepStrictEqual(scopes, ['read', 'write']);
});

test('a non-array scopes argument falls back to read-only', () => {
  assert.deepStrictEqual(apiKeys.generateKey('acme-bad', 'o', 'write').scopes, ['read']);
  assert.deepStrictEqual(apiKeys.generateKey('acme-null', 'o', null).scopes, ['read']);
});

test('the raw key resolves back to its scopes', async () => {
  const { rawKey } = apiKeys.generateKey('acme-lookup', 'o', ['read', 'write']);
  assert.deepStrictEqual((await apiKeys.lookupByRawKey(rawKey)).scopes, ['read', 'write']);
});

test('requireApiScope passes when the scope is held', () => {
  let called = false;
  const r = res();
  apiKeys.requireApiScope('write')({ apiScopes: ['read', 'write'] }, r, () => { called = true; });
  assert.strictEqual(called, true);
});

test('requireApiScope 403s a read-only key', () => {
  const r = res();
  let called = false;
  apiKeys.requireApiScope('write')({ apiScopes: ['read'] }, r, () => { called = true; });
  assert.strictEqual(called, false);
  assert.strictEqual(r.code, 403);
  assert.strictEqual(r.body.error.code, 'insufficient_scope');
});

test('requireApiScope fails closed when scopes are missing entirely', () => {
  const r = res();
  let called = false;
  apiKeys.requireApiScope('write')({}, r, () => { called = true; });
  assert.strictEqual(called, false);
  assert.strictEqual(r.code, 403);
});
