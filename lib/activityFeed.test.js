const test = require('node:test');
const assert = require('node:assert');
const { makeActivityFeed, diffOpenedBonuses } = require('./activityFeed');

test('since() returns newest first and advances the cursor', () => {
  const f = makeActivityFeed();
  f.push('bean', { type: 'call', text: 'a called Mental' });
  f.push('bean', { type: 'bonus', text: 'Mental paid $100' });
  const first = f.since('bean', null, 10);
  assert.strictEqual(first.events.length, 2);
  assert.strictEqual(first.events[0].text, 'Mental paid $100'); // newest first
  f.push('bean', { type: 'login', text: 'c signed in' });
  const next = f.since('bean', first.cursor, 10);
  assert.strictEqual(next.events.length, 1);
  assert.strictEqual(next.events[0].text, 'c signed in');
});

test('tenants are isolated', () => {
  const f = makeActivityFeed();
  f.push('bean', { type: 'call', text: 'bean event' });
  f.push('other', { type: 'call', text: 'other event' });
  assert.strictEqual(f.since('bean', null, 10).events.length, 1);
  assert.strictEqual(f.since('other', null, 10).events[0].text, 'other event');
});

test('the buffer is capped and drops oldest first', () => {
  const f = makeActivityFeed({ cap: 3 });
  for (let i = 0; i < 5; i++) f.push('bean', { type: 'call', text: `e${i}` });
  const r = f.since('bean', null, 10);
  assert.strictEqual(r.events.length, 3);
  assert.deepStrictEqual(r.events.map(e => e.text), ['e4', 'e3', 'e2']);
});

test('an unknown tenant yields an empty list, not a throw', () => {
  const f = makeActivityFeed();
  assert.deepStrictEqual(f.since('nobody', null, 10).events, []);
});

test('a cursor ahead of the buffer yields nothing', () => {
  const f = makeActivityFeed();
  f.push('bean', { type: 'call', text: 'x' });
  assert.strictEqual(f.since('bean', 9999, 10).events.length, 0);
});

test('diffOpenedBonuses reports only bonuses that gained a win', () => {
  const before = [{ id: 'a', slot: 'Mental', win: null }, { id: 'b', slot: 'Gates', win: 50 }];
  const after  = [{ id: 'a', slot: 'Mental', win: 200 }, { id: 'b', slot: 'Gates', win: 50 }];
  const opened = diffOpenedBonuses(before, after);
  assert.strictEqual(opened.length, 1);
  assert.strictEqual(opened[0].id, 'a');
});

test('diffOpenedBonuses is reorder-stable and ignores unrelated edits', () => {
  const before = [{ id: 'a', slot: 'Mental', win: 10, bet: 1 }, { id: 'b', slot: 'Gates', win: 20, bet: 1 }];
  const after  = [{ id: 'b', slot: 'Gates', win: 20, bet: 2 }, { id: 'a', slot: 'Mental', win: 10, bet: 1 }];
  assert.deepStrictEqual(diffOpenedBonuses(before, after), []);
});

test('diffOpenedBonuses falls back to slot when a bonus has no id', () => {
  const before = [{ slot: 'Mental', win: null }];
  const after  = [{ slot: 'Mental', win: 300 }];
  assert.strictEqual(diffOpenedBonuses(before, after).length, 1);
});

test('diffOpenedBonuses treats a brand-new already-won bonus as opened', () => {
  assert.strictEqual(diffOpenedBonuses([], [{ id: 'x', slot: 'New', win: 5 }]).length, 1);
});

test('diffOpenedBonuses emits nothing for a zero or null win', () => {
  assert.deepStrictEqual(diffOpenedBonuses([], [{ id: 'x', slot: 'A', win: 0 }, { id: 'y', slot: 'B', win: null }]), []);
});
