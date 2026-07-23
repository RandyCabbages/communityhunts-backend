const test = require('node:test');
const assert = require('node:assert');
const { reconcile, nameKey, passesLiveGate, providersGateOk, catalogFloorOk } = require('./rainbetReconcile');
const golden = require('./__fixtures__/rainbetReconcileGolden.json');

for (const c of golden.cases) {
  test(`reconcile golden: ${c.name}`, () => {
    const liveSet = new Set(c.liveNames);
    const res = reconcile(c.entries, liveSet, { graceDays: c.graceDays, now: new Date(c.now) });
    assert.deepStrictEqual(res.entries.map(e => e.name), c.expect.keptNames);
    assert.strictEqual(res.marked, c.expect.marked);
    assert.strictEqual(res.cleared, c.expect.cleared);
    assert.strictEqual(res.swept, c.expect.swept);
    for (const [name, ms] of Object.entries(c.expect.missingSinceByName)) {
      const e = res.entries.find(x => x.name === name);
      assert.ok(e, `expected kept entry ${name}`);
      assert.strictEqual(e.missingSince ?? null, ms);
    }
  });
}

test('nameKey strips spaces and punctuation', () => {
  assert.strictEqual(nameKey("Mr. Null's Wicked Wares"), 'mrnullswickedwares');
  assert.strictEqual(nameKey('Six Six Six'), 'sixsixsix');
  assert.strictEqual(nameKey('Rock & Roll'), 'rockandroll');
});

test('passesLiveGate fails open on empty set', () => {
  assert.strictEqual(passesLiveGate('Anything', new Set()), true);
});

test('passesLiveGate gates when set is non-empty', () => {
  const set = new Set(['gatesofolympus']);
  assert.strictEqual(passesLiveGate('Gates of Olympus', set), true);
  assert.strictEqual(passesLiveGate('Power of Ninja', set), false);
});

test('providersGateOk requires >= 20', () => {
  assert.strictEqual(providersGateOk(56), true);
  assert.strictEqual(providersGateOk(19), false);
});

test('catalogFloorOk requires >= 50% coverage', () => {
  assert.strictEqual(catalogFloorOk(5000, 8000), true);
  assert.strictEqual(catalogFloorOk(100, 8000), false);
});
