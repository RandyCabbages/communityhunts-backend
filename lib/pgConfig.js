// Postgres pool options, in one testable place.
//
// The pool used to be `new Pool({ connectionString, ssl })` with every other option left at pg's
// default. Two of those defaults are actively wrong for a Railway-hosted API:
//
//   connectionTimeoutMillis = 0  — wait FOREVER for a connection. When Postgres is unreachable,
//                                  every request that needs the pool hangs instead of failing
//                                  fast, which turns a database blip into a hung API.
//   idle_in_transaction_session_timeout unset — an abandoned transaction holds a connection AND
//                                  blocks vacuum indefinitely. statsStore holds a client across
//                                  BEGIN..COMMIT with a per-participant recompute inside, so this
//                                  is a real shape here, not a theoretical one.
//
// `max` stays at pg's default 10 — measured: exactly 10 backends are torn down per deploy, and it
// is not the bottleneck at current load — but it is now EXPLICIT, because connect-pg-simple shares
// this pool with hunt writes and that trade-off should be a decision rather than a default.

const SSL_OFF = { RE_DISABLE: /[?&]sslmode=disable\b/, RE_LOOPBACK: /@(localhost|127\.0\.0\.1|\[::1\])[:/]/ };

function makePoolConfig(databaseUrl) {
  const url = String(databaseUrl || '');
  // Railway's managed Postgres requires TLS, so SSL is the default. Opt out for an explicit
  // sslmode=disable or a loopback host — without this the backend can never reach a plain local
  // Postgres ("The server does not support SSL connections"), which is why no test in this repo
  // ran against a real database until BE #109.
  const noSsl = SSL_OFF.RE_DISABLE.test(url) || SSL_OFF.RE_LOOPBACK.test(url);
  return {
    connectionString: databaseUrl,
    ssl: noSsl ? false : { rejectUnauthorized: false },
    max: 10,
    connectionTimeoutMillis: 5000,   // fail fast instead of hanging when PG is unreachable
    idleTimeoutMillis: 30000,
    keepAlive: true,                 // Railway's TCP path can silently drop idle connections
    statement_timeout: 15000,        // one pathological query must not pin a connection
    idle_in_transaction_session_timeout: 30000,
  };
}

module.exports = { makePoolConfig };
