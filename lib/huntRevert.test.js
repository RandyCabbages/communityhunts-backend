const test = require('node:test');
const assert = require('node:assert');
const R = require('./huntRevert');

test('isRevertableRow matches category + target key', () => {
  assert.strictEqual(R.isRevertableRow({ category: 'hunt', target_id: '__vip_hunt__' }, '__vip_hunt__'), true);
  assert.strictEqual(R.isRevertableRow({ category: 'hunt', target_id: '__mod_hunt__' }, '__vip_hunt__'), false);
  assert.strictEqual(R.isRevertableRow({ category: 'admin', target_id: '__vip_hunt__' }, '__vip_hunt__'), false);
  assert.strictEqual(R.isRevertableRow(null, '__vip_hunt__'), false);
});

test('scopedUndoPatch re-appends removed bonuses without mutating the hunt', () => {
  const hunt = { bonuses: [{ slot: 'A' }] };
  const row = { action: 'bonus.delete', detail: { removed: [{ slot: 'B' }] } };
  const patch = R.scopedUndoPatch(hunt, row);
  assert.deepStrictEqual(patch, { bonuses: [{ slot: 'A' }, { slot: 'B' }] });
  assert.deepStrictEqual(hunt.bonuses, [{ slot: 'A' }]); // unmutated
});

test('scopedUndoPatch re-adds removed members, skipping ones already present', () => {
  const hunt = { equity: [{ discordId: '1', name: 'Ann' }] };
  const row = { action: 'equity.remove', detail: { members: [{ discordId: '1', name: 'Ann' }, { name: 'Bo' }] } };
  const patch = R.scopedUndoPatch(hunt, row);
  assert.deepStrictEqual(patch.equity, [{ discordId: '1', name: 'Ann' }, { name: 'Bo' }]);
});

test('scopedUndoPatch throws on a non-undoable action', () => {
  assert.throws(() => R.scopedUndoPatch({}, { action: 'equity.add' }), /not undoable/);
});

test('fullRestorePatch returns the before-snapshot arrays', () => {
  const row = { detail: { before: { bonuses: [{ slot: 'A' }], equity: [{ name: 'Ann' }], calls: [] } } };
  assert.deepStrictEqual(R.fullRestorePatch(row), { bonuses: [{ slot: 'A' }], equity: [{ name: 'Ann' }], calls: [] });
  assert.throws(() => R.fullRestorePatch({ detail: {} }), /no snapshot/);
});
