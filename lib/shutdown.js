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
//
// server.close() is called but NOT awaited; see the note at the call site. Waiting on it is the
// bug this module shipped with, because Socket.IO keeps connections open and the callback never
// fires. closeAllConnections() is not the remedy either — measured, it does not release it.

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
      // Stop accepting NEW connections — but do NOT wait for it. http.Server.close() fires its
      // callback only once every EXISTING connection has closed, and Socket.IO holds a persistent
      // one for every viewer on a live hunt, so in production it never fires at all. Verified with
      // a real server + socket.io-client: close() had not resolved after 3s, and
      // closeAllConnections() did not release it either (socket.io keeps its own handles).
      //
      // The first version awaited this, so the drain hung on step one and NEVER reached the flush;
      // it force-exited on the timeout instead — an ~8.1s gap in the Railway logs between
      // "Stopping Container" and the process dying, with no [shutdown] lines. Once hunt writes
      // became debounced that silently discarded up to 250ms of edits on every deploy.
      //
      // The flush is the only step that must not be skipped. Closing the listener is best-effort:
      // the process is about to exit, which drops the sockets anyway.
      if (server && server.close) { try { server.close(); } catch (_) { /* already closing */ } }
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
