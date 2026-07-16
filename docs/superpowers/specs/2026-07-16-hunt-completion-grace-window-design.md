# Hunt Completion Grace Window — Design

**Date:** 2026-07-16
**Repos:** communityhunts-backend, communityhunts-frontend

## Problem

When the last bonus of a hunt is confirmed with a win amount, the hunt is auto-ended
(archived + locked) immediately. Hosts routinely do final tweaks right after the last
win — adjusting equity, payouts, correcting a win amount — and the immediate archive
interrupts that work.

## Goal

After every bonus has a recorded win, the hunt stays **live and editable** for a
**10-minute grace window**. It auto-ends (archives + flips `isLive=false`) only after
10 minutes of inactivity. Any edit resets the timer. During the window the hunt stays
visible on the live hub.

Scope is regular community/VIP hunts (the `MyHunt.js` hunt types). The persistent shared
hunts (`tracker:` / `__mod_hunt__` / `__affiliate_hunt__` keys) are already exempt from the
completed-reap and are unchanged.

## Definitions

- **Completed hunt:** `huntCompleted(h)` — has bonuses and every bonus has `win != null`
  (`lib/hunts-core.js`). Unchanged.
- **Inactivity:** measured from `h.updatedAt`. Every edit to a hunt stamps `updatedAt`
  (`PUT /api/my-hunt` → `hunts.routes.js`; the janitor's `idleMs(h.updatedAt || h.startedAt)`).
  The frontend `save()` debounce refreshes `updatedAt` on each save, so an actively-tweaked
  hunt keeps resetting the timer; an idle/closed tab stops refreshing it.
- **Grace window:** `COMPLETED_GRACE_MS = 10 * 60 * 1000` (10 minutes).

## Changes

### 1. Frontend — `communityhunts-frontend/src/pages/MyHunt.js`

Remove the immediate auto-end. In `save()` (currently lines ~291–300), the block that fires
`POST /api/my-hunt/end` the instant `cur.bonuses.every(b => b.win != null)` is deleted. That
call is what archives + locks the hunt mid-tweak.

- The Winners panel + Save PNG reveal is driven separately by
  `setShowWinners(allBonusesOpened)` in `HuntTracker`, so removing the `/end` call does not
  change the UI reveal.
- Clean up the now-unused `autoEndedRef` (declaration + the reset in `doRestart`), after
  verifying it has no other consumers. The `/api/my-hunt/end` call elsewhere in the file
  (the "Save & Delete" save-to-history path) is unrelated and stays.

After this change, a completed regular hunt is ended only by the backend janitor.

### 2. Backend janitor — `communityhunts-backend/server.js`

The completed-reap (currently ~line 534) ends any completed live hunt on the next sweep
regardless of idle. Add the 10-minute idle gate:

```js
const COMPLETED_GRACE_MS = 10 * 60 * 1000; // 10m — a finished hunt stays live/editable this long

// inside cleanupStaleHunts, completed-reap branch:
if (!persistentKey && huntCompleted(h) &&
    idleMs(h.updatedAt || h.startedAt) >= COMPLETED_GRACE_MS) {
  h.isLive = false;
  h.updatedAt = new Date().toISOString();
  if (!h.archivedAt) h.archivedAt = new Date().toISOString();
  archiveHunt(h); archivedN++;
  ...
  continue;
}
```

A completed hunt still inside the window falls through this branch and stays live. The
existing 36h rule (`idleMs(...) < STALE_MS` → `continue`) leaves it alone since 10m < 36h.

Sweep cadence is unchanged (`setInterval(cleanupStaleHunts, 10 * 60 * 1000)`), so the real
end lands 10–20 minutes after the last activity — accepted.

Update the rule-summary comment block (~lines 497–503) and the completed-reap comment
(~lines 528–533): the janitor is now the primary ender of a completed hunt after a 10-minute
idle grace, not an immediate safety-net for a frontend `/end`.

### 3. Backend hub filter — `communityhunts-backend/lib/hunts-core.js`

`getPublicHunts` (line ~113) currently excludes completed hunts (`!huntCompleted(h)`) so a
finished hunt drops off the hub instantly. Remove that exclusion so a completed-but-still-live
hunt stays on the live hub for the grace window; it drops off naturally when the janitor flips
`isLive=false`.

```js
function getPublicHunts(tenantId) {
  return Object.values(hunts)
    .filter(h => h.isLive && huntHasContent(h) && inTenant(h, tenantId)
                 && h.user?.id !== modHuntKey(tenantId)
                 && h.user?.id !== affiliateHuntKey(tenantId))
    .map(huntSummary);
}
```

Update the comment block at ~lines 109–116 to reflect that completed hunts now remain on the
hub until the janitor ends them.

## Resulting behavior

Last win entered → hunt stays live, editable, and on the hub → host tweaks freely (each save
resets the 10-min timer) → 10 minutes of inactivity → janitor ends + archives → hunt moves to
the Archived tab and drops off the live hub.

## Testing

- Backend: `lib/hunts-core.test.js` for `getPublicHunts` now including completed live hunts.
  A janitor-level test for the completed-grace gate if the existing harness supports it
  (otherwise verify by reasoning + a manual idle-stamp check).
- Frontend: `CI=true npm run build` must compile; verify no dangling `autoEndedRef` reference.

## Out of scope

- No manual "end hunt" button is added (hunts have had no manual end control since 2026-07-09).
- Sweep-cadence tightening (rejected — 10–20 min end latency accepted).
- Mod/affiliate/tracker hunt lifecycle is untouched.
