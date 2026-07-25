const test = require('node:test');
const assert = require('node:assert');
const { planDedupe } = require('./slotDedupe');

// nameKey -> every live Rainbet game with that name. Must be a list: two studios
// genuinely ship a game called "Bad Santa", and keeping only one would make the
// other look like a duplicate.
const live = new Map([
  ['honeyrush100', [{ url: 'play-n-go-honey-rush-100' }]],
  ['badsanta', [{ url: 'endorphina-bad-santa' }, { url: 'peter-sons-bad-santa' }]],
  ['sleepygrandpa', [{ url: 'backseat-gaming-sleepy-grandpa' }]],
]);

test('collapses a variant pair onto the slug Rainbet actually serves', () => {
  const entries = [
    { rainbetSlug: 'playn-go-honey-rush-100', name: 'Honey Rush 100', thumb: 'a' },
    { rainbetSlug: 'play-n-go-honey-rush-100', name: 'Honey Rush 100', thumb: 'b' },
  ];
  const r = planDedupe(entries, live);
  assert.strictEqual(r.keep.length, 1);
  assert.strictEqual(r.keep[0].rainbetSlug, 'play-n-go-honey-rush-100');
  assert.strictEqual(r.drop.length, 1);
});

test('keeps both rows when two studios genuinely share a name', () => {
  const entries = [
    { rainbetSlug: 'endorphina-bad-santa', name: 'Bad Santa', thumb: 'a' },
    { rainbetSlug: 'peter-sons-bad-santa', name: 'Bad Santa', thumb: 'b' },
  ];
  const r = planDedupe(entries, live);
  assert.strictEqual(r.keep.length, 2);
  assert.strictEqual(r.drop.length, 0);
});

test('drops a mis-attributed provider prefix when Rainbet serves only one studio', () => {
  const entries = [
    { rainbetSlug: 'hacksaw-sleepy-grandpa', name: 'Sleepy Grandpa', thumb: 'a' },
    { rainbetSlug: 'backseat-gaming-sleepy-grandpa', name: 'Sleepy Grandpa', thumb: 'b' },
  ];
  const r = planDedupe(entries, live);
  assert.strictEqual(r.keep.length, 1);
  assert.strictEqual(r.keep[0].rainbetSlug, 'backseat-gaming-sleepy-grandpa');
});

test('keeps every row of a cross-studio group Rainbet does not list at all', () => {
  const entries = [
    { rainbetSlug: 'shady-lady-laced', name: 'Laced', thumb: 'a' },
    { rainbetSlug: 'thunderkick-laced', name: 'Laced', thumb: 'b' },
  ];
  const r = planDedupe(entries, live);
  assert.strictEqual(r.keep.length, 2);
  assert.strictEqual(r.drop.length, 0);
});

test('a group with no live match collapses to one row, preferring a thumb', () => {
  const entries = [
    { rainbetSlug: 'hacksaw-stack-em', name: 'Stack Em', thumb: null },
    { rainbetSlug: 'hacksaw-stackem', name: 'Stack Em', thumb: 'good' },
  ];
  const r = planDedupe(entries, new Map());
  assert.strictEqual(r.keep.length, 1);
  assert.strictEqual(r.keep[0].thumb, 'good');
});

test('non-duplicate rows pass through untouched', () => {
  const entries = [
    { rainbetSlug: 'hacksaw-solo', name: 'Solo', thumb: 'x' },
    { rainbetSlug: 'netent-other', name: 'Other', thumb: 'y' },
  ];
  const r = planDedupe(entries, live);
  assert.strictEqual(r.keep.length, 2);
  assert.strictEqual(r.drop.length, 0);
});
