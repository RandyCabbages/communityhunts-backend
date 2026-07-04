const { test } = require('node:test');
const assert = require('node:assert');
const { sanitizeOverlayConfig, DEFAULT_OVERLAY_CONFIG } = require('./overlayConfig');

test('defaults when given garbage', () => {
  assert.deepStrictEqual(sanitizeOverlayConfig(null), DEFAULT_OVERLAY_CONFIG);
  assert.deepStrictEqual(sanitizeOverlayConfig('nope'), DEFAULT_OVERLAY_CONFIG);
});

test('keeps valid aesthetic/size, rejects unknown', () => {
  assert.strictEqual(sanitizeOverlayConfig({ aesthetic: 'pass' }).aesthetic, 'pass');
  assert.strictEqual(sanitizeOverlayConfig({ aesthetic: 'x' }).aesthetic, 'classic');
  assert.strictEqual(sanitizeOverlayConfig({ size: 'compact' }).size, 'compact');
});

test('accent must be hex6 or null', () => {
  assert.strictEqual(sanitizeOverlayConfig({ accent: '#a1b2c3' }).accent, '#a1b2c3');
  assert.strictEqual(sanitizeOverlayConfig({ accent: 'red' }).accent, null);
});
