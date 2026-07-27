// The pool was built as `new Pool({ connectionString, ssl })` — every other option left at pg's
// default. Two of those defaults matter on Railway:
//
//   connectionTimeoutMillis = 0  → wait FOREVER for a connection. If Postgres is unreachable,
//                                  every request needing the pool hangs instead of failing fast.
//   idle_in_transaction_session_timeout unset → an abandoned transaction pins a connection and
//                                  blocks vacuum indefinitely.
//
// Pool max stays 10 (measured: exactly 10 backends torn down per deploy) but is now EXPLICIT, so
// it's a decision rather than a default — connect-pg-simple shares this pool with hunt writes.

const { test } = require('node:test');
const assert = require('node:assert');
const { makePoolConfig } = require('./pgConfig');

test('production URL keeps SSL on', () => {
  const c = makePoolConfig('postgres://u:p@shinkansen.proxy.rlwy.net:1234/railway');
  assert.deepStrictEqual(c.ssl, { rejectUnauthorized: false });
});

test('sslmode=disable turns SSL off (local Postgres cannot do TLS)', () => {
  assert.strictEqual(makePoolConfig('postgres://u:p@db.example:5432/x?sslmode=disable').ssl, false);
});

test('a loopback host turns SSL off', () => {
  for (const h of ['localhost', '127.0.0.1', '[::1]']) {
    assert.strictEqual(makePoolConfig(`postgres://u:p@${h}:5432/x`).ssl, false, h);
  }
});

test('the timeouts that were missing are set', () => {
  const c = makePoolConfig('postgres://u:p@host:5432/x');
  assert.ok(c.connectionTimeoutMillis > 0, 'must fail fast, not wait forever, when PG is unreachable');
  assert.ok(c.idleTimeoutMillis > 0);
  assert.ok(c.statement_timeout > 0);
  assert.ok(c.idle_in_transaction_session_timeout > 0, 'an abandoned transaction must not pin a connection');
  assert.strictEqual(c.keepAlive, true, 'Railway can silently drop idle TCP connections');
});

test('max is explicit', () => {
  assert.strictEqual(makePoolConfig('postgres://u:p@host:5432/x').max, 10);
});

test('the connection string is passed through unchanged', () => {
  const url = 'postgres://u:p@host:5432/x?sslmode=disable';
  assert.strictEqual(makePoolConfig(url).connectionString, url);
});
