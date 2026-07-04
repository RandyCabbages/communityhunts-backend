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

const { WIDGET_FONTS } = require('./overlayConfig');

test('widget color fields: hex6 or null', () => {
  const s = sanitizeOverlayConfig({ primaryColor: '#112233', bgPanel: 'bad', secondaryColor: '#ABCDEF' });
  assert.strictEqual(s.primaryColor, '#112233');
  assert.strictEqual(s.secondaryColor, '#ABCDEF');
  assert.strictEqual(s.bgPanel, null);
});

test('font must be in the whitelist, else null', () => {
  assert.strictEqual(sanitizeOverlayConfig({ font: WIDGET_FONTS[0] }).font, WIDGET_FONTS[0]);
  assert.strictEqual(sanitizeOverlayConfig({ font: 'Comic Sans' }).font, null);
});

test('amounts clamp to finite >= 0', () => {
  assert.strictEqual(sanitizeOverlayConfig({ depositAmount: 250.5 }).depositAmount, 250.5);
  assert.strictEqual(sanitizeOverlayConfig({ depositAmount: -5 }).depositAmount, 0);
  assert.strictEqual(sanitizeOverlayConfig({ withdrawAmount: 'NaN' }).withdrawAmount, 0);
});

test('bools coerce', () => {
  assert.strictEqual(sanitizeOverlayConfig({ showFullWordLabels: 'yes' }).showFullWordLabels, true);
  assert.strictEqual(sanitizeOverlayConfig({ scrollDuringOpening: 0 }).scrollDuringOpening, false);
});

test('existing fields still present', () => {
  const s = sanitizeOverlayConfig({});
  assert.strictEqual(s.aesthetic, 'classic');
  assert.strictEqual(s.primaryColor, null);
});
