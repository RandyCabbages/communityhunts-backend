const { test } = require('node:test');
const assert = require('node:assert');
const { computeGiftResults } = require('./giftLedger');
const golden = require('./__fixtures__/giftLedgerGolden.json');

for (const c of golden.cases) {
  test(`golden: ${c.name}`, () => {
    const r = computeGiftResults(c.input);
    assert.strictEqual(r.pot, c.expect.pot);
    for (const [id, v] of Object.entries(c.expect.finalPayout)) {
      assert.strictEqual(r.members[id].finalPayout, v, `finalPayout ${id}`);
    }
    for (const [id, v] of Object.entries(c.expect.plNet)) {
      assert.strictEqual(r.members[id].plNet, v, `plNet ${id}`);
    }
    if (c.expect.totalEquity) {
      for (const [id, v] of Object.entries(c.expect.totalEquity)) {
        assert.strictEqual(r.members[id].totalEquity, v, `totalEquity ${id}`);
      }
    }
    const sumFinal = r.order.reduce((s, id) => s + r.members[id].finalPayout, 0);
    assert.strictEqual(sumFinal, c.input.totalWon);
  });
}
