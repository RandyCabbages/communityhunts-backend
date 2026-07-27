// Guards the fix for the "one bad await takes the whole API down" class of bug.
//
// Before installAsyncErrors(), a rejected promise from an async route handler escaped Express 4
// entirely: the global error middleware never saw it, the client hung, and Node >= 15 killed the
// process on the resulting unhandledRejection. These tests pin the three properties we need.

const { test } = require('node:test');
const assert = require('node:assert');
const express = require('express');

const installAsyncErrors = require('./asyncErrors');

assert.strictEqual(installAsyncErrors(), true, 'patch should install');
installAsyncErrors(); // idempotent — a second call must not double-wrap

async function call(app, path) {
  const server = await new Promise(resolve => { const s = app.listen(0, () => resolve(s)); });
  try {
    const r = await fetch(`http://127.0.0.1:${server.address().port}${path}`);
    return { status: r.status, body: await r.text() };
  } finally {
    server.close();
  }
}

// The whole point: this used to crash the process instead of answering.
test('a rejecting async handler reaches the error middleware as a 500', async () => {
  const app = express();
  app.get('/boom', async () => { throw new Error('postgres went away'); });
  let seen = null;
  app.use((err, req, res, next) => { seen = err; res.status(500).json({ error: 'Internal Server Error' }); });

  const r = await call(app, '/boom');
  assert.strictEqual(r.status, 500);
  assert.strictEqual(seen && seen.message, 'postgres went away');
});

// /auth/me's exact shape: Promise.all where one leg rejects (a Discord 429 in refreshGuildRoles).
test('a rejected Promise.all inside an async handler is caught, not fatal', async () => {
  const app = express();
  app.get('/me', async (req, res) => {
    const [a, b] = await Promise.all([
      Promise.resolve({ tier: 'free' }),
      Promise.reject(new Error('Discord 429')),
    ]);
    res.json({ a, b });
  });
  app.use((err, req, res, next) => res.status(500).json({ error: err.message }));

  const r = await call(app, '/me');
  assert.strictEqual(r.status, 500);
  assert.match(r.body, /Discord 429/);
});

// Regression guard: the patch must not change ordinary sync behaviour.
test('sync handlers and sync throws behave exactly as before', async () => {
  const app = express();
  app.get('/ok', (req, res) => res.status(200).json({ ok: true }));
  app.get('/sync-throw', () => { throw new Error('sync boom'); });
  app.use((err, req, res, next) => res.status(500).json({ error: err.message }));

  const ok = await call(app, '/ok');
  assert.strictEqual(ok.status, 200);
  assert.match(ok.body, /"ok":true/);

  const bad = await call(app, '/sync-throw');
  assert.strictEqual(bad.status, 500);
  assert.match(bad.body, /sync boom/);
});

// An async handler that resolves normally must still work, and must not double-send.
test('a resolving async handler responds once, normally', async () => {
  const app = express();
  app.get('/fine', async (req, res) => { await Promise.resolve(); res.status(200).json({ fine: true }); });
  let errCount = 0;
  app.use((err, req, res, next) => { errCount++; res.status(500).end(); });

  const r = await call(app, '/fine');
  assert.strictEqual(r.status, 200);
  assert.strictEqual(errCount, 0, 'error middleware must not fire for a successful async handler');
});
