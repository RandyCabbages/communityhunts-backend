# Public API: hunt pot, average multiple, and slot thumbnails — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `pot`, `averageMultiple` and per-bonus `thumb` to the Developer API's hunt shapes, so consumers can state a hunt's profit and render its slots without re-deriving either.

**Architecture:** Three additive fields on the two hunt serializers in `lib/publicSerializers.js`, plus one narrow lookup helper exported from `lib/slots.js`. No route, schema or storage changes. The thumbnail lookup builds one map per hunt from the existing slot search pool rather than scanning it per bonus row.

**Tech Stack:** Node.js, CommonJS, `node:test` + `node:assert`. No new dependencies.

**Spec:** `bean_site/docs/superpowers/specs/2026-08-03-bonus-hunts-honest-archive-design.md` §2 and §5. This plan is Part 1 of 2; the consumer half lives in the `bean_site` repo and does not block this.

## Global Constraints

- **Working directory is `C:\Users\kylew\communityhunts-backend`.** A sibling plan operates in `C:\Users\kylew\bean_site`. Confirm with `git remote -v` before the first commit — it must show `communityhunts-backend`.
- **Never commit to `main`.** Branch, push, open a PR. `main` auto-deploys to production on merge.
- **Never `git add -A`.** Explicit paths only.
- **No `Co-Authored-By` or authorship trailers** in any commit message.
- **Additive only.** The published API policy is that changes are additive; no existing field changes name, type or meaning.
- **Whitelist-only serialization.** A new internal field must never auto-leak. Fields are named explicitly, never spread.
- **`round2` for money and ratios.** Non-numbers pass through untouched — `null` must stay `null`, never become `0`.
- **`node --test lib/` is broken on Node 24.** Run a single file as `node --test lib/<file>.test.js`, or the whole suite as `npm test`.

---

### Task 1: `pot` and `averageMultiple` on both hunt serializers

Both fields go on `publicHunt` **and** `publicHuntSummary`. The existing test `publicHuntSummary agrees with publicHunt on every field it shares` iterates every summary key and compares it against the full serializer, so adding to the summary alone fails immediately with `undefined`. Adding to both satisfies it and makes that test enforce the index-row-vs-detail-fetch invariant for free.

**Files:**
- Modify: `lib/publicSerializers.js:83-103` (`publicHuntSummary`), `:145-176` (`publicHunt` return), and the helper block near `:14`
- Test: `lib/publicSerializers.test.js`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `publicHunt(hunt)` and `publicHuntSummary(hunt)` each return `pot: number` and `averageMultiple: number | null`, in addition to their existing keys.

- [ ] **Step 1: Write the failing tests**

Append to `lib/publicSerializers.test.js`, immediately after the existing `// ── summary view ──` block:

```js
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
  // The §2 invariant stated directly: an index row, a detail fetch and the rows themselves must
  // all agree about what a hunt cost, or the consumer picks one and contradicts the others.
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
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
node --test lib/publicSerializers.test.js
```

Expected: the new tests FAIL with `undefined !== 150` and `undefined !== 100`. The existing `publicHuntSummary drops the nested arrays and keeps the index fields` still PASSES at this point — it breaks in Step 3, which is expected and handled in Step 4.

- [ ] **Step 3: Add the two helpers and wire them into both serializers**

In `lib/publicSerializers.js`, add directly below the `roundFields` definition (after line 24):

```js
// The hunt's cost — the break-even line. Summed from the RAW equity, not the masked view:
// maskEquityMember rewrites `name`/`avatar` and drops `discordId`, and never reads `amount`, so
// the totals are identical and this avoids paying per-row masking work on a 100-row listing.
const potOf = hunt => round2((hunt.equity || []).reduce((s, e) => s + (Number(e.amount) || 0), 0));

// Mean multiple over bonuses that have BOTH a stake and a result. `bet: 0` is a collected-but-
// unbought bonus and `win: null` is one not yet opened; scoring either as 0x would drag the
// average down by however many bonuses are still to come. `win: 0` IS counted — a bonus that
// opened and paid nothing is a result. Null rather than 0 when nothing qualifies, because 0
// would read as "everything paid nothing".
const averageMultipleOf = (hunt) => {
  const rows = (hunt.bonuses || []).filter(b => Number(b.bet) > 0 && b.win != null);
  if (!rows.length) return null;
  return round2(rows.reduce((s, b) => s + (b.win / b.bet), 0) / rows.length);
};
```

In `publicHuntSummary`, add both keys after `totalWon` (line 101):

```js
    totalWon: round2(bonuses.reduce((s, b) => s + (b.win || 0), 0) + sumVault(hunt)),
    pot: potOf(hunt),
    averageMultiple: averageMultipleOf(hunt),
  };
}
```

In `publicHunt`, add the same two keys immediately after its `totalWon` line (line 164), before `bonuses`:

```js
    totalWon: round2(bonuses.reduce((s, b) => s + (b.win || 0), 0) + sumVault(hunt)),
    pot: potOf(hunt),
    averageMultiple: averageMultipleOf(hunt),
    bonuses,
```

- [ ] **Step 4: Update the key-list assertion for the two new keys**

This is deliberately updated rather than loosened — it is the whitelist-only guarantee in test form, and relaxing it would let a future internal field leak unnoticed.

In `lib/publicSerializers.test.js`, in `publicHuntSummary drops the nested arrays and keeps the index fields`, replace the expected key array with:

```js
  assert.deepStrictEqual(Object.keys(out).sort(), [
    'averageMultiple', 'bonusCount', 'createdAt', 'currency', 'endedAt', 'huntKind', 'huntType',
    'id', 'isTournament', 'owner', 'pot', 'startedAt', 'status', 'totalWon', 'updatedAt',
  ]);
```

- [ ] **Step 5: Run the tests to verify they pass**

```bash
node --test lib/publicSerializers.test.js
```

Expected: PASS, including `publicHuntSummary agrees with publicHunt on every field it shares` — which now also pins that the two shapes report the same pot.

- [ ] **Step 6: Run the full suite**

```bash
npm test
```

Expected: PASS. Check the exit code directly; piping the output masks it.

- [ ] **Step 7: Commit**

```bash
git add lib/publicSerializers.js lib/publicSerializers.test.js
git commit -m "feat(api): publish a hunt's pot and average multiple"
```

---

### Task 2: `thumbForSlotNames` in the slots library

**Files:**
- Modify: `lib/slots.js` (new function beside `getSearchPool` near line 455; add to `module.exports` at line 555)
- Test: `lib/slots.thumbs.test.js` (create)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `thumbForSlotNames(names: string[]) → Map<string, string | null>` — keyed by the **original** name as passed in, valued with a thumbnail URL or `null`. Every input name appears as a key. Exported from `lib/slots.js`.

The pool and `normNameKey` stay private. This helper is the whole public surface, so a caller can never hold the pool and scan it per row.

- [ ] **Step 1: Write the failing test**

Create `lib/slots.thumbs.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert');
const slots = require('./slots');

// The pool is loaded from disk at require time, so these assert on SHAPE and CONTRACT rather than
// on any particular game being present — a catalogue reconcile must not be able to break the suite.

test('every name asked for comes back as a key', () => {
  const out = slots.thumbForSlotNames(['Le Bandit', 'Definitely Not A Real Slot 9999']);
  assert.strictEqual(out.size, 2);
  assert.ok(out.has('Le Bandit'));
  assert.ok(out.has('Definitely Not A Real Slot 9999'));
});

test('an unknown slot resolves to null, not undefined and not a throw', () => {
  const out = slots.thumbForSlotNames(['Definitely Not A Real Slot 9999']);
  assert.strictEqual(out.get('Definitely Not A Real Slot 9999'), null);
});

test('a resolved thumb is an http(s) url', () => {
  const out = slots.thumbForSlotNames(['Le Bandit']);
  const thumb = out.get('Le Bandit');
  // null is a legitimate outcome — the catalogue does not review every game.
  if (thumb !== null) assert.match(thumb, /^https?:\/\//);
});

test('lookup ignores case and punctuation differences', () => {
  // Slot names in a hunt are free text typed by whoever ran it. "Le Bandit", "le bandit" and
  // "Le  Bandit!" are the same game and must not resolve differently.
  const canonical = slots.thumbForSlotNames(['Le Bandit']).get('Le Bandit');
  assert.strictEqual(slots.thumbForSlotNames(['le bandit']).get('le bandit'), canonical);
  assert.strictEqual(slots.thumbForSlotNames(['Le  Bandit!']).get('Le  Bandit!'), canonical);
});

test('the original spelling is the key, not the normalized one', () => {
  const out = slots.thumbForSlotNames(['le bandit']);
  assert.ok(out.has('le bandit'));
  assert.ok(!out.has('Le Bandit'));
});

test('empty, non-string and duplicate names are handled without throwing', () => {
  const out = slots.thumbForSlotNames(['Le Bandit', 'Le Bandit', '', null, undefined, 42]);
  assert.ok(out.has('Le Bandit'));
  assert.ok(!out.has(''));
  assert.ok(!out.has(null));
  assert.ok(!out.has(42));
});

test('an empty input returns an empty map without touching the pool', () => {
  assert.strictEqual(slots.thumbForSlotNames([]).size, 0);
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
node --test lib/slots.thumbs.test.js
```

Expected: FAIL with `slots.thumbForSlotNames is not a function`.

- [ ] **Step 3: Implement the helper**

In `lib/slots.js`, add immediately after `getSearchPool` (after line 458):

```js
// Resolve slot NAMES to thumbnails in a single pass over the pool.
//
// Takes the whole list at once, deliberately. The pool is thousands of games, so a per-row lookup
// would be a five-figure string-comparison count for one hunt, on the single event loop serving
// every tenant. One pass answers all of them.
//
// A miss is normal, not an error: slot names on a hunt are free text typed by whoever ran it, and
// the catalogue has not reviewed every game, so `thumb` is legitimately null on pool entries too.
// Callers render a fallback tile — see SlotThumb on the frontend.
function thumbForSlotNames(names) {
  const out = new Map();
  const wanted = new Map(); // normalized key -> [original names]
  for (const name of names || []) {
    if (typeof name !== 'string' || !name) continue;
    if (out.has(name)) continue;
    out.set(name, null);
    const key = normNameKey(name);
    if (!key) continue;
    const bucket = wanted.get(key);
    if (bucket) bucket.push(name); else wanted.set(key, [name]);
  }
  if (!wanted.size) return out;

  for (const game of getSearchPool()) {
    if (!game.thumb) continue;
    const bucket = wanted.get(normNameKey(game.name || ''));
    if (!bucket) continue;
    for (const name of bucket) {
      if (out.get(name) === null) out.set(name, game.thumb);
    }
  }
  return out;
}
```

Add it to `module.exports` at the end of the file:

```js
module.exports = {
  getSlotGames,
  prefetchSlots,
  imgProxyHandler,
  IMG_PROXY_MAX_ENTRIES,
  slotsSearchHandler,
  makePopularHandler,
  reloadRainbetSlots,
  loadLiveNames,
  thumbForSlotNames,
};
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
node --test lib/slots.thumbs.test.js
```

Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add lib/slots.js lib/slots.thumbs.test.js
git commit -m "feat(slots): resolve a batch of slot names to thumbnails in one pass"
```

---

### Task 3: `thumb` on public bonus rows

**Files:**
- Modify: `lib/publicSerializers.js:108-113` (the `bonuses` map inside `publicHunt`), and the require block at `:3`
- Test: `lib/publicSerializers.test.js`

**Interfaces:**
- Consumes: `thumbForSlotNames` from Task 2.
- Produces: each element of `publicHunt(hunt).bonuses` gains `thumb: string | null`. `publicHuntSummary` is unaffected — it omits `bonuses` entirely.

- [ ] **Step 1: Write the failing test**

Append to `lib/publicSerializers.test.js`:

```js
// ── bonus thumbnails ──────────────────────────────────────────────────────────────────────────

test('every bonus row carries a thumb key, null when the catalogue has no entry', () => {
  const hunt = { ...HUNT, bonuses: [{ slot: 'Definitely Not A Real Slot 9999', bet: 2, win: 10 }] };
  const out = S.publicHunt(hunt);
  assert.ok('thumb' in out.bonuses[0], 'thumb key must always be present');
  assert.strictEqual(out.bonuses[0].thumb, null);
});

test('a bonus with no slot name still serializes, with a null thumb', () => {
  const hunt = { ...HUNT, bonuses: [{ slot: null, bet: 2, win: 10 }] };
  const out = S.publicHunt(hunt);
  assert.strictEqual(out.bonuses[0].slot, null);
  assert.strictEqual(out.bonuses[0].thumb, null);
});

test('thumb never appears on the summary shape', () => {
  const json = JSON.stringify(S.publicHuntSummary(HUNT));
  assert.ok(!json.includes('thumb'));
});

test('a duplicated slot in one hunt resolves to the same thumb on every row', () => {
  // Buying the same slot twice is routine. A per-row lookup that mutated shared state would
  // resolve the first and miss the rest.
  const hunt = { ...HUNT, bonuses: [
    { slot: 'Le Bandit', bet: 2, win: 200 },
    { slot: 'Le Bandit', bet: 2, win: 50 },
  ] };
  const out = S.publicHunt(hunt);
  assert.strictEqual(out.bonuses[0].thumb, out.bonuses[1].thumb);
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
node --test lib/publicSerializers.test.js
```

Expected: FAIL on `thumb key must always be present`.

- [ ] **Step 3: Wire the lookup into `publicHunt`**

In `lib/publicSerializers.js`, extend the require block at line 3:

```js
const { sumVault, huntCategoryOf, tenantOf, isIdentityMasked } = require('./hunts-core');
const { publicOwnerId } = require('./publicIds');
const { thumbForSlotNames } = require('./slots');
```

Replace the `bonuses` map at lines 108-113:

```js
  // One pool pass for the whole hunt, not one per bonus — see thumbForSlotNames. `thumb` is null
  // for a slot the catalogue has not reviewed and for a row with no slot name; both are normal
  // and a consumer renders a fallback tile.
  const rawBonuses = hunt.bonuses || [];
  const thumbs = thumbForSlotNames(rawBonuses.map(b => b.slot));
  const bonuses = rawBonuses.map(b => ({
    slot: b.slot || null,
    bet: b.bet ?? null,
    win: b.win ?? null,
    multiplier: (Number(b.bet) > 0 && b.win != null) ? +(b.win / b.bet).toFixed(2) : null,
    thumb: (typeof b.slot === 'string' && thumbs.get(b.slot)) || null,
  }));
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
node --test lib/publicSerializers.test.js
```

Expected: PASS.

- [ ] **Step 5: Check for a circular require**

`publicSerializers` now requires `slots`. Confirm `slots` does not require `publicSerializers` back, and that the server still boots:

```bash
grep -n "require(" lib/slots.js | grep -i "publicserializers\|hunts-core"
node -e "require('./lib/publicSerializers'); console.log('serializers load OK')"
```

Expected: the grep prints nothing, and the node command prints `serializers load OK`. A circular require would surface here as an empty object or a `TypeError` on the destructure.

- [ ] **Step 6: Run the full suite**

```bash
npm test
```

Expected: PASS, including `routes/public.routes.test.js` — the `view=summary` test asserts the nested arrays stay omitted, which this task does not change.

- [ ] **Step 7: Commit**

```bash
git add lib/publicSerializers.js lib/publicSerializers.test.js
git commit -m "feat(api): put a slot thumbnail on every public bonus row"
```

---

### Task 4: Document the three fields and open the PR

**Files:**
- Modify: `docs/developer-api-multitenant-readiness.md` if it enumerates hunt fields; otherwise whichever file documents the public hunt shape (find with the grep below)

- [ ] **Step 1: Find the documented field list**

```bash
grep -rln "totalWon" docs/
```

Expected: one or more docs listing the hunt shape. If none mention `totalWon`, there is no field-list doc to update — skip to Step 3 and note it in the PR body.

- [ ] **Step 2: Add the three fields to that list**

Document them exactly as:

- `pot` — number. The hunt's cost: the sum of the equity stakes. `0` when a hunt records no equity. Present on both the full and summary views, and identical on each.
- `averageMultiple` — number or **null**. Mean `win / bet` across bonuses that have both a stake and a result. Null, never `0`, when no bonus qualifies. Present on both views.
- `bonuses[].thumb` — string or **null**. Thumbnail URL for the slot. Null when the catalogue has no reviewed entry for that name, which is normal — render a fallback tile. Full view only.

- [ ] **Step 3: Verify the branch, then push and open the PR**

```bash
git remote -v
git status -sb
```

Expected: the remote is `communityhunts-backend`, and the branch is **not** `main`. If it is `main`, stop and move the commits to a branch before going further.

```bash
git push -u origin HEAD
```

Then open a PR whose body states: three additive fields, no existing field changed, no schema or route change, and that merging deploys to production. Note that `bean_site` consumes these but does not require them — it renders the affected figures as absent until they arrive.
