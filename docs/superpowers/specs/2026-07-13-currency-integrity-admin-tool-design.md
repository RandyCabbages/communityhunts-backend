# Currency Integrity: Admin Fix/Delete Tool + Creation-Time Prevention

**Date:** 2026-07-13
**Repos:** `communityhunts-backend` (core), `communityhunts-frontend` (admin UI + modal)
**Status:** Design — pending implementation plan

## Problem

A user ("ShooterMcGavin") ran hunts entering **ARS (Argentine peso)** amounts while the hunt's
`currency` was left at the default **`USD`**. The stats pipeline stamps a USD conversion rate at
archive time; `USD` → `usdRate = 1`, so raw peso numbers are counted as dollars. A ~500,000 ARS
(~$500) hunt lands in the all-time stats as **$500,000**.

Because the rollup is per-participant, the corruption is not isolated to the host — it inflates:
- the host's `user_hunt_stats` rollup,
- **every co-participant's** rollup (equity members share the hunt),
- tenant-wide records surfaced from it (`biggestWin`, `bestHuntNet`).

### Root cause (confirmed by reading the code)
- `currency` defaults to `'USD'` and is only a small `<select>` in the Open-Hunt modal
  (`StartHuntModal.js`), easy to skip past on autopilot.
- On archive, `statsStore.recordHunt` stamps `usdRate = fxRates.getUsdRate(currency, endedDate)`
  (`lib/statsStore.js:150`). For `USD` that is `1`.
- `computeUserHuntStats` (`lib/userStats.js`) normalizes all money to USD via that `usdRate`.

The bug is a **mislabel, not bad math** — which is why the primary remedy is *relabel*, not delete.

## Goals

1. Give admins a surgical tool to **correct** a past hunt's currency (relabel + re-stamp rate,
   preserving the hunt) or **delete** it, operating on the durable stats store and recomputing
   all affected participants atomically.
2. Use that tool to fix the existing ShooterMcGavin hunts (no separate one-off script).
3. Prevent recurrence by making the currency choice a **deliberate, visible** step at hunt
   creation — the only point where currency can be set wrong. No threshold nag.

## Non-Goals

- No self-serve (host-facing) delete this round — admin-only.
- No in-tracker input changes (bet/equity fields). Currency cannot diverge once a hunt is
  running; every slot and equity row uses the hunt's single currency. Prevention is
  creation-time only.
- No historical FX time-series. `fxRates` stays latest-rate + per-(currency,date) cache; the
  Fix action exposes a manual rate override to compensate (see Rate Handling).
- No change to the 100-cap file archive semantics.

## Data Model Context (source of truth)

Durable stats live in Postgres, written by `lib/statsStore.js`:
- `hunt_history (hunt_key PK, tenant_id, host_user_id, currency, usd_rate, started_at, ended_at, snapshot JSONB)`
- `hunt_participants (hunt_key, tenant_id, user_id, role)`
- `user_hunt_stats (tenant_id, user_id, …, stats JSONB)` — the per-user rollup the profile reads.

The file archive (`hunts_archive.json`, 100-cap) is **separate** and may not contain older hunts.
**The tool must target `hunt_history`, not the file archive** — that is where the stats the admin
sees are computed from.

`hunt_key` = `hunt.huntId` when present, else `${hunt.user.id}|${hunt.startedAt}`
(`statsStore.huntKey`). This is the address for all corrections.

## Piece 1 — Backend: statsStore functions + admin routes

### 1a. `recordHunt` refactor (rate override)
`recordHunt(hunt, opts?)` gains an optional `opts.usdRate`. When provided, it is used verbatim
instead of calling `fxRates.getUsdRate`, and `snapshot.approx` is set `true` (an admin-supplied
rate is inherently approximate). Existing callers (`persistence.archiveHunt`) pass no opts and are
unaffected.

### 1b. `correctHuntCurrency(tenantId, huntKey, { currency, usdRate })`
1. `SELECT snapshot FROM hunt_history WHERE hunt_key = $1` (404 to the route if absent).
2. Build `corrected = { ...snapshot, currency }`.
3. Call the existing `recordHunt` upsert/recompute path with `corrected` and, if `usdRate` was
   supplied, `{ usdRate }`. This re-stamps the rate, re-derives participants, upserts the snapshot,
   and recomputes **all affected users** in one transaction — reusing the proven `recordHunt`
   transaction body (no parallel logic to drift).
4. `usdRate` omitted → auto-fetch via `fxRates.getUsdRate(currency, endedDate)` (latest-rate
   approximation; acceptable for stable currencies, flagged for volatile ones — see Rate Handling).

### 1c. `deleteHuntByKey(tenantId, huntKey)`
Same transaction shape as the existing `removeHunt`, but keyed rather than passed a hunt object:
load participants from `hunt_participants`, `DELETE` both `hunt_history` + `hunt_participants`
rows, recompute each affected user. (`removeHunt` today requires a hunt object and is only reached
via the reopen path; this keyed variant is what an admin action needs.)

### 1d. Admin routes (`routes/admin.routes.js`, `requireAdmin`, tenant-scoped via `req.tenant.id`)
- `PATCH /api/admin/hunt-history/:huntKey/currency` — body `{ currency, usdRate? }`.
  Validates `currency ∈ CURRENCIES`; `usdRate` optional positive number. → `correctHuntCurrency`.
- `DELETE /api/admin/hunt-history/:huntKey` → `deleteHuntByKey`.
- Both return the refreshed target-user rollup (or `204`) so the frontend can re-render without a
  second round-trip. `:huntKey` is URL-encoded (it can contain `|`).

`statsStore` is already wired through `persistence.initPersistence` and available where the router
is constructed; expose the two new fns on the returned object.

### 1e. `userStats` row keying (enables the frontend to address rows)
`computeUserHuntStats` already emits `huntId` per `pastHunts` row. Add `huntKey` to each row,
computed with the **same fallback rule** as `statsStore.huntKey`
(`h.huntId || \`${h.user?.id}|${h.startedAt}\``) — with a comment tying the two together — so the
admin UI can address legacy hunts that lack a `huntId` (where `huntId` alone ≠ `hunt_key`).

## Piece 2 — Frontend: admin controls on the profile

`src/admin/userProfile/PastHunts.js` is presentational today. Add **admin-only** per-row actions,
rendered only when the parent passes the handlers:
- `Fix currency` — a small inline control: currency dropdown (`CURRENCIES`) + optional rate field
  ("rate at hunt time — leave blank for latest"), Apply.
- `Delete` — confirm, then remove.

Wiring in `src/admin/UserProfile.js`:
- Pass `onCorrect(huntKey, { currency, usdRate })` and `onDelete(huntKey)` (added to
  `src/admin/adminApi.js`) plus an `isAdmin` gate down to `PastHunts`.
- On success, re-fetch the profile stats (existing loader) so tiles/records/charts reflect the
  recompute for the host and any co-participants.

No new god-file risk: the Fix/Delete row UI is small and lives inside the existing `PastHunts`
component (its natural home); if it grows past a few dozen lines, extract a `PastHuntAdminRow`.

## Piece 3 — Prevention (creation-time, modal only)

`src/hunt/StartHuntModal.js` already renders a `currency` `<select>` (defaulting `'USD'`) next to
the equity/balance inputs in both the community/vip block and the solo/beans block. Make the choice
deliberate and visible without nagging:
- **Restate at commit:** near the primary "Open Hunt" button, echo the active currency in words,
  e.g. `Tracking in AR$ (ARS)`. This puts the chosen currency in front of the user at the moment of
  creation — the highest-signal, zero-friction guard.
- **Clarify the options:** show symbol + code in the dropdown (`AR$ · ARS`) so the selection is
  unambiguous, and widen the control enough to display it.
- Keep `USD` as the default; **no** confirm dialog, **no** amount threshold.

This is intentionally the lightest touch that keeps currency top-of-mind at the one place it can go
wrong.

## Rate Handling (why the manual override exists)

`fxRates.getUsdRate(currency, date)` returns a cached per-(currency,date) rate if present, else
fetches the **latest** table and computes today's rate (`lib/fxRates.js`). For a weeks-old hunt in a
high-inflation currency (ARS moves fast), auto-correcting therefore stamps today's rate — directionally
right (peso amounts stop counting as dollars) but numerically approximate. The Fix action's optional
rate field lets an admin supply the rate that applied at hunt time; corrected hunts carry
`snapshot.approx = true` so the approximation is honest and future-auditable.

## Edge Cases

- **Co-participants:** `correctHuntCurrency`/`deleteHuntByKey` recompute every user in
  `hunt_participants` for the key (union of stored + new), same as `recordHunt`/`removeHunt` today —
  so a shared hunt's members are all fixed in one transaction.
- **Legacy hunts without `huntId`:** addressed by the `huntKey` row field (Piece 1e).
- **Missing snapshot:** route returns 404; UI surfaces "hunt not found in history".
- **Currency unchanged but rate supplied:** allowed (pure rate correction).
- **Invalid currency / non-positive rate:** 400, no mutation.
- **File archive vs history divergence:** the tool operates on `hunt_history` only; the file
  archive is untouched (it does not feed the stats the admin is fixing). Documented, not reconciled.

## Testing

- **Unit (`node --test lib/`):** extend `lib/statsStore.test.js` — correcting USD→ARS on a hunt
  re-normalizes the rollup for host and a co-participant; delete removes the hunt and recomputes;
  rate override is used verbatim and sets `approx`. Extend `lib/userStats.test.js` for the new
  `huntKey` row field. (Node 24: run `node --test lib/*.test.js`.)
- **Manual (backend):** `PATCH`/`DELETE` routes against a seeded hunt; verify `requireAdmin` gate,
  tenant scoping, URL-encoded key.
- **Manual (frontend):** admin profile → Fix currency on a mislabeled hunt → tiles/records update;
  Delete → row and rollup update; non-admin sees no controls; `CI=true npm run build` clean.
- **Prevention:** visual check that the modal restates the currency and shows symbol+code.

## Build / Deploy Order (backend-first)

1. Backend: `recordHunt` override, `correctHuntCurrency`, `deleteHuntByKey`, `userStats.huntKey`,
   admin routes, unit tests. PR → merge → Railway deploy.
2. Fix the ShooterMcGavin hunts with the live tool (relabel USD→ARS, era-appropriate rate).
3. Frontend: admin controls + `adminApi` calls + `UserProfile` wiring. Branch → preview → PR.
4. Frontend: modal prevention. (Can ride with step 3.)

Frontend calls the new routes, so backend must deploy first.

## Out of Scope / Future

- Host self-serve delete of their own hunts.
- Historical FX time-series / automatic era-correct rates.
- Reconciling the 100-cap file archive with `hunt_history`.
