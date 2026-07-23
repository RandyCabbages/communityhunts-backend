# Rainbet Stale-Slot Reconciliation

**Date:** 2026-07-23
**Status:** Approved (design)

## Problem

`rainbet_slots.json` (~8,300 entries) grows but never shrinks in normal operation. Removal
logic exists in `scripts/check_new_slots.js` (see `isFullCatalog` / `removed`), but it only
fires when **Strategy 3** (the headed full-catalog DOM crawl) runs — and Strategy 3 is a
*fallback* that only runs when slot.report (Strategy 2) returns nothing. slot.report almost
never fails, so Strategy 3 essentially never runs, so **removal essentially never happens.**

Result: games Rainbet has delisted (e.g. `nolimit-payday`, a mis-slugged duplicate of
`nolimit-outsourced-payday`) linger in the catalog and surface in the slot picker / wheel as
games that no longer exist on the casino.

We want a periodic reconciliation that authoritatively enumerates what Rainbet *actually still
carries* and prunes what's gone — **without ever deleting a real game** because a single scrape
was rate-limited, region-filtered, or half-broken.

## The two picker feeds (why file-only pruning is not enough)

`lib/slots.js rebuildSearchPool` builds the autocomplete pool from **two** feeds:

1. **File entries** (`RAINBET_SLOTS` from `rainbet_slots.json`) — authoritative, pruned by this job.
2. **slot.report merge** — gap-fills with slot.report games not in the file, gated only by
   "has a trusted thumb" (`if (!thumb) continue`, `lib/slots.js:363`).

slot.report's catalog is **much broader than Rainbet's** (it lists games from many casinos), so
feed 2 injects games Rainbet never carried — e.g. "Power of Ninja" (Pragmatic Play): confirmed
absent from Rainbet via their own games API (`search=ninja` returns six ninja slots, none of them
Power of Ninja; provider `pragmatic-play` has 618 slots, this isn't one). Its slot.report thumb
(`pragmaticplay.com/...Power-of-Ninja...png`) now 307-redirects to HTML, so it renders as a black
/ broken tile. **Pruning only the file would never remove it — it isn't in the file.**

So this job must ALSO constrain feed 2. Since the job already computes Rainbet's authoritative
live-name-set, it **commits that set as an artifact** (`rainbet_live_names.json`) and the merge
gates on it (see "Component: merge gating" below). This closes the ghost path at its real source.

## Non-goals

- Not changing the every-10-min live add-only sync (`lib/rainbetSlotSync.js` /
  `check_new_slots.js`). That stays as-is: it adds new releases + upgrades thumbs, never removes.
- Not a real-time removal. Delisting detection is deliberately slow and conservative.
- No new datastore. State rides on the existing JSON file; commits go through the existing
  `GITHUB_PAT` push path (here, via the Actions runner's checkout token).

## Design overview

A new **scheduled GitHub Actions job** runs a new **`scripts/reconcile_rainbet.js`** script
once a day. The script:

1. Authoritatively enumerates Rainbet's live catalog (region-inclusive) via the Rainbet games
   API, per-provider.
2. Applies **mark-then-sweep** to `rainbet_slots.json`: entries absent from the live set get a
   `missingSince` stamp; entries present get it cleared; entries stamped **older than 3 days**
   are removed.
3. Two hard safety gates abort the run (write nothing) if the crawl looks broken.
4. Writes the live-name-set as a committed artifact (`rainbet_live_names.json`) that gates the
   backend's slot.report merge feed — so ghosts that live in the merge (not the file) are also
   suppressed.
5. Commits the changed files (rebase-retry on push contention with the live sync).

### Why Actions, not in-process on Railway

The live 10-min sync already runs on Railway's IP. The memory's Rainbet notes warn: *do not run
two Rainbet sessions from the same IP at once* — a heavy per-provider API crawl would 429 the
live sync. Actions gives a **separate IP** and full isolation. Actions `schedule` timing is
unreliable (fires every 1.5–5h under load) — which is exactly why it was abandoned for
*new-release* detection — but that is **irrelevant here**: mark-then-sweep with a grace period
does not care whether a run slips a few hours.

## Component: `scripts/reconcile_rainbet.js`

Separate file from `check_new_slots.js`. Shares no removal logic with it (that path stays dead
/ unchanged). Structure:

### 1. Live-set enumeration (integration layer)

- Launch a **headed** patchright browser under the runner's `xvfb` (same as the existing
  workflow), navigate to rainbet.com to clear the Cloudflare Managed Challenge.
- From the CF-cleared page, call the games API via `page.evaluate(fetch(...))` (inherits cleared
  cookies — a bare fetch/curl 403s):
  - `providers/list?country=US` → ~56 provider slugs.
  - For each provider: `games/list?provider={apiSlug}&country=US&region=IA`, cursor-paginated
    (`&cursor=<next_cursor>`, 64/page). `country/region` params **include region-blocked
    titles** (plain `grouping=slots` excludes them — that exclusion is the false-removal trap).
- Throttle **~1.8s between pages**; on HTTP 429, back off **90s** and retry. A full crawl is
  minutes long — fine for a daily job.
- Collect the union of all returned games into a **live set keyed by normalized name**
  (see below).

### 2. Name-based matching (not slug)

Rainbet's API provider slugs differ from ours (`play-n-go` → `playn-go`, etc.), and per-game
slug construction differs between sources. Matching the catalog against the live set **by slug
would false-flag hundreds of real games as absent.** So membership is tested by a normalized
**name** key:

```js
const nameKey = s => (s || '').toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]/g, '');
```

(Mirrors `searchKey` in `lib/slots.js:456` — strips all spaces + punctuation. Distinct from the
load-bearing `normNameKey` used for pool dedup; do not reuse that one.)

`liveNameSet = new Set(liveGames.map(g => nameKey(g.name)))`.

### 3. Mark-then-sweep transform (pure — the unit-tested core)

A pure function `reconcile(entries, liveNameSet, { graceDays = 3, now = Date() })` returning the
new entries array. For each entry:

- `nameKey(entry.name)` **in** `liveNameSet` → delete `entry.missingSince` (present/back-live).
- `nameKey(entry.name)` **not in** `liveNameSet`:
  - no `missingSince` yet → set `entry.missingSince = <ISO date, now>`.
  - already stamped → leave it.
- **Sweep:** drop entries whose `missingSince` is > `graceDays` old.

`missingSince` is an ISO date string on the entry object. The frontend ignores unknown fields;
the live sync's `existing.filter(...)`/entry-preserving writes carry the field through untouched,
so both writers coexist. Grace is **time-based** (3 days), not run-count — robust to irregular
Actions timing. A game that reappears in any run clears its stamp instantly.

### 4. Safety gates (belt-and-suspenders on top of grace)

The transform only runs if the crawl passed both gates; otherwise the script writes nothing and
exits non-zero (the Actions run fails loudly, catalog untouched):

- **Provider gate:** `providers/list` returned a plausible provider count (e.g. ≥ 20). A failed
  or truncated provider list means we can't trust the live set.
- **Catalog-floor gate:** the live set covers at least **50%** of current catalog entries by
  name. A crawl that mysteriously returns a tiny live set (Cloudflare re-challenged mid-crawl,
  mass 429s) must never be allowed to stamp/sweep the whole catalog.

These bound the blast radius of a *systematically* broken crawl; the 3-day grace bounds
*intermittent* misses.

### 5. `--dry-run` flag

Enumerate + compute, print a summary of what *would* be newly-marked, cleared, and swept — write
nothing. First-run validation is done locally on the Windows desktop with the real display:

```bash
SCRAPE_HEADLESS=false node scripts/reconcile_rainbet.js --dry-run
```

## Component: `.github/workflows/reconcile-rainbet-slots.yml`

Clone of the existing manual `check-rainbet-slots.yml` (node 22 + `playwright install --with-deps
chromium` + `apt-get install xvfb`), differing in:

- `on: { schedule: [{ cron: '0 9 * * *' }], workflow_dispatch: {} }` — daily ~09:00 UTC + manual
  trigger. (Exact time is not load-bearing; grace tolerates Actions' timing drift.)
- Runs `xvfb-run -a node scripts/reconcile_rainbet.js`.
- Commit step: before push, `git pull --rebase origin main` then push; retry once on non-fast-
  forward (the live Railway sync may have pushed a new-releases commit in between). Same race the
  local-dev workaround already handles. Commit message: `auto: reconcile rainbet catalog (sweep N stale)`.

## Component: `rainbet_live_names.json` artifact + merge gating

The reconciliation script writes, alongside the pruned catalog, a small committed artifact:

```json
{ "generatedAt": "2026-07-23T09:00:00Z", "names": ["gatesofolympus", "sixsixsix", ...] }
```

`names` is the sorted set of `nameKey`-normalized live Rainbet game names from the crawl. It is
only written when both safety gates pass (never an empty/partial set).

`lib/slots.js` loads it at startup and on change (it deploys with the backend). In
`rebuildSearchPool` **step 2 only**, add one guard right after the name is computed:

```js
if (liveNames.size && !liveNames.has(nameKey(name))) continue; // not a real Rainbet game
```

- **Fail-open:** if the artifact is missing or empty (`liveNames.size === 0`), the guard is a
  no-op — behavior is exactly as today. The gate can only ever *tighten* when we have a trusted
  set, never hide games because the file failed to load.
- **Step 1 (file feed) is NOT gated** — the job already pruned the file, and gating it too would
  double-jeopardy a real game on one bad crawl. The artifact only disciplines the unverified
  slot.report merge.
- **Latency:** a brand-new Rainbet release that's in slot.report but not yet in the file *or* in
  today's live-name snapshot is briefly not merged — it appears within a day (next snapshot) or
  sooner via the 10-min file sync. Acceptable, self-healing.
- Use the same `nameKey` (strip-all-spaces/punct) on both sides so spacing/punctuation never
  causes a false miss.

## Data flow

```
[daily cron] → Actions runner
  → headed patchright (xvfb) → clear CF on rainbet.com
  → page.evaluate(fetch) providers/list → per-provider games/list (paginated, throttled)
  → liveNameSet
  → gates pass? ──no──→ exit non-zero, no write
        │yes
  → reconcile(entries, liveNameSet, graceDays=3)  [pure]
        → clear stamps for live games
        → stamp newly-absent games (missingSince = today)
        → sweep games stamped > 3 days ago
  → if changed: write rainbet_slots.json + rainbet_live_names.json
       → git pull --rebase → commit → push
  → (backend loads rainbet_live_names.json → gates slot.report merge feed)
```

## Error handling

- **CF never clears / providers/list fails:** provider gate fails → non-zero exit, no write.
  Next day's run retries.
- **Partial crawl (mass 429):** catalog-floor gate fails → non-zero exit, no write.
- **Push contention with the live sync:** rebase-retry once; if it still fails, the run fails and
  next day reconciles the (now-merged) file. No data loss — stamps are idempotent.
- **A real game briefly region-hidden or missed once:** gets stamped, but clears on any run that
  sees it within 3 days. Only a game absent from *every* successful run across 3+ days is swept.

## Testing

- **Pure transform (`reconcile`) — TDD, golden fixtures.** Cases:
  - live game with an old stamp → stamp cleared, kept.
  - live game, no stamp → unchanged.
  - newly-absent game → stamp set to `now`, kept.
  - absent game stamped 2 days ago → kept (within grace).
  - absent game stamped 4 days ago → swept.
  - `missingSince` boundary exactly at `graceDays` → defined (kept; sweep is strictly older-than).
  - real game whose name differs only in spacing/punctuation from the API name → matched via
    `nameKey`, kept (guards the slug-mismatch false-positive).
- **Gates:** unit-test that `reconcile`/driver refuses to write when the live set is empty / below
  floor (simulate by passing a tiny liveNameSet + assert no sweep, or a separate gate function).
- **Merge gating (pure):** unit-test `rebuildSearchPool`'s step-2 guard — a slot.report game NOT
  in `liveNames` is dropped; one that IS in `liveNames` is kept; an empty `liveNames` set gates
  nothing (fail-open, current behavior). Use the existing pool-build test harness if present.
- **Integration (crawl/CF):** not unit-tested; validated manually via `--dry-run` locally before
  enabling the schedule, and by the first few real Actions runs (dry-run mode first, then arm).

## Rollout

1. Land the script + workflow with the workflow in **dry-run** (or `workflow_dispatch`-only)
   first. Inspect the reported would-sweep list across a couple of manual runs.
2. Confirm the would-sweep list is all genuine delistings (spot-check a few on rainbet.com).
3. Flip the workflow to the daily `schedule` + real write.

## Open follow-ups (out of scope here)

- If false-positives ever appear despite the gates, add a small never-sweep allowlist field for
  manually-curated entries. Not built now (YAGNI — gates + grace should suffice).
