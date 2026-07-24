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

// Regression guard for the Developer API leak: /api/public/v1/bangers called collectBangers
// with no opts, so the opt-in isAnon defaulted to "mask nobody" and returned the real display
// name of hosts who had turned on anonymous mode. The default is now fail-closed.
test('omitting isAnon masks every name rather than leaking them', () => {
  const hunts = { a: mk('a', 'acme', [{ slot: 'Big', bet: 1, win: 400 }], { isLive: true }) };
  const out = collectBangers(hunts, [], 'acme');
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].username, 'Anonymous');
  assert.strictEqual(out[0].avatar, null);
});

test('an explicit isAnon predicate decides per host', () => {
  const hunts = {
    shy:  mk('shy',  'acme', [{ slot: 'Big', bet: 1, win: 400 }], { isLive: true }),
    open: mk('open', 'acme', [{ slot: 'Big', bet: 1, win: 500 }], { isLive: true }),
  };
  const out = collectBangers(hunts, [], 'acme', { isAnon: ({ discordId }) => discordId === 'shy' });
  const byUser = Object.fromEntries(out.map(x => [x.userId, x.username]));
  assert.strictEqual(byUser.shy, 'Anonymous');
  assert.strictEqual(byUser.open, 'open');
});
