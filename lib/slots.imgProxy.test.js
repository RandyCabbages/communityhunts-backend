// /api/img-proxy is UNAUTHENTICATED and behind no rate limiter (the only limiters in the app are
// the developer-API buckets and the per-IP throttle on /api/tickets). Two properties therefore
// have to hold in the handler itself.
//
// 1. The response cache must be BOUNDED. It is keyed by the full URL, and the host allowlist does
//    not constrain the query string — so `…/x.png?cb=1`, `?cb=2`, … are unlimited distinct keys,
//    each holding an image buffer. Confirmed against production: three cache-busted URLs all
//    returned 200 and each landed as its own entry.
// 2. The allowlist must survive REDIRECTS. `fetch` follows up to 20 by default and the host was
//    only ever checked on the URL the caller supplied, so an allowlisted host that redirects
//    (open redirect, or a compromised CDN) turned this into an SSRF fetcher.

const { test } = require('node:test');
const assert = require('node:assert');
const slots = require('./slots');

const ALLOWED = 'https://cdn.rainbet.com/slots/x.png';

function res() {
  const r = {
    code: 200, body: null, headers: {}, ended: false,
    status(c) { r.code = c; return r; },
    json(b) { r.body = b; r.ended = true; return r; },
    send(b) { r.body = b; r.ended = true; return r; },
    set(k, v) { r.headers[k] = v; return r; },
    end() { r.ended = true; return r; },
  };
  return r;
}

// Minimal fetch double. `finalUrl` simulates where the redirect chain LANDED (fetch exposes this
// as response.url), which is the thing the allowlist has to be re-checked against.
function stubFetch({ finalUrl } = {}) {
  const calls = [];
  global.fetch = async (url) => {
    calls.push(String(url));
    return {
      ok: true,
      url: finalUrl || String(url),
      headers: { get: () => 'image/png' },
      arrayBuffer: async () => new ArrayBuffer(64),
    };
  };
  return calls;
}

test('the img-proxy cache is bounded — old entries are evicted, not kept forever', async () => {
  const cap = slots.IMG_PROXY_MAX_ENTRIES;
  assert.ok(Number.isFinite(cap) && cap > 0, 'handler must publish a finite cache cap');

  const calls = stubFetch();
  const first = `${ALLOWED}?cb=0`;

  // Fill past the cap with distinct, attacker-shaped keys.
  for (let i = 0; i <= cap; i++) {
    await slots.imgProxyHandler({ query: { url: `${ALLOWED}?cb=${i}` } }, res());
  }
  const afterFill = calls.length;

  // The oldest key must be gone: re-requesting it has to hit the network again.
  await slots.imgProxyHandler({ query: { url: first } }, res());
  assert.strictEqual(calls.length, afterFill + 1,
    'the first URL should have been evicted, forcing a refetch — an unbounded cache would serve it from memory');
});

test('a still-cached entry is served without refetching (the cache still works)', async () => {
  const calls = stubFetch();
  const url = `${ALLOWED}?fresh=1`;
  await slots.imgProxyHandler({ query: { url } }, res());
  await slots.imgProxyHandler({ query: { url } }, res());
  assert.strictEqual(calls.length, 1, 'second hit must come from cache');
});

test('a redirect landing on a non-allowlisted host is refused', async () => {
  stubFetch({ finalUrl: 'http://169.254.169.254/latest/meta-data/' });
  const r = res();
  await slots.imgProxyHandler({ query: { url: ALLOWED } }, r);
  assert.notStrictEqual(r.code, 200, 'must not serve a body fetched from an off-allowlist host');
});

test('a redirect that stays on an allowlisted host is still served', async () => {
  stubFetch({ finalUrl: 'https://cdn.rainbet.com/slots/other.png' });
  const r = res();
  await slots.imgProxyHandler({ query: { url: ALLOWED } }, r);
  assert.strictEqual(r.code, 200, 'same-allowlist redirects are legitimate CDN behaviour');
});

test('an off-allowlist host is still refused up front', async () => {
  stubFetch();
  const r = res();
  await slots.imgProxyHandler({ query: { url: 'https://evil.example/x.png' } }, r);
  assert.strictEqual(r.code, 403);
});
