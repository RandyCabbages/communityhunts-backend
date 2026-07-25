const test = require('node:test');
const assert = require('node:assert');
const { canonKey, splitSlug } = require('./slotSlugCanon');

test('splitSlug prefers the longest provider prefix', () => {
  assert.deepStrictEqual(splitSlug('play-n-go-honey-rush-100'),
    { providerToken: 'play-n-go', gameSlug: 'honey-rush-100' });
  assert.deepStrictEqual(splitSlug('pragmatic-play-great-rhino'),
    { providerToken: 'pragmatic-play', gameSlug: 'great-rhino' });
});

test('provider aliases collapse to one studio token', () => {
  assert.strictEqual(canonKey('playn-go-honey-rush-100'), canonKey('play-n-go-honey-rush-100'));
  assert.strictEqual(canonKey('nownow-shadow-treasure'), canonKey('nownow-gaming-shadow-treasure'));
  assert.strictEqual(canonKey('wazdan-30-coins-score-the-jackpot'),
    canonKey('voltent-wazdan-30-coins-score-the-jackpot'));
});

test('apostrophe and word-join variants collapse', () => {
  assert.strictEqual(canonKey('pragmatic-play-santas-xmas-rush'),
    canonKey('pragmatic-play-santa-s-xmas-rush'));
  assert.strictEqual(canonKey('hacksaw-stack-em'), canonKey('hacksaw-stackem'));
  assert.strictEqual(canonKey('hacksaw-rusty-curly'), canonKey('hacksaw-rusty-and-curly'));
});

test('different studios with the same game name never collide', () => {
  assert.notStrictEqual(canonKey('endorphina-bad-santa'), canonKey('peter-sons-bad-santa'));
  assert.notStrictEqual(canonKey('shady-lady-laced'), canonKey('thunderkick-laced'));
});
