const test = require('node:test');
const assert = require('node:assert');
const { linkWithinHunt, proposeFromAliases, collectUnlinkedNames, applyNameLinks, unlinkNameLinks,
  linkFromConfirmed, normName } = require('./identityLink');

const REAL = '110983319176384512';
const REAL2 = '135203806676779008';

test('a call whose caller matches one linked equity row gets that discordId', () => {
  const hunt = {
    equity: [{ id: 'e1', name: 'SpinSage', discordId: REAL }],
    calls: [{ id: 'c1', slot: 'Mental', user: 'SpinSage' }],
  };
  const r = linkWithinHunt(hunt);
  assert.strictEqual(hunt.calls[0].callerId, REAL);
  assert.strictEqual(r.calls, 1);
});

test('matching is case- and whitespace-insensitive', () => {
  const hunt = {
    equity: [{ id: 'e1', name: 'Spin Sage', discordId: REAL }],
    calls: [{ id: 'c1', slot: 'A', user: '  spinsage ' }],
  };
  linkWithinHunt(hunt);
  assert.strictEqual(hunt.calls[0].callerId, REAL);
});

test('an ambiguous name links nothing', () => {
  const hunt = {
    equity: [
      { id: 'e1', name: 'Sage', discordId: REAL },
      { id: 'e2', name: 'Sage', discordId: REAL2 },
    ],
    calls: [{ id: 'c1', slot: 'A', user: 'Sage' }],
  };
  const r = linkWithinHunt(hunt);
  assert.strictEqual(hunt.calls[0].callerId, undefined);
  assert.strictEqual(r.calls, 0);
});

test('two equity rows with the same name AND the same id are not ambiguous', () => {
  const hunt = {
    equity: [
      { id: 'e1', name: 'Sage', discordId: REAL },
      { id: 'e2', name: 'Sage', discordId: REAL },
    ],
    calls: [{ id: 'c1', slot: 'A', user: 'Sage' }],
  };
  linkWithinHunt(hunt);
  assert.strictEqual(hunt.calls[0].callerId, REAL);
});

test('an existing callerId is never overwritten', () => {
  const hunt = {
    equity: [{ id: 'e1', name: 'SpinSage', discordId: REAL }],
    calls: [{ id: 'c1', slot: 'A', user: 'SpinSage', callerId: REAL2 }],
  };
  linkWithinHunt(hunt);
  assert.strictEqual(hunt.calls[0].callerId, REAL2);
});

test('a synthetic manual: id is never written as an identity', () => {
  const hunt = {
    equity: [{ id: 'e1', name: 'Ghost', discordId: 'manual:ghost' }],
    calls: [{ id: 'c1', slot: 'A', user: 'Ghost' }],
  };
  const r = linkWithinHunt(hunt);
  assert.strictEqual(hunt.calls[0].callerId, undefined);
  assert.strictEqual(r.calls, 0);
});

test('bonuses carrying a caller name are linked too', () => {
  const hunt = {
    equity: [{ id: 'e1', name: 'SpinSage', discordId: REAL }],
    calls: [],
    bonuses: [{ slot: 'Mental', caller: 'SpinSage', bet: 1, win: 2 }],
  };
  const r = linkWithinHunt(hunt);
  assert.strictEqual(hunt.bonuses[0].callerId, REAL);
  assert.strictEqual(r.bonuses, 1);
});

test('an unlinked equity row cannot be a source', () => {
  const hunt = {
    equity: [{ id: 'e1', name: 'SpinSage' }],
    calls: [{ id: 'c1', slot: 'A', user: 'SpinSage' }],
  };
  assert.strictEqual(linkWithinHunt(hunt).calls, 0);
});

test('an empty or missing name links nothing and does not throw', () => {
  const hunt = { equity: [{ id: 'e1', name: '', discordId: REAL }], calls: [{ id: 'c1', slot: 'A', user: '' }] };
  assert.strictEqual(linkWithinHunt(hunt).calls, 0);
  assert.doesNotThrow(() => linkWithinHunt({}));
  assert.doesNotThrow(() => linkWithinHunt(null));
});

test('links[] reports every applied link for the audit trail', () => {
  const hunt = {
    equity: [{ id: 'e1', name: 'SpinSage', discordId: REAL }],
    calls: [{ id: 'c1', slot: 'A', user: 'SpinSage' }],
    bonuses: [{ slot: 'B', caller: 'SpinSage', bet: 1, win: 5 }],
  };
  const r = linkWithinHunt(hunt);
  assert.strictEqual(r.links.length, 2);
  assert.deepStrictEqual(r.links.map(l => l.kind).sort(), ['bonus', 'call']);
  assert.ok(r.links.every(l => l.discordId === REAL));
});

test('proposeFromAliases proposes a unique owner and never mutates', () => {
  const hunt = { equity: [{ id: 'e1', name: 'SpinSage' }], calls: [] };
  const owners = new Map([['SpinSage', new Set([REAL])]]);
  const r = proposeFromAliases(hunt, owners);
  assert.strictEqual(r.proposals.length, 1);
  assert.strictEqual(r.proposals[0].discordId, REAL);
  assert.strictEqual(hunt.equity[0].discordId, undefined); // untouched
});

test('proposeFromAliases reports an ambiguous name instead of proposing it', () => {
  const hunt = { equity: [{ id: 'e1', name: 'Sage' }], calls: [] };
  const owners = new Map([['Sage', new Set([REAL, REAL2])]]);
  const r = proposeFromAliases(hunt, owners);
  assert.strictEqual(r.proposals.length, 0);
  assert.deepStrictEqual(r.ambiguous, [{ name: 'Sage', count: 2 }]);
});

test('proposeFromAliases skips rows that already carry an id', () => {
  const hunt = { equity: [{ id: 'e1', name: 'SpinSage', discordId: REAL2 }], calls: [] };
  const owners = new Map([['SpinSage', new Set([REAL])]]);
  assert.strictEqual(proposeFromAliases(hunt, owners).proposals.length, 0);
});

test('proposeFromAliases refuses a synthetic manual: owner', () => {
  const hunt = { equity: [{ id: 'e1', name: 'Ghost' }], calls: [] };
  const owners = new Map([['Ghost', new Set(['manual:ghost'])]]);
  assert.strictEqual(proposeFromAliases(hunt, owners).proposals.length, 0);
});

test('proposeFromAliases covers calls as well as equity, and tolerates no owners', () => {
  const hunt = { equity: [], calls: [{ id: 'c1', slot: 'A', user: 'SpinSage' }] };
  const owners = new Map([['SpinSage', new Set([REAL])]]);
  const r = proposeFromAliases(hunt, owners);
  assert.strictEqual(r.proposals.length, 1);
  assert.strictEqual(r.proposals[0].kind, 'call');
  assert.deepStrictEqual(proposeFromAliases(hunt, new Map()).proposals, []);
});

// ── Name-grouped review (the operator reviews PEOPLE, not rows) ─────────────

const huntWith = (over) => ({ huntId: 'h1', user: { id: 'u1', displayName: 'Bean' }, equity: [], calls: [], bonuses: [], ...over });

test('collectUnlinkedNames counts rows and hunts per distinct name', () => {
  const hunts = [
    huntWith({ huntId: 'h1',
      equity: [{ id: 'e1', name: 'SpinSage' }],
      calls: [{ id: 'c1', slot: 'A', user: 'SpinSage' }, { id: 'c2', slot: 'B', user: 'SpinSage' }] }),
    huntWith({ huntId: 'h2', calls: [{ id: 'c3', slot: 'C', user: 'SpinSage' }] }),
  ];
  const rows = collectUnlinkedNames(hunts);
  const sage = rows.find(r => r.name === 'SpinSage');
  assert.strictEqual(sage.rows, 4);   // 1 equity + 3 calls
  assert.strictEqual(sage.hunts, 2);
});

test('collectUnlinkedNames counts bonuses too, so the count matches what apply will change', () => {
  const hunts = [huntWith({
    calls: [{ id: 'c1', slot: 'A', user: 'SpinSage' }],
    bonuses: [{ slot: 'A', caller: 'SpinSage', bet: 1, win: 5 }],
  })];
  const counted = collectUnlinkedNames(hunts).find(r => r.name === 'SpinSage').rows;
  const { applied } = applyNameLinks(hunts, new Map([['SpinSage', REAL]]));
  assert.strictEqual(counted, 2);
  assert.strictEqual(applied, counted, 'the preview count must equal what apply reports');
});

test('collectUnlinkedNames ignores rows that already carry an id, and is sorted by rows desc', () => {
  const hunts = [huntWith({
    equity: [{ id: 'e1', name: 'Linked', discordId: REAL }],
    calls: [
      { id: 'c1', slot: 'A', user: 'Loud' }, { id: 'c2', slot: 'B', user: 'Loud' },
      { id: 'c3', slot: 'C', user: 'Quiet' },
      { id: 'c4', slot: 'D', user: 'Already', callerId: REAL },
    ],
  })];
  const rows = collectUnlinkedNames(hunts);
  assert.deepStrictEqual(rows.map(r => r.name), ['Loud', 'Quiet']);
  assert.strictEqual(rows[0].rows, 2);
});

test('applyNameLinks fills every matching blank row across every hunt in ONE pass', () => {
  const hunts = [
    huntWith({ huntId: 'h1',
      equity: [{ id: 'e1', name: 'SpinSage' }],
      calls: [{ id: 'c1', slot: 'A', user: 'SpinSage' }],
      bonuses: [{ slot: 'A', caller: 'SpinSage', bet: 1, win: 5 }] }),
    huntWith({ huntId: 'h2', calls: [{ id: 'c2', slot: 'B', user: 'spin sage' }] }),
  ];
  const r = applyNameLinks(hunts, new Map([['SpinSage', REAL]]));
  assert.strictEqual(r.applied, 4);
  assert.strictEqual(hunts[0].equity[0].discordId, REAL);
  assert.strictEqual(hunts[0].calls[0].callerId, REAL);
  assert.strictEqual(hunts[0].bonuses[0].callerId, REAL);
  assert.strictEqual(hunts[1].calls[0].callerId, REAL, 'case/space-insensitive match');
});

test('applyNameLinks never overwrites and never writes a synthetic id', () => {
  const hunts = [huntWith({
    equity: [{ id: 'e1', name: 'Taken', discordId: REAL2 }],
    calls: [{ id: 'c1', slot: 'A', user: 'Ghost' }],
  })];
  const r = applyNameLinks(hunts, new Map([['Taken', REAL], ['Ghost', 'manual:ghost']]));
  assert.strictEqual(r.applied, 0);
  assert.strictEqual(hunts[0].equity[0].discordId, REAL2);
  assert.strictEqual(hunts[0].calls[0].callerId, undefined);
});

test('applyNameLinks reports a per-name breakdown for the audit log', () => {
  const hunts = [huntWith({ calls: [
    { id: 'c1', slot: 'A', user: 'One' }, { id: 'c2', slot: 'B', user: 'One' },
    { id: 'c3', slot: 'C', user: 'Two' },
  ] })];
  const r = applyNameLinks(hunts, new Map([['One', REAL], ['Two', REAL2]]));
  assert.strictEqual(r.applied, 3);
  assert.deepStrictEqual(r.byName, { One: 2, Two: 1 });
});

test('applyNameLinks with no decisions is a no-op', () => {
  const hunts = [huntWith({ calls: [{ id: 'c1', slot: 'A', user: 'One' }] })];
  assert.strictEqual(applyNameLinks(hunts, new Map()).applied, 0);
  assert.strictEqual(hunts[0].calls[0].callerId, undefined);
});

test('unlinkNameLinks reverses an apply for one name, and only that name', () => {
  const hunts = [huntWith({
    equity: [{ id: 'e1', name: 'SpinSage' }, { id: 'e2', name: 'Other' }],
    calls: [{ id: 'c1', slot: 'A', user: 'SpinSage' }],
    bonuses: [{ slot: 'A', caller: 'SpinSage', bet: 1, win: 5 }],
  })];
  applyNameLinks(hunts, new Map([['SpinSage', REAL], ['Other', REAL2]]));
  const r = unlinkNameLinks(hunts, 'spinsage', REAL);
  assert.strictEqual(r.cleared, 3);
  assert.strictEqual(hunts[0].equity[0].discordId, undefined);
  assert.strictEqual(hunts[0].calls[0].callerId, undefined);
  assert.strictEqual(hunts[0].bonuses[0].callerId, undefined);
  assert.strictEqual(hunts[0].equity[1].discordId, REAL2, 'the other name is untouched');
});

test('unlinkNameLinks refuses to clear a row holding a DIFFERENT id', () => {
  const hunts = [huntWith({ equity: [{ id: 'e1', name: 'SpinSage', discordId: REAL2 }] })];
  const r = unlinkNameLinks(hunts, 'SpinSage', REAL);
  assert.strictEqual(r.cleared, 0);
  assert.strictEqual(hunts[0].equity[0].discordId, REAL2);
});

test('apply then unlink then apply restores the same state (idempotent round trip)', () => {
  const mk = () => [huntWith({ calls: [{ id: 'c1', slot: 'A', user: 'SpinSage' }] })];
  const a = mk(); applyNameLinks(a, new Map([['SpinSage', REAL]]));
  const b = mk(); applyNameLinks(b, new Map([['SpinSage', REAL]]));
  unlinkNameLinks(b, 'SpinSage', REAL);
  applyNameLinks(b, new Map([['SpinSage', REAL]]));
  assert.strictEqual(b[0].calls[0].callerId, a[0].calls[0].callerId);
});

// ── Seeded host row ─────────────────────────────────────────────────────────
// A hunt's host equity row is seeded server-side from the AUTHENTICATED creator, so it must carry
// that Discord id. It historically did not (solo/community got `id:'creator_auto'` and no
// discordId), which put every host's own display name into the Tier 2 review queue the moment they
// started a hunt — and left Tier 1 with no seed to resolve that hunt's typed caller names against.
const { initialEquity } = require('./hunts-core');
const HOST = { id: REAL, displayName: 'SpinSage', username: 'spinsage' };
const TENANT = { slug: 'bean', hostDiscordId: REAL2, branding: { hostName: 'Bean' } };

for (const huntType of ['community', 'solo']) {
  test(`a freshly-seeded ${huntType} hunt has no unlinked names`, () => {
    const hunt = { huntId: 'h1', huntType, equity: initialEquity(huntType, HOST, TENANT, 500), calls: [], bonuses: [] };
    assert.deepStrictEqual(collectUnlinkedNames([hunt]), []);
    assert.strictEqual(hunt.equity[0].discordId, REAL);
    assert.strictEqual(hunt.equity[0].id, 'creator_auto', 'row id is unchanged — only identity is added');
  });
}

test('a freshly-seeded vip hunt has no unlinked names (tenant host)', () => {
  const hunt = { huntId: 'h1', huntType: 'vip', equity: initialEquity('vip', HOST, TENANT, 1000), calls: [], bonuses: [] };
  assert.deepStrictEqual(collectUnlinkedNames([hunt]), []);
  assert.strictEqual(hunt.equity[0].discordId, REAL2);
});

test('the seeded host row lets Tier 1 link that hunt\'s typed caller names', () => {
  const hunt = {
    huntId: 'h1', huntType: 'community',
    equity: initialEquity('community', HOST, TENANT, 500),
    calls: [{ id: 'c1', slot: 'Mental', user: 'SpinSage' }],
    bonuses: [{ slot: 'Mental', caller: 'SpinSage', bet: 1, win: 5 }],
  };
  const r = linkWithinHunt(hunt);
  assert.strictEqual(r.calls, 1);
  assert.strictEqual(r.bonuses, 1);
  assert.strictEqual(hunt.calls[0].callerId, REAL);
});

test('a host with no id seeds nothing rather than a junk row', () => {
  const eq = initialEquity('community', { displayName: 'Ghost' }, TENANT, 0);
  assert.strictEqual(eq[0].discordId, undefined, 'absent id must not become the string "undefined"');
});

// ── Tier 1.5: remembered operator decisions ─────────────────────────────────
// A confirmed link is human-approved knowledge about a PERSON, not a one-time patch of the rows
// that happened to exist that day. These cover the rails that let it be replayed safely.

// Stand-in for lib/confirmedAliases.resolve: one id, or null for unknown/ambiguous.
const resolver = (map) => (name) => map[normName(name)] || null;

test('linkFromConfirmed fills a blank equity id from a remembered decision', () => {
  const hunt = { equity: [{ id: 'e1', name: 'SpinSage' }], calls: [], bonuses: [] };
  const r = linkFromConfirmed(hunt, resolver({ spinsage: REAL }));
  assert.strictEqual(hunt.equity[0].discordId, REAL);
  assert.strictEqual(r.equity, 1);
});

test('linkFromConfirmed reaches calls and bonuses, not just equity', () => {
  const hunt = {
    equity: [],
    calls: [{ id: 'c1', slot: 'Mental', user: 'SpinSage' }],
    bonuses: [{ id: 'b1', slot: 'Mental', caller: 'SpinSage' }],
  };
  const r = linkFromConfirmed(hunt, resolver({ spinsage: REAL }));
  assert.strictEqual(hunt.calls[0].callerId, REAL);
  assert.strictEqual(hunt.bonuses[0].callerId, REAL);
  assert.strictEqual(r.calls, 1);
  assert.strictEqual(r.bonuses, 1);
});

test('linkFromConfirmed matches case- and whitespace-insensitively', () => {
  const hunt = { equity: [{ id: 'e1', name: '  Spin Sage ' }], calls: [], bonuses: [] };
  linkFromConfirmed(hunt, resolver({ spinsage: REAL }));
  assert.strictEqual(hunt.equity[0].discordId, REAL);
});

test('linkFromConfirmed never overwrites an id that is already there', () => {
  const hunt = { equity: [{ id: 'e1', name: 'SpinSage', discordId: REAL2 }], calls: [], bonuses: [] };
  const r = linkFromConfirmed(hunt, resolver({ spinsage: REAL }));
  assert.strictEqual(hunt.equity[0].discordId, REAL2);
  assert.strictEqual(r.equity, 0);
});

test('linkFromConfirmed writes nothing for an unresolved or ambiguous name', () => {
  const hunt = { equity: [{ id: 'e1', name: 'Nobody' }], calls: [], bonuses: [] };
  const r = linkFromConfirmed(hunt, () => null);
  assert.strictEqual(hunt.equity[0].discordId, undefined);
  assert.strictEqual(r.equity, 0);
});

test('linkFromConfirmed refuses a synthetic id even if one is remembered', () => {
  const hunt = { equity: [{ id: 'e1', name: 'Ghost' }], calls: [], bonuses: [] };
  linkFromConfirmed(hunt, resolver({ ghost: 'manual:ghost' }));
  assert.strictEqual(hunt.equity[0].discordId, undefined);
});

test('linkFromConfirmed reports the rows it changed so the write is auditable', () => {
  const hunt = {
    equity: [{ id: 'e1', name: 'SpinSage' }],
    calls: [{ id: 'c1', slot: 'A', user: 'SpinSage' }],
    bonuses: [],
  };
  const r = linkFromConfirmed(hunt, resolver({ spinsage: REAL }));
  assert.strictEqual(r.links.length, 2);
  assert.deepStrictEqual(r.links[0], { kind: 'equity', id: 'e1', name: 'SpinSage', discordId: REAL });
  assert.strictEqual(r.links[1].kind, 'call');
});

test('linkFromConfirmed with no resolver is a safe no-op', () => {
  const hunt = { equity: [{ id: 'e1', name: 'SpinSage' }], calls: [], bonuses: [] };
  const r = linkFromConfirmed(hunt, null);
  assert.strictEqual(hunt.equity[0].discordId, undefined);
  assert.strictEqual(r.equity, 0);
});

test('a hunt run through linkFromConfirmed drops out of the review queue', () => {
  const hunt = {
    huntId: 'h1',
    equity: [{ id: 'e1', name: 'SpinSage' }],
    calls: [{ id: 'c1', slot: 'A', user: 'SpinSage' }],
    bonuses: [{ id: 'b1', slot: 'A', caller: 'SpinSage' }],
  };
  assert.strictEqual(collectUnlinkedNames([hunt]).length, 1, 'unlinked before');
  linkFromConfirmed(hunt, resolver({ spinsage: REAL }));
  assert.deepStrictEqual(collectUnlinkedNames([hunt]), [], 'and gone after — this is the refill fix');
});

test('normName strips whitespace so it agrees with the grouping key', () => {
  assert.strictEqual(normName('  Big  Cabbage '), 'bigcabbage');
  assert.strictEqual(normName(null), '');
});
