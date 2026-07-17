const test = require('node:test');
const assert = require('node:assert');
const { diffBonuses, summarize } = require('./auditLog');

test('diffBonuses: detects a deletion by slot', () => {
  const before = [{ slot: 'Gates of Olympus' }, { slot: 'Sugar Rush' }];
  const after  = [{ slot: 'Gates of Olympus' }];
  const d = diffBonuses(before, after);
  assert.strictEqual(d.removed.length, 1);
  assert.strictEqual(d.removed[0].slot, 'Sugar Rush');
  assert.strictEqual(d.cleared, false);
});

test('diffBonuses: ignores a pure reorder', () => {
  const before = [{ slot: 'A' }, { slot: 'B' }, { slot: 'C' }];
  const after  = [{ slot: 'C' }, { slot: 'A' }, { slot: 'B' }];
  assert.strictEqual(diffBonuses(before, after).removed.length, 0);
});

test('diffBonuses: ignores a win/bet value edit', () => {
  const before = [{ slot: 'A', bet: 1, win: 0 }];
  const after  = [{ slot: 'A', bet: 1, win: 250 }];
  assert.strictEqual(diffBonuses(before, after).removed.length, 0);
});

test('diffBonuses: prefers id over slot, duplicate-safe', () => {
  const before = [{ id: 'x', slot: 'A' }, { id: 'y', slot: 'A' }];
  const after  = [{ id: 'x', slot: 'A' }];
  const d = diffBonuses(before, after);
  assert.strictEqual(d.removed.length, 1);
  assert.strictEqual(d.removed[0].id, 'y');
});

test('diffBonuses: cleared flag when after is empty', () => {
  const d = diffBonuses([{ slot: 'A' }], []);
  assert.strictEqual(d.cleared, true);
  assert.strictEqual(d.removed.length, 1);
});

test('summarize: bonus.delete lists up to 3 + overflow', () => {
  const s = summarize('bonus.delete', {
    actorName: 'Kyle', targetName: 'Bean',
    removed: [{ slot: 'A' }, { slot: 'B' }, { slot: 'C' }, { slot: 'D' }],
  });
  assert.match(s, /Kyle removed 4 bonuses \(A, B, C, \+1\) from Bean's hunt/);
});
