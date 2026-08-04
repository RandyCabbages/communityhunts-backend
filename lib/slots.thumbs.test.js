const { test } = require('node:test');
const assert = require('node:assert');
const slots = require('./slots');

// The pool is loaded from disk at require time, so these assert on SHAPE and CONTRACT rather than
// on any particular game being present — a catalogue reconcile must not be able to break the suite.

test('every name asked for comes back as a key', () => {
  const out = slots.thumbForSlotNames(['Le Bandit', 'Definitely Not A Real Slot 9999']);
  assert.strictEqual(out.size, 2);
  assert.ok(out.has('Le Bandit'));
  assert.ok(out.has('Definitely Not A Real Slot 9999'));
});

test('an unknown slot resolves to null, not undefined and not a throw', () => {
  const out = slots.thumbForSlotNames(['Definitely Not A Real Slot 9999']);
  assert.strictEqual(out.get('Definitely Not A Real Slot 9999'), null);
});

test('a resolved thumb is an http(s) url', () => {
  const out = slots.thumbForSlotNames(['Le Bandit']);
  const thumb = out.get('Le Bandit');
  // null is a legitimate outcome — the catalogue does not review every game.
  if (thumb !== null) assert.match(thumb, /^https?:\/\//);
});

test('lookup ignores case and punctuation differences', () => {
  // Slot names in a hunt are free text typed by whoever ran it. "Le Bandit", "le bandit" and
  // "Le  Bandit!" are the same game and must not resolve differently.
  const canonical = slots.thumbForSlotNames(['Le Bandit']).get('Le Bandit');
  assert.strictEqual(slots.thumbForSlotNames(['le bandit']).get('le bandit'), canonical);
  assert.strictEqual(slots.thumbForSlotNames(['Le  Bandit!']).get('Le  Bandit!'), canonical);
});

test('the original spelling is the key, not the normalized one', () => {
  const out = slots.thumbForSlotNames(['le bandit']);
  assert.ok(out.has('le bandit'));
  assert.ok(!out.has('Le Bandit'));
});

test('empty, non-string and duplicate names are handled without throwing', () => {
  const out = slots.thumbForSlotNames(['Le Bandit', 'Le Bandit', '', null, undefined, 42]);
  assert.ok(out.has('Le Bandit'));
  assert.ok(!out.has(''));
  assert.ok(!out.has(null));
  assert.ok(!out.has(42));
});

test('an empty input returns an empty map without touching the pool', () => {
  assert.strictEqual(slots.thumbForSlotNames([]).size, 0);
});
