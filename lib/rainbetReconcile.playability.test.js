// Covers the three fixes from the 2026-08-01 stale-catalogue investigation:
//   2. a provider the crawl could not enumerate is NOT sweep-eligible (fail closed)
//   3. presence is decided by SLUG (canonKey), not by name
//   4. a playability verdict overrides the listing in BOTH directions
//
// Why each exists is in the comments on lib/rainbetReconcile.js. The measured numbers
// behind them: 900 catalogue entries sat in providers the crawl could not reach, 40 dead
// slugs were masked by a live same-name twin, and avatarux-majestic-meow was present in
// the games API as type=slots/region_blocked=false while being unplayable.

const test = require('node:test');
const assert = require('node:assert');
const { reconcile } = require('./rainbetReconcile');

const NOW = new Date('2026-08-01T12:00:00Z');
const opts = extra => ({ graceDays: 3, now: NOW, ...extra });

// A live index covering one reachable provider (hacksaw) holding one game.
function index(over = {}) {
  return {
    slugs: new Set(['hacksaw:lezeus']),
    names: new Set(['lezeus']),
    reachableProviders: new Set(['hacksaw']),
    ...over,
  };
}

test('provider the crawl could not reach is never marked or swept', () => {
  const entries = [
    // wazdan was unreachable (the voltent games query 400s) — must be left completely alone,
    // even though it carries an old stamp that would otherwise be swept.
    { name: 'Bell Wizard', rainbetSlug: 'voltent-wazdan-bell-wizard', missingSince: '2026-07-01' },
    { name: 'Le Zeus', rainbetSlug: 'hacksaw-le-zeus' },
  ];
  const r = reconcile(entries, index(), opts());
  assert.strictEqual(r.swept, 0, 'unreachable provider must not be swept');
  assert.strictEqual(r.marked, 0);
  assert.strictEqual(r.skipped, 1);
  const kept = r.entries.find(e => e.rainbetSlug === 'voltent-wazdan-bell-wizard');
  assert.ok(kept, 'entry must survive');
  assert.strictEqual(kept.missingSince, '2026-07-01', 'its stamp must be left untouched, not cleared');
});

test('presence is decided by slug, so a live same-name twin no longer masks a dead slug', () => {
  // "Floating Dragon" is live only as pragmatic-play-floating-dragon-holdspin; the bare
  // slug is dead. Name matching kept it forever — 40 real entries were in this state.
  const live = index({
    slugs: new Set(['pragmatic-play:floatingdragonholdspin']),
    names: new Set(['floatingdragon']),
    reachableProviders: new Set(['pragmatic-play']),
  });
  const entries = [{ name: 'Floating Dragon', rainbetSlug: 'pragmatic-play-floating-dragon' }];
  const r = reconcile(entries, live, opts());
  assert.strictEqual(r.marked, 1, 'dead slug must be marked despite the live name twin');
  assert.strictEqual(r.entries[0].missingSince, '2026-08-01');
});

test('slug matching is canonical — a playn-go/play-n-go variant still counts as present', () => {
  const live = index({
    slugs: new Set(['playngo:bookofdead']),
    names: new Set(),
    reachableProviders: new Set(['playngo']),
  });
  const entries = [{ name: 'Book of Dead', rainbetSlug: 'play-n-go-book-of-dead', missingSince: '2026-07-01' }];
  const r = reconcile(entries, live, opts());
  assert.strictEqual(r.cleared, 1);
  assert.strictEqual(r.swept, 0);
  assert.strictEqual(r.entries[0].missingSince, undefined);
});

test('playability verdict "dead" marks an entry the listing still carries', () => {
  // The avatarux-majestic-meow case: in the games API, type=slots, region_blocked=false,
  // and unplayable. No listing-based check can see this.
  const live = index({
    slugs: new Set(['avatarux:majesticmeow']),
    names: new Set(['majesticmeow']),
    reachableProviders: new Set(['avatarux']),
  });
  const entries = [{ name: 'Majestic Meow', rainbetSlug: 'avatarux-majestic-meow' }];
  const r = reconcile(entries, live, opts({
    playability: new Map([['avatarux-majestic-meow', 'dead']]),
  }));
  assert.strictEqual(r.marked, 1);
  assert.strictEqual(r.entries[0].missingSince, '2026-08-01');
});

test('playability verdict "alive" rescues an entry the listing lost', () => {
  // Protects against a canonKey gap or listing lag: if the game actually launches,
  // it stays, and any existing stamp is cleared.
  const entries = [{ name: 'Ghost', rainbetSlug: 'hacksaw-ghost', missingSince: '2026-07-01' }];
  const r = reconcile(entries, index(), opts({
    playability: new Map([['hacksaw-ghost', 'alive']]),
  }));
  assert.strictEqual(r.cleared, 1);
  assert.strictEqual(r.swept, 0);
  assert.strictEqual(r.entries[0].missingSince, undefined);
});

test('playability verdict "unknown" defers to the listing and never sweeps on its own', () => {
  // region_blocked=true games cannot be probed from the crawl's vantage. An entry the
  // listing still carries stays; the verdict adds nothing either way.
  const entries = [{ name: 'Le Zeus', rainbetSlug: 'hacksaw-le-zeus' }];
  const r = reconcile(entries, index(), opts({
    playability: new Map([['hacksaw-le-zeus', 'unknown']]),
  }));
  assert.strictEqual(r.marked, 0);
  assert.strictEqual(r.swept, 0);
});

test('an absent entry past grace is still swept', () => {
  const entries = [{ name: 'Gone', rainbetSlug: 'hacksaw-gone', missingSince: '2026-07-20' }];
  const r = reconcile(entries, index(), opts());
  assert.strictEqual(r.swept, 1);
  assert.strictEqual(r.entries.length, 0);
});

test('legacy Set argument keeps the exact old name-matching behaviour', () => {
  // The golden fixtures call reconcile with a bare Set of nameKeys; that path must not
  // change, and with no provider information nothing may be treated as unreachable.
  const entries = [
    { name: 'SixSixSix', rainbetSlug: 'hacksaw-sixsixsix', missingSince: '2026-07-01' },
    { name: 'Payday', rainbetSlug: 'nolimit-payday' },
  ];
  const r = reconcile(entries, new Set(['sixsixsix']), opts());
  assert.strictEqual(r.cleared, 1);
  assert.strictEqual(r.marked, 1);
  assert.strictEqual(r.skipped, 0);
});

test('an empty reachableProviders set sweeps nothing at all', () => {
  // A totally failed crawl must be inert, not catastrophic.
  const entries = [{ name: 'Gone', rainbetSlug: 'hacksaw-gone', missingSince: '2026-07-01' }];
  const r = reconcile(entries, index({ reachableProviders: new Set() }), opts());
  assert.strictEqual(r.swept, 0);
  assert.strictEqual(r.marked, 0);
  assert.strictEqual(r.skipped, 1);
});
