# Durable All-Time Per-User Hunt Stats — Design

**Date:** 2026-07-12
**Status:** Approved (design), pending implementation plan
**Repos:** `communityhunts-backend` (primary), `communityhunts-frontend` (UI surfaces)

## Problem

The app already computes rich per-user hunt aggregates (`lib/userStats.js` →
`computeUserHuntStats`), surfaced admin-only at `GET /api/admin/users/:userId`. But the
underlying data source is `rawTenantHunts` = live hunts **+ the archive**, and the archive is a
single JSONB blob (`hunts_kv` key `archive`) **hard-capped at the most recent 100 hunts across all
tenants** — because it is rewritten whole on every hunt-end (`lib/persistence.js:199-200`). So:

- History silently ages out; "all-time" is really "last ~100 hunts, globally."
- Users cannot see their own stats at all (admin-gated only).
- Mixed-currency totals blend (an ARS hunt and a USD hunt sum into a meaningless number).

## Goal

Durable, extensive, **true all-time** per-user hunt history, scoped **per-community (tenant)**, with:

- **Self-serve:** each logged-in user sees their own stats via a box in the user dropdown.
- **Admin:** the existing `admin/users` view reads the same richer data for anyone.
- **Extensive metrics:** core lifetime totals, records/extremes, trends over time, and breakdowns
  (per-slot, per-caller, multiplier histogram, per-currency).
- **Correct currency conversion:** convert to USD using the exchange rate **at the time of each
  hunt** (captured on archive), so inflationary currencies (ARS) stay correct over time.

Non-goals (YAGNI for now): cross-user leaderboards, global (cross-tenant) user view, crypto
currencies. The schema is keyed by tenant so a global toggle can be added later without migration.

## Existing stats surfaces (reuse, don't duplicate)

Discovered during design — the durable store must plug into these, not reinvent them:

- **`lib/hunts-core.js` `getHuntStats(tenantId, tz)`** → served at `GET /api/admin/hunt-stats`
  (admin, tenant-wide, **all hunters combined**, grouped by currency with no cross-currency sums).
  Not per-user. Left as-is.
- **`lib/userStats.js` `computeUserHuntStats(hunts, userId)`** → `GET /api/admin/users/:userId`
  (admin, **per-user**) → rendered by `admin/userProfile/{ProfileCharts,PastHunts}.js`. This is the
  function we extend and cache.
- **Frontend `src/stats/StatsView.js`** exports the shared renderer (`StatsBlock`, `CurrencyTabs`,
  `BarChart`, `moneyIn`, …) used by the admin console. **Reuse it** for the new dropdown box.
- **`src/stats/MyStats.js` (`/tracker/stats`, Pro-gated)** calls `GET /api/tracker/stats` — **which
  does not exist on the backend today** (the personal page is wired to a missing endpoint). The new
  per-user rollup is the natural backing for a real personal-stats endpoint; wiring/repairing that
  Pro page is out of scope here but the rollup makes it a small follow-up.

The one genuinely new capability neither existing system has: **cross-currency USD normalization**
(both deliberately keep currencies separate). This design adds it on top, opt-in via a toggle.

## Storage approach — C: materialized rollup (chosen)

One row per completed hunt in a real per-row table (unbounded, cheap O(1) writes), **plus** a
pre-computed per-user rollup table for instant reads. The rollup is maintained as a **refreshed
cache of the pure `computeUserHuntStats` output** — not fragile incremental deltas — so reads are a
single indexed SELECT while correctness reuses the existing, unit-tested compute code (critical for
order-dependent metrics like streaks and records).

This is **fully additive and non-breaking**: the existing 100-cap `archive` blob is left exactly as
it is for the live hub / recent-history UI.

## Data model — new Postgres tables

All created idempotently via `CREATE TABLE IF NOT EXISTS`, alongside the existing `hunts_kv` init in
`lib/persistence.js` (or a new `lib/statsStore.js` — see Components).

### `hunt_history` — raw source of truth, one row per completed hunt
| column | type | note |
|---|---|---|
| `hunt_key` | TEXT PRIMARY KEY | stable id: `huntId` if present, else `user.id \| startedAt` (matches existing `sameHuntInstance`) |
| `tenant_id` | TEXT NOT NULL | per-community scope |
| `host_user_id` | TEXT | hunt owner's Discord id |
| `currency` | TEXT | native currency of the hunt |
| `usd_rate` | NUMERIC | USD rate for `currency` on `ended_at` date; `1.0` for USD; NULL if FX fetch failed |
| `started_at` | TIMESTAMPTZ | |
| `ended_at` | TIMESTAMPTZ | `archivedAt` |
| `snapshot` | JSONB NOT NULL | full hunt (bonuses, equity, calls) + carried `usdRate` — any future metric derivable, no schema change |

Index: `(tenant_id, ended_at)`.

### `hunt_participants` — per-(hunt, user), makes "a user's hunts" an indexed lookup
| column | type | note |
|---|---|---|
| `hunt_key` | TEXT | FK-ish to `hunt_history.hunt_key` |
| `tenant_id` | TEXT | |
| `user_id` | TEXT | host + each equity member |
| `role` | TEXT | `host` or `member` |

PK `(hunt_key, user_id)`. Index `(tenant_id, user_id)`.

Rationale: avoids a JSONB scan / GIN index to find every hunt a user participated in (as host **or**
equity member). Replaced wholesale for a hunt whenever that hunt is (re-)archived.

### `user_hunt_stats` — materialized rollup, one row per (tenant, user)
| column | type | note |
|---|---|---|
| `tenant_id` | TEXT | |
| `user_id` | TEXT | |
| ...sortable scalars... | NUMERIC/INT/TIMESTAMPTZ | hunts, hosted, joined, wagered_usd, won_usd, net_usd, win_rate, avg_start_usd, avg_x, biggest_win_usd, highest_mult, best_hunt_net_usd, worst_hunt_net_usd, longest_win_streak, longest_loss_streak, last_hunt_at |
| `stats` | JSONB NOT NULL | full `computeUserHuntStats` output: trends series, per-slot / per-caller / per-currency breakdowns, mult histogram, records, recent hunts, native + USD aggregates |
| `updated_at` | TIMESTAMPTZ | |

PK `(tenant_id, user_id)`. The scalar columns are denormalized out of `stats` so a future
leaderboard can `ORDER BY` them without unpacking JSONB.

### `fx_rates` — cache of daily USD conversion rates
| column | type | note |
|---|---|---|
| `currency` | TEXT | e.g. `ARS`, `BRL`, `EUR` |
| `date` | DATE | the hunt's `ended_at` date (UTC) |
| `usd_rate` | NUMERIC | 1 unit of `currency` = `usd_rate` USD |

PK `(currency, date)`. USD rows are trivially `1.0`. Cached so we never re-hit the FX API for the
same (currency, date) and conversions are reproducible.

## Components

- **`lib/statsStore.js`** (new) — owns the three stats tables + `fx_rates`; table init, upserts,
  per-user recompute, and read helpers. Keeps `persistence.js` focused; injected `pgPool` like the
  existing modules.
- **`lib/fxRates.js`** (new) — FX adapter over the **same source the frontend already uses**:
  `https://open.er-api.com/v6/latest/USD` (free, keyless, USD-based, updates daily, covers ARS).
  `getUsdRate(currency, date)`:
  1. `USD` → `1.0`.
  2. Look up `fx_rates` cache for `(currency, date)`; return if present.
  3. Else fetch the latest er-api table (itself cached in-process ~12h, mirroring the frontend's
     TTL), derive `usd_rate = 1 / table[currency]`, write `(currency, date)` into `fx_rates`, return.
  4. On failure → return `null` (caller stores the hunt unconverted; see Failure handling).

  **Historical caveat:** er-api's free endpoint is **latest-only** — no by-date history. This is
  exact for the going-forward path (we capture the rate *at archive time*, which is the hunt's own
  time) but for the ≤100 **backfilled** hunts we can only stamp today's rate as a best-effort
  approximation. Backfilled rows are flagged `approx: true` in `snapshot` so the UI can mark them.
  (Accepted: user confirmed backfill scope of ~100 is fine; new hunts — the vast majority over
  time — are converted correctly.)
- **`lib/userStats.js`** (extend) — stays a **pure** function. Now reads `usdRate` off each hunt
  (data on the row) and emits native per-currency **and** USD-normalized aggregates, plus the new
  metric categories. No network in the compute path.
- **`routes/settings.routes.js`** (edit) — add `GET /api/my-stats`; switch the admin profile's
  `stats` to read the rollup (with lazy fallback).
- **`lib/persistence.js`** (hook) — `archiveHunt` / `unarchiveHunt` call into `statsStore` (see
  Write path). Fire-and-forget so a stats failure never blocks the core hunt flow.

## Write path — rollup refreshed on hunt-end

On `archiveHunt(hunt)` (after the existing archive-blob write):
1. Compute `hunt_key`; resolve `usdRate = fxRates.getUsdRate(hunt.currency, ended_at date)`.
2. **Upsert** one `hunt_history` row (idempotent by `hunt_key` — re-ending refreshes in place, same
   semantics as today's archive upsert). Carry `usdRate` into `snapshot`.
3. **Replace** `hunt_participants` rows for this `hunt_key` (host + each equity member).
4. For **each affected participant** `user_id`: read that user's hunts (participants → history,
   indexed), run extended `computeUserHuntStats`, **upsert** their `user_hunt_stats` row.

On `unarchiveHunt(hunt)` (reopen a mistakenly-ended hunt): delete the `hunt_history` +
`hunt_participants` rows for that `hunt_key`, then recompute the affected users' rollups.

All stats writes are wrapped so failures log and no-op rather than throwing into the hunt lifecycle
(the live archive blob remains the authoritative fast path).

## Read path — endpoints

- **`GET /api/my-stats`** (`requireAuth`): `SELECT * FROM user_hunt_stats WHERE tenant_id=$tenant AND
  user_id=$me`. Returns the rollup (`stats` JSONB + scalars). Powers the dropdown box.
- **`GET /api/admin/users/:userId`** (`requireAuth, requireAdmin`): read the rollup for
  `(req.tenant, userId)` instead of computing inline over `rawTenantHunts`.
- **Fallback (both):** if no rollup row exists (user hunted before migration, or not yet computed),
  compute on the fly from `hunt_history` and lazily upsert the row so the next read is hot.

## Metrics (extended `computeUserHuntStats`)

Existing: hunts count, hosted/joined, win rate, wagered, won, avg start, avg mult, weekly activity,
cumulative profit series, mult histogram, recent-hunt rows.

Added:
- **Records / extremes:** biggest single win, highest multiplier ever, best & worst hunt by net,
  longest win streak, longest loss streak, biggest req-X beaten.
- **Trends:** profit curve, hunts per week/month, rolling average return (avg-X) over time.
- **Breakdowns:** per-slot performance (favorite / most-profitable), per-caller performance,
  multiplier distribution histogram, **per-currency split**.
- **Currency:** every monetary aggregate produced in **both** native-per-currency and a
  USD-normalized total (native × captured `usdRate`, summed). USD totals note "excludes N
  unconverted hunts" when any participant hunt has a `null` rate.

## FX / currency conversion

- **Source:** `open.er-api.com/v6/latest/USD` — the same free, keyless table the frontend's
  `CurrencySwitch.js` already uses (consistency + no new dependency/keys).
- **Rate captured at hunt-time** (at archive) and stored per `hunt_history` row → all-time USD
  totals sum pre-converted values and stay correct as ARS inflates.
- **Backfill** stamps today's rate as a best-effort approximation (er-api is latest-only; see the
  `fxRates` caveat above) and flags those rows `approx`.
- **Display:** the stats box defaults to USD-normalized totals with a **native ⇄ USD toggle**; the
  per-currency breakdown is expandable.
- **Failure handling:** FX fetch failure → hunt stored with `usd_rate = NULL`, counted natively;
  USD totals transparently exclude it and report the count; a lazy backfill fills the rate on a
  later view/recompute.

## Frontend (communityhunts-frontend)

Follow repo **File Discipline** (new UI → new file; tokens via `useTheme()` only; no god-files) and
**never push to `main`** — branch + Vercel preview URL, `CI=true npm run build` must pass.

- **User dropdown:** new "My Stats" box (its own component file, not an inline block) → fetches
  `GET /api/my-stats`, **reuses `src/stats/StatsView.js`** (`StatsBlock` / `CurrencyTabs`) as the
  renderer rather than a bespoke layout. Tokens come from `useTheme()` (canonical violet/Inter
  palette — near-black aubergine bg `#0a0710`, accent `#a78bfa`→`#7c3aed`, win-green `#b6ff2e`,
  loss-red `#ff6b6b`; the `#c6f135`/Chakra Petch tokens in the backend CLAUDE.md are stale). Adds
  the **native ⇄ USD toggle** (the one thing `StatsView` doesn't do yet — money is currently
  currency-grouped only).
- **Admin/users section:** extend `admin/userProfile/{ProfileCharts,PastHunts}.js` (already consume
  `GET /api/admin/users/:userId`) with the new metric sections (records, breakdowns, trends).
- **Note / follow-up:** the existing Pro-gated `MyStats.js` (`/tracker/stats`) points at a missing
  backend endpoint — out of scope here, but the rollup makes repairing it a small later task.

## Migration & backfill

One-shot idempotent `scripts/backfill-hunt-history.js`:
1. Ensure tables exist.
2. Walk the existing `archive` (≤100) + current live hunts → upsert `hunt_history` +
   `hunt_participants`, stamping today's `usd_rate` (best-effort, `approx: true`) since the source
   is latest-only.
3. Recompute all `user_hunt_stats` rollups.

**Honest caveat:** the 100-cap has already discarded older hunts; there is no way to recover history
beyond the ≤100 currently archived. True all-time accrues from deploy forward.

## Error handling summary

- Stats write failures (`statsStore`, `fxRates`) log and no-op — never block the hunt lifecycle.
- FX unavailable → `null` rate, native-only counting, transparent exclusion note, lazy later fill.
- Missing rollup row on read → compute-and-populate fallback.
- `hunt_key` idempotency guarantees re-ending a hunt never double-counts.

## Testing

- **Unit (`lib/userStats.test.js`, extend, TDD):** each new metric — records, streaks, per-slot,
  per-caller, per-currency, native vs USD aggregation (incl. a `null`-rate exclusion case).
- **Unit (`lib/fxRates`):** cache hit path, USD short-circuit, provider-failure → `null`.
- **Integration (`statsStore`):** write-path idempotency (re-end doesn't double-count), recompute
  correctness across a host + a member of the same hunt, reopen (`unarchiveHunt`) removal, and the
  missing-rollup read fallback.

## Rollout

1. Deploy backend: tables auto-create; `archiveHunt` starts populating going forward (additive,
   no behavior change to the live hub).
2. Run `scripts/backfill-hunt-history.js` once to seed from the current archive.
3. Ship `GET /api/my-stats` + admin read swap.
4. Ship frontend dropdown box + admin view extension.
