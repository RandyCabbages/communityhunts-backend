# Per-user stats: hunt-type split + four new stat groups — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a hunt-type axis (Solo / Community / VIP / Affiliate / Streamer) to the per-user stats panel alongside the existing All / Hosting / Joined role axis, plus four new data groups: who joins their hunts, currency breakdown, bet size + vault, and time of day.

**Architecture:** The backend nests a `byType` sub-tree under the existing stats blob — each entry is the *same* three-role structure produced by the same `slicesFor()` code over a filtered input, so a type slice and the combined slice cannot disagree. `pastHunts` is carried once at top level, its rows stamped with the derived category, so the table filters in the browser. The frontend composes `sliceOf(pickType(stats, type), role)` and degrades to today's panel when `byType` is absent, so the two repos deploy in any order.

**Tech Stack:** Node.js (CommonJS, `node:test`), React 18 (CRA), Postgres JSONB cache.

**Spec:** `docs/superpowers/specs/2026-08-04-user-stats-hunt-type-split-design.md`

## Global Constraints

- **Backend branch:** `feat/user-stats-hunt-type-split` (already exists, spec committed on it).
- **Frontend branch:** `feat/user-stats-hunt-type-split`, **created off fresh `main`** — the frontend worktree is currently on `release/extension-1.0.34`, which must NOT be used as the base.
- **Never commit to `main` in either repo.** Branch + PR only. Both `main`s auto-deploy to production.
- **`git add` with explicit paths only — never `git add -A`.** The backend worktree carries an unrelated uncommitted edit to `scripts/dev-public-api.js` that must stay out of every commit.
- **No `Co-Authored-By` or AI-attribution trailers** in any commit message.
- **Backend tests:** `npm test` → `node --test lib/*.test.js routes/*.test.js sockets/*.test.js`. Each test *file* runs in its own process, so module-global state set by `initHuntsCore` is contained to the file that sets it.
- **Frontend tests:** pure-logic modules get a `.test.js`; components do **not** (`@testing-library/react` is not installed — do not add it).
- **Frontend build gate:** `CI=true npm run build` must print "Compiled successfully" before any push. Vercel treats warnings as errors.
- **Frontend styling:** tokens via `useTheme()` only. Never introduce a local `const C = {…}` token object.
- **Money rule, everywhere in this pipeline:** USD-normalized, and a hunt with no FX rate is *skipped*, never summed at face value.
- **Never import `shouldMaskIdentity` from `lib/hunts-core.js`.** It is a rebindable module-level `let`; importing the binding captures the privacy-safe default at require time. Use the exported `isIdentityMasked(discordId, name)` wrapper.

---

## Task 1: Derived hunt category on every per-hunt detail and past-hunts row

Fixes a live bug (the profile's type column is blank on hunts that never set the internal flag, and mislabels the three shared hunts) and is the enabler for every later task.

**Files:**
- Modify: `communityhunts-backend/lib/userStatsHunt.js` (imports at :9, `perHunt` return at :99-112)
- Modify: `communityhunts-backend/lib/userStatsSlice.js:98`
- Test: `communityhunts-backend/lib/userStats.test.js` (append)

**Interfaces:**
- Consumes: `huntCategoryOf(h)` from `lib/hunts-core.js` — returns `'community' | 'solo' | 'vip' | 'affiliate' | 'streamer'`. Pure; needs no `initHuntsCore`.
- Produces: `perHunt(h, id)` gains `category: string`. `pastHunts[i].huntType` becomes the derived category instead of the raw `h.huntType` flag.

- [ ] **Step 1: Write the failing tests**

Append to `communityhunts-backend/lib/userStats.test.js`:

```js
test('pastHunts huntType is the DERIVED category, not the raw internal flag', () => {
  const hs = [
    // No huntType flag at all — this read `null` before, blanking the admin table's type column.
    { user: { id: 'u1' }, huntId: 'a', currency: 'USD', usdRate: 1, archivedAt: '2026-07-01T00:00:00Z',
      equity: [{ id: 'r1', discordId: 'u1', amount: 100 }], bonuses: [{ bet: 10, win: 20, mult: 2 }] },
    { user: { id: 'u1' }, huntId: 'b', huntType: 'solo', currency: 'USD', usdRate: 1, archivedAt: '2026-07-02T00:00:00Z',
      equity: [{ id: 'r2', discordId: 'u1', amount: 100 }], bonuses: [{ bet: 10, win: 20, mult: 2 }] },
    // 'vip' is NOT a storable category — a mod's VIP-shaped regular hunt reports as community.
    { user: { id: 'u1' }, huntId: 'c', huntType: 'vip', currency: 'USD', usdRate: 1, archivedAt: '2026-07-03T00:00:00Z',
      equity: [{ id: 'r3', discordId: 'u1', amount: 100 }], bonuses: [{ bet: 10, win: 20, mult: 2 }] },
  ];
  const byKey = Object.fromEntries(
    computeUserHuntStats(hs, 'u1').pastHunts.map(r => [r.huntKey, r.huntType]));
  assert.strictEqual(byKey.a, 'community');
  assert.strictEqual(byKey.b, 'solo');
  assert.strictEqual(byKey.c, 'community');
});

test('pastHunts huntType labels the three shared hunts by KEY, not by huntType', () => {
  const shared = (huntId, key) => ({
    user: { id: key }, huntId, huntType: 'community', currency: 'USD', usdRate: 1,
    archivedAt: '2026-07-01T00:00:00Z',
    equity: [{ id: 'r', discordId: 'u1', amount: 100 }],
    bonuses: [{ bet: 10, win: 20, mult: 2 }],
  });
  const byKey = Object.fromEntries(computeUserHuntStats([
    shared('t', '__tenant_hunt__'),
    shared('a', '__affiliate_hunt__'),
    shared('v', '__vip_hunt__'),
  ], 'u1').pastHunts.map(r => [r.huntKey, r.huntType]));
  assert.strictEqual(byKey.t, 'streamer');
  assert.strictEqual(byKey.a, 'affiliate');
  assert.strictEqual(byKey.v, 'vip');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd communityhunts-backend && node --test lib/userStats.test.js`
Expected: FAIL — `byKey.a` is `null` (not `'community'`), and the shared-hunt keys all read `'community'`.

- [ ] **Step 3: Add `category` to the per-hunt detail**

In `communityhunts-backend/lib/userStatsHunt.js`, change the import on line 9:

```js
const { sumVault, huntCategoryOf } = require('./hunts-core');
```

Then in `perHunt`'s return block, add `category` directly under the `code` line:

```js
    rate, code: h.currency || 'USD',
    // PUBLIC product label, derived from the hunt key + huntType — never the raw huntType flag,
    // which is blank on older hunts and cannot see the three key-identified shared hunts.
    category: huntCategoryOf(h),
```

- [ ] **Step 4: Stamp it on the past-hunts row**

In `communityhunts-backend/lib/userStatsSlice.js`, change line 98 from:

```js
      date: d.when, huntType: h.huntType || null,
```

to:

```js
      date: d.when, huntType: d.category,
```

- [ ] **Step 5: Run the full backend suite**

Run: `cd communityhunts-backend && npm test`
Expected: PASS — all tests green, including the two new ones.

- [ ] **Step 6: Commit**

```bash
git add lib/userStatsHunt.js lib/userStatsSlice.js lib/userStats.test.js
git commit -m "fix(stats): past-hunts rows carry the derived hunt category

The row stamped the raw internal huntType flag, which is blank on every
hunt that never set it and cannot see the three shared hunts (they are
identified by key). The admin profile's type column was blank or wrong
for those rows. huntCategoryOf is derived, so this applies to the whole
archive with no migration."
```

---

## Task 2: Bet sizing and vault totals

**Files:**
- Modify: `communityhunts-backend/lib/userStatsHunt.js` (`perHunt` body at :68-69, return block)
- Modify: `communityhunts-backend/lib/userStatsSlice.js` (`aggregate` accumulators, bonus loop, outputs)
- Test: `communityhunts-backend/lib/userStats.test.js` (append)

**Interfaces:**
- Consumes: `perHunt(h, id)` from Task 1.
- Produces: `perHunt` gains `vault: number` (native currency). `aggregate` gains `tiles.avgBet`, `records.biggestBet`, `usd.vault`, `usd.vaultHunts` — all USD-normalized, all skipping rate-less hunts.

- [ ] **Step 1: Write the failing tests**

Append to `communityhunts-backend/lib/userStats.test.js`:

```js
test('bets: avgBet and biggestBet are USD-normalized and skip unconverted hunts', () => {
  const hs = [
    { user: { id: 'u1' }, huntId: 'rated', currency: 'GBP', usdRate: 2, archivedAt: '2026-07-01T00:00:00Z',
      equity: [{ id: 'r1', discordId: 'u1', amount: 100 }],
      bonuses: [{ bet: 10, win: 40, mult: 4 }, { bet: 30, win: 0, mult: 0 }] },
    // No usdRate: contributes to neither figure rather than being summed at face value.
    { user: { id: 'u1' }, huntId: 'unrated', currency: 'ARS', archivedAt: '2026-07-02T00:00:00Z',
      equity: [{ id: 'r2', discordId: 'u1', amount: 100 }],
      bonuses: [{ bet: 9999, win: 0, mult: 0 }] },
  ];
  const s = computeUserHuntStats(hs, 'u1');
  assert.strictEqual(s.records.biggestBet, 60);   // 30 GBP x 2
  assert.strictEqual(s.tiles.avgBet, 40);         // (10 + 30) x 2 / 2 bonuses
});

test('vault: reported on its own, USD-normalized, and never a multiplier', () => {
  const hs = [{
    user: { id: 'u1' }, huntId: 'v', currency: 'GBP', usdRate: 2, archivedAt: '2026-07-01T00:00:00Z',
    equity: [{ id: 'r1', discordId: 'u1', amount: 100 }],
    bonuses: [{ bet: 10, win: 40, mult: 4 }],
    vault: [{ amount: 15 }, { amount: 5 }],
  }];
  const s = computeUserHuntStats(hs, 'u1');
  assert.strictEqual(s.usd.vault, 40);            // (15 + 5) GBP x 2
  assert.strictEqual(s.usd.vaultHunts, 1);
  assert.strictEqual(s.tiles.avgMult, 4);         // vault must NOT reach a multiplier
});

test('vault: a hunt with no vault reports zero, not a missing field', () => {
  const s = computeUserHuntStats([{
    user: { id: 'u1' }, huntId: 'n', currency: 'USD', usdRate: 1, archivedAt: '2026-07-01T00:00:00Z',
    equity: [{ id: 'r1', discordId: 'u1', amount: 100 }], bonuses: [{ bet: 10, win: 40, mult: 4 }],
  }], 'u1');
  assert.strictEqual(s.usd.vault, 0);
  assert.strictEqual(s.usd.vaultHunts, 0);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd communityhunts-backend && node --test lib/userStats.test.js`
Expected: FAIL — `s.records.biggestBet`, `s.tiles.avgBet`, `s.usd.vault` are all `undefined`.

- [ ] **Step 3: Expose `vault` on the per-hunt detail**

In `communityhunts-backend/lib/userStatsHunt.js`, replace lines 68-69:

```js
  const hn = bonuses.reduce((a, b) => a + (Number(b.win) || 0), 0);   // bonus-only won — feeds avgX (multiplier), vault MUST stay excluded here
  const hnWinnings = hn + sumVault(h);   // total won incl. vault = end balance — winnings/payout site, never a multiplier numerator
```

with:

```js
  const hn = bonuses.reduce((a, b) => a + (Number(b.win) || 0), 0);   // bonus-only won — feeds avgX (multiplier), vault MUST stay excluded here
  const vault = sumVault(h);             // base-game wins: a winnings/payout figure, NEVER a multiplier numerator
  const hnWinnings = hn + vault;         // total won incl. vault = end balance
```

Then add `vault` to the return block, on the line that already carries the other money figures:

```js
    hw, hn, hnWinnings, betOpened, pot, vault,
```

- [ ] **Step 4: Accumulate the new figures in `aggregate`**

In `communityhunts-backend/lib/userStatsSlice.js`:

**4a.** Add accumulators next to the existing ones (after the `let biggestWin = 0, highestMult = 0;` line):

```js
  let betCount = 0, betSum = 0, biggestBet = 0;      // USD, rate-carrying hunts only
  let vaultTotal = 0, vaultHunts = 0;
```

**4b.** Inside the existing `if (rate != null) { … }` block that accumulates `usdWagered` etc., add as its last statement (immediately before the closing `}` that precedes `} else {`):

```js
      if (d.vault > 0) { vaultTotal += d.vault * rate; vaultHunts++; }
```

**4c.** In the bonus loop, extend the inner rate guard. Replace:

```js
      if (rate != null) {                                          // USD-normalized; skip unconverted hunts
        const w = (Number(b.win) || 0) * rate; if (w > biggestWin) biggestWin = w;
      }
```

with:

```js
      if (rate != null) {                                          // USD-normalized; skip unconverted hunts
        const w = (Number(b.win) || 0) * rate; if (w > biggestWin) biggestWin = w;
        const bt = (Number(b.bet) || 0) * rate;
        betSum += bt; betCount++;
        if (bt > biggestBet) biggestBet = bt;
      }
```

**4d.** Add `vault` / `vaultHunts` to the `usd` object:

```js
  const usd = {
    wagered: usdWagered, won: usdWon, net: usdNet,
    avgStart: usdConv ? usdStartSum / usdConv : 0,
    unconvertedCount: usdUnconv,
    invested: usdInvested, returned: usdReturned,
    roi: usdInvested > 0 ? usdNet / usdInvested : null,
    vault: vaultTotal, vaultHunts,
  };
```

**4e.** Add `avgBet` to `tiles` and `biggestBet` to `records` in the returned `slice`:

```js
    tiles: {
      hunts: details.length,
      hosted, joined,
      winRate: details.length ? wins / details.length : 0,
      wagered, won,
      avgStart: details.length ? potSum / details.length : 0,
      avgMult: multN ? multSum / multN : 0,
      avgBet: betCount ? betSum / betCount : 0,
    },
    activity, profit,
    multHistogram: BUCKETS.map(b => ({ bucket: b, count: histo[b] })),
    records: {
      biggestWin, highestMult, biggestBet,
      bestHuntNet, worstHuntNet, longestWinStreak: wStreak, longestLossStreak: lStreak,
    },
```

- [ ] **Step 5: Run the full backend suite**

Run: `cd communityhunts-backend && npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add lib/userStatsHunt.js lib/userStatsSlice.js lib/userStats.test.js
git commit -m "feat(stats): report bet sizing and vault totals

avgBet, biggestBet, and vault (base-game wins) were all recorded and
none were surfaced — vault money was folded into winnings, so a big
vault run looked identical to a big bonus run. All three skip hunts
with no FX rate, matching biggestWin."
```

---

## Task 3: Who joins their hunts (`host.operator.topMembers`)

**Files:**
- Modify: `communityhunts-backend/lib/userStatsGroups.js` (imports :11-12, `hostOperator` :16-70, `joinedPlayer` signature :72)
- Create: `communityhunts-backend/lib/userStatsGroups.test.js`

**Interfaces:**
- Consumes: `perHunt` details (Task 1), `eqUserId` / `isRealUserId` from `lib/userStatsHunt.js`, `isIdentityMasked(discordId, name)` from `lib/hunts-core.js`.
- Produces:
  - `hostOperator(details, { cap } = {})` — gains `topMembers: [{ userId, name, hunts, invested, returned, net }]` (sorted `hunts` desc, then `net` desc, capped) and `anonymousMembers: number`.
  - `joinedPlayer(details, { cap } = {})` — signature gains the same options bag; behaviour otherwise unchanged.
  - Exported constant `TOP_MEMBERS_CAP = 10`.

- [ ] **Step 1: Write the failing test**

Create `communityhunts-backend/lib/userStatsGroups.test.js`:

```js
// Host-side member table + the anonymity rule.
//
// initHuntsCore below is LOAD-BEARING. `shouldMaskIdentity` is a rebindable module-level `let`
// inside hunts-core whose default masks NOTHING, and no unit test arms it. Without this call the
// anonymity assertions would pass while testing nothing at all. Safe to do at module scope:
// node:test runs each test FILE in its own process.
const { test } = require('node:test');
const assert = require('node:assert');
const { initHuntsCore } = require('./hunts-core');

initHuntsCore({
  hunts: {}, archive: [], viewers: {}, io: null,
  shouldMaskIdentity: ({ discordId }) => discordId === 'ghost',
});

const { computeUserHuntStats } = require('./userStats');

// pot 300 (me 100 + pal 100 + ghost 100; the seed row is 0), won 600.
// With no gifts each 100-stake member takes 600 x 100/300 = 200, so plNet = +100 each.
const HOSTED = [{
  user: { id: 'me' }, huntId: 'h1', huntType: 'community', currency: 'USD', usdRate: 1,
  startedAt: '2026-07-01T00:00:00.000Z', archivedAt: '2026-07-01T02:00:00.000Z',
  equity: [
    { id: 'r1', name: 'Me', discordId: 'me', amount: 100 },
    { id: 'r2', name: 'Pal', discordId: 'pal', amount: 100 },
    { id: 'r3', name: 'Ghost', discordId: 'ghost', amount: 100 },
    { id: 'creator_auto', name: 'Seed', amount: 0 },
  ],
  bonuses: [{ bet: 10, win: 600, mult: 60 }],
}];

test('topMembers: names the people who joined, with their own money', () => {
  const op = computeUserHuntStats(HOSTED, 'me').host.operator;
  assert.deepStrictEqual(op.topMembers, [
    { userId: 'pal', name: 'Pal', hunts: 1, invested: 100, returned: 200, net: 100 },
  ]);
});

test('topMembers: the host, seed placeholders and masked members are all excluded', () => {
  const op = computeUserHuntStats(HOSTED, 'me').host.operator;
  const ids = op.topMembers.map(m => m.userId);
  assert.ok(!ids.includes('me'), 'the host is not one of their own members');
  assert.ok(!ids.includes('creator_auto'), 'seed placeholders are not people');
  assert.ok(!ids.includes('ghost'), 'an anonymous member is never named');
});

test('topMembers: anonymous members are counted, and still count everywhere else', () => {
  const op = computeUserHuntStats(HOSTED, 'me').host.operator;
  assert.strictEqual(op.anonymousMembers, 1);
  // Excluded from the NAMED list only — they are still a participant and still got paid.
  assert.strictEqual(op.uniqueParticipants, 3);   // me + pal + ghost (creator_auto is not real)
  assert.strictEqual(op.paidOutToMembers, 400);   // pal 200 + ghost 200 + seed 0
});

test('topMembers: attribution is by discordId, never the per-row uuid', () => {
  const hs = [{
    user: { id: 'me' }, huntId: 'h2', currency: 'USD', usdRate: 1,
    archivedAt: '2026-07-02T00:00:00.000Z',
    equity: [
      { id: 'uuid-host', name: 'Me', discordId: 'me', amount: 100 },
      { id: 'uuid-one', name: 'Pal', discordId: 'pal', amount: 100 },
    ],
    bonuses: [{ bet: 10, win: 400, mult: 40 }],
  }, ...HOSTED];
  const op = computeUserHuntStats(hs, 'me').host.operator;
  const pal = op.topMembers.find(m => m.userId === 'pal');
  // Same person across two hunts with DIFFERENT row uuids — one row, not two.
  assert.strictEqual(op.topMembers.filter(m => m.userId === 'pal').length, 1);
  assert.strictEqual(pal.hunts, 2);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd communityhunts-backend && node --test lib/userStatsGroups.test.js`
Expected: FAIL — `op.topMembers` is `undefined`.

- [ ] **Step 3: Implement `topMembers`**

In `communityhunts-backend/lib/userStatsGroups.js`:

**3a.** Replace the imports on lines 11-12:

```js
const { huntCompleted, huntCategoryOf, isIdentityMasked } = require('./hunts-core');
const { eqUserId, isRealUserId } = require('./userStatsHunt');
```

**3b.** Add the cap constant next to `TOP_HOSTS_CAP`:

```js
const TOP_HOSTS_CAP = 10;
const TOP_MEMBERS_CAP = 10;
```

**3c.** Change the `hostOperator` signature and add the two collections:

```js
function hostOperator(details, { cap = TOP_MEMBERS_CAP } = {}) {
  let potUsd = 0, potHunts = 0, paidOut = 0;
  let peopleSum = 0, slotSum = 0, completed = 0;
  let durSum = 0, durN = 0;
  let reqN = 0, beatReq = 0;
  const participants = new Set();
  const typeMix = {};
  const members = new Map();   // discordId -> { userId, name, hunts, invested, returned, net }
  const anon = new Set();      // distinct masked members — counted, never named
```

**3d.** Replace the whole `if (rate != null) { … }` block at the top of the loop (lines 28-38 in the original) with:

```js
    if (rate != null) { potUsd += d.pot * rate; potHunts++; }

    // ONE pass over the equity rows feeding both `paidOutToMembers` and the per-member table.
    // Counting is rate-independent (a hunt with no FX rate still happened); money is not.
    const hostId = String(h.user?.id ?? '');
    for (const e of (h.equity || [])) {
      const uid = eqUserId(e);
      if (uid === hostId) continue;                 // the host is not one of their own members
      // The ledger is keyed by the equity ROW id; identity is the discordId. Deliberately different.
      const m = d.ledger.members[e.id];
      const money = m && rate != null;
      if (money) paidOut += (Number(m.finalPayout) || 0) * rate;

      if (!isRealUserId(uid)) continue;             // creator_auto / bean_auto / row uuids aren't people
      // Masked at COMPUTE time: this blob is cached once and served to both the admin profile and
      // the member's own stats page, so it must never carry a name it would not show to everyone.
      if (isIdentityMasked(uid, e.name)) { anon.add(uid); continue; }

      const row = members.get(uid)
        || { userId: uid, name: e.name || null, hunts: 0, invested: 0, returned: 0, net: 0 };
      row.hunts++;
      if (e.name) row.name = e.name;                // freshest non-empty display name wins
      if (money) {
        row.invested += (Number(m.selfInvested) || 0) * rate;
        row.returned += (Number(m.finalPayout) || 0) * rate;
        row.net += (Number(m.plNet) || 0) * rate;
      }
      members.set(uid, row);
    }
```

**3e.** Add the sorted list to the return block, mirroring how `topHosts` is built:

```js
  const topMembers = [...members.values()]
    .sort((a, b) => b.hunts - a.hunts || b.net - a.net)
    .slice(0, cap);

  const n = details.length;
  return {
    hunts: n,
    totalPot: potUsd,
    avgPot: potHunts ? potUsd / potHunts : 0,
    paidOutToMembers: paidOut,
    avgPeople: n ? peopleSum / n : 0,
    uniqueParticipants: participants.size,
    avgSlots: n ? slotSum / n : 0,
    completionRate: n ? completed / n : 0,
    avgDurationMs: durN ? durSum / durN : null,
    beatReqRate: reqN ? beatReq / reqN : null,
    beatReqHunts: reqN,
    typeMix,
    topMembers, anonymousMembers: anon.size,
  };
}
```

**3f.** Give `joinedPlayer` the same options bag so Task 4 can cap both symmetrically. Change its signature and the `.slice()`:

```js
function joinedPlayer(details, { cap = TOP_HOSTS_CAP } = {}) {
```

```js
  const topHosts = [...hosts.values()]
    .map(r => ({ ...r, roi: r.invested > 0 ? r.net / r.invested : null }))
    .sort((a, b) => b.hunts - a.hunts || b.net - a.net)
    .slice(0, cap);
```

**3g.** Export the new constant:

```js
module.exports = { hostOperator, joinedPlayer, callingRecord, TOP_HOSTS_CAP, TOP_MEMBERS_CAP };
```

- [ ] **Step 4: Run the tests**

Run: `cd communityhunts-backend && node --test lib/userStatsGroups.test.js`
Expected: PASS — all five tests.

Then run the full suite: `cd communityhunts-backend && npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/userStatsGroups.js lib/userStatsGroups.test.js
git commit -m "feat(stats): name the people who join a host's hunts

The joined side has had topHosts since the role split; the host side had
only a headcount. Mirrors it, reusing the equity pass that already runs
for paidOutToMembers.

Anonymous members are masked at compute time rather than at render: the
blob is cached once and served to both the admin profile and the member's
own stats page, so a viewer-dependent name is not possible. They are
counted in anonymousMembers and still count toward every money total."
```

---

## Task 4: The `byType` slice tree

**Files:**
- Modify: `communityhunts-backend/lib/userStats.js` (whole file)
- Test: `communityhunts-backend/lib/userStatsSlices.test.js` (append)

**Interfaces:**
- Consumes: `perHunt().category` (Task 1), `hostOperator(details, {cap})` / `joinedPlayer(details, {cap})` (Task 3), `aggregate(details, {includePastHunts, listCap})`, `PUBLIC_HUNT_CATEGORIES` from `lib/hunts-core.js`.
- Produces: the blob gains `byType: { [category]: { …slice, calling, host, joined } }` — sparse (only non-empty categories), no `pastHunts` inside. `STATS_VERSION` becomes `3`. Also exports `TYPE_LIST_CAP = 10`, `TYPE_GROUP_CAP = 5`.

- [ ] **Step 1: Write the failing tests**

Append to `communityhunts-backend/lib/userStatsSlices.test.js`:

```js
// A third hunt for the type axis: solo, hosted, pot 20 -> won 100, net +80.
const SOLO = {
  user: { id: 'me' }, huntId: 'h-solo-1', huntType: 'solo', currency: 'USD', usdRate: 1,
  startedAt: '2026-07-03T00:00:00.000Z', archivedAt: '2026-07-03T01:00:00.000Z',
  equity: [{ id: 'r5', name: 'Me', discordId: 'me', amount: 20 }],
  bonuses: [{ slot: 'Wanted', bet: 5, win: 100, mult: 20, caller: 'Randy' }],
};

test('byType: one sub-tree per category the user actually has, and nothing else', () => {
  const s = computeUserHuntStats(MIXED, 'me');
  assert.deepStrictEqual(Object.keys(s.byType), ['community']);
  assert.strictEqual(s.byType.community.tiles.hunts, 2);
});

test('byType: type slices PARTITION the combined slice', () => {
  const s = computeUserHuntStats([...MIXED, SOLO], 'me');
  assert.deepStrictEqual(Object.keys(s.byType).sort(), ['community', 'solo']);
  assert.strictEqual(s.byType.community.tiles.hunts + s.byType.solo.tiles.hunts, s.tiles.hunts);
  assert.strictEqual(s.byType.community.usd.net + s.byType.solo.usd.net, s.usd.net);
  assert.strictEqual(s.byType.solo.usd.net, 80);
});

test('byType: the role axis survives inside a type slice', () => {
  const s = computeUserHuntStats([...MIXED, SOLO], 'me');
  assert.strictEqual(s.byType.solo.host.tiles.hunts, 1);
  assert.strictEqual(s.byType.solo.joined.tiles.hunts, 0);
  assert.strictEqual(s.byType.community.host.tiles.hunts, 1);
  assert.strictEqual(s.byType.community.joined.tiles.hunts, 1);
  // The group cards follow both axes too.
  assert.strictEqual(s.byType.solo.host.operator.hunts, 1);
  assert.ok(s.byType.community.joined.player, 'joined player group exists inside a type slice');
});

test('byType: sub-trees carry no pastHunts — the top-level array filters client-side', () => {
  const s = computeUserHuntStats([...MIXED, SOLO], 'me');
  assert.strictEqual(s.byType.community.pastHunts, undefined);
  assert.strictEqual(s.byType.solo.pastHunts, undefined);
  assert.strictEqual(s.pastHunts.length, 3);
  // Every row carries the category, which is what makes the client-side filter possible.
  assert.deepStrictEqual(s.pastHunts.map(r => r.huntType).sort(),
    ['community', 'community', 'solo']);
});

test('byType: version stamp is 3 so cached v2 rows recompute themselves', () => {
  assert.strictEqual(STATS_VERSION, 3);
  assert.strictEqual(computeUserHuntStats(MIXED, 'me').v, 3);
});

test('byType: a user with no hunts gets an empty map, not undefined', () => {
  assert.deepStrictEqual(computeUserHuntStats([], 'nobody').byType, {});
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd communityhunts-backend && node --test lib/userStatsSlices.test.js`
Expected: FAIL — `s.byType` is `undefined`; the version assertion reads 2.

- [ ] **Step 3: Restructure `userStats.js`**

Replace the whole of `communityhunts-backend/lib/userStats.js` with:

```js
// communityhunts-backend/lib/userStats.js
// Pure per-user hunt aggregation for the admin profile and the personal stats page.
// No DB, no side effects.
//
// The shape is sliced on TWO axes. ROLE (all / host / joined) separates running a hunt — you own
// the whole pot and the whole result — from joining one, where you own an equity fraction; a host
// who runs profitably and joins badly used to read as roughly even. TYPE (the derived public
// category) separates solo grinding from community hunts, which is the same failure one axis over.
//
//   { v, ...combined, calling, host: {…}, joined: {…}, pastHunts: [], byType: { solo: {…}, … } }
//
// The combined slice stays SPREAD AT THE TOP LEVEL rather than nested under `all`, because
// StatsBox and the admin profile already read stats.tiles / .usd / .byCurrency / .records — this
// way both splits are purely additive and no existing reader has to change to keep working.
const { perHunt, eqUserId } = require('./userStatsHunt');
const { aggregate } = require('./userStatsSlice');
const { hostOperator, joinedPlayer, callingRecord } = require('./userStatsGroups');
const { PUBLIC_HUNT_CATEGORIES } = require('./hunts-core');

// Bump when the SHAPE changes. statsStore caches this whole object as JSONB per user and only
// recomputed a MISSING row, so without a version stamp every existing user would sit on a
// pre-split blob forever — new tiles blank until their next hunt happened to refresh it.
const STATS_VERSION = 3;

// Nested type slices are capped harder than the top-level ones. The per-week series, histogram and
// records PARTITION their parent (all the types together are about one parent's worth), but the
// top-N lists do NOT — five categories could each carry a full 25 slots and 10 hosts.
const TYPE_LIST_CAP = 10;
const TYPE_GROUP_CAP = 5;

// The three role slices over one set of hunts. Runs over all hunts, and again per hunt type —
// which is the point: a type slice and the combined slice are the same code over different
// inputs, so they cannot disagree.
function slicesFor(details, names, { includePastHunts = false, listCap, groupCap } = {}) {
  const hostDetails = details.filter(d => d.isOwner);
  const joinedDetails = details.filter(d => !d.isOwner);
  return {
    ...aggregate(details, { includePastHunts, listCap }),
    calling: callingRecord(details, names),
    host: {
      ...aggregate(hostDetails, { listCap }),
      calling: callingRecord(hostDetails, names),
      operator: hostOperator(hostDetails, { cap: groupCap }),
    },
    joined: {
      ...aggregate(joinedDetails, { listCap }),
      calling: callingRecord(joinedDetails, names),
      player: joinedPlayer(joinedDetails, { cap: groupCap }),
    },
  };
}

// opts.names — every handle the user is known by (Discord display name + username, Rainbet,
// Twitch). Only used to attribute the free-text `caller` field on a bonus back to them.
function computeUserHuntStats(hunts, userId, opts = {}) {
  const id = String(userId);
  const mine = (hunts || []).filter(h =>
    String(h.user?.id) === id || (h.equity || []).some(e => eqUserId(e) === id));

  const details = mine.map(h => perHunt(h, id));
  const names = opts.names || [];

  // Sparse: a category the user has never touched gets no key at all, so the frontend can offer
  // exactly the type buttons this person has rather than a row of dead zeroes. Iterating the
  // published vocabulary (not the data) keeps the key order stable for the toggle.
  const byType = {};
  for (const cat of PUBLIC_HUNT_CATEGORIES) {
    const sub = details.filter(d => d.category === cat);
    if (sub.length) {
      byType[cat] = slicesFor(sub, names, { listCap: TYPE_LIST_CAP, groupCap: TYPE_GROUP_CAP });
    }
  }

  return {
    v: STATS_VERSION,
    // pastHunts is carried ONCE, here. Every row has `role` and `huntType`, so both the role and
    // the type view filter the table client-side instead of the blob storing it many times over.
    ...slicesFor(details, names, { includePastHunts: true }),
    byType,
  };
}

module.exports = { computeUserHuntStats, STATS_VERSION, TYPE_LIST_CAP, TYPE_GROUP_CAP };
```

- [ ] **Step 4: Run the full backend suite**

Run: `cd communityhunts-backend && npm test`
Expected: PASS — including the pre-existing `userStats.test.js` and `userStatsSlices.test.js` cases, which pin that the combined slice and the role split are unchanged.

- [ ] **Step 5: Commit**

```bash
git add lib/userStats.js lib/userStatsSlices.test.js
git commit -m "feat(stats): slice per-user stats by hunt type

Adds a byType sub-tree beside the existing role slices — same slicesFor()
code over a filtered input, so a type slice and the combined slice cannot
disagree. Sparse: only categories the user actually has.

pastHunts stays at top level and is not repeated per type; its rows now
carry the derived category, so the table filters client-side. Nested
top-N lists are capped lower because, unlike the per-week series, they
do not partition their parent.

STATS_VERSION 2 -> 3 so cached rows recompute on first read."
```

- [ ] **Step 6: Push the backend branch and open the PR**

```bash
git push -u origin feat/user-stats-hunt-type-split
```

Then open the PR against `main`. Do **not** merge yet — the frontend degrades gracefully, so merge order does not matter, but the two PRs should be reviewed together.

---

## Task 5: Frontend pure helpers — type selection and hour-of-day

**Files:**
- Modify: `communityhunts-frontend/src/stats/userStats/userStatsDerive.js`
- Test: `communityhunts-frontend/src/stats/userStats/userStatsDerive.test.js` (append)

**Interfaces:**
- Consumes: the blob shape from Task 4 (`stats.byType`, `pastHunts[].huntType`).
- Produces, all exported from `userStatsDerive.js`:
  - `TYPES: [{ key, label }]` — `all`, `community`, `solo`, `vip`, `affiliate`, `streamer`
  - `pickType(stats, type) → statsLike | null`
  - `typesPresent(stats) → [{ key, label }]`
  - `huntsForType(rows, type) → rows`
  - `hourCounts(pastHunts) → number[24]`
  - `activityStats(...)` gains `byHour: number[24]` and `peakHour: number | null`

- [ ] **Step 1: Create the frontend branch off fresh `main`**

The frontend worktree is on `release/extension-1.0.34`. Branch from `main`, not from where it sits:

```bash
cd communityhunts-frontend
git fetch origin
git checkout main
git pull --ff-only
git checkout -b feat/user-stats-hunt-type-split
```

- [ ] **Step 2: Write the failing tests**

Append to `communityhunts-frontend/src/stats/userStats/userStatsDerive.test.js`:

```js
import { pickType, typesPresent, huntsForType, hourCounts, activityStats } from './userStatsDerive';

const STATS = {
  tiles: { hunts: 3 },
  byType: {
    community: { tiles: { hunts: 2 } },
    solo: { tiles: { hunts: 1 } },
  },
};

test('pickType returns the requested sub-tree', () => {
  expect(pickType(STATS, 'solo').tiles.hunts).toBe(1);
  expect(pickType(STATS, 'all')).toBe(STATS);
});

test('pickType returns null for a type this user has none of', () => {
  // Not a fallback to the combined stats: showing every hunt under a "VIP" label would be a lie.
  expect(pickType(STATS, 'vip')).toBe(null);
});

test('pickType degrades to the combined stats when byType is absent', () => {
  // A frontend deployed ahead of the backend must render today's panel, not a blank one.
  const old = { tiles: { hunts: 3 } };
  expect(pickType(old, 'solo')).toBe(old);
});

test('typesPresent offers only categories the user has, and hides a one-category toggle', () => {
  expect(typesPresent(STATS).map(t => t.key)).toEqual(['all', 'community', 'solo']);
  expect(typesPresent({ byType: { community: {} } })).toEqual([]);
  expect(typesPresent({})).toEqual([]);
});

test('huntsForType filters rows on the derived category', () => {
  const rows = [{ huntType: 'solo' }, { huntType: 'community' }, { huntType: 'solo' }];
  expect(huntsForType(rows, 'solo')).toHaveLength(2);
  expect(huntsForType(rows, 'all')).toHaveLength(3);
});

test('hourCounts buckets by the viewer local hour', () => {
  // Built as a LOCAL time then serialized, so the assertion holds in any timezone.
  const at = (h) => ({ date: new Date(2026, 6, 1, h, 30).toISOString() });
  const counts = hourCounts([at(14), at(14), at(3)]);
  expect(counts).toHaveLength(24);
  expect(counts[14]).toBe(2);
  expect(counts[3]).toBe(1);
  expect(counts[0]).toBe(0);
});

test('activityStats exposes byHour and a peak hour, null when there is nothing', () => {
  const rows = [{ date: new Date(2026, 6, 1, 21, 0).toISOString() }];
  expect(activityStats(rows, []).peakHour).toBe(21);
  expect(activityStats([], []).peakHour).toBe(null);
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd communityhunts-frontend && CI=true npx react-scripts test --testPathPattern="userStatsDerive" --watchAll=false`
Expected: FAIL — `pickType is not a function`.

- [ ] **Step 4: Implement the helpers**

In `communityhunts-frontend/src/stats/userStats/userStatsDerive.js`, add after the existing `ROLES` export:

```js
// The PUBLIC hunt categories, in toggle order. Mirrors PUBLIC_HUNT_CATEGORIES in the backend's
// lib/hunts-core.js. Community leads because it is by far the most common.
export const TYPES = [
  { key: 'all', label: 'All' },
  { key: 'community', label: 'Community' },
  { key: 'solo', label: 'Solo' },
  { key: 'vip', label: 'VIP' },
  { key: 'affiliate', label: 'Affiliate' },
  { key: 'streamer', label: 'Streamer' },
];

// Pick the type sub-tree; sliceOf then reads a role slice out of whatever this returns, so the two
// axes compose as sliceOf(pickType(stats, type), role).
//
// The two non-obvious returns are deliberate:
//   - no `byType` at all  -> the backend predates this field. Degrade to the combined stats so a
//     frontend deployed ahead of the backend shows today's panel rather than a blank one.
//   - `byType` but no key -> the user genuinely has no hunts of that type. Return null (an empty
//     slice) — falling back to the combined stats would show every hunt under the wrong label.
export function pickType(stats, type) {
  if (!stats || !type || type === 'all') return stats || null;
  if (!stats.byType) return stats;
  return stats.byType[type] || null;
}

// Which type buttons to offer: only categories this user actually has, in TYPES order. Below two
// categories the toggle can only ever be a no-op, so it isn't rendered at all.
export function typesPresent(stats) {
  const have = stats && stats.byType ? Object.keys(stats.byType) : [];
  if (have.length < 2) return [];
  return TYPES.filter(t => t.key === 'all' || have.includes(t.key));
}

// pastHunts rows carry the DERIVED category (backend userStatsSlice), not the raw huntType flag.
export function huntsForType(rows, type) {
  if (!type || type === 'all') return rows || [];
  return (rows || []).filter(r => r.huntType === type);
}
```

Then add `hourCounts` next to `weekdayCounts`:

```js
// Hour-of-day histogram in the VIEWER's local timezone, 0..23. Same reasoning as weekdayCounts:
// a server-computed bucket would bake one timezone into a cached row.
//
// NOTE the row date is when the hunt ENDED (archivedAt || updatedAt || createdAt || startedAt),
// so this reads as when they finish hunting. The card must label it that way.
export function hourCounts(pastHunts) {
  const counts = new Array(24).fill(0);
  for (const r of (pastHunts || [])) {
    const t = r && r.date ? new Date(r.date) : null;
    if (!t || isNaN(t.getTime())) continue;
    counts[t.getHours()]++;
  }
  return counts;
}
```

Finally extend `activityStats` — add these two lines after `const byWeekday = weekdayCounts(pastHunts);`:

```js
  const byHour = hourCounts(pastHunts);
  const hourPeak = byHour.reduce((bi, v, i, a) => (v > a[bi] ? i : bi), 0);
```

and add these two entries to its returned object, after `busiestWeekday`:

```js
    byHour,
    peakHour: byHour[hourPeak] > 0 ? hourPeak : null,
```

- [ ] **Step 5: Run the tests**

Run: `cd communityhunts-frontend && CI=true npx react-scripts test --testPathPattern="userStatsDerive" --watchAll=false`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/stats/userStats/userStatsDerive.js src/stats/userStats/userStatsDerive.test.js
git commit -m "feat(stats): type-selection and hour-of-day helpers

pickType composes with sliceOf so the two axes read as
sliceOf(pickType(stats, type), role). It degrades to the combined stats
when byType is absent, which is what lets the two repos deploy in any
order; a type the user has none of returns null instead, because falling
back would show every hunt under the wrong label."
```

---

## Task 6: The type toggle and its wiring

**Files:**
- Modify: `communityhunts-frontend/src/stats/userStats/primitives.js` (add `SegmentedToggle`)
- Modify: `communityhunts-frontend/src/stats/userStats/RoleToggle.js` (rewrite on the shared control)
- Create: `communityhunts-frontend/src/stats/userStats/TypeToggle.js`
- Modify: `communityhunts-frontend/src/stats/userStats/UserStatsPanel.js`
- Modify: `communityhunts-frontend/src/stats/MyStats.js`
- Modify: `communityhunts-frontend/src/admin/UserProfile.js`
- Modify: `communityhunts-frontend/src/admin/userProfile/ProfileCharts.js`
- Modify: `communityhunts-frontend/src/admin/userProfile/PastHunts.js`

**Interfaces:**
- Consumes: `pickType`, `typesPresent`, `huntsForType`, `TYPES` (Task 5).
- Produces:
  - `SegmentedToggle({ value, onChange, options, ariaLabel, counts })` in `primitives.js` — `options` is `[{ key, label }]`, `counts` an optional `{ [key]: number }`.
  - `TypeToggle({ stats, type, onType })` — renders nothing when `typesPresent(stats)` is empty.
  - `UserStatsPanel({ stats, role, onRole, type, onType })`.
  - `ProfileCharts({ stats, role, onRole, type, onType, tilesOnly, chartsOnly })`.
  - `PastHunts({ hunts, role, type, onCorrect, onDelete })`.

- [ ] **Step 1: Add the shared segmented control**

Append to `communityhunts-frontend/src/stats/userStats/primitives.js`:

```js
// The segmented switch behind both the role and the type filter rows. One control so the two rows
// cannot drift visually — they sit directly above/below each other.
export function SegmentedToggle({ value, onChange, options, ariaLabel, counts }) {
  const C = useTheme();
  return (
    <div role="tablist" aria-label={ariaLabel}
      style={{ display: 'inline-flex', padding: 3, gap: 3, background: C.bg,
        border: `1px solid ${C.bdr}`, borderRadius: C.rCtl }}>
      {options.map(o => {
        const on = value === o.key;
        const n = counts ? counts[o.key] : null;
        return (
          <button key={o.key} type="button" role="tab" aria-selected={on}
            onClick={() => onChange(o.key)}
            style={{ height: 28, padding: '0 12px', border: 'none', cursor: 'pointer',
              borderRadius: (C.rCtl || 8) - 2,
              background: on ? (C.accent || '#a78bfa') : 'transparent',
              color: on ? '#0a0710' : C.t3,
              fontFamily: C.body, fontSize: 12, fontWeight: on ? 800 : 600, whiteSpace: 'nowrap' }}>
            {o.label}
            {n != null && (
              <span style={{ marginLeft: 6, opacity: on ? 0.7 : 0.6, fontFamily: C.mono, fontWeight: 600 }}>{n}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}
```

- [ ] **Step 2: Rewrite `RoleToggle` on the shared control**

Replace the whole of `communityhunts-frontend/src/stats/userStats/RoleToggle.js` with:

```js
import React from 'react';
import { SegmentedToggle } from './primitives';
import { ROLES } from './userStatsDerive';

// All / Hosting / Joined switch. Drives the tiles, records, charts, group cards AND the past-hunts
// table from one piece of state, so the whole panel always describes the same set of hunts.
// Counts ride in the labels — knowing someone has hosted 2 and joined 40 is itself the answer to
// most "who is this" questions, before you click anything.
export default function RoleToggle({ role, onRole, counts }) {
  return <SegmentedToggle value={role} onChange={onRole} options={ROLES}
    ariaLabel="Hunt role" counts={counts} />;
}
```

- [ ] **Step 3: Create `TypeToggle`**

Create `communityhunts-frontend/src/stats/userStats/TypeToggle.js`:

```js
import React from 'react';
import { SegmentedToggle } from './primitives';
import { typesPresent } from './userStatsDerive';

// Solo / Community / VIP / Affiliate / Streamer switch — the second axis, sitting under the role
// row. Both feed one selection each, and every tile, record, chart, group card and table row
// below follows BOTH.
//
// Renders nothing at all when the user has fewer than two categories: a lone "Community" button
// next to "All" is a control that cannot do anything. That also covers a backend with no byType,
// which is what keeps this deployable ahead of the API.
export default function TypeToggle({ stats, type, onType }) {
  const options = typesPresent(stats);
  if (!options.length) return null;
  const counts = Object.fromEntries(options.map(o => [
    o.key,
    o.key === 'all' ? (stats.tiles?.hunts ?? 0) : (stats.byType[o.key]?.tiles?.hunts ?? 0),
  ]));
  return <SegmentedToggle value={type} onChange={onType} options={options}
    ariaLabel="Hunt type" counts={counts} />;
}
```

- [ ] **Step 4: Wire the player-facing panel**

Replace the body of `communityhunts-frontend/src/stats/userStats/UserStatsPanel.js` (keeping its header comment) with:

```js
import React from 'react';
import RoleToggle from './RoleToggle';
import TypeToggle from './TypeToggle';
import StatTiles from './StatTiles';
import RecordTiles from './RecordTiles';
import StatsCharts from './StatsCharts';
import SliceGroups from './SliceGroups';
import { SliceEmpty } from './primitives';
import { sliceOf, pickType, huntsForRole, huntsForType } from './userStatsDerive';

// Single-column composition of the whole per-user stats panel — used by the personal stats page.
//
// The admin profile does NOT use this: its layout splits the tiles across the top and the charts
// into the right-hand column of a two-column grid, so it composes the same pieces itself and owns
// the role + type state (the past-hunts table below it has to follow the same selection). Both
// read their slice through pickType + sliceOf, so the two surfaces can't disagree.
export default function UserStatsPanel({ stats, role, onRole, type, onType }) {
  const typed = pickType(stats, type);
  const slice = sliceOf(typed, role);
  const rows = huntsForType(huntsForRole(stats?.pastHunts, role), type);
  const t = typed?.tiles || {};

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        <RoleToggle role={role} onRole={onRole}
          counts={{ all: t.hunts ?? 0, host: t.hosted ?? 0, joined: t.joined ?? 0 }} />
        <TypeToggle stats={stats} type={type} onType={onType} />
      </div>

      {!slice || !slice.tiles?.hunts ? (
        <SliceEmpty>
          {role === 'host' ? 'No hunts run yet.'
            : role === 'joined' ? 'No hunts joined yet.'
              : 'No hunts yet.'}
          <div style={{ marginTop: 6, fontSize: 12, opacity: 0.8 }}>
            {role === 'host' ? 'Stats here cover hunts this account opened and ran.'
              : role === 'joined' ? "Stats here cover hunts run by someone else."
                : 'Run or join a hunt and it shows up here.'}
          </div>
        </SliceEmpty>
      ) : (
        <>
          <StatTiles slice={slice} role={role} />
          <RecordTiles slice={slice} />
          <SliceGroups stats={typed} slice={slice} role={role} rows={rows} />
          <StatsCharts slice={slice} />
        </>
      )}
    </div>
  );
}
```

> Note `SliceGroups` receives `typed`, not `stats` — it reaches into `stats.host.operator` and
> `stats.joined.player`, which must come from the selected type sub-tree.

- [ ] **Step 5: Give `MyStats` the type state**

In `communityhunts-frontend/src/stats/MyStats.js`, add the state next to `role` (line 23):

```js
  const [role, setRole] = React.useState('all');
  const [type, setType] = React.useState('all');
```

and pass it through at line 76:

```js
        {stats && <UserStatsPanel stats={stats} role={role} onRole={setRole}
          type={type} onType={setType} />}
```

- [ ] **Step 6: Wire the admin profile**

In `communityhunts-frontend/src/admin/UserProfile.js`:

**6a.** Update the import:

```js
import { huntsForRole, huntsForType } from '../stats/userStats/userStatsDerive';
```

**6b.** Add the state under the existing `role` state (line 26):

```js
  const [role, setRole] = React.useState('all');
  // Reset alongside `role` when the profile changes — a type the previous user had and this one
  // doesn't would otherwise leave the panel on an empty slice.
  const [type, setType] = React.useState('all');
```

**6c.** Reset it in the effect (line 29):

```js
    setU(null); setErr(''); setRole('all'); setType('all');
```

**6d.** Pass both axes down in the render:

```js
      <ProfileCharts stats={u.stats} role={role} onRole={setRole}
        type={type} onType={setType} tilesOnly />
      <div className="admin-profile-grid">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <AdminControls userId={u.id} rainbet={u.rainbetName || ''}
            twitch={u.twitchName || ''} grants={u.featureGrants || []}
            fullExtension={u.fullExtension} onField={onField} onGrant={onGrant} />
          {canBan && <BanControl userId={u.id} displayName={u.displayName} />}
          <CosmeticsPanel cosmetics={u.cosmetics} owned={u.cosmeticsOwned} onCosmetics={onCosmetics} />
          <SlotPicksAndCommunities slots={u.preferredSlots} communities={u.communities} />
        </div>
        <ProfileCharts stats={u.stats} role={role} type={type} chartsOnly />
      </div>
      <PastHunts hunts={huntsForType(huntsForRole(u.stats?.pastHunts, role), type)}
        role={role} type={type} onCorrect={onCorrectHunt} onDelete={onDeleteHunt} />
```

- [ ] **Step 7: Make `ProfileCharts` type-aware**

Replace the body of `communityhunts-frontend/src/admin/userProfile/ProfileCharts.js` below its
header comment with:

```js
import React from 'react';
import UserLink from '../UserLink';
import RoleToggle from '../../stats/userStats/RoleToggle';
import TypeToggle from '../../stats/userStats/TypeToggle';
import StatTiles from '../../stats/userStats/StatTiles';
import RecordTiles from '../../stats/userStats/RecordTiles';
import StatsCharts from '../../stats/userStats/StatsCharts';
import SliceGroups from '../../stats/userStats/SliceGroups';
import { SliceEmpty } from '../../stats/userStats/primitives';
import { sliceOf, pickType, huntsForRole, huntsForType } from '../../stats/userStats/userStatsDerive';

export default function ProfileCharts({ stats, role = 'all', onRole, type = 'all', onType, tilesOnly, chartsOnly }) {
  const typed = pickType(stats, type);
  const slice = sliceOf(typed, role);
  const rows = huntsForType(huntsForRole(stats?.pastHunts, role), type);
  const t = typed?.tiles || {};
  const empty = !slice || !slice.tiles?.hunts;

  if (tilesOnly) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {onRole && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            <RoleToggle role={role} onRole={onRole}
              counts={{ all: t.hunts ?? 0, host: t.hosted ?? 0, joined: t.joined ?? 0 }} />
            {onType && <TypeToggle stats={stats} type={type} onType={onType} />}
          </div>
        )}
        {empty
          ? <SliceEmpty>{role === 'host' ? 'This user has never run a hunt.'
            : role === 'joined' ? "This user has never joined someone else's hunt."
              : 'No hunts recorded for this user.'}</SliceEmpty>
          : <StatTiles slice={slice} role={role} />}
      </div>
    );
  }

  // chartsOnly (default)
  if (empty) return null;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <RecordTiles slice={slice} />
      {/* Host names in "Hunts with" become links into that user's own admin profile —
          UserLink is the single hook for any username surface in the panel. */}
      <SliceGroups stats={typed} slice={slice} role={role} rows={rows} UserLinkFor={UserLink} />
      <StatsCharts slice={slice} />
    </div>
  );
}
```

- [ ] **Step 8: Label the past-hunts table with both axes**

In `communityhunts-frontend/src/admin/userProfile/PastHunts.js`, replace the two label constants
(lines 14-15) and the component signature (line 17):

```js
const ROLE_TITLE = { host: 'HUNTS RUN', joined: 'HUNTS JOINED' };
const ROLE_EMPTY = { host: 'No hunts run', joined: 'No hunts joined' };
const TYPE_LABEL = { community: 'Community', solo: 'Solo', vip: 'VIP', affiliate: 'Affiliate', streamer: 'Streamer' };

export default function PastHunts({ hunts, role = 'all', type = 'all', onCorrect, onDelete }) {
```

Then replace the heading and the empty line so both say which set this is — the caller has already
filtered `hunts` to match, so a bare "No hunts yet" would read as "this user has none at all":

```js
      <div style={{ color: C.t2, fontFamily: C.display, fontWeight: 700, fontSize: 13, letterSpacing: '0.02em', marginBottom: 10 }}>
        {ROLE_TITLE[role] || 'PAST HUNTS'}
        {TYPE_LABEL[type] && <span style={{ color: C.t4, fontWeight: 600 }}> · {TYPE_LABEL[type].toUpperCase()}</span>}
      </div>
      {rows.length === 0
        ? <div style={{ color: C.t4, fontFamily: C.mono || C.body, fontSize: 13, padding: '1.5rem', textAlign: 'center' }}>
            {ROLE_EMPTY[role] || 'No hunts yet'}{TYPE_LABEL[type] ? ` · ${TYPE_LABEL[type].toLowerCase()}` : ''}
          </div>
```

- [ ] **Step 9: Verify the build and the suite**

Run: `cd communityhunts-frontend && CI=true npm run build`
Expected: "Compiled successfully".

Run: `cd communityhunts-frontend && CI=true npm test -- --watchAll=false`
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add src/stats/userStats/primitives.js src/stats/userStats/RoleToggle.js \
        src/stats/userStats/TypeToggle.js src/stats/userStats/UserStatsPanel.js \
        src/stats/MyStats.js src/admin/UserProfile.js \
        src/admin/userProfile/ProfileCharts.js src/admin/userProfile/PastHunts.js
git commit -m "feat(stats): hunt-type filter row on both stats surfaces

Second axis under the existing role switch; every tile, record, chart,
group card and table row follows both. RoleToggle and the new TypeToggle
share one SegmentedToggle so the two rows cannot drift visually.

The row renders only when the user has two or more categories, which also
covers a backend with no byType yet."
```

---

## Task 7: Currency breakdown card

**Files:**
- Create: `communityhunts-frontend/src/stats/userStats/CurrencyCard.js`
- Modify: `communityhunts-frontend/src/stats/userStats/SliceGroups.js`

**Interfaces:**
- Consumes: `slice.byCurrency` — `{ [code]: { hunts, wagered, won, net, avgStart, invested, returned, roi } }` — and `slice.usd.unconvertedCount`. Both already exist on every slice; no backend work.
- Produces: `CurrencyCard({ slice })` — renders nothing when the user has fewer than two currencies and nothing unconverted.

- [ ] **Step 1: Create the card**

Create `communityhunts-frontend/src/stats/userStats/CurrencyCard.js`:

```js
import React from 'react';
import { useTheme } from '../../theme/ThemeContext';
import { ChartCard, RankList, StatLine, StatLines, compact, pct } from './primitives';

// Per-currency breakdown. Every other figure in this panel is USD-normalized at each hunt's own
// rate, which is right for totals and hides one thing worth seeing: which currencies this person
// actually hunts in. A row in an unexpected currency is also how a mis-tagged hunt shows itself,
// before it skews a site-wide total.
//
// Suppressed for the common case — a single currency and nothing unconverted is exactly what the
// USD tiles already say, so the card would be noise.
export default function CurrencyCard({ slice }) {
  const C = useTheme();
  const green = C.green || '#b6ff2e', red = C.red || '#ff6b6b';
  const by = (slice && slice.byCurrency) || {};
  const unconverted = (slice && slice.usd && slice.usd.unconvertedCount) || 0;

  const rows = Object.entries(by)
    .map(([code, c]) => ({ code, ...c }))
    .sort((a, b) => b.hunts - a.hunts || a.code.localeCompare(b.code));

  if (rows.length < 2 && !unconverted) return null;

  // Money here is NATIVE, not USD — that is the whole point of the card, so it is never passed
  // through `compact` (which prefixes a $).
  const native = (v) => `${Math.round(+v || 0).toLocaleString()}`;

  return (
    <ChartCard title="By currency" note="Native amounts, as stored — every other figure on this page is converted to USD">
      <RankList
        rows={rows.map(r => ({
          key: r.code,
          name: <span><strong>{r.code}</strong> <span style={{ opacity: 0.7 }}>· {r.hunts} hunt{r.hunts === 1 ? '' : 's'}</span></span>,
          sub: `${native(r.net)} net · ${pct(r.roi, { sign: true })}`,
          color: r.net > 0 ? green : (r.net < 0 ? red : undefined),
        }))}
        empty="No hunts recorded yet." />

      {unconverted > 0 && (
        <div style={{ marginTop: 12, paddingTop: 10, borderTop: `1px solid ${C.bdr}` }}>
          <StatLines>
            <StatLine label="Left out of USD totals" value={`${unconverted} hunt${unconverted === 1 ? '' : 's'}`}
              color={C.t2}
              hint="No exchange rate on record for these, so they are excluded from every USD figure rather than summed at face value" />
            <StatLine label="USD net (converted only)" value={compact(slice?.usd?.net)}
              color={(slice?.usd?.net || 0) > 0 ? green : ((slice?.usd?.net || 0) < 0 ? red : undefined)} />
          </StatLines>
        </div>
      )}
    </ChartCard>
  );
}
```

- [ ] **Step 2: Render it in `SliceGroups`**

In `communityhunts-frontend/src/stats/userStats/SliceGroups.js`, add the import:

```js
import CurrencyCard from './CurrencyCard';
```

Add the presence check alongside the others:

```js
  const hasCalling = !!(calling && calling.calls);
  const hasActivity = !!(rows && rows.length);
  // The card self-suppresses on a single currency with nothing unconverted; mirror that condition
  // here so the auto-fit grid doesn't reserve a track for a component that renders nothing.
  const byCur = slice?.byCurrency || {};
  const hasCurrency = Object.keys(byCur).length > 1 || (slice?.usd?.unconvertedCount || 0) > 0;
  if (!hasOperator && !hasPlayer && !hasCalling && !hasActivity && !hasCurrency) return null;
```

And render it as the last card:

```js
      {hasActivity && <ActivityCard rows={rows} activity={slice?.activity} />}
      {hasCurrency && <CurrencyCard slice={slice} />}
```

- [ ] **Step 3: Verify the build**

Run: `cd communityhunts-frontend && CI=true npm run build`
Expected: "Compiled successfully".

- [ ] **Step 4: Commit**

```bash
git add src/stats/userStats/CurrencyCard.js src/stats/userStats/SliceGroups.js
git commit -m "feat(stats): per-currency breakdown card

byCurrency has been computed on every slice since the role split and
rendered nowhere. Shows native amounts (the one place on this page that
isn't USD-normalized) plus the unconverted-hunt count, which is how a
mis-tagged hunt surfaces before it skews a site-wide total.

Suppressed on a single currency with nothing unconverted — that case is
exactly what the USD tiles already say."
```

---

## Task 8: Surface the new numbers — members, hours, bets, vault

**Files:**
- Modify: `communityhunts-frontend/src/stats/userStats/HostOperatorCard.js`
- Modify: `communityhunts-frontend/src/stats/userStats/ActivityCard.js`
- Modify: `communityhunts-frontend/src/stats/userStats/StatTiles.js`
- Modify: `communityhunts-frontend/src/stats/userStats/RecordTiles.js`
- Modify: `communityhunts-frontend/src/stats/userStats/SliceGroups.js` (one line — pass `UserLinkFor` through, Step 1d)

**Interfaces:**
- Consumes: `operator.topMembers` / `operator.anonymousMembers` (Task 3), `tiles.avgBet` / `records.biggestBet` / `usd.vault` / `usd.vaultHunts` (Task 2), `activityStats().byHour` / `.peakHour` (Task 5).
- Produces: no new exports. `HostOperatorCard` gains a `UserLinkFor` prop, matching `JoinedPlayerCard`'s existing signature.

- [ ] **Step 1: Add the member list to `HostOperatorCard`**

In `communityhunts-frontend/src/stats/userStats/HostOperatorCard.js`:

**1a.** Extend the import and the signature:

```js
import { ChartCard, RankList, StatLine, StatLines, compact, pct, fmtCount, fmtDuration } from './primitives';
```

```js
export default function HostOperatorCard({ operator, UserLinkFor }) {
```

**1b.** Build the rows next to the existing `types` list:

```js
  const types = Object.entries(o.typeMix || {})
    .sort((a, b) => b[1] - a[1]);

  // Mirror of JoinedPlayerCard's "Hunts with", pointed the other way. UserLinkFor is injected by
  // the caller so admin gets clickable names and the player page renders plain text.
  const members = (o.topMembers || []).slice(0, 5).map(m => ({
    key: m.userId,
    name: UserLinkFor
      ? <UserLinkFor userId={m.userId}>{m.name || m.userId}</UserLinkFor>
      : (m.name || m.userId),
    sub: `${m.hunts} hunt${m.hunts === 1 ? '' : 's'} · ${compact(m.net)}`,
    color: m.net > 0 ? green : (m.net < 0 ? red : undefined),
  }));
  const anon = o.anonymousMembers || 0;
```

**1c.** Render the block immediately before the existing "Hunt types run" block:

```js
      {(members.length > 0 || anon > 0) && (
        <div style={{ marginTop: 12, paddingTop: 10, borderTop: `1px solid ${C.bdr}` }}>
          <div style={{ color: C.t4, fontFamily: C.body, fontSize: 11, marginBottom: 6 }}>Who joins their hunts</div>
          <RankList rows={members} empty="No named members yet." />
          {anon > 0 && (
            <div style={{ color: C.t4, fontFamily: C.body, fontSize: 11, marginTop: 8 }}
              title="Members who hunt anonymously. They count toward every total on this card, but are never named — on this page or any other.">
              + {anon} anonymous
            </div>
          )}
        </div>
      )}
```

**1d.** Pass the link factory through in `SliceGroups.js`, which already receives it:

```js
      {hasOperator && <HostOperatorCard operator={operator} UserLinkFor={UserLinkFor} />}
```

- [ ] **Step 2: Add the hour bars to `ActivityCard`**

In `communityhunts-frontend/src/stats/userStats/ActivityCard.js`:

**2a.** Add a peak-hour line to the existing `StatLines` block, right after "Busiest day":

```js
        <StatLine label="Busiest day" value={a.busiestWeekday || '—'} />
        <StatLine label="Busiest hour" value={a.peakHour == null ? '—' : fmtHour(a.peakHour)}
          hint="Hunts are stamped when they END, so this is when they finish, not when they start" />
```

**2b.** Add the formatter above the component:

```js
// 0..23 -> 12am / 1pm. Local to the viewer, same as the buckets themselves.
const fmtHour = (h) => `${h % 12 === 0 ? 12 : h % 12}${h < 12 ? 'am' : 'pm'}`;
```

**2c.** Add the bar scale next to the existing `peak` const (the bar row in 2d reads it):

```js
  const peak = Math.max(...a.byWeekday, 1);
  const hourPeak = Math.max(...a.byHour, 1);
```

**2d.** Add the bar row after the existing "Hunts by weekday" block, inside the same card:

```js
      <div style={{ marginTop: 12, paddingTop: 10, borderTop: `1px solid ${C.bdr}` }}>
        <div style={{ color: C.t4, fontFamily: C.body, fontSize: 11, marginBottom: 8 }}>When hunts finish (your time)</div>
        <div style={{ display: 'flex', alignItems: 'flex-end', gap: 2, height: 48 }}>
          {a.byHour.map((n, h) => (
            <div key={h} title={`${fmtHour(h)}: ${n}`}
              style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}>
              <div style={{ width: '100%', height: `${Math.round((n / hourPeak) * 34)}px`, minHeight: n ? 2 : 1,
                background: n ? (C.accent || '#a78bfa') : C.bdr, borderRadius: 1 }} />
              {h % 6 === 0 && <span style={{ color: C.t4, fontFamily: C.body, fontSize: 8 }}>{fmtHour(h)}</span>}
            </div>
          ))}
        </div>
      </div>
```

- [ ] **Step 3: Add avg bet and vault to `StatTiles`**

In `communityhunts-frontend/src/stats/userStats/StatTiles.js`, insert two tiles after the "Avg mult"
tile:

```js
      <Tile label="Avg mult" value={`${(t.avgMult || 0).toFixed(1)}×`} />
      <Tile label="Avg bet" value={compact(t.avgBet)} />
      {(u.vault || 0) > 0 && (
        <Tile label="Vault" value={compact(u.vault)}
          hint={`Base-game wins across ${u.vaultHunts} hunt${u.vaultHunts === 1 ? '' : 's'}. Counted in winnings, never as a multiplier.`} />
      )}
```

- [ ] **Step 4: Add biggest bet to `RecordTiles`**

In `communityhunts-frontend/src/stats/userStats/RecordTiles.js`, insert one tile after "Highest mult":

```js
        <Tile label="Highest mult" value={`${(r.highestMult || 0).toFixed(1)}×`} />
        <Tile label="Biggest bet" value={compact(r.biggestBet)} />
```

- [ ] **Step 5: Verify the build and the suite**

Run: `cd communityhunts-frontend && CI=true npm run build`
Expected: "Compiled successfully".

Run: `cd communityhunts-frontend && CI=true npm test -- --watchAll=false`
Expected: PASS.

- [ ] **Step 6: Commit and push**

```bash
git add src/stats/userStats/HostOperatorCard.js src/stats/userStats/ActivityCard.js \
        src/stats/userStats/StatTiles.js src/stats/userStats/RecordTiles.js \
        src/stats/userStats/SliceGroups.js
git commit -m "feat(stats): surface members, hours, bet size and vault

Who joins a host's hunts (with the anonymous count beside it), an
hour-of-day row under the weekday bars, and the three money figures that
were computed and never displayed.

The hour row is labelled 'when hunts finish' rather than 'when they play'
— the row date is archivedAt, not startedAt."
```

```bash
git push -u origin feat/user-stats-hunt-type-split
```

Then open the PR against `main`.

---

## Task 9: Warm the cached rollups after deploy

**Files:**
- Run only: `communityhunts-backend/scripts/recompute-all-user-stats.js`

**Interfaces:**
- Consumes: `STATS_VERSION = 3` (Task 4).

- [ ] **Step 1: Confirm the script is safe to run as-is**

Read `communityhunts-backend/scripts/recompute-all-user-stats.js` and confirm it iterates every
`(tenant_id, user_id)` in `user_hunt_stats` and calls `recomputeUser`. It is idempotent — it
rewrites rows from `hunt_history`, which this change does not touch.

- [ ] **Step 2: Run it against production once the backend PR is merged and deployed**

```bash
railway run node scripts/recompute-all-user-stats.js
```

Expected: one line per user, no errors. Without this, each profile still heals itself lazily on
first view (`getUserStats` recomputes on a version mismatch) — this just moves the cost off the
first admin click.

- [ ] **Step 3: Spot-check a profile in production**

Open `/admin` → Users → a user known to have both solo and community hunts. Confirm:
- the Type row appears under the role row with real counts
- switching to Solo changes the tiles, records, charts, group cards **and** the past-hunts table
- the past-hunts table's type column is populated on every row (no `—`)
- Avg bet / Biggest bet render; Vault appears only for users who have one
- "Who joins their hunts" lists names, and anonymous members show as a count

---

## Self-Review

**Spec coverage:**

| Spec section | Task |
|---|---|
| §1 derived category (`perHunt.category`, `pastHunts[].huntType`) | 1 |
| §2 `byType` shape, `pastHunts` carried once | 4 |
| §3 blob growth, nested caps (`TYPE_LIST_CAP` 10, `TYPE_GROUP_CAP` 5) | 3 (cap plumbing), 4 (values) |
| §4 `topMembers` + `anonymousMembers`, masking traps | 3 |
| §5 bet size + vault | 2 |
| §6 currency breakdown | 7 |
| §7 time of day | 5 (helper), 8 (render) |
| §8 frontend wiring, graceful degradation | 5, 6 |
| §9 `STATS_VERSION` 2→3, recompute script | 4, 9 |

**Type consistency check:** `pickType` / `typesPresent` / `huntsForType` / `hourCounts` are defined
in Task 5 and used with those exact names in Tasks 6 and 8. `hostOperator(details, { cap })` and
`joinedPlayer(details, { cap })` are defined in Task 3 and called with `{ cap: groupCap }` in Task 4.
`SegmentedToggle({ value, onChange, options, ariaLabel, counts })` is defined in Task 6 Step 1 and
consumed by both toggles in Steps 2-3. `UserLinkFor` matches `JoinedPlayerCard`'s existing prop name.
`operator.topMembers[].{ userId, name, hunts, invested, returned, net }` matches between Task 3's
implementation, its test, and Task 8's renderer.

**Ordering:** Tasks 1-4 (backend) are strictly sequential — 2 and 3 both depend on 1, and 4 depends
on 2 and 3. Tasks 5-8 (frontend) are sequential after 5. The frontend needs no backend deploy to
build or test, because `pickType` degrades and every new field reads through `|| 0` / `|| []`.
