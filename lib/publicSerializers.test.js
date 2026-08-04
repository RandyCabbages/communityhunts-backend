const { test } = require('node:test');
const assert = require('node:assert');
const S = require('./publicSerializers');

// Inject a fake publicHuntView that mimics anonymity masking + secret strip.
S._setPublicHuntView(h => ({
  ...h,
  equity: (h.equity || []).map(e => e.discordId === 'anon1' ? { ...e, name: 'Anonymous' } : e),
}));

const HUNT = {
  huntId: 'h_1', user: { id: '111', displayName: 'Runner' }, tenantId: 'acme',
  huntType: 'community', isLive: false, archivedAt: '2026-07-10T00:00:00Z',
  startedAt: '2026-07-09T00:00:00Z', createdAt: '2026-07-09T00:00:00Z', currency: 'USD',
  invitedEditors: ['secret'], callsPermissions: { x: 1 },
  bonuses: [{ slot: 'Le Bandit', bet: 2, win: 200, ts: 1 }],
  equity: [{ name: 'Alice', amount: 100, discordId: '222' }, { name: 'Bob', amount: 50, discordId: 'anon1' }],
};

test('publicHunt whitelists — no Discord IDs / editor lists / permissions leak', () => {
  const out = S.publicHunt(HUNT);
  const json = JSON.stringify(out);
  assert.ok(!json.includes('invitedEditors') && !json.includes('callsPermissions'));
  assert.ok(!json.includes('"111"') && !json.includes('discordId'));
  assert.strictEqual(out.id, 'h_1');
  assert.strictEqual(out.status, 'archived');
  assert.strictEqual(out.bonuses[0].multiplier, 100);
});

test('publicHunt keeps anonymous member masked', () => {
  const out = S.publicHunt(HUNT);
  const bob = out.equity.find(e => e.amount === 50);
  assert.strictEqual(bob.name, 'Anonymous');
});

test('publicHunt rounds a float-accumulated totalWon to 2dp and keeps it a number', () => {
  // 0.1 + 0.2 + 184.24 === 184.54000000000002 in IEEE-754 — the real prod artifact.
  const hunt = { ...HUNT, bonuses: [
    { slot: 'A', bet: 1, win: 0.1 },
    { slot: 'B', bet: 1, win: 0.2 },
    { slot: 'C', bet: 1, win: 184.24 },
  ] };
  const out = S.publicHunt(hunt);
  assert.strictEqual(out.totalWon, 184.54);
  assert.strictEqual(typeof out.totalWon, 'number');
});

test('publicHunt.updatedAt takes the LATEST lifecycle stamp, not updatedAt alone', () => {
  // archiveHunt() snapshots the hunt and then stamps archivedAt on the copy, so `updatedAt` is
  // left at the last edit. Reporting that would tell a consumer polling the list endpoint that
  // nothing happened at the exact moment the hunt's status flipped to 'archived'.
  const ended = { ...HUNT, updatedAt: '2026-07-09T12:00:00Z', archivedAt: '2026-07-10T00:00:00Z' };
  assert.strictEqual(S.publicHunt(ended).updatedAt, '2026-07-10T00:00:00Z');

  // A live hunt: the edit stamp is the newest and wins.
  const live = { ...HUNT, isLive: true, archivedAt: null, updatedAt: '2026-07-09T18:00:00Z' };
  assert.strictEqual(S.publicHunt(live).updatedAt, '2026-07-09T18:00:00Z');

  // Legacy rows predate `updatedAt` entirely — fall back rather than emit null.
  const legacy = { ...HUNT, updatedAt: undefined, archivedAt: null, startedAt: '2026-07-09T00:00:00Z' };
  assert.strictEqual(S.publicHunt(legacy).updatedAt, '2026-07-09T00:00:00Z');

  assert.strictEqual(S.lastChangedAt({}), null);
});

test('publicStats drops name-bearing lists (topHunters/biggestHits)', () => {
  const raw = { currencies: [{ code: 'USD', hunts: 3 }], tz: 'UTC',
    byCurrency: { USD: { summary: { totalHunts: 3, totalWon: 9 }, topGotIn: [{ slot: 'X', count: 2 }],
      topCalled: [], topHunters: [{ name: 'Alice' }], biggestHits: [{ member: 'Bob' }], hours: [], weekdays: [], weeks: [] } } };
  const out = S.publicStats(raw);
  const json = JSON.stringify(out);
  assert.ok(!json.includes('topHunters') && !json.includes('biggestHits'));
  assert.strictEqual(out.byCurrency.USD.summary.totalWon, 9);
  assert.deepStrictEqual(out.byCurrency.USD.topGotIn, [{ slot: 'X', count: 2 }]);
});

test('publicStats rounds money/ratio fields, preserves null pnl, leaves counts + types untouched', () => {
  const raw = { currencies: [{ code: 'USD', hunts: 5 }], tz: 'UTC',
    byCurrency: { USD: {
      summary: {
        totalHunts: 5, completedHunts: 5, liveNow: 0, totalBonuses: 12, openedBonuses: 10,
        totalBet: 3726.789999999982, totalWon: 109644.79200000022, overallMulti: 29.667484353818995,
        avgSlotsPerHunt: 2.4, avgPot: 745.357999999996, totalPot: 3726.79,
        pnl: null, pnlHunts: 0, untagged: 0, types: { community: 5, vip: 0, solo: 0 },
      },
      topGotIn: [{ name: 'Slot A', entries: 3, hunts: 2, totalBet: 61.513333333333336, totalWin: 184.54000000000002,
                   avgMulti: 12.336666666666667, bestMulti: 20.111111111111668, bestWin: 500 }],
      topCalled: [{ name: 'Slot A', called: 4, gotIn: 3 }],
      hours: [], weekdays: [], weeks: [],
    } } };
  const out = S.publicStats(raw);
  const sum = out.byCurrency.USD.summary;
  // money/ratio fields rounded to 2dp
  assert.strictEqual(sum.totalBet, 3726.79);
  assert.strictEqual(sum.totalWon, 109644.79);
  assert.strictEqual(sum.overallMulti, 29.67);
  assert.strictEqual(sum.avgPot, 745.36);
  // pnl stays null (unknowable), never coerced to 0
  assert.strictEqual(sum.pnl, null);
  // integer counts + types untouched
  assert.strictEqual(sum.totalHunts, 5);
  assert.strictEqual(sum.completedHunts, 5);
  assert.strictEqual(sum.liveNow, 0);
  assert.strictEqual(sum.totalBonuses, 12);
  assert.strictEqual(sum.openedBonuses, 10);
  assert.strictEqual(sum.pnlHunts, 0);
  assert.strictEqual(sum.untagged, 0);
  assert.deepStrictEqual(sum.types, { community: 5, vip: 0, solo: 0 });
  // topGotIn: money/ratio rounded, counts untouched
  const g = out.byCurrency.USD.topGotIn[0];
  assert.strictEqual(g.totalBet, 61.51);
  assert.strictEqual(g.totalWin, 184.54);
  assert.strictEqual(g.avgMulti, 12.34);
  assert.strictEqual(g.entries, 3);
  assert.strictEqual(g.hunts, 2);
  // topCalled has no money/ratio fields — passes through unchanged
  assert.deepStrictEqual(out.byCurrency.USD.topCalled, [{ name: 'Slot A', called: 4, gotIn: 3 }]);
});

test('an already-clean number is left unchanged and stays a number (not a "100.00" string)', () => {
  const raw = { byCurrency: { USD: { summary: { totalBet: 100, totalWon: 0, pnl: null },
    topGotIn: [], topCalled: [], hours: [], weekdays: [], weeks: [] } } };
  const out = S.publicStats(raw);
  assert.strictEqual(out.byCurrency.USD.summary.totalBet, 100);
  assert.strictEqual(typeof out.byCurrency.USD.summary.totalBet, 'number');
});

test('publicGotIn + publicBanger shape', () => {
  assert.deepStrictEqual(S.publicGotIn([{ ts: 5, slot: 'Y', bet: 1 }]), [{ slot: 'Y', bet: 1, at: 5 }]);
  const b = S.publicBanger({ slot: 'Z', bet: 1, win: 500, mult: 500, userId: 'x', avatar: 'a', username: 'Runner', huntType: 'solo', at: 't' });
  assert.deepStrictEqual(b, { slot: 'Z', bet: 1, win: 500, multiplier: 500, username: 'Runner', huntType: 'solo', at: 't' });
});

test('fail-closed default masks all equity names when publicHuntView is unconfigured', () => {
  delete require.cache[require.resolve('./publicSerializers')];
  const Fresh = require('./publicSerializers');
  const out = Fresh.publicHunt({ huntId: 'h', bonuses: [], equity: [{ name: 'Alice', amount: 10, discordId: '1' }] });
  assert.strictEqual(out.equity[0].name, 'Hidden');
  delete require.cache[require.resolve('./publicSerializers')]; // restore for any later tests
});

// ── calls + derived category (Developer API live-hunt support) ──────────────────

const CALLS_HUNT = { ...HUNT, calls: [
  { id: 'c1', slot: 'Le Bandit', user: 'Alice', callerId: '222', status: 'pending', ts: 1720000000000, source: 'public' },
  { id: 'c2', slot: 'Gates', user: 'Anonymous', callerId: 'anon1', status: 'in', ts: 1720000001000 },
]};

test('publicHunt exposes calls but never callerId', () => {
  const out = S.publicHunt(CALLS_HUNT);
  assert.strictEqual(out.calls.length, 2);
  // `userId` is the opaque form of callerId — the raw id is still gone (asserted below).
  assert.deepStrictEqual(out.calls[0], {
    slot: 'Le Bandit', user: 'Alice', userId: publicOwnerId('acme', '222'),
    status: 'pending', at: 1720000000000,
  });
  const json = JSON.stringify(out.calls);
  assert.ok(!json.includes('callerId') && !json.includes('222'));
});

test('publicHunt tolerates a hunt with no calls', () => {
  assert.deepStrictEqual(S.publicHunt(HUNT).calls, []);
});

test('publicHunt reports the derived category, not the raw huntType', () => {
  // Affiliate hunts are stored as huntType 'vip'; the public label must say 'affiliate'.
  const aff = { ...HUNT, user: { id: '__affiliate_hunt__:acme' }, tenantId: 'acme', huntType: 'vip' };
  assert.strictEqual(S.publicHunt(aff).huntType, 'affiliate');
  // Tenant hunts are stored as huntType 'solo'; the public label must say 'streamer'.
  const mod = { ...HUNT, user: { id: '__tenant_hunt__:acme' }, tenantId: 'acme', huntType: 'solo' };
  assert.strictEqual(S.publicHunt(mod).huntType, 'streamer');
  // A regular hunt is unchanged.
  assert.strictEqual(S.publicHunt(HUNT).huntType, 'community');
});

test('publicHunt coerces call field values, never emitting a stored object', () => {
  // An editor could store a non-string in `user`; the anonymity check upstream cannot see
  // inside an object, so emitting it verbatim would bypass masking AND leak whatever it holds.
  const weird = { ...HUNT, calls: [
    { slot: 'Ok', user: { name: 'Sneaky', discordId: '999' }, status: 'pending', ts: 5 },
    { slot: { nested: 1 }, user: 'Alice', status: ['in'], ts: 'not-a-number' },
  ]};
  const out = S.publicHunt(weird);
  assert.deepStrictEqual(out.calls[0], { slot: 'Ok', user: null, userId: null, status: 'pending', at: 5 });
  assert.deepStrictEqual(out.calls[1], { slot: null, user: 'Alice', userId: null, status: null, at: null });
  assert.ok(!JSON.stringify(out).includes('999'));
});

// ── owner ─────────────────────────────────────────────────────────────────────────────────────
// Before this field existed, the only handle on a hunt was `equity[0].name`. That is the owner on
// a solo hunt and a BACKER on a community hunt, so every consumer showing one streamer's hunts was
// string-matching a display name and losing the whole list on a rename.

test('publicHunt carries an opaque owner, never the raw Discord id', () => {
  const out = S.publicHunt(HUNT);
  assert.strictEqual(out.owner.name, 'Runner');
  assert.match(out.owner.id, /^usr_/);
  assert.ok(!JSON.stringify(out.owner).includes('111'));
});

test('owner.id is stable across a display-name change — the entire point of the field', () => {
  const renamed = { ...HUNT, user: { id: '111', displayName: 'Runner2' } };
  assert.strictEqual(S.publicHunt(renamed).owner.id, S.publicHunt(HUNT).owner.id);
  assert.strictEqual(S.publicHunt(renamed).owner.name, 'Runner2');
});

test('owner is null when a hunt has no user, rather than a half-built object', () => {
  assert.strictEqual(S.publicHunt({ ...HUNT, user: null }).owner, null);
  assert.strictEqual(S.publicHunt({ ...HUNT, user: { id: '' } }).owner, null);
});

// ── summary view ──────────────────────────────────────────────────────────────────────────────

test('publicHuntSummary drops the nested arrays and keeps the index fields', () => {
  const out = S.publicHuntSummary(HUNT);
  assert.deepStrictEqual(Object.keys(out).sort(), [
    'averageMultiple', 'bonusCount', 'createdAt', 'currency', 'endedAt', 'huntKind', 'huntType',
    'id', 'isTournament', 'owner', 'pot', 'startedAt', 'status', 'totalWon', 'updatedAt',
  ]);
  assert.strictEqual(out.bonusCount, 1);
  assert.strictEqual(out.totalWon, 200);
});

test('publicHuntSummary agrees with publicHunt on every field it shares', () => {
  // Two serializers, one contract: an index row and the detail fetch must not disagree about a
  // hunt's status, type, owner or totals, or a card grid and its detail page show different things.
  const full = S.publicHunt(HUNT), sum = S.publicHuntSummary(HUNT);
  for (const k of Object.keys(sum)) assert.deepStrictEqual(sum[k], full[k], `mismatch on ${k}`);
});

test('publicHuntSummary still carries an opaque owner, and no Discord id', () => {
  const json = JSON.stringify(S.publicHuntSummary(HUNT));
  assert.ok(!json.includes('"111"') && !json.includes('discordId'));
  assert.match(S.publicHuntSummary(HUNT).owner.id, /^usr_/);
});

// ── pot + averageMultiple ─────────────────────────────────────────────────────────────────────
// A consumer cannot state a hunt's profit without knowing what it cost. Before these existed the
// only way to learn the pot was a full fetch per row, and at least one consumer instead assumed a
// pot of zero — which silently defines profit as the entire amount won.

test('pot is the sum of equity amounts, on both shapes', () => {
  assert.strictEqual(S.publicHunt(HUNT).pot, 150);
  assert.strictEqual(S.publicHuntSummary(HUNT).pot, 150);
});

test('pot is 0 when a hunt has no equity, and stays a number', () => {
  const hunt = { ...HUNT, equity: [] };
  assert.strictEqual(S.publicHuntSummary(hunt).pot, 0);
  assert.strictEqual(S.publicHuntSummary({ ...HUNT, equity: undefined }).pot, 0);
});

test('an anonymous member contributes to pot exactly as a named one does', () => {
  // Bob is masked to 'Anonymous' by the injected publicHuntView. Masking rewrites names, never
  // amounts — if that ever changed, the pot would silently drop a backer's stake.
  const out = S.publicHunt(HUNT);
  const masked = out.equity.find(e => e.name === 'Anonymous');
  assert.strictEqual(masked.amount, 50);
  assert.strictEqual(out.pot, 150);
});

test('pot equals the sum of the equity rows the same payload exposes', () => {
  // The invariant stated directly: an index row, a detail fetch and the rows themselves must all
  // agree about what a hunt cost, or the consumer picks one and contradicts the others.
  const full = S.publicHunt(HUNT);
  const fromRows = full.equity.reduce((s, e) => s + e.amount, 0);
  assert.strictEqual(full.pot, fromRows);
  assert.strictEqual(S.publicHuntSummary(HUNT).pot, fromRows);
});

test('pot rounds a float-accumulated sum to 2dp', () => {
  const hunt = { ...HUNT, equity: [{ name: 'A', amount: 0.1 }, { name: 'B', amount: 0.2 }] };
  assert.strictEqual(S.publicHuntSummary(hunt).pot, 0.3);
});

test('averageMultiple is the mean win/bet over opened, staked bonuses', () => {
  assert.strictEqual(S.publicHuntSummary(HUNT).averageMultiple, 100);
  const hunt = { ...HUNT, bonuses: [
    { slot: 'A', bet: 2, win: 200 },   // 100x
    { slot: 'B', bet: 2, win: 100 },   //  50x
  ] };
  assert.strictEqual(S.publicHuntSummary(hunt).averageMultiple, 75);
});

test('averageMultiple ignores unopened and unstaked bonuses rather than scoring them zero', () => {
  // bet: 0 is a collected-but-unbought bonus and win: null is one not yet opened. Counting either
  // as a 0x drags the average down by however many bonuses are still to come.
  const hunt = { ...HUNT, bonuses: [
    { slot: 'A', bet: 2, win: 200 },      // 100x — the only qualifying row
    { slot: 'B', bet: 0, win: null },     // collected, not bought
    { slot: 'C', bet: 2, win: null },     // bought, not opened
  ] };
  assert.strictEqual(S.publicHuntSummary(hunt).averageMultiple, 100);
});

test('averageMultiple is null, never 0, when nothing qualifies', () => {
  // 0 would read as "every bonus paid nothing", which is a result. Null is "no result yet".
  const hunt = { ...HUNT, bonuses: [{ slot: 'A', bet: 0, win: null }] };
  assert.strictEqual(S.publicHuntSummary(hunt).averageMultiple, null);
  assert.strictEqual(S.publicHuntSummary({ ...HUNT, bonuses: [] }).averageMultiple, null);
});

test('a bonus that opened and paid nothing counts as 0x rather than being skipped', () => {
  const hunt = { ...HUNT, bonuses: [
    { slot: 'A', bet: 2, win: 200 },   // 100x
    { slot: 'B', bet: 2, win: 0 },     //   0x — a real result
  ] };
  assert.strictEqual(S.publicHuntSummary(hunt).averageMultiple, 50);
});

// ── stable ids on equity[] and calls[] ────────────────────────────────────────────────────────
// Until these existed the same person was identified two different ways in one payload — `owner`
// by a stable id, everyone else by a display name that changes when they rename. A consumer could
// not join a backer to a user or to its own records, and a consumer with a privacy obligation had
// no key with which to keep a masked identity consistent between periods.
const { publicOwnerId } = require('./publicIds');

const LINKED = {
  huntId: 'h_ids', user: { id: '111', displayName: 'Runner' }, tenantId: 'acme',
  huntType: 'community', isLive: true, currency: 'USD',
  bonuses: [],
  equity: [
    { name: 'Alice', amount: 100, discordId: '222' },   // linked
    { name: 'Typed In', amount: 50 },                    // never linked — the common case
    { name: 'Bob', amount: 25, discordId: 'anon1' },      // linked AND anonymous
  ],
  calls: [
    { slot: 'Le Bandit', user: 'Alice', status: 'in', ts: 1, callerId: '222' },
    { slot: 'Sugar Rush', user: 'someviewer', status: 'pending', ts: 2 }, // free text, no id
  ],
};

test('equity and calls carry the SAME id the owner field would use for that person', () => {
  const out = S.publicHunt(LINKED);
  const alice = publicOwnerId('acme', '222');
  assert.strictEqual(out.equity[0].userId, alice);
  // The join that was impossible before: the same person, same key, in two different arrays.
  assert.strictEqual(out.calls[0].userId, alice);
});

test('userId is null on an unlinked row — the common case, not a failure', () => {
  const out = S.publicHunt(LINKED);
  assert.strictEqual(out.equity[1].userId, null);
  assert.strictEqual(out.calls[1].userId, null);
  // The display name is still there; only the id is absent.
  assert.strictEqual(out.equity[1].name, 'Typed In');
  assert.strictEqual(out.calls[1].user, 'someviewer');
});

test('an anonymous member loses their NAME and keeps their id — same rule as owner', () => {
  const out = S.publicHunt(LINKED);
  const bob = out.equity[2];
  assert.strictEqual(bob.name, 'Anonymous');
  // Without this a consumer masking handles cannot keep one masked person consistent across
  // periods, which is the whole reason a stable key is needed here.
  assert.strictEqual(bob.userId, publicOwnerId('acme', 'anon1'));
});

test('the raw Discord id still never leaves — only the opaque form', () => {
  const json = JSON.stringify(S.publicHunt(LINKED));
  assert.ok(!json.includes('"222"'));
  assert.ok(!json.includes('discordId') && !json.includes('callerId'));
  assert.ok(json.includes('usr_'));
});

test('ids stay attached to the right row when masking rewrites the array', () => {
  // publicHunt reads ids off the RAW hunt and names off the MASKED copy, pairing by index. That
  // holds only while publicHuntView maps 1:1 — if it ever filtered, every id would shift onto the
  // wrong person, which is worse than having no ids at all.
  const out = S.publicHunt(LINKED);
  assert.strictEqual(out.equity.length, LINKED.equity.length);
  assert.strictEqual(out.calls.length, LINKED.calls.length);
  assert.deepStrictEqual(out.equity.map(e => e.userId), [
    publicOwnerId('acme', '222'), null, publicOwnerId('acme', 'anon1'),
  ]);
});

test('two communities never mint the same id for one person', () => {
  const other = S.publicHunt({ ...LINKED, tenantId: 'other' });
  assert.notStrictEqual(S.publicHunt(LINKED).equity[0].userId, other.equity[0].userId);
});

test('the existing fields are untouched — this is additive, not a reshape', () => {
  const out = S.publicHunt(LINKED);
  // `calls[].user` must stay a STRING. Turning it into an object would print "[object Object]"
  // on a consumer's board with no error anywhere.
  assert.strictEqual(typeof out.calls[0].user, 'string');
  assert.strictEqual(out.equity[0].name, 'Alice');
  assert.strictEqual(out.equity[0].amount, 100);
});

// ── hunt kind + tournament fields (Task 3) ───────────────────────────────────────────────────

test('publicHunt publishes the hunt kind and tournament fields', () => {
  const out = S.publicHunt({
    huntId: 'h1', huntKind: 'buy', isTournament: true,
    tournamentProvider: 'hacksaw', tournamentRound: 'Quarter final 2',
    targetBonuses: 10, bonuses: [],
  });
  assert.strictEqual(out.huntKind, 'buy');
  assert.strictEqual(out.isTournament, true);
  assert.strictEqual(out.tournamentProvider, 'hacksaw');
  assert.strictEqual(out.tournamentRound, 'Quarter final 2');
  assert.strictEqual(out.targetBonuses, 10);
});

test('a hunt with no kind publishes null, never a default', () => {
  const out = S.publicHunt({ huntId: 'h1', bonuses: [] });
  assert.strictEqual(out.huntKind, null);
  assert.strictEqual(out.isTournament, false);
});

test('the summary shape carries the kind too', () => {
  const out = S.publicHuntSummary({ huntId: 'h1', huntKind: 'natty', bonuses: [] });
  assert.strictEqual(out.huntKind, 'natty');
});
