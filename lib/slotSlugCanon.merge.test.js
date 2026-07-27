// Regression guard for the new-releases merge in scripts/check_new_slots.js.
//
// That merge used to key on the literal lowercased slug. Rainbet serves some titles as
// playn-go-… and others as play-n-go-… with no derivable rule, so the two spellings of ONE
// game compared as different rows and the merge re-added a duplicate for every Play'n GO
// title already in the catalog — 294 in a single observed run. The catalog then tripped
// "shipped catalog has no two rows sharing a canonKey" and needed a manual dedupe pass.
//
// The merge is embedded in a long scraper function that needs a browser, so this pins the
// KEYING RULE the merge must use rather than importing it.

const { test } = require('node:test');
const assert = require('node:assert');
const { canonKey } = require('./slotSlugCanon');

// Mirrors the fixed merge: dedupe candidates against existing rows by canonKey.
function mergeNewReleases(games, newReleases) {
  const seen = new Set(games.map(g => canonKey(g.rainbetSlug || '')));
  const out = games.slice();
  for (const nr of newReleases) {
    const k = canonKey(nr.rainbetSlug || '');
    if (!seen.has(k)) { out.push(nr); seen.add(k); }
  }
  return out;
}

test('a play-n-go / playn-go spelling variant is NOT re-added', () => {
  const games = [{ rainbetSlug: 'play-n-go-spice-spice-baby', name: 'Spice Spice Baby' }];
  const merged = mergeNewReleases(games, [
    { rainbetSlug: 'playn-go-spice-spice-baby', name: 'Spice Spice Baby' },
  ]);
  assert.strictEqual(merged.length, 1, 'the two spellings are one game');
});

test('the reverse spelling order is also collapsed', () => {
  const games = [{ rainbetSlug: 'playn-go-legion-gold-reckoning' }];
  const merged = mergeNewReleases(games, [{ rainbetSlug: 'play-n-go-legion-gold-reckoning' }]);
  assert.strictEqual(merged.length, 1);
});

test('a genuinely new game IS still added', () => {
  const games = [{ rainbetSlug: 'play-n-go-book-of-dead' }];
  const merged = mergeNewReleases(games, [{ rainbetSlug: 'hacksaw-le-bandit' }]);
  assert.strictEqual(merged.length, 2);
  assert.strictEqual(merged[1].rainbetSlug, 'hacksaw-le-bandit');
});

// Same game name from a DIFFERENT studio must stay separate — over-collapsing would delete
// a real slot from the catalog.
test('same title from different providers stays two rows', () => {
  const games = [{ rainbetSlug: 'endorphina-bad-santa' }];
  const merged = mergeNewReleases(games, [{ rainbetSlug: 'peter-sons-bad-santa' }]);
  assert.strictEqual(merged.length, 2);
});

test('a batch of variants collapses to nothing added', () => {
  const games = Array.from({ length: 50 }, (_, i) => ({ rainbetSlug: `play-n-go-game-${i}` }));
  const dupes = Array.from({ length: 50 }, (_, i) => ({ rainbetSlug: `playn-go-game-${i}` }));
  assert.strictEqual(mergeNewReleases(games, dupes).length, 50,
    'this is the 294-duplicate scenario in miniature');
});
