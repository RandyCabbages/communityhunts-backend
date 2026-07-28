const test = require('node:test');
const assert = require('node:assert');
const { buildUndoEntry, pushUndoEntry, undoPatch, popUndo, MAX_ENTRIES } = require('./huntUndo');

const bonus = (id, over = {}) => ({ id, slot: id, bet: 10, win: null, mult: null, ...over });
const hunt = (over = {}) => ({ bonuses: [], equity: [], calls: [], ...over });

// Round-trip: apply the write, undo it, and you are back where you started.
const roundTrip = (before, after, meta) => {
  const entry = buildUndoEntry(before, after, meta);
  assert.ok(entry, 'expected a change to be recorded');
  return { entry, undone: { ...after, ...undoPatch(after, entry) } };
};

test('a no-op PUT records nothing', () => {
  const h = hunt({ bonuses: [bonus('a', { win: 500 })], huntMode: 'rolling' });
  // Clients re-PUT unchanged state on a debounce. Recording it would fill the log with entries that
  // do nothing when replayed, so Undo would appear dead until you clicked it enough times.
  assert.equal(buildUndoEntry(h, JSON.parse(JSON.stringify(h))), null);
});

test('undoes a win, leaving every other row alone', () => {
  const before = hunt({ bonuses: [bonus('a'), bonus('b')] });
  const after = hunt({ bonuses: [bonus('a', { win: 500, mult: 50 }), bonus('b')] });
  const { undone } = roundTrip(before, after);
  assert.equal(undone.bonuses.find(b => b.id === 'a').win, null);
  assert.equal(undone.bonuses.length, 2);
});

// THE POINT OF THE WHOLE FEATURE. The entry is applied to CURRENT state, not to the state it was
// recorded against, so work done after it — by anyone, from either client — survives.
test('undo applied to newer state keeps what happened after it was recorded', () => {
  const before = hunt({ bonuses: [bonus('a'), bonus('b')] });
  const after = hunt({ bonuses: [bonus('a', { win: 500, mult: 50 }), bonus('b')] });
  const entry = buildUndoEntry(before, after);

  // Meanwhile: the site opened 'b' for 900 and added 'c'.
  const current = hunt({ bonuses: [bonus('a', { win: 500, mult: 50 }), bonus('b', { win: 900, mult: 45 }), bonus('c')] });
  const undone = { ...current, ...undoPatch(current, entry) };

  assert.equal(undone.bonuses.find(b => b.id === 'a').win, null); // the recorded action reverses
  assert.equal(undone.bonuses.find(b => b.id === 'b').win, 900);  // NOT rolled back
  assert.ok(undone.bonuses.find(b => b.id === 'c'));              // NOT deleted
});

test('undoes an added row by removing it', () => {
  const before = hunt({ bonuses: [bonus('a')] });
  const after = hunt({ bonuses: [bonus('a'), bonus('new')] });
  const { undone } = roundTrip(before, after);
  assert.deepEqual(undone.bonuses.map(b => b.id), ['a']);
});

test('undoes a deletion by putting the row back where it was', () => {
  const before = hunt({ bonuses: [bonus('a'), bonus('b'), bonus('c')] });
  const after = hunt({ bonuses: [bonus('a'), bonus('c')] });
  const { undone } = roundTrip(before, after);
  assert.deepEqual(undone.bonuses.map(b => b.id), ['a', 'b', 'c']);
});

test('undoes a pure reorder', () => {
  const before = hunt({ bonuses: [bonus('a'), bonus('b'), bonus('c')] });
  const after = hunt({ bonuses: [bonus('a'), bonus('c'), bonus('b')] });
  const { entry, undone } = roundTrip(before, after);
  assert.deepEqual(entry.order.bonuses, ['a', 'b', 'c']);
  assert.deepEqual(undone.bonuses.map(b => b.id), ['a', 'b', 'c']);
});

// A row edit must not drag the sequence back with it, or undoing a win would silently re-sort a
// board someone had deliberately reordered since.
test('a value edit records no order change', () => {
  const before = hunt({ bonuses: [bonus('a'), bonus('b')] });
  const after = hunt({ bonuses: [bonus('a', { win: 5 }), bonus('b')] });
  assert.deepEqual(buildUndoEntry(before, after).order, {});
});

test('a reorder undo keeps rows added since, at the end', () => {
  const before = hunt({ bonuses: [bonus('a'), bonus('b')] });
  const after = hunt({ bonuses: [bonus('b'), bonus('a')] });
  const entry = buildUndoEntry(before, after);
  const current = hunt({ bonuses: [bonus('b'), bonus('a'), bonus('late')] });
  const undone = { ...current, ...undoPatch(current, entry) };
  assert.deepEqual(undone.bonuses.map(b => b.id), ['a', 'b', 'late']);
});

test('undoes vault, equity and calls the same way', () => {
  const before = hunt({ vault: [{ id: 'v1', amount: 300 }], equity: [{ id: 'e1', amount: 100 }], calls: [{ id: 'c1', status: 'pending' }] });
  const after = hunt({
    vault: [{ id: 'v1', amount: 300 }, { id: 'v2', amount: 50 }],
    equity: [{ id: 'e1', amount: 250 }],
    calls: [{ id: 'c1', status: 'out' }],
  });
  const { undone } = roundTrip(before, after);
  assert.deepEqual(undone.vault.map(v => v.id), ['v1']);
  assert.equal(undone.equity[0].amount, 100);
  assert.equal(undone.calls[0].status, 'pending');
});

test('undoes a scalar without touching the others', () => {
  const before = hunt({ huntMode: 'buying', callLimit: 20 });
  const after = hunt({ huntMode: 'rolling', callLimit: 20 });
  const { entry, undone } = roundTrip(before, after);
  assert.deepEqual(Object.keys(entry.scalars), ['huntMode']);
  assert.equal(undone.huntMode, 'buying');
});

// Fields the entry says nothing about must come through untouched — that is what makes applying an
// old entry to current state safe.
test('the patch only names fields the entry actually covers', () => {
  const before = hunt({ bonuses: [bonus('a')], huntMode: 'buying' });
  const after = hunt({ bonuses: [bonus('a', { win: 5 })], huntMode: 'buying' });
  const patch = undoPatch(after, buildUndoEntry(before, after));
  assert.deepEqual(Object.keys(patch), ['bonuses']);
});

test('history is capped and drops the oldest', () => {
  const h = hunt();
  for (let i = 0; i < MAX_ENTRIES + 5; i++) pushUndoEntry(h, { rows: {}, order: {}, scalars: { callLimit: i } });
  assert.equal(h.undoLog.length, MAX_ENTRIES);
  assert.equal(h.undoLog[0].scalars.callLimit, 5);
});

test('popUndo walks back through the history, newest first', () => {
  const h = hunt({ bonuses: [bonus('a')], huntMode: 'buying' });
  const s1 = JSON.parse(JSON.stringify(h));
  Object.assign(h, { huntMode: 'rolling' });
  pushUndoEntry(h, buildUndoEntry(s1, h));

  const s2 = JSON.parse(JSON.stringify(h));
  h.bonuses = [bonus('a', { win: 700 })];
  pushUndoEntry(h, buildUndoEntry(s2, h));

  const first = popUndo(h);          // the win, not the mode
  Object.assign(h, first.patch);
  assert.equal(h.bonuses[0].win, null);
  assert.equal(h.huntMode, 'rolling');

  const second = popUndo(h);
  Object.assign(h, second.patch);
  assert.equal(h.huntMode, 'buying');

  assert.equal(popUndo(h), null);    // exhausted
});

test('popUndo on a hunt with no history is null, not a throw', () => {
  assert.equal(popUndo(hunt()), null);
  assert.equal(popUndo(null), null);
});

test('buildUndoEntry tolerates a hunt with missing collections', () => {
  assert.equal(buildUndoEntry({}, {}), null);
  const e = buildUndoEntry({}, { bonuses: [bonus('a')] });
  assert.deepEqual(e.rows.bonuses.addedIds, ['a']);
});

test('rows without ids are ignored rather than crashing', () => {
  const before = hunt({ bonuses: [{ slot: 'no id' }] });
  const after = hunt({ bonuses: [{ slot: 'no id' }, bonus('a')] });
  const e = buildUndoEntry(before, after);
  assert.deepEqual(e.rows.bonuses.addedIds, ['a']);
});
