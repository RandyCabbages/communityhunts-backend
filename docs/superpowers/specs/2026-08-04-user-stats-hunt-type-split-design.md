# Per-user stats: hunt-type split + four new stat groups

**Date:** 2026-08-04
**Repos:** `communityhunts-backend`, `communityhunts-frontend`
**Branch (both):** `feat/user-stats-hunt-type-split`

Successor to `2026-08-01-user-stats-host-joined-split-design.md`, which added the All / Hosting /
Joined axis. This adds a second, orthogonal axis — hunt **type** — and four new data groups.

## Problem

The per-user stats panel slices hunts exactly one way: by **role** (All / Hosting / Joined). There is
no way to ask the question Kyle actually has — *how does this person do on solo hunts versus
community hunts?* A user who grinds solo profitably and bleeds in community hunts reads as one
blended line, which is the same failure the host/joined split was built to fix, one axis over.

The data to answer it is already in the pipeline and thrown away. `hostOperator` computes a
`typeMix` (`lib/userStatsGroups.js:51`) using the correct derived category — but it is **counts
only, host slice only**, and nothing else in the panel is type-aware.

### The type column on the past-hunts table is wrong today

`lib/userStatsSlice.js:98` stamps each row with `huntType: h.huntType || null` — the **raw internal
behaviour flag**, not the public category. Two consequences visible in production right now:

- Hunts that never set the flag (offline, legacy, and every hunt created before it was written)
  render as `—` in the table's type column.
- The three shared hunts are identified by their **key**, not by `huntType`, so a Tenant, Affiliate
  or VIP hunt is mislabelled or blank rather than showing its real category.

`huntCategoryOf(h)` (`lib/hunts-core.js:229`) is the correct source and is **derived, never stored**,
so it labels the entire archive retroactively with no migration. Fixing the row is both a visible
bug fix and the enabler for the client-side table filter.

### Data that is recorded and never surfaced

- `byCurrency` is computed on every slice and rendered nowhere.
- Vault (base-game wins) is folded into `hnWinnings` (`lib/userStatsHunt.js:69`) and never reported
  on its own, so a big vault run is indistinguishable from a big bonus run.
- Bet sizing — the per-bonus `bet` field is summed for totals but yields no avg or max.
- The host side has `uniqueParticipants` as a bare **count**. The joined side gets `topHosts` with
  names; there is no mirror image telling you *who turns up to this person's hunts*.

## Scope

Confirmed with Kyle 2026-08-04:

- Type slicing UI: a **second filter row** under the existing role toggle. Every tile, record, chart,
  group card and table row responds to **both** switches.
- All four new data groups: who joins their hunts, currency breakdown, bet size + vault, time of day.
- Both the admin profile **and** the player-facing `/tracker/stats` page.
- Anonymous equity members are **counted but never named** (see §4).

Non-goals: cross-user leaderboards, the tenant-wide `getHuntStats` pipeline
(`/api/admin/hunt-stats`), the archive blob, any schema change.

## Design

### 1. One vocabulary for hunt type — the derived category

The panel's type axis is `huntCategoryOf(h)`, whose five values are already the published contract
(`PUBLIC_HUNT_CATEGORIES`, `lib/hunts-core.js:228`):

`solo` · `community` · `vip` · `affiliate` · `streamer`

Two changes make it usable:

- `lib/userStatsHunt.js` — `perHunt` returns `category: huntCategoryOf(h)` alongside the numbers it
  already derives, so every consumer reads one computed value rather than re-deriving it.
- `lib/userStatsSlice.js:98` — the `pastHunts` row's `huntType` becomes `d.category`.

**This changes what an existing field means** (raw flag → derived category). It is safe: `pastHunts`
is consumed only by the two frontends. It is **not** on the Developer API — `lib/publicSerializers.js`
builds its own `huntType` straight from `huntCategoryOf` and never reads this blob.

> Ordering trap, already handled inside `huntCategoryOf` and not to be "simplified": a shared hunt
> matches both its key branch and the `huntType` branch, so the key checks must come first.

### 2. Shape — type nests under the existing slice tree

```
{
  v: 3,
  ...allSlice,              // combined, spread at top level — unchanged, back-compat
  calling, host: {…}, joined: {…},
  pastHunts: [ … ],         // ONCE. Rows carry `role` AND the derived `huntType`
  byType: {
    solo:      { ...slice, calling, host: { …operator }, joined: { …player } },
    community: { … },
    //  ↑ only categories with at least one hunt
  }
}
```

Each `byType[cat]` is the **same three-role structure** produced by the same code over a filtered
input, so a type slice and the combined slice cannot disagree. Extract the current body of
`computeUserHuntStats` into `slicesFor(details, names, opts)` and call it once for the whole set and
once per non-empty category.

`byType` sub-trees carry **no `pastHunts`** — the single array at top level already has `role` and
`huntType` on every row, so the table filters in the browser. Repeating it per type is the one thing
that would genuinely blow up the row.

Selection on the frontend composes cleanly with what exists:

```js
sliceOf(pickType(stats, type), role)   // pickType returns `stats` itself for type === 'all'
```

### 3. Blob growth and the caps

Nested type slices **partition** their parent, so `tiles` / `activity` / `profit` / `multHistogram` /
`records` / `byCurrency` / `usd` across all types sum to roughly the parent's size plus per-slice
fixed overhead. Total ≈ **2×** the current row.

The parts that do *not* partition are the capped top-N lists — five type slices could each carry a
full 25. Inside `byType`, therefore:

- `bySlot` / `byCaller` → `listCap: 10`
- `topHosts` / `topMembers` → cap 5

Top-level slices keep their current caps — `LIST_CAP` 25 for `bySlot` / `byCaller`, `TOP_HOSTS_CAP`
10 for `topHosts`, and the new `topMembers` joins that 10.

### 4. New group — who joins their hunts (`host.operator.topMembers`)

The mirror of `joined.player.topHosts`, pointed the other way.

| field | meaning |
|---|---|
| `topMembers` | `[{ userId, name, hunts, invested, returned, net }]`, sorted by `hunts` desc then `net` desc, capped |
| `anonymousMembers` | count of distinct masked members, named nowhere |

Per member, read off the ledger entry the loop already resolves — `invested` = `selfInvested`,
`returned` = `finalPayout`, `net` = `plNet`, each × the hunt's FX rate and accumulated only where a
rate exists. `name` is the equity row's `name`, `hunts` counts every hunt they appear in regardless
of rate.

Computed inside the loop `hostOperator` **already runs** for `paidOutToMembers`
(`lib/userStatsGroups.js:31-37`) — no second pass over the equity rows.

Two identity rules, both already established in this pipeline:

- **Person identity is `eqUserId(e)` (the Discord id); `e.id` is a per-row UUID and must never be
  used for attribution.** The ledger, however, *is* keyed by `e.id` — so the aggregation key and the
  `ledger.members[…]` lookup key are deliberately different. This is exactly what the existing
  `paidOutToMembers` loop does.
- `isRealUserId` filters out `creator_auto` / `bean_auto` / UUID rows, so seed placeholders never
  become "people". Same rule as `uniqueParticipants`.

**Anonymity.** The stats blob is cached once and served to both the admin page (`GET
/api/admin/users/:userId`) and the player's own page (`GET /api/my-stats`). A cached row cannot be
viewer-dependent, and shipping real names to a player's browser to hide them in the UI is not
hiding them. So masking happens at **compute** time: a member for whom `isIdentityMasked(discordId,
name)` is true is excluded from `topMembers` entirely and counted in `anonymousMembers`. They still
count toward `uniqueParticipants` and every money total.

This mirrors what `huntSummary` already does for archived equity
(`lib/hunts-core.js:148`). Admins lose the name **on this card only** — the hunt itself is still
one click away.

> **Two traps in the masking call.**
> 1. Call the exported **`isIdentityMasked(discordId, name)` wrapper**. Never import
>    `shouldMaskIdentity` — it is a rebindable module-level `let`, so importing the binding captures
>    the privacy-safe default at require time and never sees `initHuntsCore`'s real predicate. The
>    wrapper exists for precisely this reason (`lib/hunts-core.js:548-552`).
> 2. That default **masks nothing**, and `initHuntsCore` is not called in unit tests. A test for the
>    masking path must arm it explicitly — `initHuntsCore({ …, shouldMaskIdentity })`
>    (`lib/hunts-core.js:37`) — or it passes while testing nothing.

### 5. New group — bet size + vault

`sumVault(h)` is already called inside `perHunt` to build `hnWinnings`. Lift it to a named value on
the per-hunt detail (`vault`) rather than computing it twice.

In `aggregate`, inside the bonus loop that already runs, tracked **only for hunts carrying an FX
rate** — identical treatment to `biggestWin`, so an unconverted hunt is never summed at face value:

| field | meaning |
|---|---|
| `tiles.avgBet` | Σ bet ÷ bonus count, USD — both sides counting **only** bonuses in rate-carrying hunts |
| `records.biggestBet` | largest single bet, USD |
| `usd.vault` | total base-game wins, USD |
| `usd.vaultHunts` | hunts with a vault entry (rate-carrying only, so it matches `usd.vault`) |

### 6. Currency breakdown — frontend only

`slice.byCurrency` already carries `{ hunts, wagered, won, net, avgStart, invested, returned, roi }`
per code, and `slice.usd.unconvertedCount` is already displayed as a tile. New `CurrencyCard.js`
renders one row per currency plus the unconverted callout. **No backend work.**

Its second job is operational: a hunt tagged with the wrong currency shows up here as an
out-of-place row, which is how you catch it before it skews site-wide totals — the same failure mode
as the `?type=` URL bug that ran the homepage total 4.4× high.

### 7. Time of day — frontend only

`userStatsDerive.js` gains `hourCounts(pastHunts)` → 24 buckets in the **viewer's** local timezone,
and `activityStats` gains `byHour` + `peakHour`. Rendered as a second bar row inside `ActivityCard`.

Timezone reasoning is the existing one, unchanged: a server-computed hour bucket would bake one zone
into a **cached** row and be wrong for everyone outside it (`userStatsDerive.js:3-7`).

**Labelled honestly.** `pastHunts[].date` is `archivedAt || updatedAt || createdAt || startedAt`
(`lib/userStatsHunt.js:107`) — that is when the hunt **ended**. The card says "when hunts finish",
not "when they play".

### 8. Frontend wiring

New files, one component per file per the repo's no-god-files rule:

- `src/stats/userStats/TypeToggle.js` — the second filter row
- `src/stats/userStats/CurrencyCard.js` — §6

Extended in place (all well under the ~400-line extract threshold):

- `userStatsDerive.js` — `TYPES` vocabulary, `pickType(stats, type)`, `huntsForType(rows, type)`,
  `hourCounts`, and `activityStats` gaining `byHour` / `peakHour`
- `HostOperatorCard.js` — `topMembers` RankList + the anonymous count, mirroring
  `JoinedPlayerCard`'s "Hunts with" (including the same `UserLinkFor` injection, so admin gets
  clickable names and the player page renders plain text)
- `ActivityCard.js` — hour bars
- `StatTiles.js` — Avg bet, Vault · `RecordTiles.js` — Biggest bet
- `SliceGroups.js` — renders `CurrencyCard`
- `UserStatsPanel.js` (player) and `UserProfile.js` (admin) each own the `type` state alongside the
  `role` state they already own, and pass both down

**Graceful degradation, so the two repos deploy independently.** `pickType` returns the parent slice
when `byType` is absent or lacks the key, and `TypeToggle` renders only when `stats.byType` has ≥2
keys. A new frontend against an old backend shows exactly today's panel; an old frontend against a
new backend ignores the extra field. **No lockstep deploy, either order is safe.**

The type row also only offers categories the user actually has, so a normal member never sees a dead
"Affiliate 0" button.

### 9. The stale-cache trigger

`stats` is cached as JSONB in `user_hunt_stats` and `getUserStats` recomputes only on a version
mismatch (`lib/statsStore.js:364`). Bump `STATS_VERSION` **2 → 3** (`lib/userStats.js:22`). Each
profile then recalculates once, lazily, on first view — the same path v1 → v2 took.

`scripts/recompute-all-user-stats.js` exists and is idempotent; run it after deploy to warm the rows
rather than paying the recompute on first admin click.

`getUserStatsAllTenants` computes fresh on every miss and has no version gate, so it needs nothing.

## Risks

- **`pastHunts[].huntType` changes meaning** (raw flag → derived category). Internal only; not on the
  Developer API. Visible effect is a fix: blanks become real labels and shared hunts stop
  being mislabelled.
- **Masking is inert in unit tests** until `initHuntsCore` is armed — see the trap box in §4. A test
  that forgets this passes while asserting nothing.
- **Blob growth ≈ 2×.** Mitigated by §2 (`pastHunts` carried once) and §3 (lower nested caps).
- **Vercel treats warnings as errors** — `CI=true npm run build` must print "Compiled successfully"
  before any frontend push.
- **Shared `main` on both repos, auto-deploying to production.** Branch + PR on each; §8's
  degradation means neither has to wait for the other.

## Verification

- Backend `npm test` (652 tests today), with new cases:
  - `lib/userStats.test.js` — `byType` present only for non-empty categories; a type slice's tiles
    equal the combined tiles when the user has exactly one category; `byType` sub-trees carry no
    `pastHunts`; version stamp is 3.
  - `lib/userStats.test.js` — `pastHunts[].huntType` is the derived category: a hunt with no
    `huntType` flag reads `community`, and each of the three shared-hunt keys reads its own label.
  - `lib/userStatsGroups.test.js` (new) — `topMembers` attribution by `eqUserId` not `e.id`;
    placeholders excluded; masked members excluded from the list and counted in `anonymousMembers`,
    with `initHuntsCore` armed.
  - `lib/userStatsSlice.js` coverage — `avgBet` / `biggestBet` / `usd.vault` skip unconverted hunts.
- Frontend `npm test` + `CI=true npm run build`, with `userStatsDerive.test.js` extended for
  `pickType` (including the missing-`byType` fallback), `huntsForType`, and `hourCounts` bucketing.
- Live click-through happens **after merge**: the admin panel is behind Discord OAuth and Vercel
  preview URLs are not in `EXTRA_ORIGINS`, so a preview looks permanently signed out.
