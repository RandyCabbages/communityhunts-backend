const { test } = require('node:test');
const assert = require('node:assert');
const { collectBangers } = require('./bangers');

const mk = (id, tenantId, bonuses, extra = {}) => ({ user: { id, displayName: id }, tenantId, bonuses, ...extra });

test('only >=300x wins from the given tenant, capped per user', () => {
  const hunts = {
    a: mk('a', 'acme', [{ slot: 'Big', bet: 1, win: 400 }, { slot: 'Also', bet: 1, win: 500 }, { slot: 'Third', bet: 1, win: 600 }], { isLive: true }),
    b: mk('b', 'other', [{ slot: 'Nope', bet: 1, win: 900 }], { isLive: true }),
  };
  const out = collectBangers(hunts, [], 'acme');
  assert.ok(out.every(x => x.mult >= 300));
  assert.ok(out.every(x => x.userId === 'a'));       // other tenant excluded
  assert.ok(out.length <= 2);                         // maxPerUser default 2
});

test('skips sub-threshold and zero-bet bonuses', () => {
  const hunts = { a: mk('a', 'acme', [{ slot: 'Low', bet: 1, win: 10 }, { slot: 'ZeroBet', bet: 0, win: 999 }], { isLive: true }) };
  assert.strictEqual(collectBangers(hunts, [], 'acme').length, 0);
});

test('carries a valid replayUrl through, nulls a missing or non-http one', () => {
  const hunts = {
    a: mk('a', 'acme', [
      { slot: 'WithClip', bet: 1, win: 400, replayUrl: 'https://replay.example/abc' },
      { slot: 'NoClip', bet: 1, win: 500 },
      { slot: 'BadClip', bet: 1, win: 600, replayUrl: 'javascript:alert(1)' },
    ], { isLive: true }),
  };
  const out = collectBangers(hunts, [], 'acme', { maxPerUser: 5 });
  const bySlot = Object.fromEntries(out.map(x => [x.slot, x.replayUrl]));
  assert.strictEqual(bySlot.WithClip, 'https://replay.example/abc');
  assert.strictEqual(bySlot.NoClip, null);   // no field → null
  assert.strictEqual(bySlot.BadClip, null);  // non-http scheme rejected
});
