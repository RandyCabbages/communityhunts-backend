const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const { isCategory, keyForCategory, sharedRunHasWork, encodeRunKey, decodeRunKey,
        cleanMember, cleanMembers, mergeEquity } = require('./discordHunts');

// Deterministic, so a merge's output can be asserted whole.
const uid = (() => { let n = 0; return () => `new${++n}`; })();
const merge = (existing, incoming) => mergeEquity(existing, incoming, { uid });

describe('isCategory', () => {
  it('accepts the two public categories', () => {
    assert.equal(isCategory('affiliate'), true);
    assert.equal(isCategory('vip'), true);
  });

  it('refuses topLb, which has no hunt of its own', () => {
    // Top-LB giveaways run in the VIP hunt. The bot maps that before it calls;
    // accepting it here would create a third hunt nobody watches.
    assert.equal(isCategory('topLb'), false);
  });

  it('refuses anything else', () => {
    for (const bad of ['', null, undefined, 'VIP', '__vip_hunt__', 'affiliate ']) {
      assert.equal(isCategory(bad), false, String(bad));
    }
  });
});

describe('keyForCategory', () => {
  const keys = {
    affiliateHuntKey: (t) => `__affiliate_hunt__:${t}`,
    vipHuntKey: (t) => `__vip_hunt__:${t}`,
  };

  it('maps each category to its own tenant-scoped hunt', () => {
    assert.equal(keyForCategory('affiliate', 'bean', keys), '__affiliate_hunt__:bean');
    assert.equal(keyForCategory('vip', 'bean', keys), '__vip_hunt__:bean');
  });

  it('returns null for anything else rather than guessing a key', () => {
    // A guessed key is a write against the wrong hunt, which is the failure this whole module
    // exists to make impossible.
    for (const bad of ['topLb', 'mod', '', null]) {
      assert.equal(keyForCategory(bad, 'bean', keys), null, String(bad));
    }
  });
});

describe('run keys', () => {
  it('carries the hunt key and the run in one string', () => {
    assert.equal(encodeRunKey('__affiliate_hunt__', 'abc123'), '__affiliate_hunt__#abc123');
  });

  it('round-trips', () => {
    assert.deepEqual(decodeRunKey(encodeRunKey('__vip_hunt__:acme', 'abc123')),
      { key: '__vip_hunt__:acme', huntId: 'abc123' });
  });

  it('stays a bare key when there is no run to pin to', () => {
    assert.equal(encodeRunKey('__vip_hunt__', null), '__vip_hunt__');
    assert.deepEqual(decodeRunKey('__vip_hunt__'), { key: '__vip_hunt__', huntId: null });
  });

  it('splits on the FIRST separator', () => {
    // Otherwise a value like `__vip_hunt__#x#__affiliate_hunt__` could present a different hunt
    // key to the check than the one it is really asking to write to.
    assert.deepEqual(decodeRunKey('__vip_hunt__#a#b'), { key: '__vip_hunt__', huntId: 'a#b' });
  });

  it('never invents a run out of a trailing separator', () => {
    assert.deepEqual(decodeRunKey('__vip_hunt__#'), { key: '__vip_hunt__', huntId: null });
  });

  it('survives nothing at all', () => {
    for (const empty of [null, undefined, '']) {
      assert.deepEqual(decodeRunKey(empty), { key: '', huntId: null }, String(empty));
    }
  });
});

describe('sharedRunHasWork', () => {
  // The seed the server itself writes when a run is opened. Present in EVERY fresh run.
  const seeded = (extra = {}) => ({
    bonuses: [], calls: [], archivedAt: null,
    equity: [{ id: 'bean_auto', name: 'Bean', amount: 1000, isRollWinner: false }],
    ...extra,
  });

  it('says no to a freshly opened run', () => {
    // The case that matters most. huntHasContent() says YES here — the seeded host row is
    // amount 1000 — so gating the open endpoint on that would 409 every run after the first,
    // forever. This is why the two predicates are not the same function.
    assert.equal(sharedRunHasWork(seeded()), false);
  });

  it('says no when there is no run at all', () => {
    assert.equal(sharedRunHasWork(undefined), false);
    assert.equal(sharedRunHasWork(null), false);
  });

  it('says yes once a bonus has been added', () => {
    assert.equal(sharedRunHasWork(seeded({ bonuses: [{ slot: 'Gates' }] })), true);
  });

  it('says yes once a slot has been called', () => {
    assert.equal(sharedRunHasWork(seeded({ calls: [{ slot: 'Gates' }] })), true);
  });

  it('says yes once anyone but the seed is on the equity sheet', () => {
    const withMember = seeded();
    withMember.equity.push({ id: 'abc', name: 'thacker_gb', amount: 50, isRollWinner: true });
    assert.equal(sharedRunHasWork(withMember), true);
  });

  it('ignores the creator seed used by personal hunts too', () => {
    assert.equal(sharedRunHasWork(seeded({
      equity: [{ id: 'creator_auto', name: 'Bean', amount: 1000 }],
    })), false);
  });

  it('says no to an ENDED run, however much is in it', () => {
    // It is already archived; opening the next one is exactly what should happen.
    assert.equal(sharedRunHasWork(seeded({
      bonuses: [{ slot: 'Gates', win: 100 }], archivedAt: '2026-07-29T00:00:00.000Z',
    })), false);
  });
});

describe('cleanMember', () => {
  it('keeps a well-formed row', () => {
    assert.deepEqual(
      cleanMember({ name: 'Cabbage', discordId: '135203806676779008', amount: 50, isRollWinner: true }),
      { name: 'Cabbage', amount: 50, isRollWinner: true, discordId: '135203806676779008' },
    );
  });

  it('drops a discordId that is not one', () => {
    // vetEquityIdentity is the real gate; this just refuses to carry junk that far.
    for (const bad of ['creator_auto', 'manual:Bean', 'bean_auto', 12345, null, '1234']) {
      const row = cleanMember({ name: 'x', amount: 1, discordId: bad });
      assert.equal('discordId' in row, false, String(bad));
    }
  });

  it('refuses a row with no name', () => {
    assert.equal(cleanMember({ name: '   ', amount: 50 }), null);
    assert.equal(cleanMember({ amount: 50 }), null);
  });

  it('refuses an amount that is not a real number', () => {
    // A NaN amount would land on the sheet and poison every total on the page.
    for (const bad of ['fifty', NaN, Infinity, -1, undefined]) {
      assert.equal(cleanMember({ name: 'x', amount: bad }), null, String(bad));
    }
  });

  it('allows zero, which is a real equity amount', () => {
    assert.equal(cleanMember({ name: 'x', amount: 0 })?.amount, 0);
  });

  it('never takes isRollWinner on trust', () => {
    assert.equal(cleanMember({ name: 'x', amount: 1 }).isRollWinner, false);
    assert.equal(cleanMember({ name: 'x', amount: 1, isRollWinner: 'yes' }).isRollWinner, false);
  });

  it('caps a silly name rather than storing it', () => {
    assert.equal(cleanMembers([{ name: 'x'.repeat(500), amount: 1 }])[0].name.length, 80);
  });
});

describe('mergeEquity', () => {
  const host = { id: 'bean_auto', name: 'Bean', amount: 1000, isRollWinner: false, discordId: '111000111000111000' };
  const byHand = { id: 'abc', name: 'thacker_gb', amount: 50, isRollWinner: true };

  it('adds a winner without touching what is already there', () => {
    const { rows, added } = merge([host], cleanMembers([{ name: 'Cabbage', amount: 50, isRollWinner: true }]));

    assert.equal(added, 1);
    assert.deepEqual(rows[0], host, 'the host row is untouched');
    assert.deepEqual(rows[1], { id: 'new1', name: 'Cabbage', amount: 50, isRollWinner: true });
  });

  it('never drops a row the bot did not send', () => {
    // The whole reason this is a merge endpoint. A short array through the plain PUT would
    // delete everyone a mod added by hand.
    const { rows } = merge([host, byHand], cleanMembers([{ name: 'Someone New', amount: 50 }]));

    assert.deepEqual(rows.map((r) => r.name), ['Bean', 'thacker_gb', 'Someone New']);
  });

  it('is idempotent — the bot re-sends the same winners every sweep', () => {
    const members = cleanMembers([{ name: 'Cabbage', discordId: '999000999000999000', amount: 50, isRollWinner: true }]);

    const once = merge([host], members);
    const twice = merge(once.rows, members);

    assert.equal(twice.added, 0, 'nothing appended the second time');
    assert.equal(twice.rows.length, once.rows.length);
  });

  it('matches an existing row by discordId even when the name changed', () => {
    // People rename themselves. The id is the strong claim.
    const existing = [{ id: 'abc', name: 'old name', amount: 50, isRollWinner: true, discordId: '999000999000999000' }];
    const { rows, added, updated } = merge(existing, cleanMembers([{ name: 'new name', discordId: '999000999000999000', amount: 75 }]));

    assert.equal(added, 0);
    assert.equal(updated, 1);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].amount, 75);
  });

  it('matches a hand-typed row by name, rather than duplicating the person', () => {
    const { rows, added } = merge([byHand], cleanMembers([{ name: 'thacker_gb', discordId: '222000222000222000', amount: 50 }]));

    assert.equal(added, 0, 'no second row for the same person');
    assert.equal(rows[0].discordId, '222000222000222000', 'and the id fills the blank the mod left');
  });

  it('ignores case and padding when matching a name', () => {
    const { added } = merge([byHand], cleanMembers([{ name: '  THACKER_GB ', amount: 50 }]));
    assert.equal(added, 0);
  });

  it('never overwrites an id that is already there', () => {
    // A name collision must not be able to reassign somebody else's equity.
    const existing = [{ id: 'abc', name: 'Cabbage', amount: 50, isRollWinner: true, discordId: '111000111000111000' }];
    const { rows } = merge(existing, cleanMembers([{ name: 'Cabbage', discordId: '999000999000999000', amount: 50 }]));

    assert.equal(rows[0].discordId, '111000111000111000');
  });

  it('marks a matched row as a roll winner, which is what it now is', () => {
    const existing = [{ id: 'abc', name: 'Cabbage', amount: 0, isRollWinner: false }];
    const { rows } = merge(existing, cleanMembers([{ name: 'Cabbage', amount: 50, isRollWinner: true }]));

    assert.equal(rows[0].isRollWinner, true);
    assert.equal(rows[0].amount, 50);
  });

  it('lands on the first of two rows sharing a name, not the newer one', () => {
    const existing = [
      { id: 'first', name: 'Cabbage', amount: 10, isRollWinner: false },
      { id: 'second', name: 'Cabbage', amount: 20, isRollWinner: false },
    ];
    const { rows } = merge(existing, cleanMembers([{ name: 'Cabbage', amount: 50 }]));

    assert.equal(rows[0].amount, 50);
    assert.equal(rows[1].amount, 20, 'the duplicate is left exactly as it was');
  });

  it('does not mutate the array it was given', () => {
    // The caller holds the live hunt. A merge that edited it in place would have written to
    // the sheet before vetEquityIdentity ever saw the rows.
    const existing = [{ id: 'abc', name: 'Cabbage', amount: 10, isRollWinner: false }];
    const snapshot = JSON.parse(JSON.stringify(existing));

    merge(existing, cleanMembers([{ name: 'Cabbage', amount: 50 }]));

    assert.deepEqual(existing, snapshot);
  });

  it('survives a hunt with no equity at all', () => {
    const { rows, added } = merge(undefined, cleanMembers([{ name: 'Cabbage', amount: 50 }]));
    assert.equal(added, 1);
    assert.equal(rows.length, 1);
  });

  it('does nothing when there is nothing to merge', () => {
    const { rows, added, updated } = merge([host], []);
    assert.deepEqual(rows, [host]);
    assert.equal(added, 0);
    assert.equal(updated, 0);
  });
});
