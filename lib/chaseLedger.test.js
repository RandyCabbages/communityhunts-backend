const test = require('node:test');
const assert = require('node:assert');
const { computePostHunt } = require('./chaseLedger');
const golden = require('./__fixtures__/chaseLedgerGolden.json');

for (const c of golden.cases) {
  test(`golden: ${c.name}`, () => {
    const r = computePostHunt(c.input);
    for (const [id, v] of Object.entries(c.expect.finalPayout)) {
      assert.strictEqual(r.members[id].finalPayout, v);
    }
    for (const [id, v] of Object.entries(c.expect.plNet)) {
      assert.strictEqual(r.members[id].plNet, v);
    }
    if (c.expect.totalPaid != null) {
      const sum = r.order.reduce((s, id) => s + r.members[id].finalPayout, 0);
      assert.strictEqual(sum, c.expect.totalPaid);
    }
  });
}
