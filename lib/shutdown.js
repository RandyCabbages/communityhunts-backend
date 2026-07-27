// Graceful shutdown. There was none, so Railway's SIGTERM killed the process outright on every
// deploy and Postgres logged the result each time: bursts of "SSL error: unexpected eof while
// reading" and "could not receive data from client: Connection reset by peer". In-flight
// persistHunts() writes were cut mid-flight, and Postgres was left reaping abandoned backends.
//
// Order matters: stop accepting NEW work, then flush in-memory state to the durable store, then
// close the pool. Flushing after closing the pool would be pointless, and closing the pool while
// requests are still landing would fail them.
//
// The hard timeout is as load-bearing as the drain. A drain that never finishes wedges every
// deploy, which would be a worse bug than the one being fixed — so a hung flush force-exits.
// Note we deliberately do NOT call server.closeAllConnections(): that kills in-flight requests
// immediately, which is the opposite of draining. server.close() lets them finish, and the
// timeout is what bounds it.

function installGracefulShutdown({
  server,
  pgPool,
  flush,
  exit = process.exit,
  on = process.on.bind(process),
  signals = ['SIGTERM', 'SIGINT'],
  timeoutMs = 8000,
  log = console.log,
} = {}) {
  let draining = false;

  async function drain() {
    if (draining) return;          // Railway may send a second signal; never double-flush
    draining = true;
    log('[shutdown] signal received — draining');

    const force = setTimeout(() => {
      log(`[shutdown] drain exceeded ${timeoutMs}ms — forcing exit`);
      exit(1);
    }, timeoutMs);
    if (typeof force.unref === 'function') force.unref();

    try {
      if (server && server.close) await new Promise(res => server.close(res));
      if (flush) await flush();
      if (pgPool && pgPool.end) await pgPool.end();
      log('[shutdown] drained cleanly');
    } catch (e) {
      log('[shutdown] error while draining: ' + (e && e.message));
    }

    clearTimeout(force);
    exit(0);
  }

  for (const sig of signals) on(sig, drain);
  return drain;
}

module.exports = { installGracefulShutdown };
