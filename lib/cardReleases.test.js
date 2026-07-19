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
  assert.deepStrictEqual(cardReleases.listReleased(), {});
});

test('setReleased(true) makes a card live; idempotent', () => {
  cardReleases.setReleased('card_cook', true);
  assert.deepStrictEqual(cardReleases.listReleased(), { card_cook: true });
  cardReleases.setReleased('card_cook', true);
  assert.deepStrictEqual(cardReleases.listReleased(), { card_cook: true }, 'no change on re-set');
});

test('setReleased(false) records an explicit hide (both directions latch)', () => {
  cardReleases.setReleased('card_tylerrr', false);
  assert.deepStrictEqual(cardReleases.listReleased(), { card_tylerrr: false },
    'an explicit false is stored so a never-hidden card can be hidden');
  cardReleases.setReleased('card_tylerrr', true);
  assert.deepStrictEqual(cardReleases.listReleased(), { card_tylerrr: true });
});

test('setReleased returns the full map', () => {
  assert.deepStrictEqual(cardReleases.setReleased('card_cook', true), { card_cook: true });
  assert.deepStrictEqual(cardReleases.setReleased('card_tylerrr', false),
    { card_cook: true, card_tylerrr: false });
});

test('survives a re-init (file fallback)', async () => {
  cardReleases.setReleased('card_cook', true);
  cardReleases.setReleased('card_tylerrr', false);
  await cardReleases.initCardReleases({});
  assert.deepStrictEqual(cardReleases.listReleased(), { card_cook: true, card_tylerrr: false },
    'reloaded from disk');
});

test('migrates a legacy array value to a {id:true} map on load', async () => {
  // Simulate the pre-map persisted shape written straight to the file.
  fs.writeFileSync(FILE, JSON.stringify(['card_cook', 'card_orange']), 'utf8');
  await cardReleases.initCardReleases({});
  assert.deepStrictEqual(cardReleases.listReleased(), { card_cook: true, card_orange: true });
});
