// ONE CORS policy shared by Express and Socket.IO. Extracted from server.js so it can be pinned.
//
// The behaviour that needed fixing: an origin outside the allowlist was rejected by calling back
// with an Error. The `cors` package propagates that to Express's error handler, so a disallowed
// origin returned **500** — not the 403 you'd expect — and every one of them logged a stack.
// Observed in production on /api/img-proxy from Origin: https://rainbet.com (the extension), and
// it is also why Vercel PREVIEW deploys look permanently logged out: their *.vercel.app origin
// isn't allowlisted, so GET /auth/me 500s.
//
// `callback(null, false)` is the conventional refusal: no Access-Control-Allow-Origin header is
// set, the browser blocks the response, and the server returns a normal status with no stack.

const { test } = require('node:test');
const assert = require('node:assert');
const { makeCorsPolicy } = require('./corsPolicy');

const SITE = 'https://communityhunts.gg';
const policy = makeCorsPolicy([SITE, 'https://www.communityhunts.gg']);

// callback(err, allow) -> capture both
function check(origin) {
  let out;
  policy.corsOrigin(origin, (err, allow) => { out = { err, allow }; });
  return out;
}

test('an allowlisted site origin is allowed', () => {
  const r = check(SITE);
  assert.strictEqual(r.err, null);
  assert.strictEqual(r.allow, true);
});

test('a request with no Origin is allowed (server-to-server, OBS, plain <img>)', () => {
  const r = check(undefined);
  assert.strictEqual(r.err, null);
  assert.strictEqual(r.allow, true);
});

test('browser-extension origins are allowed (unstable id, cannot be hardcoded)', () => {
  for (const o of ['chrome-extension://abcdef', 'moz-extension://abcdef']) {
    const r = check(o);
    assert.strictEqual(r.err, null, `${o} should not error`);
    assert.strictEqual(r.allow, true, `${o} should be allowed`);
  }
});

// The fix. Refusing by Error turns a routine cross-origin request into a 500 + stack trace.
test('a disallowed origin is REFUSED, not turned into an error (no 500, no stack)', () => {
  const r = check('https://evil.example');
  assert.strictEqual(r.err, null, 'must not call back with an Error — that becomes a 500');
  assert.strictEqual(r.allow, false, 'must refuse by omitting the CORS headers');
});

test('a Vercel preview origin is refused the same quiet way, not with a 500', () => {
  const r = check('https://communityhunts-frontend-abc123.vercel.app');
  assert.strictEqual(r.err, null);
  assert.strictEqual(r.allow, false);
});

// Extra origins (EXTRA_ORIGINS on Railway) are the supported way to let a specific preview
// deploy talk to the API — that is what makes previews usable without widening the allowlist.
test('an origin supplied via extra origins is allowed', () => {
  const p = makeCorsPolicy([SITE, 'https://communityhunts-frontend-abc123.vercel.app']);
  let out;
  p.corsOrigin('https://communityhunts-frontend-abc123.vercel.app', (err, allow) => { out = { err, allow }; });
  assert.strictEqual(out.allow, true);
});

// Credentials: site origins get cookie-credentialed CORS; extension origins are reflected
// WITHOUT credentials so a malicious extension can't ride the session cookie (audit 2026-07-18 #6).
test('site origins get credentials, extension origins do not', () => {
  const opts = (origin) => {
    let o; policy.corsDelegate({ headers: { origin } }, (err, v) => { o = v; }); return o;
  };
  assert.strictEqual(opts(SITE).credentials, true);
  assert.strictEqual(opts('chrome-extension://abcdef').credentials, false);
  assert.strictEqual(opts('moz-extension://abcdef').credentials, false);
});

test('the delegate tolerates a request with no headers object', () => {
  let o;
  policy.corsDelegate({}, (err, v) => { o = v; });
  assert.strictEqual(o.credentials, true, 'no origin is not an extension origin');
});
