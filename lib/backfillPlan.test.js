// scripts/backfill-hunt-history.js seeds hunt_history from the archive. It stamped EVERY hunt it
// touched with `_approxRate: true`, and statsStore.recordHunt re-fetches the LATEST fx rate for
// those — so a second run silently downgrades hunts that were recorded live with an exact same-day
// rate, and overwrites their usd_rate. Measured on the live database 2026-07-27: 93 of 374 hunts
// (24.9%) already carry approx; a re-run pushes that toward 100% and moves the public usdWon
// figure. The script also had no --dry-run and no confirmation, unlike its siblings
// dedupe_rainbet_slots.js and reconcile_rainbet.js which both do.
//
// A backfill should FILL GAPS, not rewrite history. Deciding which hunts are gaps is the part
// worth testing.

const { test } = require('node:test');
const assert = require('node:assert');
const { planBackfill } = require('./backfillPlan');

const H = (huntId, over = {}) => ({
  huntId, user: { id: 'u1' }, bonuses: [{ slot: 'A', bet: 1, win: 2 }], ...over,
});

test('a hunt already in hunt_history is SKIPPED, not re-stamped', () => {
  const p = planBackfill({ hunts: [H('h1')], existingKeys: new Set(['h1']) });
  assert.strictEqual(p.toRecord.length, 0);
  assert.deepStrictEqual(p.skipped.map(h => h.huntId), ['h1'],
    're-recording it would overwrite an exact fx rate with the latest one');
});

test('a genuinely missing hunt IS recorded, and flagged approx', () => {
  const p = planBackfill({ hunts: [H('h2')], existingKeys: new Set() });
  assert.strictEqual(p.toRecord.length, 1);
  assert.strictEqual(p.toRecord[0]._approxRate, true,
    'a backfilled row has no same-day rate — approx is honest for THESE');
});

test('mixed input splits correctly', () => {
  const p = planBackfill({
    hunts: [H('a'), H('b'), H('c')],
    existingKeys: new Set(['b']),
  });
  assert.deepStrictEqual(p.toRecord.map(h => h.huntId).sort(), ['a', 'c']);
  assert.deepStrictEqual(p.skipped.map(h => h.huntId), ['b']);
});

test('hunts with no bonuses are not backfilled', () => {
  const p = planBackfill({ hunts: [H('h1', { bonuses: [] })], existingKeys: new Set() });
  assert.strictEqual(p.toRecord.length, 0, 'archiveHunt refuses these too — nothing to analyse');
});

test('hunts with no user are skipped rather than throwing', () => {
  const p = planBackfill({ hunts: [{ huntId: 'x', bonuses: [{ win: 1 }] }], existingKeys: new Set() });
  assert.strictEqual(p.toRecord.length, 0);
});

// Falls back to the same composite key statsStore.huntKey uses when huntId is absent.
test('a legacy hunt with no huntId keys on user|startedAt', () => {
  const legacy = { user: { id: 'u9' }, startedAt: '2026-01-01T00:00:00.000Z', bonuses: [{ win: 1 }] };
  const already = planBackfill({ hunts: [legacy], existingKeys: new Set(['u9|2026-01-01T00:00:00.000Z']) });
  assert.strictEqual(already.toRecord.length, 0, 'must match statsStore.huntKey, or it re-records every legacy hunt');
});

test('the original input is not mutated', () => {
  const h = H('h1');
  planBackfill({ hunts: [h], existingKeys: new Set() });
  assert.strictEqual(h._approxRate, undefined, 'the flag belongs on the copy sent to recordHunt');
});

test('duplicates in the input are recorded once', () => {
  const p = planBackfill({ hunts: [H('dup'), H('dup')], existingKeys: new Set() });
  assert.strictEqual(p.toRecord.length, 1);
});
