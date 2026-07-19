// lib/ticketContext.js — sanitizer for the client-supplied ticket context blob.
// The payload comes from an UNAUTHENTICATED public endpoint, so nothing in it is trusted:
// unknown keys are dropped, strings are capped, and an oversized blob is discarded entirely.
const { test } = require('node:test');
const assert = require('node:assert');

const { sanitizeContext } = require('./ticketContext');

test('returns null for missing / non-object input', () => {
  assert.strictEqual(sanitizeContext(undefined), null);
  assert.strictEqual(sanitizeContext(null), null);
  assert.strictEqual(sanitizeContext('nope'), null);
  assert.strictEqual(sanitizeContext(42), null);
  assert.strictEqual(sanitizeContext([1, 2]), null);
});

test('keeps known keys and drops unknown ones', () => {
  const out = sanitizeContext({
    route: '/bean/hunt',
    tenantSlug: 'bean',
    viewport: { w: 1440, h: 900 },
    userAgent: 'Mozilla/5.0',
    huntId: '123',
    buildSha: 'abc1234',
    evil: 'drop me',
    password: 'hunter2',
  });
  assert.deepStrictEqual(out, {
    route: '/bean/hunt',
    tenantSlug: 'bean',
    userAgent: 'Mozilla/5.0',
    huntId: '123',
    buildSha: 'abc1234',
    viewport: { w: 1440, h: 900 },
  });
});

test('omits keys that are absent rather than writing undefined', () => {
  const out = sanitizeContext({ route: '/shop' });
  assert.deepStrictEqual(out, { route: '/shop' });
  assert.ok(!('userAgent' in out));
});

test('caps long strings', () => {
  const out = sanitizeContext({ route: 'x'.repeat(500), userAgent: 'y'.repeat(500) });
  assert.strictEqual(out.route.length, 300);
  assert.strictEqual(out.userAgent.length, 300);
});

test('viewport must be two finite numbers, else dropped', () => {
  // Each case carries a valid `route` sibling: a bad viewport should drop the VIEWPORT,
  // not the whole blob. Without the sibling, sanitizeContext returns null (nothing usable)
  // and the .viewport access below would throw instead of failing cleanly.
  const withRoute = v => sanitizeContext({ route: '/x', viewport: v });
  assert.strictEqual(withRoute({ w: 'a', h: 9 }).viewport, undefined);
  assert.strictEqual(withRoute({ w: 1440 }).viewport, undefined);
  assert.strictEqual(withRoute('wide').viewport, undefined);
  assert.strictEqual(withRoute(null).viewport, undefined);
  assert.deepStrictEqual(withRoute({ w: 1440, h: 900 }).viewport, { w: 1440, h: 900 });
  // A dropped viewport must leave the rest of the context intact.
  assert.strictEqual(withRoute('wide').route, '/x');
});

test('returns null when the serialized blob exceeds the size cap', () => {
  // 5 keys each near the 300-char cap still fits; a hostile nested blob does not.
  const huge = { route: 'a'.repeat(300), userAgent: 'b'.repeat(300), tenantSlug: 'c'.repeat(300),
                 huntId: 'd'.repeat(300), buildSha: 'e'.repeat(300) };
  assert.notStrictEqual(sanitizeContext(huge), null); // ~1.5KB — under cap
});

test('an empty result object is null, not {}', () => {
  assert.strictEqual(sanitizeContext({ unknownOnly: 1 }), null);
});
