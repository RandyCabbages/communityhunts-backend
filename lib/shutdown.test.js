// There was no SIGTERM handling at all, so Railway killed the process outright on every deploy.
// The Postgres log shows the consequence each time: bursts of "SSL error: unexpected eof while
// reading" and "could not receive data from client: Connection reset by peer". In-flight
// persistHunts() writes are cut mid-flight, and Postgres reaps abandoned backends.
//
// The hazard in the FIX is the opposite one: a drain that never finishes wedges every deploy. So
// the hard timeout is as important as the drain itself.

const { test } = require('node:test');
const assert = require('node:assert');
const { installGracefulShutdown } = require('./shutdown');

function harness({ flush, poolEnd, closeCb } = {}) {
  const calls = [];
  const handlers = {};
  const fake = {
    on: (sig, fn) => { handlers[sig] = fn; },
    server: {
      close: (cb) => { calls.push('server.close'); (closeCb || (c => c()))(cb); },
      closeAllConnections: () => calls.push('closeAllConnections'),
    },
    pgPool: { end: async () => { calls.push('pool.end'); if (poolEnd) await poolEnd(); } },
    flush: async () => { calls.push('flush'); if (flush) await flush(); },
    exit: (code) => { calls.push(`exit:${code}`); },
  };
  installGracefulShutdown({
    server: fake.server, pgPool: fake.pgPool, flush: fake.flush,
    exit: fake.exit, on: fake.on, timeoutMs: 50, log: () => {},
  });
  return { calls, handlers };
}

test('SIGTERM drains in order: stop accepting, flush state, close the pool, exit', async () => {
  const h = harness();
  await h.handlers.SIGTERM();
  assert.deepStrictEqual(h.calls, ['server.close', 'flush', 'pool.end', 'exit:0']);
});

// THE PRODUCTION CASE. http.Server.close() only fires its callback once every open connection has
// closed — and Socket.IO holds persistent ones for every viewer on a live hunt, so in production it
// NEVER fires. Measured with a real server + a real socket.io-client: close() had not resolved
// after 3s, and closeAllConnections() did not release it either (socket.io holds its own handles).
//
// The first version of this module AWAITED that callback before flushing, so the drain hung on step
// one, never reached the flush, and force-exited on the timeout — visible in Railway as an ~8.1s
// gap between "Stopping Container" and the process dying, with no [shutdown] lines. Once hunt
// writes became debounced, that silently discarded up to 250ms of edits on every deploy.
//
// The flush is the ONLY step that must not be skipped. server.close() is best-effort.
test('a server.close() that NEVER calls back must not block the flush', async () => {
  const h = harness({ closeCb: () => { /* callback never invoked — production behaviour */ } });

  await h.handlers.SIGTERM();

  assert.ok(h.calls.includes('flush'), 'the durable write must happen even though close() never resolved');
  assert.ok(h.calls.includes('pool.end'));
  assert.ok(h.calls.some(c => c.startsWith('exit:')));
  assert.ok(h.calls.indexOf('server.close') < h.calls.indexOf('flush'),
    'still stop accepting new work first — just do not wait on it');
});

test('SIGINT is handled too', async () => {
  const h = harness();
  assert.ok(typeof h.handlers.SIGINT === 'function');
});

// Railway can send a second signal; re-entering would double-flush and double-close.
test('a second signal does not re-run the drain', async () => {
  const h = harness();
  await h.handlers.SIGTERM();
  const after = h.calls.length;
  await h.handlers.SIGTERM();
  assert.strictEqual(h.calls.length, after, 'shutdown must be idempotent');
});

// The important one: a hung flush must not hold the deploy open forever.
test('a hanging flush still exits, on the timeout', async () => {
  const h = harness({ flush: () => new Promise(() => {}) });   // never resolves
  h.handlers.SIGTERM();
  await new Promise(r => setTimeout(r, 140));
  assert.ok(h.calls.some(c => c.startsWith('exit:')), 'must force an exit rather than wedge the deploy');
});

test('a failing pool.end still exits', async () => {
  const h = harness({ poolEnd: async () => { throw new Error('already ended'); } });
  await h.handlers.SIGTERM();
  assert.ok(h.calls.some(c => c.startsWith('exit:')));
});

test('works with no pgPool (file-only mode)', async () => {
  const calls = [];
  const handlers = {};
  installGracefulShutdown({
    server: { close: cb => { calls.push('server.close'); cb(); }, closeAllConnections() {} },
    pgPool: null,
    flush: async () => { calls.push('flush'); },
    exit: c => calls.push(`exit:${c}`), on: (s, f) => { handlers[s] = f; },
    timeoutMs: 50, log: () => {},
  });
  await handlers.SIGTERM();
  assert.deepStrictEqual(calls, ['server.close', 'flush', 'exit:0']);
});
