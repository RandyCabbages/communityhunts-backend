const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const cardReleases = require('./cardReleases');

// With no pgPool the module persists to card_releases.json in the backend root (file
// fallback). Reset before each test and remove it after the run so tests leave no artifact.
const FILE = path.join(__dirname, '..', 'card_releases.json');
const clean = () => { try { fs.unlinkSync(FILE); } catch {} };

beforeEach(async () => { clean(); await cardReleases.initCardReleases({}); });
after(clean);

test('starts empty', () => {
  assert.deepStrictEqual(cardReleases.listReleased(), []);
});

test('setReleased(true) makes a card live, and is idempotent', () => {
  cardReleases.setReleased('card_cook', true);
  assert.deepStrictEqual(cardReleases.listReleased(), ['card_cook']);
  cardReleases.setReleased('card_cook', true);
  assert.deepStrictEqual(cardReleases.listReleased(), ['card_cook'], 'no duplicate on re-release');
});

test('setReleased(false) un-releases; removing an absent id is a no-op', () => {
  cardReleases.setReleased('card_cook', true);
  cardReleases.setReleased('card_cook', false);
  assert.deepStrictEqual(cardReleases.listReleased(), []);
  assert.doesNotThrow(() => cardReleases.setReleased('card_never_seen', false));
  assert.deepStrictEqual(cardReleases.listReleased(), []);
});

test('setReleased returns the full list', () => {
  assert.deepStrictEqual(cardReleases.setReleased('card_cook', true), ['card_cook']);
  assert.deepStrictEqual(cardReleases.setReleased('card_orange', true), ['card_cook', 'card_orange']);
});

test('survives a re-init (file fallback)', async () => {
  cardReleases.setReleased('card_cook', true);
  await cardReleases.initCardReleases({});
  assert.deepStrictEqual(cardReleases.listReleased(), ['card_cook'], 'reloaded from disk');
});

test('a stale id for a card that no longer exists round-trips inertly', async () => {
  cardReleases.setReleased('card_deleted_long_ago', true);
  await cardReleases.initCardReleases({});
  assert.ok(cardReleases.listReleased().includes('card_deleted_long_ago'), 'stored, never matched');
});
