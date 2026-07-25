# Rainbet catalog dedup — design

**Date:** 2026-07-25
**Status:** approved, not yet implemented

## Problem

`rainbet_slots.json` (8,340 rows) contains **828 name-collision groups covering 1,671 rows**. Most
are the same Rainbet game stored twice under slug variants, so the slot picker shows the game twice
— often with one working thumb and one dead one.

Found while fixing the dead-CDN thumb sweep (backend `486b75a`), which collapsed 5 of these by hand
via `SLUG_FIXES`. Hand-maintaining ~800 more entries in two mirrored literals is not viable.

### The two classes

**761 same-studio groups** — mechanical variants of one game:

| Variant kind | Example |
|---|---|
| Provider alias | `playn-go-honey-rush-100` vs `play-n-go-honey-rush-100` |
| Provider alias | `nownow-shadow-treasure` vs `nownow-gaming-shadow-treasure` |
| Provider alias | `wazdan-30-coins-…` vs `voltent-wazdan-30-coins-…` |
| Apostrophe | `pragmatic-play-santas-xmas-rush` vs `…-santa-s-xmas-rush` |
| Word-join | `hacksaw-stack-em` vs `hacksaw-stackem` |

**67 cross-studio groups** — genuinely ambiguous, and the reason this needs evidence rather than a
rule. Some are real distinct games sharing a name (`endorphina-bad-santa` vs `peter-sons-bad-santa`).
Others are one game filed under two provider prefixes (`hacksaw-sleepy-grandpa` vs
`backseat-gaming-sleepy-grandpa` — Backseat is Hacksaw's sister studio). A purely mechanical dedup
would delete real games here.

## Approach

Mechanical rules **identify** collision groups; a targeted Rainbet games-API crawl **arbitrates**
which row survives. This is the technique already proven in the `486b75a` thumb fix.

Rejected alternatives:

- **Mechanical rules only** — no crawl, but the survivor is chosen by heuristic, so some survivors
  would be slugs Rainbet doesn't serve, and the 67 cross-studio groups stay unresolved.
- **Full 56-provider crawl** — most thorough but 1–2 h under the required throttle, real 429 risk,
  and it duplicates what `scripts/reconcile_rainbet.js` already does.

## Components

### 1. `lib/slotSlugCanon.js` (new, pure, no I/O)

The key design decision: **do not compute a canonical slug — only a canonical key.**

Rainbet serves some games as `playn-go-…` and others as `play-n-go-…`. There is no derivable rule,
only per-game truth from the API. So the catalog file stores the real slug, and this module answers
one narrower question: *are these two slugs the same game?*

- `PROVIDER_ALIASES` — `play-n-go`/`playn-go` → `playngo`, `nownow-gaming` → `nownow`,
  `voltent-wazdan` → `wazdan`, `mascot-gaming` → `mascot`, `penguin-king` → `penguin`,
  `amigo-gaming` → `amigo`, `ace-roll` → `aceroll`, `peter-and-sons` → `peter-sons`
- `splitSlug(rainbetSlug)` → `{ providerToken, gameSlug }`, longest-prefix match against the
  existing sorted provider list
- `canonKey(rainbetSlug)` → `"{canonProvider}:{gameSlug stripped of all non-alphanumerics}"`

Stripping non-alphanumerics collapses the apostrophe and word-join variants for free, so those need
no dedicated rules.

### 2. `scripts/dedupe_rainbet_slots.js` (new one-shot maintenance script)

Mirrors the crawl in `scripts/reconcile_rainbet.js`: CF-cleared headed patchright, `page.evaluate`
fetch, 1.8 s throttle, 90 s 429 backoff. Crawls **only the providers present in collision groups**,
not all 56 — this is what keeps it to ~15–30 min and well under the rate limit.

Resolution rule per group, using the API's `url` field as the real slug:

| Group resolves to | Action |
|---|---|
| One live `url` | Keep the row whose `rainbetSlug` matches it; drop the rest |
| Different live `url`s | **Distinct games — keep every row** |
| No live match | Collapse to one row, preferring canonical provider + working thumb |

Ghost *removal* is deliberately out of scope — `reconcile_rainbet.js` owns that, with its 3-day
mark-then-sweep grace. This script only ever merges rows; it never deletes a game the catalog
uniquely knows about.

Safety gates. Reconcile's `providersGateOk` (≥20) does not transfer, because this script
deliberately crawls only a handful of providers. The equivalent gates here are:

- **Every targeted provider must return games.** If any provider in the target list yields zero
  games, the crawl was rate-limited or the provider slug is wrong — abort without writing. This is
  the gate that matters: a silently empty provider would make its rows look dead and collapse the
  wrong survivors.
- **Deletion cap:** abort if planned deletions exceed **1,671** (the current total rows in collision
  groups). A correct run can never exceed this, so tripping it means the grouping logic is wrong.

`--dry-run` prints the plan without writing, and is the required first step.

### 3. Enforcement

`lib/slots.js` `rebuildSearchPool` and `scripts/check_new_slots.js` currently dedup on the literal
slug (`seenSlugs.has(constructed)`). Both change to track **`canonKey`** in their seen-set, so a
slot.report row that is a slug variant of an existing file row is skipped instead of appended.

Both `require` the single new module, so this class of bug loses the "two mirrored maps must stay in
sync" trap that `SLUG_FIXES` has.

`SLUG_FIXES` stays, for one-offs canonicalization cannot catch — e.g.
`pragmatic-play-little-gem-hold-and-spin` → `pragmatic-play-little-gem`, a subtitle difference
rather than a punctuation one.

### 4. Tests

`lib/slotSlugCanon.test.js` (`node:test`, beside the module):

- alias table, including the three-segment `voltent-wazdan` case
- apostrophe and word-join collapse
- longest-prefix provider split (`play-n-go` must not match as provider `play`)
- **regression lock:** the shipped `rainbet_slots.json` contains no two rows sharing a `canonKey`

## Verification

1. Re-run the collision analysis → 0 same-studio groups remain; every surviving cross-studio pair is
   justified by a distinct Rainbet `url`.
2. Re-sweep all thumbs → 0 dead.
3. `node --test lib/slotSlugCanon.test.js lib/slots.test.js lib/rainbetReconcile.test.js`.
4. Spot-check the affected names on prod after deploy.

## Risks

| Risk | Mitigation |
|---|---|
| Deleting a genuinely distinct game | Cross-studio groups only collapse on identical live `url`; otherwise all rows survive |
| Rate-limited/partial crawl corrupts the file | Provider-count and deletion-cap gates abort before any write; `--dry-run` first |
| Local backend auto-sync re-appends dropped rows | Script is idempotent and slug-based; restart the local server after merge |
| Canonicalization too aggressive, merging real games | `canonKey` is provider-scoped, so same-name/different-studio can never collide |

Rollback is a single `git revert` — the change touches one data file and three code files.
