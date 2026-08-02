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

// A shared VIP/Affiliate hunt is owned by the COMMUNITY, so `user.displayName` is the tenant host
// ("Bean") whoever actually ran it. huntSummary has resolved that through huntRunnerOf since the
// hub started listing these; this rail never got the same treatment, so the SAME archived run
// reported "Mcflury" on /api/hunts/archived and "Bean" here (reported from production 2026-08-01).
const shared = (key, extra = {}) => ({
  user: { id: key, displayName: 'Bean', avatar: 'https://cdn/bean.png' },
  tenantId: 'bean',
  bonuses: [{ slot: 'Fury of Anubis', bet: 0.6, win: 572.16 }],
  ...extra,
});

test('a shared hunt is credited to its runner, not to the tenant host', () => {
  const hunts = {
    __vip_hunt__: shared('__vip_hunt__', {
      isLive: true, runner: { id: '102963341407838208', name: 'Mcflury', avatar: 'https://cdn/mcflury.png' },
    }),
  };
  const out = collectBangers(hunts, [], 'bean', { isAnon: () => false });
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].username, 'Mcflury');
  assert.strictEqual(out[0].avatar, 'https://cdn/mcflury.png');
  assert.strictEqual(out[0].userId, '__vip_hunt__'); // watch/OBS links stay on the shared key
});

test('the affiliate hunt is credited the same way, and carries a category huntType cannot give', () => {
  const hunts = {
    __affiliate_hunt__: shared('__affiliate_hunt__', {
      // emptyAffiliateHunt really does stamp huntType 'vip' — which is why the rail needs `category`.
      huntType: 'vip', isLive: true,
      runner: { id: '102963341407838208', name: 'Mcflury', avatar: 'https://cdn/mcflury.png' },
    }),
  };
  const out = collectBangers(hunts, [], 'bean', { isAnon: () => false });
  assert.strictEqual(out[0].username, 'Mcflury');
  assert.strictEqual(out[0].category, 'affiliate');
  assert.strictEqual(out[0].huntType, 'vip'); // unchanged — the frozen field stays as it was
});

test('a runner falls back to the creator_auto equity row when no runner was stamped', () => {
  const hunts = {
    __vip_hunt__: shared('__vip_hunt__', {
      isLive: true,
      equity: [{ id: 'bean_auto', name: 'Bean' }, { id: 'creator_auto', name: 'Mcflury' }],
    }),
  };
  const out = collectBangers(hunts, [], 'bean', { isAnon: () => false });
  assert.strictEqual(out[0].username, 'Mcflury');
  assert.strictEqual(out[0].avatar, null); // that row has never carried one — don't borrow Bean's
});

// An anonymous runner has no creditable name, so the card falls back to the hunt's actual owner —
// the community host. That is deliberate and matches huntSummary exactly: these two build the same
// two fields off the same hunt, and letting them diverge is what produced this bug to begin with.
// What must hold either way is that nothing about the masked runner reaches the payload.
test('an anonymous runner leaks neither name nor avatar', () => {
  const hunts = {
    __vip_hunt__: shared('__vip_hunt__', {
      isLive: true, runner: { id: 'shy', name: 'ShyMod', avatar: 'https://cdn/shy.png' },
    }),
  };
  const out = collectBangers(hunts, [], 'bean', { isAnon: ({ discordId }) => discordId === 'shy' });
  assert.strictEqual(out[0].username, 'Bean');       // the community owns the hunt
  assert.notStrictEqual(out[0].username, 'ShyMod');
  assert.notStrictEqual(out[0].avatar, 'https://cdn/shy.png');
});

test('a personal hunt is untouched — its owner name is already correct', () => {
  const hunts = { a: mk('a', 'acme', [{ slot: 'Big', bet: 1, win: 400 }], { isLive: true }) };
  const out = collectBangers(hunts, [], 'acme', { isAnon: () => false });
  assert.strictEqual(out[0].username, 'a');
  assert.strictEqual(out[0].category, 'community');
});
