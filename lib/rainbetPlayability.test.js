const test = require('node:test');
const assert = require('node:assert');
const { classify, selectProbeTargets, mergeHistory } = require('./rainbetPlayability');

const LAUNCHER = 'https://cdn.launcher.a8r.games/index.html?options=eyJsYXVuY2';

test('a launcher iframe src means alive', () => {
  assert.strictEqual(classify({ title: 'Play Keys To The Sea Slot by Popiplay - Rainbet', iframeSrcs: [LAUNCHER, ''] }), 'alive');
});

test('iframes present but every src empty means dead', () => {
  // The observed avatarux-majestic-meow shape: the page renders, the player never boots.
  assert.strictEqual(classify({ title: 'Play Majestic Meow Slot by AvatarUX - Rainbet', iframeSrcs: ['', ''] }), 'dead');
});

test('no iframes at all means dead', () => {
  assert.strictEqual(classify({ title: 'Play Something - Rainbet', iframeSrcs: [] }), 'dead');
});

test('a 404 title is an explicit dead answer', () => {
  // Every one of the 12 absent-from-listing slugs sampled on 2026-08-01 titled itself
  // "404 – Rainbet". That beats inferring from iframes.
  assert.strictEqual(classify({ title: '404 – Rainbet', iframeSrcs: [''] }), 'dead');
  assert.strictEqual(classify({ title: '404 – Rainbet', iframeSrcs: [] }), 'dead');
});

test('a 404 outranks regionBlocked', () => {
  // A slug Rainbet 404s is gone regardless of which region we asked about.
  assert.strictEqual(classify({ regionBlocked: true, title: '404 – Rainbet', iframeSrcs: [''] }), 'dead');
});

test('a game whose title merely contains 404 is not treated as a 404 page', () => {
  assert.strictEqual(classify({ title: 'Play Route 404 Slot by Hacksaw - Rainbet', iframeSrcs: [LAUNCHER] }), 'alive');
});

test('region_blocked is never decidable, even with no launcher', () => {
  // hacksaw-le-zeus / 3-oaks-power-sun / nolimit-duck-hunters-happy-hour are all playable
  // on a real session and all look launcher-less from the crawl's vantage.
  assert.strictEqual(classify({ regionBlocked: true, title: 'Play Le Zeus Slot by Hacksaw - Rainbet', iframeSrcs: [''] }), 'unknown');
});

test('a navigation error or Cloudflare interstitial is not evidence', () => {
  assert.strictEqual(classify({ navError: 'Timeout 45000ms exceeded' }), 'unknown');
  assert.strictEqual(classify({ title: 'Just a moment...', iframeSrcs: [] }), 'unknown');
  assert.strictEqual(classify({ title: '', iframeSrcs: [] }), 'unknown');
});

test('candidates are probed before the rolling audit', () => {
  const t = selectProbeTargets({
    candidates: ['a', 'b'], present: ['x', 'y'], limit: 3, history: {},
  });
  assert.deepStrictEqual(t.slice(0, 2), ['a', 'b']);
  assert.strictEqual(t.length, 3);
});

test('candidates alone can consume the whole budget', () => {
  const t = selectProbeTargets({ candidates: ['a', 'b', 'c'], present: ['x'], limit: 2 });
  assert.deepStrictEqual(t, ['a', 'b']);
});

test('the rolling audit takes least-recently-probed first, never-probed first of all', () => {
  const now = new Date('2026-08-01T00:00:00Z');
  const history = {
    recent: { checkedAt: '2026-07-31T00:00:00Z', verdict: 'alive' },
    old: { checkedAt: '2026-01-01T00:00:00Z', verdict: 'alive' },
  };
  const t = selectProbeTargets({
    candidates: [], present: ['recent', 'old', 'never'], history, limit: 10, now, recheckDays: 30,
  });
  assert.deepStrictEqual(t, ['never', 'old'], 'recent is inside the recheck window and skipped');
});

test('a slug is not probed twice in one run', () => {
  const t = selectProbeTargets({ candidates: ['dup'], present: ['dup', 'other'], limit: 10 });
  assert.deepStrictEqual(t, ['dup', 'other']);
});

test('mergeHistory records unknown so the rotation does not thrash on it', () => {
  const now = new Date('2026-08-01T00:00:00Z');
  const h = mergeHistory({}, new Map([['a', 'dead'], ['b', 'unknown']]), now);
  assert.strictEqual(h.a.verdict, 'dead');
  assert.strictEqual(h.b.verdict, 'unknown');
  assert.strictEqual(h.b.checkedAt, '2026-08-01T00:00:00.000Z');
});
