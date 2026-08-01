# Per-user stats: host / joined split + four new stat groups

**Date:** 2026-08-01
**Repos:** `communityhunts-backend`, `communityhunts-frontend`
**Branch (both):** `feat/user-stats-host-joined`

## Problem

The admin user profile shows **one** stat line for a user. `computeUserHuntStats` walks every hunt
the user touched — hosted *or* joined — and merges them into a single `tiles` block. It already
computes `isOwner` per hunt (`lib/userStats.js:58`) and counts `hosted` / `joined`, then throws that
distinction away: every record, chart, currency total, top-slot list and streak is computed on the
merged pile.

A user who hosts profitably and loses money joining other people's hunts reads as "roughly even".
The panel cannot answer the question an admin actually has: *is this person good at running hunts,
or good at joining them?*

Separately, a lot of recorded data is never surfaced at all — equity shares, the gift ledger, chase
deposits, host identity on joined hunts, hunt duration, hunt type, completion state, and the caller
field on every bonus.

## Second problem, found during design

**`/tracker/stats` (the Pro-gated "My Stats" page) is broken in production.**
`src/stats/MyStats.js:27` fetches `GET /api/tracker/stats`. That endpoint does not exist — not in
`routes/tracker.routes.js`, not anywhere in the backend. Routers mount at root with no prefix, so
there is no path variant being missed. The page 404s and renders its error line.

This was recorded as a known follow-up in
`docs/superpowers/specs/2026-07-12-all-time-user-stats-design.md:45` and never picked up.

`GET /api/my-stats` already returns exactly the `computeUserHuntStats` blob and is currently used
only by the account-dropdown `StatsBox`. So repairing the page and upgrading it are the same job.

## Scope

Confirmed with Kyle 2026-08-01:

- Slicing UI: a **toggle — All / Host / Joined** — over one set of tiles and charts.
- All four new stat groups (host operator, joined player, calling record, activity & timing).
- Both the admin profile **and** the player-facing page.
- The player page reports **cross-community** totals, matching what its own header already claims.

Non-goals: cross-user leaderboards, changing the tenant-wide `getHuntStats` pipeline
(`/api/admin/hunt-stats`), touching the archive blob.

## Design

### 1. Slice the aggregation instead of duplicating it

Extract the per-hunt loop in `lib/userStats.js` into an inner `aggregate(hunts, id, opts)` that
returns the existing shape (tiles, activity, profit, multHistogram, records, byCurrency, usd,
bySlot, byCaller). Run it three times — over all hunts, host-only, joined-only.

Every existing metric becomes available per slice with no new math, so host and joined win rates,
streaks, records and profit curves cannot drift from the combined ones.

```
{
  v: 2,
  ...allSlice,              // top level stays the "all" slice — back-compat, see §5
  host:    { ...slice, operator: {…} },
  joined:  { ...slice, player: {…} },
  calling: {…},
  pastHunts: [ … ]          // computed ONCE, rows already carry `role`
}
```

`pastHunts` is **not** repeated per slice — each row carries `role: 'host' | 'member'`, so the table
filters client-side. This is the single biggest contributor to blob size.

### 2. New group — host operator (`host.operator`)

Only meaningful for hunts the user ran.

| field | meaning |
|---|---|
| `totalPot`, `avgPot` | starting balance they put up, USD-normalized |
| `avgPeople`, `uniqueParticipants` | how many people hunt with them |
| `paidOutToMembers` | total returned to non-host equity members |
| `avgSlots` | bonuses per hunt |
| `completionRate` | hunts where every bonus was opened ÷ hosted |
| `avgDurationMs` | `archivedAt − startedAt` |
| `typeMix` | `{ community, vip, affiliate, solo, tenant }` counts |
| `beatReqRate` | share of hunts where Got× ≥ Req× |

### 3. New group — joined player (`joined.player`)

| field | meaning |
|---|---|
| `avgSharePct` | their equity ÷ pot, averaged |
| `topHosts` | `[{ hostId, hostName, hunts, net, roi }]`, capped |
| `giftsGiven`, `giftsReceived` | from `computePostHunt` (`newMoneyGiven`, `totalEquity − selfInvested`) |
| `chaseDeposits` | `depositTotal` across joined hunts |

`computePostHunt` is already called per joined hunt for the gift-aware payout, so these are read off
a result the loop computes anyway.

### 4. New group — calling record (`calling`)

Bonuses whose `caller` matches one of the user's known names: total calls, staked, avg × returned,
best and worst call.

`computeUserHuntStats` gains an optional third argument `{ names: [] }`. `recomputeUser` supplies
display name + username (`known_users`) and rainbet + twitch handles (`user_settings`).

**Known limit:** `caller` is free text typed by the host. Matching is case-insensitive against known
handles. Good signal, not an audit trail — the UI must say so.

### 5. Activity & timing — derived on the frontend

First hunt, last hunt, days quiet, weeks active, longest active streak and busiest weekday are all
derivable from `pastHunts[].date` and the existing `activity` array.

Computing them server-side would bake a timezone into a **cached** row, so a weekday bucket would be
wrong for anyone outside that zone. Deriving client-side also keeps the blob from growing.

### 6. The stale-cache trap

`stats` is cached as JSONB in `user_hunt_stats`, and `getUserStats` only recomputes when the row is
**missing**. Shipping new fields without a trigger leaves every existing user with empty new tiles
permanently — the rollup would only heal on their next hunt.

Fix: `STATS_VERSION` stamped as `v` on the blob; `getUserStats` recomputes when `s.v !== STATS_VERSION`.

Also cap stored `bySlot` / `byCaller` at 25 entries. They are unbounded today and the UI shows 5;
tripling the slices without a cap would inflate a row measured at ~17 kB.

### 7. Cross-community scope for the player page

`GET /api/my-stats?scope=all` unions the caller's hunts across every tenant:
`hunt_participants` joined to `hunt_history` **without** the tenant filter, fed through
`computeUserHuntStats`. Not materialized (the rollup is keyed by tenant) — cached in-memory ~60s
per user, same pattern as `getCommunityStats`.

`/tracker/stats` is not tenant-scoped, so without this it would silently resolve to Bean.

### 8. Frontend — one panel, both pages

New `src/stats/userStats/`, one component per file per the repo's no-god-files rule:

- `UserStatsPanel.js` — owns the All/Host/Joined toggle, composes the rest
- `RoleToggle.js`, `StatTiles.js`, `RecordTiles.js`
- `HostOperatorCard.js`, `JoinedPlayerCard.js`, `CallingRecordCard.js`, `ActivityCard.js`
- `userStatsDerive.js` + `userStatsDerive.test.js` — pure helpers (§5 derivations, slice picking).
  Pure logic gets a test; components do not (`@testing-library/react` is not installed).

`admin/userProfile/ProfileCharts.js` becomes a thin consumer rather than owning the tiles.
`MyStats.js` is repointed from the dead `/api/tracker/stats` to `/api/my-stats?scope=all` and
renders the same panel.

## Risks

- **Back-compat.** `StatsBox.js` reads `stats.tiles`, `stats.usd`, `stats.byCurrency`,
  `stats.records`. Spreading the "all" slice at top level keeps every existing reader working;
  this is why the shape is additive rather than nested under `all`.
- **MyStats shape change.** It currently expects the `getHuntStats` shape (`byCurrency` blocks,
  `currencies`, `tz`) rendered by `StatsBlock`. It moves to the userStats shape. Since the page
  404s today, there is no working behavior to regress.
- **Blob growth.** Mitigated by §1 (no repeated `pastHunts`) and §6 (capped lists).
- Vercel treats warnings as errors — `CI=true npm run build` must pass before any push.

## Verification

- `npm test` in the backend (652 tests) with new cases in `lib/userStats.test.js`:
  slice isolation, host-only and joined-only attribution, operator/player/calling math,
  version stamp forcing recompute.
- `npm test` + `CI=true npm run build` in the frontend, plus `userStatsDerive.test.js`.
- Admin panel is behind Discord OAuth and previews force a login
  (`EXTRA_ORIGINS` is not set for preview URLs), so live click-testing happens after merge.
