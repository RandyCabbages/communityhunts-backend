const test = require('node:test');
const assert = require('node:assert');
const { computeOverviewMetrics, groupHuntsByCurrency } = require('./adminMetrics');

const HOUR = 3600 * 1000;
const NOW = 1700000000000;

const hunt = (over = {}) => ({
  isLive: false, archivedAt: null, currency: 'USD',
  user: { id: 'u1', displayName: 'Runner' },
  equity: [], calls: [], bonuses: [], ...over,
});

test('groupHuntsByCurrency buckets by hunt.currency, untagged as USD', () => {
  const g = groupHuntsByCurrency([hunt({ currency: 'ARS' }), hunt({ currency: null }), hunt()]);
  assert.strictEqual(g.get('ARS').length, 1);
  assert.strictEqual(g.get('USD').length, 2);
});

test('kpis count live hunts and opened bonuses inside the range', () => {
  const hunts = [
    hunt({ isLive: true, bonuses: [
      { slot: 'Mental', bet: 10, win: 100, ts: NOW - HOUR },
      { slot: 'Mental', bet: 10, win: null, ts: NOW - HOUR },
      { slot: 'Old',    bet: 10, win: 50,  ts: NOW - 100 * HOUR }, // outside a 24h range
    ] }),
  ];
  const r = computeOverviewMetrics(hunts, { now: NOW, rangeMs: 24 * HOUR, currency: 'USD' });
  assert.strictEqual(r.kpis.liveHunts, 1);
  assert.strictEqual(r.kpis.bonusesOpened, 1);
  assert.strictEqual(r.kpis.wagered, 20); // both in-range bonuses' bets, opened or not
});

test('rangeMs null means all time', () => {
  const hunts = [hunt({ bonuses: [{ slot: 'A', bet: 5, win: 5, ts: NOW - 10000 * HOUR }] })];
  const r = computeOverviewMetrics(hunts, { now: NOW, rangeMs: null, currency: 'USD' });
  assert.strictEqual(r.kpis.bonusesOpened, 1);
});

test('activity buckets the last 24h and the 24h before it, newest bucket last', () => {
  const hunts = [hunt({ bonuses: [
    { slot: 'A', bet: 1, win: 1, ts: NOW - 30 * 60 * 1000 },  // this hour
    { slot: 'B', bet: 1, win: 1, ts: NOW - 25 * HOUR },       // yesterday window
  ] })];
  const r = computeOverviewMetrics(hunts, { now: NOW, rangeMs: null, currency: 'USD' });
  assert.strictEqual(r.activity.today.length, 24);
  assert.strictEqual(r.activity.yesterday.length, 24);
  assert.strictEqual(r.activity.today[23], 1);
  assert.strictEqual(r.activity.yesterday.reduce((a, b) => a + b, 0), 1);
});

test('topGames ranks by opens and reports the best multiplier', () => {
  const hunts = [hunt({ bonuses: [
    { slot: 'Mental', bet: 10, win: 1000, ts: NOW },
    { slot: 'Mental', bet: 10, win: 20,   ts: NOW },
    { slot: 'Gates',  bet: 10, win: 30,   ts: NOW },
  ] })];
  const r = computeOverviewMetrics(hunts, { now: NOW, rangeMs: null, currency: 'USD' });
  assert.strictEqual(r.topGames[0].name, 'Mental');
  assert.strictEqual(r.topGames[0].opens, 2);
  assert.strictEqual(r.topGames[0].bestMulti, 100);
});

test('biggestWins is sorted by multiplier, carries the hunter name', () => {
  const hunts = [hunt({ user: { id: 'u1', displayName: 'Bean' }, bonuses: [
    { slot: 'A', bet: 10, win: 100, ts: NOW },
    { slot: 'B', bet: 10, win: 900, ts: NOW },
  ] })];
  const r = computeOverviewMetrics(hunts, { now: NOW, rangeMs: null, currency: 'USD' });
  assert.strictEqual(r.biggestWins[0].slot, 'B');
  assert.strictEqual(r.biggestWins[0].mult, 90);
  assert.strictEqual(r.biggestWins[0].hunter, 'Bean');
});

test('nearBreakEven counts live hunts within 20% of covering their start cost', () => {
  const hunts = [
    hunt({ isLive: true, equity: [{ amount: 100 }], bonuses: [{ slot: 'A', bet: 1, win: 85, ts: NOW }] }),
    hunt({ isLive: true, equity: [{ amount: 100 }], bonuses: [{ slot: 'A', bet: 1, win: 10, ts: NOW }] }),
  ];
  const r = computeOverviewMetrics(hunts, { now: NOW, rangeMs: null, currency: 'USD' });
  assert.strictEqual(r.kpis.nearBreakEven, 1);
});

test('caller stats are ALL-TIME and ignore the selected range', () => {
  // Calls carry no timestamp, so they cannot be range-filtered. Filtering only the bonuses left
  // the denominator all-time and the numerator in-range, which read as ~0% on the default
  // "Today" range even for a caller with a perfect record.
  const hunts = [hunt({
    calls: [
      { slot: 'Mental', user: 'alice', callerId: '111' },
      { slot: 'Gates', user: 'alice', callerId: '111' },
    ],
    bonuses: [
      { slot: 'Mental', bet: 10, win: 100, caller: 'alice', callerId: '111', ts: NOW - 500 * HOUR },
      { slot: 'Gates',  bet: 10, win: 200, caller: 'alice', callerId: '111', ts: NOW - 500 * HOUR },
    ],
  })];
  const today = computeOverviewMetrics(hunts, { now: NOW, rangeMs: 24 * HOUR, currency: 'USD' });
  const all   = computeOverviewMetrics(hunts, { now: NOW, rangeMs: null, currency: 'USD' });
  assert.strictEqual(today.callers.best[0].hitRate, 1, 'old got-ins must still count on a Today range');
  assert.deepStrictEqual(today.callers.best, all.callers.best);
});

test('an empty hunt list yields zeroed, well-formed output', () => {
  const r = computeOverviewMetrics([], { now: NOW, rangeMs: null, currency: 'USD' });
  assert.strictEqual(r.kpis.liveHunts, 0);
  assert.strictEqual(r.topGames.length, 0);
  assert.strictEqual(r.activity.today.length, 24);
});
