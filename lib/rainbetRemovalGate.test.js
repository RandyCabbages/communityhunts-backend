// The UNATTENDED slot sync auto-commits its result to main. Its removal path had exactly ONE
// guard — "fewer than 50% removed" — while the MANUAL script (scripts/reconcile_rainbet.js) has
// three real ones (provider count, catalog floor, Cloudflare-didn't-clear) and hard-aborts on any.
// The safer script is the one a human watches; the one that pushes to main unattended had none.
//
// Currently dormant only because slot.report is up: removal arms only when `isFullCatalog` is
// true, which requires the DOM crawl to be the sole source. The day slot.report has an outage,
// a partial crawl (Cloudflare half-cleared, the maxClicks=500 cap hit, or "Load more" markup
// changed) returning 4,000 of 7,568 slots passes `4000 - 7568*0.5` and auto-deletes ~3,500 rows.

const { test } = require('node:test');
const assert = require('node:assert');
const { removalAllowed } = require('./rainbetReconcile');

const CATALOG = 7568;
const ok = (over = {}) => removalAllowed({
  isFullCatalog: true, removedCount: 50, existingCount: CATALOG,
  providerCount: 40, liveCount: CATALOG - 50, ...over,
});

test('a normal small removal is allowed', () => {
  const r = ok();
  assert.strictEqual(r.ok, true, r.reason);
});

test('the partial-crawl catastrophe is refused', () => {
  // 4,000 of 7,568 came back — the old 50% rule let this through.
  const r = ok({ removedCount: 3568, liveCount: 4000 });
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /removal|floor|ratio/i);
});

test('removal never arms without a full-catalog crawl', () => {
  const r = ok({ isFullCatalog: false, removedCount: 10 });
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /full catalog/i);
});

test('too few providers refuses (the manual script gate)', () => {
  const r = ok({ providerCount: 3 });
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /provider/i);
});

test('a collapsed live count refuses (catalog floor)', () => {
  const r = ok({ liveCount: 1000, removedCount: 100 });
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /floor|live/i);
});

// The absolute cap is the point: the old rule permitted deleting 49.9% of the catalog in one
// unattended run. Real churn is a handful of slots.
test('a removal over the absolute cap refuses even with every other gate passing', () => {
  const r = ok({ removedCount: Math.round(CATALOG * 0.2), liveCount: CATALOG });
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /cap|ratio|too many/i);
});

test('nothing to remove is a no-op, not an error', () => {
  const r = ok({ removedCount: 0 });
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /nothing/i);
});

test('an empty catalog can never authorise removal', () => {
  const r = ok({ existingCount: 0, removedCount: 0, liveCount: 0 });
  assert.strictEqual(r.ok, false);
});

// Escape hatch for a genuine mass delisting, so the cap is not a dead end.
test('an explicit override permits an oversized removal', () => {
  const r = ok({ removedCount: Math.round(CATALOG * 0.2), liveCount: CATALOG, override: true });
  assert.strictEqual(r.ok, true, r.reason);
});

test('the override still cannot bypass the partial-crawl gates', () => {
  const r = ok({ removedCount: 3568, liveCount: 4000, providerCount: 3, override: true });
  assert.strictEqual(r.ok, false, 'a broken crawl is not a delisting, whatever the operator forces');
});
