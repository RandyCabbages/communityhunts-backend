// lib/hallOfFame.js — pure selection logic, no persistence, no env. Fixtures mirror
// the real shapes: hunts = object keyed by userId, archive = array of snapshots.
const { test } = require('node:test');
const assert = require('node:assert');

const {
  collectHallOfFame, pageHallOfFame,
  FAME_MIN_MULT, FAME_CAP, FAME_PAGE_DEFAULT, FAME_PAGE_MAX,
} = require('./hallOfFame');

const REPLAY = 'https://dhh68l6ktxf70.cloudfront.net/replay-manager/?roundid=1&partner=2881';

const user = (id, name) => ({ id, displayName: name, avatar: `https://cdn.example/${id}.png` });

const hunt = (over = {}) => ({
  user: user('u1', 'Hunter One'),
  isLive: false,
  huntType: 'community',
  startedAt: '2026-07-01T00:00:00.000Z',
  archivedAt: null,
  tenantId: 'bean',
  bonuses: [],
  ...over,
});

const bonus = (over = {}) => ({ slot: 'Gates of Olympus', bet: 1, win: 400, replayUrl: REPLAY, ...over });

test('includes only bonuses with a replayUrl', () => {
  const archive = [hunt({ bonuses: [bonus(), bonus({ slot: 'Sugar Rush', replayUrl: '' })] })];
  const out = collectHallOfFame({}, archive, 'bean');
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].slot, 'Gates of Olympus');
  assert.strictEqual(out[0].replayUrl, REPLAY);
});

test('excludes replay hits under the 300x floor', () => {
  const archive = [hunt({ bonuses: [bonus({ win: 299 })] })];
  assert.strictEqual(collectHallOfFame({}, archive, 'bean').length, 0);
  assert.strictEqual(FAME_MIN_MULT, 300);
});

test('excludes non-http(s) replay urls', () => {
  const archive = [hunt({ bonuses: [bonus({ replayUrl: 'javascript:alert(1)' })] })];
  assert.strictEqual(collectHallOfFame({}, archive, 'bean').length, 0);
});

test('sorts by multiplier descending, not recency', () => {
  const archive = [
    hunt({ archivedAt: '2026-07-14T00:00:00.000Z', bonuses: [bonus({ slot: 'Recent Small', win: 350 })] }),
    hunt({ archivedAt: '2026-05-01T00:00:00.000Z', bonuses: [bonus({ slot: 'Old Record', win: 5000 })] }),
  ];
  const out = collectHallOfFame({}, archive, 'bean');
  assert.deepStrictEqual(out.map(h => h.slot), ['Old Record', 'Recent Small']);
  assert.strictEqual(out[0].mult, 5000);
});

test('no per-user cap — one user may hold several records', () => {
  const archive = [hunt({
    bonuses: [
      bonus({ slot: 'A', win: 400 }),
      bonus({ slot: 'B', win: 500 }),
      bonus({ slot: 'C', win: 600 }),
    ],
  })];
  assert.strictEqual(collectHallOfFame({}, archive, 'bean').length, 3);
});

test('returns the FULL sorted list — truncation is the caller\'s job', () => {
  const bonuses = Array.from({ length: 15 }, (_, i) => bonus({ slot: `Slot ${i}`, win: 400 + i }));
  const archive = [hunt({ bonuses })];
  const out = collectHallOfFame({}, archive, 'bean');
  assert.strictEqual(out.length, 15, 'library must not truncate');
  // FAME_CAP still exists and still means "what the hub route shows".
  assert.strictEqual(FAME_CAP, 12);
  assert.ok(out.length > FAME_CAP, 'fixture must exceed the cap for this test to mean anything');
});

test('full list stays mult-desc across the old cap boundary', () => {
  const bonuses = Array.from({ length: 15 }, (_, i) => bonus({ slot: `Slot ${i}`, win: 400 + i }));
  const out = collectHallOfFame({}, [hunt({ bonuses })], 'bean');
  const mults = out.map(h => h.mult);
  assert.deepStrictEqual(mults, [...mults].sort((a, b) => b - a), 'must be sorted descending');
  assert.strictEqual(out[0].mult, 414);   // win 414 / bet 1 — the biggest
  assert.strictEqual(out[14].mult, 400);  // the smallest, past the old cap of 12
});

test('tenant isolation — other tenants never leak; untagged hunts default to bean', () => {
  const archive = [
    hunt({ tenantId: 'otherstreamer', bonuses: [bonus({ slot: 'Foreign' })] }),
    hunt({ tenantId: undefined, bonuses: [bonus({ slot: 'Untagged' })] }),
  ];
  const out = collectHallOfFame({}, archive, 'bean');
  assert.deepStrictEqual(out.map(h => h.slot), ['Untagged']);
});

test('live hunt copy wins the dedupe over an archived duplicate and is flagged live', () => {
  const dupe = bonus();
  const hunts = { u1: hunt({ isLive: true, bonuses: [dupe] }) };
  const archive = [hunt({ archivedAt: '2026-07-10T00:00:00.000Z', bonuses: [dupe] })];
  const out = collectHallOfFame(hunts, archive, 'bean');
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].live, true);
});

test('payload carries the full card shape', () => {
  const out = collectHallOfFame({}, [hunt({ huntType: 'vip', bonuses: [bonus({ bet: 2, win: 800 })] })], 'bean');
  assert.deepStrictEqual(out[0], {
    slot: 'Gates of Olympus', bet: 2, win: 800, mult: 400, currency: 'USD',
    userId: 'u1', username: 'Hunter One', avatar: 'https://cdn.example/u1.png',
    huntType: 'vip', live: false, at: '2026-07-01T00:00:00.000Z',
    archivedAt: null, replayUrl: REPLAY,
  });
});

// --- pageHallOfFame: paging for GET /api/hall-of-fame/all -------------------
// Inputs arrive from a query string, so every test here treats them as untrusted.

test('pageHallOfFame slices by offset and limit, reporting the full total', () => {
  const list = Array.from({ length: 30 }, (_, i) => ({ slot: `S${i}` }));
  const p = pageHallOfFame(list, { limit: 10, offset: 10 });
  assert.strictEqual(p.total, 30, 'total is the full set, not the page');
  assert.strictEqual(p.items.length, 10);
  assert.strictEqual(p.items[0].slot, 'S10');
  assert.strictEqual(p.offset, 10);
  assert.strictEqual(p.limit, 10);
});

test('pageHallOfFame defaults: limit 24, offset 0', () => {
  const list = Array.from({ length: 30 }, (_, i) => ({ slot: `S${i}` }));
  const p = pageHallOfFame(list, {});
  assert.strictEqual(p.limit, FAME_PAGE_DEFAULT);
  assert.strictEqual(p.limit, 24);
  assert.strictEqual(p.offset, 0);
  assert.strictEqual(p.items.length, 24);
  assert.strictEqual(p.items[0].slot, 'S0');
});

test('pageHallOfFame clamps limit to FAME_PAGE_MAX', () => {
  const list = Array.from({ length: 200 }, (_, i) => ({ slot: `S${i}` }));
  const p = pageHallOfFame(list, { limit: 9999 });
  assert.strictEqual(p.limit, FAME_PAGE_MAX);
  assert.strictEqual(p.limit, 50);
  assert.strictEqual(p.items.length, 50);
});

test('pageHallOfFame parses numeric strings from the query string', () => {
  const list = Array.from({ length: 30 }, (_, i) => ({ slot: `S${i}` }));
  const p = pageHallOfFame(list, { limit: '5', offset: '3' });
  assert.strictEqual(p.limit, 5);
  assert.strictEqual(p.offset, 3);
  assert.strictEqual(p.items[0].slot, 'S3');
  assert.strictEqual(p.items.length, 5);
});

test('pageHallOfFame falls back to defaults on garbage, NaN and negatives', () => {
  const list = Array.from({ length: 30 }, (_, i) => ({ slot: `S${i}` }));
  for (const bad of ['abc', '', null, undefined, NaN, -5, 0, {}]) {
    const p = pageHallOfFame(list, { limit: bad, offset: bad });
    assert.strictEqual(p.limit, FAME_PAGE_DEFAULT, `limit fallback for ${JSON.stringify(bad)}`);
    assert.strictEqual(p.offset, 0, `offset fallback for ${JSON.stringify(bad)}`);
  }
});

test('pageHallOfFame past the end yields empty items with a correct total', () => {
  const list = Array.from({ length: 5 }, (_, i) => ({ slot: `S${i}` }));
  const p = pageHallOfFame(list, { limit: 10, offset: 500 });
  assert.deepStrictEqual(p.items, []);
  assert.strictEqual(p.total, 5);
  assert.strictEqual(p.offset, 500);
});

test('pageHallOfFame on an empty list is a well-formed empty envelope', () => {
  const p = pageHallOfFame([], {});
  // `currencies` is empty, not absent: the tab bar reads it unconditionally.
  assert.deepStrictEqual(p, { items: [], total: 0, offset: 0, limit: FAME_PAGE_DEFAULT, currencies: [] });
});

test('paging the real selection keeps rank order across a page boundary', () => {
  const bonuses = Array.from({ length: 15 }, (_, i) => bonus({ slot: `Slot ${i}`, win: 400 + i }));
  const list = collectHallOfFame({}, [hunt({ bonuses })], 'bean');
  const p1 = pageHallOfFame(list, { limit: 12, offset: 0 });
  const p2 = pageHallOfFame(list, { limit: 12, offset: 12 });
  assert.strictEqual(p1.items.length, 12);
  assert.strictEqual(p2.items.length, 3);
  assert.strictEqual(p1.total, 15);
  assert.strictEqual(p2.total, 15);
  // Last of page 1 must still outrank the first of page 2.
  assert.ok(p1.items[11].mult >= p2.items[0].mult);
  assert.deepStrictEqual(
    [...p1.items, ...p2.items].map(h => h.slot),
    list.map(h => h.slot),
    'concatenated pages reconstruct the full list exactly',
  );
});

test('carries the hunt currency onto each hit', () => {
  const archive = [hunt({ currency: 'ARS', bonuses: [bonus()] })];
  const out = collectHallOfFame({}, archive, 'bean');
  assert.strictEqual(out[0].currency, 'ARS');
});

test('a hunt with no currency is reported as USD (legacy rows)', () => {
  const archive = [hunt({ bonuses: [bonus()] })]; // fixture has no currency key
  const out = collectHallOfFame({}, archive, 'bean');
  assert.strictEqual(out[0].currency, 'USD');
});

// --- currency grouping + latest sort ---------------------------------------
// A 3-hit fixture spanning two currencies. Wins differ so mult order is deterministic.
const mixed = () => [
  hunt({ currency: 'USD', archivedAt: '2026-07-01T00:00:00.000Z', bonuses: [bonus({ slot: 'Usd Big', win: 5000 })] }),
  hunt({ currency: 'ARS', archivedAt: '2026-07-03T00:00:00.000Z', bonuses: [bonus({ slot: 'Ars Mid', win: 1000 })] }),
  hunt({ currency: 'USD', archivedAt: '2026-07-02T00:00:00.000Z', bonuses: [bonus({ slot: 'Usd Small', win: 400 })] }),
];

test('currencies rolls up the FULL set, desc by count', () => {
  const all = collectHallOfFame({}, mixed(), 'bean');
  const page = pageHallOfFame(all, {});
  assert.deepStrictEqual(page.currencies, [{ code: 'USD', total: 2 }, { code: 'ARS', total: 1 }]);
});

test('currency filter narrows items and total, but NOT currencies', () => {
  const all = collectHallOfFame({}, mixed(), 'bean');
  const page = pageHallOfFame(all, { currency: 'ARS' });
  assert.deepStrictEqual(page.items.map(h => h.slot), ['Ars Mid']);
  assert.strictEqual(page.total, 1);
  // The tab bar must still show USD while the ARS tab is selected.
  assert.deepStrictEqual(page.currencies, [{ code: 'USD', total: 2 }, { code: 'ARS', total: 1 }]);
});

test('currency filter is case-insensitive', () => {
  const all = collectHallOfFame({}, mixed(), 'bean');
  assert.strictEqual(pageHallOfFame(all, { currency: 'ars' }).total, 1);
});

test('an unknown or junk currency falls back to unfiltered', () => {
  const all = collectHallOfFame({}, mixed(), 'bean');
  assert.strictEqual(pageHallOfFame(all, { currency: 'XYZ' }).total, 3);
  assert.strictEqual(pageHallOfFame(all, { currency: '' }).total, 3);
  assert.strictEqual(pageHallOfFame(all, { currency: { bad: 1 } }).total, 3);
});

test('sort=latest orders by date desc instead of multiplier', () => {
  const all = collectHallOfFame({}, mixed(), 'bean');
  assert.deepStrictEqual(pageHallOfFame(all, { sort: 'latest' }).items.map(h => h.slot),
    ['Ars Mid', 'Usd Small', 'Usd Big']);
  // default stays multiplier-desc
  assert.deepStrictEqual(pageHallOfFame(all, {}).items.map(h => h.slot),
    ['Usd Big', 'Ars Mid', 'Usd Small']);
});

test('an unknown sort falls back to the multiplier default', () => {
  const all = collectHallOfFame({}, mixed(), 'bean');
  assert.deepStrictEqual(pageHallOfFame(all, { sort: 'sideways' }).items.map(h => h.slot),
    ['Usd Big', 'Ars Mid', 'Usd Small']);
});

test('pageHallOfFame does not mutate the caller list', () => {
  const all = collectHallOfFame({}, mixed(), 'bean');
  const before = all.map(h => h.slot);
  pageHallOfFame(all, { sort: 'latest', currency: 'USD' });
  assert.deepStrictEqual(all.map(h => h.slot), before);
});
