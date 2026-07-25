# Rainbet Catalog Dedup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Collapse the 1,671 duplicate rows in `rainbet_slots.json` down to one row per real Rainbet game, without deleting genuinely distinct same-name games from different studios.

**Architecture:** A pure `canonKey()` module identifies slug variants of the same game (provider aliases, apostrophes, word-joins). A one-shot crawl script arbitrates which row survives using Rainbet's games API as ground truth. Both slot.report merge paths then dedup on `canonKey` instead of the literal slug, so the variants cannot come back.

**Tech Stack:** Node.js (CommonJS), `node:test`, patchright (headed Chromium for the Cloudflare-gated Rainbet API).

## Global Constraints

- Design doc: `docs/superpowers/specs/2026-07-25-rainbet-catalog-dedup-design.md`
- Branch: `feat/catalog-dedup`. Never commit to `main` directly.
- No AI attribution or `Co-Authored-By` trailers in commit messages.
- Run tests as `node --test lib/<file>.test.js` — `node --test lib/` is broken on Node 24.
- The crawl requires `SCRAPE_HEADLESS=false` and a real display; headless hangs forever on Cloudflare.
- Rainbet's games API rate-limits aggressively: 1.8 s throttle between pages, 90 s backoff on 429, never two crawl sessions from one IP at once.
- A local backend on `:3001` rewrites `rainbet_slots.json` every ~10 min. Data-mutating scripts must be idempotent and slug-based, and re-run immediately before commit.

---

### Task 1: `canonKey` module

**Files:**
- Create: `lib/slotSlugCanon.js`
- Test: `lib/slotSlugCanon.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: `splitSlug(rainbetSlug) -> { providerToken: string, gameSlug: string }`, `canonKey(rainbetSlug) -> string`, `PROVIDER_ALIASES: Record<string,string>`.

- [ ] **Step 1: Write the failing test**

Create `lib/slotSlugCanon.test.js`:

```javascript
const test = require('node:test');
const assert = require('node:assert');
const { canonKey, splitSlug } = require('./slotSlugCanon');

test('splitSlug prefers the longest provider prefix', () => {
  assert.deepStrictEqual(splitSlug('play-n-go-honey-rush-100'),
    { providerToken: 'play-n-go', gameSlug: 'honey-rush-100' });
  assert.deepStrictEqual(splitSlug('pragmatic-play-great-rhino'),
    { providerToken: 'pragmatic-play', gameSlug: 'great-rhino' });
});

test('provider aliases collapse to one studio token', () => {
  assert.strictEqual(canonKey('playn-go-honey-rush-100'), canonKey('play-n-go-honey-rush-100'));
  assert.strictEqual(canonKey('nownow-shadow-treasure'), canonKey('nownow-gaming-shadow-treasure'));
  assert.strictEqual(canonKey('wazdan-30-coins-score-the-jackpot'),
    canonKey('voltent-wazdan-30-coins-score-the-jackpot'));
});

test('apostrophe and word-join variants collapse', () => {
  assert.strictEqual(canonKey('pragmatic-play-santas-xmas-rush'),
    canonKey('pragmatic-play-santa-s-xmas-rush'));
  assert.strictEqual(canonKey('hacksaw-stack-em'), canonKey('hacksaw-stackem'));
  assert.strictEqual(canonKey('hacksaw-rusty-curly'), canonKey('hacksaw-rusty-and-curly'));
});

test('different studios with the same game name never collide', () => {
  assert.notStrictEqual(canonKey('endorphina-bad-santa'), canonKey('peter-sons-bad-santa'));
  assert.notStrictEqual(canonKey('shady-lady-laced'), canonKey('thunderkick-laced'));
});
```

Note: `rusty-curly` vs `rusty-and-curly` collapses only because `and` is stripped as a filler word — see Step 3.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test lib/slotSlugCanon.test.js`
Expected: FAIL, `Cannot find module './slotSlugCanon'`

- [ ] **Step 3: Write the implementation**

Create `lib/slotSlugCanon.js`:

```javascript
// Canonical identity for a Rainbet slug. Answers exactly one question: do two slugs
// refer to the same game? It deliberately does NOT produce a canonical slug —
// Rainbet serves some games as playn-go-… and others as play-n-go-… with no
// derivable rule, so the real slug only ever comes from the games API. The catalog
// file stores that real slug; this module just detects variants of it.
//
// Used by lib/slots.js and scripts/check_new_slots.js so the slot.report merge
// can't re-add a variant of a row the catalog already has.

// Provider prefixes seen in Rainbet slugs, longest first so "play-n-go" wins over "play".
const PROVIDER_PREFIXES = [
  'voltent-wazdan','big-time-gaming','massive-studios','backseat-gaming','bullshark-games',
  'foxhound-games','kitsune-studios','pineapple-play','print-studios','peter-and-sons',
  'pragmatic-play','nownow-gaming','mascot-gaming','penguin-king','amigo-gaming',
  'clutch-gaming','jinx-gaming','relax-gaming','trusty-gaming','elk-studios','push-gaming',
  'iron-dog-studio','red-tiger','playn-go','play-n-go','peter-sons','shady-lady','iron-dog',
  'blueprint','spinomenal','thunderkick','yggdrasil','quickspin','clawbuster','endorphina',
  'ace-roll','1spin4win','habanero','platipus','avatarux','slotmill','fantasma','isoftbet',
  'onetouch','playnetic','zillion','truelab','popiplay','gamomat','gameart','belatra',
  'nolimit','playngo','bgaming','voltent','betsoft','netent','wazdan','hacksaw','pgsoft',
  'mascot','penguin','3-oaks','aceroll','nownow','amigo','retro',
].sort((a, b) => b.length - a.length);

// Prefix variants that mean the same studio.
const PROVIDER_ALIASES = {
  'play-n-go': 'playngo',
  'playn-go': 'playngo',
  'nownow-gaming': 'nownow',
  'voltent-wazdan': 'wazdan',
  'mascot-gaming': 'mascot',
  'penguin-king': 'penguin',
  'amigo-gaming': 'amigo',
  'ace-roll': 'aceroll',
  'peter-and-sons': 'peter-sons',
  'iron-dog-studio': 'iron-dog',
};

function splitSlug(rainbetSlug) {
  const s = String(rainbetSlug || '').toLowerCase();
  for (const p of PROVIDER_PREFIXES) {
    if (s.startsWith(p + '-')) return { providerToken: p, gameSlug: s.slice(p.length + 1) };
  }
  const i = s.indexOf('-');
  if (i > 0) return { providerToken: s.slice(0, i), gameSlug: s.slice(i + 1) };
  return { providerToken: '', gameSlug: s };
}

// "and" is dropped because Rainbet and slot.report disagree on it freely
// (hacksaw-rusty-curly vs hacksaw-rusty-and-curly are one game).
function gameKey(gameSlug) {
  return String(gameSlug || '')
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/\band\b/g, '')
    .replace(/[^a-z0-9]/g, '');
}

function canonKey(rainbetSlug) {
  const { providerToken, gameSlug } = splitSlug(rainbetSlug);
  const provider = PROVIDER_ALIASES[providerToken] || providerToken;
  return `${provider}:${gameKey(gameSlug)}`;
}

module.exports = { canonKey, splitSlug, gameKey, PROVIDER_ALIASES, PROVIDER_PREFIXES };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test lib/slotSlugCanon.test.js`
Expected: PASS, 4 tests

- [ ] **Step 5: Commit**

```bash
git add lib/slotSlugCanon.js lib/slotSlugCanon.test.js
git commit -m "feat(slots): canonKey module for slug-variant identity"
```

---

### Task 2: Dedup script with dry-run

**Files:**
- Create: `scripts/dedupe_rainbet_slots.js`
- Test: `lib/slotDedupe.js` + `lib/slotDedupe.test.js` (pure resolution logic, testable without a crawl)

**Interfaces:**
- Consumes: `canonKey` from Task 1.
- Produces: `planDedupe(entries, liveByNameKey) -> { keep: Array, drop: Array, groups: Array, distinctKept: number }`.

Pure logic lives in `lib/slotDedupe.js` so it is unit-testable; the script only crawls and writes.

- [ ] **Step 1: Write the failing test**

Create `lib/slotDedupe.test.js`:

```javascript
const test = require('node:test');
const assert = require('node:assert');
const { planDedupe, nameKey } = require('./slotDedupe');

const live = new Map([
  ['honeyrush100', { url: 'play-n-go-honey-rush-100' }],
  ['badsanta', { url: 'endorphina-bad-santa' }],
]);

test('collapses a variant pair onto the slug Rainbet actually serves', () => {
  const entries = [
    { rainbetSlug: 'playn-go-honey-rush-100', name: 'Honey Rush 100', thumb: 'a' },
    { rainbetSlug: 'play-n-go-honey-rush-100', name: 'Honey Rush 100', thumb: 'b' },
  ];
  const r = planDedupe(entries, live);
  assert.strictEqual(r.keep.length, 1);
  assert.strictEqual(r.keep[0].rainbetSlug, 'play-n-go-honey-rush-100');
  assert.strictEqual(r.drop.length, 1);
});

test('keeps both rows when two studios genuinely share a name', () => {
  const entries = [
    { rainbetSlug: 'endorphina-bad-santa', name: 'Bad Santa', thumb: 'a' },
    { rainbetSlug: 'peter-sons-bad-santa', name: 'Bad Santa', thumb: 'b' },
  ];
  const r = planDedupe(entries, live);
  assert.strictEqual(r.keep.length, 2);
  assert.strictEqual(r.drop.length, 0);
});

test('a group with no live match collapses to one row, preferring a thumb', () => {
  const entries = [
    { rainbetSlug: 'hacksaw-stack-em', name: 'Stack Em', thumb: null },
    { rainbetSlug: 'hacksaw-stackem', name: 'Stack Em', thumb: 'good' },
  ];
  const r = planDedupe(entries, new Map());
  assert.strictEqual(r.keep.length, 1);
  assert.strictEqual(r.keep[0].thumb, 'good');
});

test('non-duplicate rows pass through untouched', () => {
  const entries = [
    { rainbetSlug: 'hacksaw-solo', name: 'Solo', thumb: 'x' },
    { rainbetSlug: 'netent-other', name: 'Other', thumb: 'y' },
  ];
  const r = planDedupe(entries, live);
  assert.strictEqual(r.keep.length, 2);
  assert.strictEqual(r.drop.length, 0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test lib/slotDedupe.test.js`
Expected: FAIL, `Cannot find module './slotDedupe'`

- [ ] **Step 3: Write the implementation**

Create `lib/slotDedupe.js`:

```javascript
// Pure dedup resolution. Given catalog entries plus Rainbet's authoritative live
// games (keyed by stripped name), decide which rows survive. Never deletes a game
// the catalog uniquely knows about — removing delisted games is
// scripts/reconcile_rainbet.js's job, with its 3-day grace.
const { canonKey } = require('./slotSlugCanon');

const nameKey = s => String(s || '').toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]/g, '');

function planDedupe(entries, liveByNameKey) {
  const groups = new Map();
  for (const e of entries) {
    const k = nameKey(e.name);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(e);
  }

  const keep = [], drop = [], report = [];
  let distinctKept = 0;

  for (const [k, rows] of groups) {
    if (rows.length === 1) { keep.push(rows[0]); continue; }

    // Same canonKey => same game. Different canonKey => possibly different studios.
    const byCanon = new Map();
    for (const r of rows) {
      const c = canonKey(r.rainbetSlug);
      if (!byCanon.has(c)) byCanon.set(c, []);
      byCanon.get(c).push(r);
    }

    const live = liveByNameKey.get(k);
    if (byCanon.size > 1) {
      // Distinct studios sharing a name. Only collapse if Rainbet proves they are
      // one game by serving a single slug that matches exactly one of them.
      const match = live && rows.filter(r => r.rainbetSlug === live.url);
      if (live && match.length === 1 && rows.length === 2) {
        keep.push(match[0]);
        drop.push(...rows.filter(r => r !== match[0]));
        report.push({ key: k, action: 'cross-collapse', kept: match[0].rainbetSlug });
      } else {
        keep.push(...rows);
        distinctKept += rows.length;
        report.push({ key: k, action: 'kept-distinct', slugs: rows.map(r => r.rainbetSlug) });
      }
      continue;
    }

    // One canonKey: pure slug variants of a single game.
    const winner = (live && rows.find(r => r.rainbetSlug === live.url))
      || rows.find(r => r.thumb)
      || rows[0];
    keep.push(winner);
    drop.push(...rows.filter(r => r !== winner));
    report.push({ key: k, action: 'collapsed', kept: winner.rainbetSlug });
  }

  return { keep, drop, groups: report, distinctKept };
}

module.exports = { planDedupe, nameKey };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test lib/slotDedupe.test.js`
Expected: PASS, 4 tests

- [ ] **Step 5: Write the crawl script**

Create `scripts/dedupe_rainbet_slots.js`:

```javascript
#!/usr/bin/env node
//
// One-shot: collapse duplicate rows in rainbet_slots.json onto the slug Rainbet
// actually serves. Crawls ONLY the providers that appear in collision groups.
//
//   SCRAPE_HEADLESS=false node scripts/dedupe_rainbet_slots.js --dry-run
//   SCRAPE_HEADLESS=false node scripts/dedupe_rainbet_slots.js
//
// Headless hangs forever on Cloudflare — a headed browser clears it in ~5s.

const fs = require('fs');
const path = require('path');
const { planDedupe, nameKey } = require('../lib/slotDedupe');
const { splitSlug, PROVIDER_ALIASES } = require('../lib/slotSlugCanon');

const SLOTS_FILE = path.join(process.cwd(), 'rainbet_slots.json');
const PROVIDERS_URL = 'https://services.rainbet.com/v1/public/providers/list?country=US';
const GAMES_URL = 'https://services.rainbet.com/v1/public/games/list';
const HEADLESS = process.env.SCRAPE_HEADLESS !== 'false';
const DELETION_CAP = 1671;

const sleep = ms => new Promise(r => setTimeout(r, ms));
const CF = ['just a moment', 'attention required', 'cloudflare', 'checking your browser'];
const isCfTitle = t => CF.some(m => (t || '').toLowerCase().includes(m));

const apiGet = (page, url) => page.evaluate(async (u) => {
  const r = await fetch(u, { headers: { accept: 'application/json' } });
  let body = null;
  try { body = await r.json(); } catch {}
  return { status: r.status, body };
}, url);

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const entries = JSON.parse(fs.readFileSync(SLOTS_FILE, 'utf8'));

  // Which providers own a collision group? Only those get crawled.
  const byName = new Map();
  for (const e of entries) {
    const k = nameKey(e.name);
    if (!byName.has(k)) byName.set(k, []);
    byName.get(k).push(e);
  }
  const needed = new Set();
  for (const [, rows] of byName) {
    if (rows.length < 2) continue;
    for (const r of rows) {
      const { providerToken } = splitSlug(r.rainbetSlug);
      needed.add(PROVIDER_ALIASES[providerToken] || providerToken);
    }
  }
  console.log(`[dedupe] ${[...byName.values()].filter(v => v.length > 1).length} collision groups across ${needed.size} providers`);

  const { chromium } = require('patchright');
  const browser = await chromium.launch({ headless: HEADLESS });
  const liveByNameKey = new Map();
  let targets = [];
  try {
    const ctx = await browser.newContext({
      viewport: { width: 1280, height: 900 }, locale: 'en-US', timezoneId: 'America/Chicago',
    });
    const page = await ctx.newPage();
    await page.goto('https://rainbet.com/casino/slots', { waitUntil: 'domcontentloaded', timeout: 60000 });
    let cleared = false;
    for (let i = 0; i < 30; i++) {
      if (!isCfTitle(await page.title().catch(() => ''))) { cleared = true; break; }
      await sleep(2000);
    }
    if (!cleared) throw new Error('Cloudflare did not clear');

    const provRes = await apiGet(page, PROVIDERS_URL);
    const all = ((provRes.body && (provRes.body.providers || provRes.body)) || []).map(p => p.url).filter(Boolean);
    const norm = s => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
    targets = all.filter(p => [...needed].some(w => norm(p) === norm(w)
      || norm(p).startsWith(norm(w)) || norm(w).startsWith(norm(p))));
    console.log(`[dedupe] crawling ${targets.length} providers: ${targets.join(', ')}`);

    for (const prov of targets) {
      let cursor = null, count = 0;
      do {
        const url = `${GAMES_URL}?provider=${encodeURIComponent(prov)}&country=US&region=IA&limit=64`
          + (cursor ? `&cursor=${encodeURIComponent(cursor)}` : '');
        let res = await apiGet(page, url);
        let guard = 0;
        while (res.status === 429 && guard++ < 5) { console.log('  429 — backing off 90s'); await sleep(90000); res = await apiGet(page, url); }
        if (res.status !== 200 || !res.body) break;
        for (const g of (res.body.games || [])) {
          const k = nameKey(g.name);
          if (!liveByNameKey.has(k)) liveByNameKey.set(k, { url: g.url, thumb: g.custom_banner || g.icon });
          count++;
        }
        cursor = res.body.next_cursor || null;
        await sleep(1800);
      } while (cursor);
      console.log(`  ${prov}: ${count} games`);
      // Gate: a silently empty provider would make its rows look delisted.
      if (count === 0) throw new Error(`provider ${prov} returned 0 games — crawl unreliable, aborting`);
    }
  } finally {
    await browser.close().catch(() => {});
  }

  const r = planDedupe(entries, liveByNameKey);
  console.log(`[dedupe] keep=${r.keep.length} drop=${r.drop.length} kept-distinct=${r.distinctKept}`);
  for (const g of r.groups.filter(g => g.action === 'kept-distinct')) {
    console.log(`  distinct: ${g.slugs.join('  |  ')}`);
  }
  if (r.drop.length > DELETION_CAP) throw new Error(`deletion cap exceeded (${r.drop.length} > ${DELETION_CAP})`);

  if (dryRun) {
    console.log('[dedupe] --dry-run: no write');
    fs.writeFileSync('dedupe_plan.json', JSON.stringify(r.groups, null, 2));
    console.log('[dedupe] plan written to dedupe_plan.json');
    return;
  }
  fs.writeFileSync(SLOTS_FILE, JSON.stringify(r.keep, null, 2) + '\n');
  console.log(`[dedupe] wrote ${r.keep.length} entries`);
}

main().catch(e => { console.error('[dedupe]', e.message); process.exit(1); });
```

- [ ] **Step 6: Commit**

```bash
git add lib/slotDedupe.js lib/slotDedupe.test.js scripts/dedupe_rainbet_slots.js
git commit -m "feat(slots): dedupe resolution logic and crawl script"
```

---

### Task 3: Run the dedup and land the data change

**Files:**
- Modify: `rainbet_slots.json`

- [ ] **Step 1: Dry run**

Run: `SCRAPE_HEADLESS=false node scripts/dedupe_rainbet_slots.js --dry-run`
Expected: prints collision-group count, per-provider game counts, `keep=`/`drop=` totals, and every `kept-distinct` group. Writes `dedupe_plan.json`.

- [ ] **Step 2: Review the plan by hand**

Read the `kept-distinct` list and confirm each is a real pair of different games (e.g. Bad Santa from two studios). Read a sample of `collapsed` entries and confirm the kept slug is the one Rainbet serves. **Do not proceed if any provider reported 0 games.**

- [ ] **Step 3: Apply**

Run: `SCRAPE_HEADLESS=false node scripts/dedupe_rainbet_slots.js`
Expected: `[dedupe] wrote <N> entries`, N ≈ 8340 − drop count.

- [ ] **Step 4: Verify no dead thumbs were introduced**

Run the thumb sweep over the new file and confirm 0 dead. Then:

Run: `node --test lib/slotSlugCanon.test.js lib/slotDedupe.test.js lib/slots.test.js lib/rainbetReconcile.test.js`
Expected: all pass.

- [ ] **Step 5: Commit**

Re-run the script first if the local `:3001` backend has rewritten the file since Step 3.

```bash
rm -f dedupe_plan.json
git add rainbet_slots.json
git commit -m "chore(slots): collapse duplicate catalog rows onto real Rainbet slugs"
```

---

### Task 4: Enforce canonKey in both merge paths

**Files:**
- Modify: `lib/slots.js:349-384`
- Modify: `scripts/check_new_slots.js:542,565`
- Test: `lib/slotSlugCanon.test.js` (append regression lock)

**Interfaces:**
- Consumes: `canonKey` from Task 1.
- Produces: nothing new.

- [ ] **Step 1: Write the failing regression-lock test**

Append to `lib/slotSlugCanon.test.js`:

```javascript
test('shipped catalog has no two rows sharing a canonKey', () => {
  const entries = require('../rainbet_slots.json');
  const seen = new Map();
  const collisions = [];
  for (const e of entries) {
    const k = canonKey(e.rainbetSlug);
    if (seen.has(k)) collisions.push(`${seen.get(k)} <-> ${e.rainbetSlug}`);
    else seen.set(k, e.rainbetSlug);
  }
  assert.deepStrictEqual(collisions, []);
});
```

- [ ] **Step 2: Run it**

Run: `node --test lib/slotSlugCanon.test.js`
Expected: PASS (Task 3 already cleaned the data). If it FAILS, the dedup missed a class — fix the data before continuing.

- [ ] **Step 3: Wire canonKey into `lib/slots.js`**

Add to the requires at the top:

```javascript
const { canonKey } = require('./slotSlugCanon');
```

In `rebuildSearchPool`, replace the literal-slug seen-set. Change line 355-356 from:

```javascript
    const key = (s.rainbetSlug || '').toLowerCase();
    if (key) seenSlugs.add(key);
```

to:

```javascript
    const key = (s.rainbetSlug || '').toLowerCase();
    if (key) seenSlugs.add(canonKey(key));
```

and change lines 382-383 from:

```javascript
      if (seenSlugs.has(constructed.toLowerCase())) continue;
      seenSlugs.add(constructed.toLowerCase());
```

to:

```javascript
      if (seenSlugs.has(canonKey(constructed))) continue;
      seenSlugs.add(canonKey(constructed));
```

- [ ] **Step 4: Wire canonKey into `scripts/check_new_slots.js`**

Add to the requires at the top:

```javascript
const { canonKey } = require('../lib/slotSlugCanon');
```

Change line 542 from:

```javascript
  const seenSlugs = new Set(existing.filter(s => s.thumb).map(s => (s.rainbetSlug || '').toLowerCase()));
```

to:

```javascript
  const seenSlugs = new Set(existing.filter(s => s.thumb).map(s => canonKey(s.rainbetSlug || '')));
```

and line 565 from:

```javascript
    if (seenSlugs.has(g.rainbetSlug.toLowerCase())) continue;
```

to:

```javascript
    if (seenSlugs.has(canonKey(g.rainbetSlug))) continue;
```

`existingBySlug` (line 541) stays keyed on the literal slug — it is an identity lookup for in-place upgrades, not a dedup gate.

- [ ] **Step 5: Verify the merge still works**

Run: `node --test lib/slots.test.js lib/slotSlugCanon.test.js lib/slotDedupe.test.js`
Expected: all pass.

Run: `node -e "const s=require('./lib/slots');console.log('loaded ok')"`
Expected: prints the `[slots] Loaded N slots` line then `loaded ok`, no throw.

- [ ] **Step 6: Commit**

```bash
git add lib/slots.js scripts/check_new_slots.js lib/slotSlugCanon.test.js
git commit -m "fix(slots): dedup merge candidates on canonKey, not literal slug"
```

---

### Task 5: Ship

- [ ] **Step 1: Push and open the PR**

```bash
git push -u origin feat/catalog-dedup
```

Open a PR summarizing: collision groups collapsed, rows dropped, distinct pairs preserved, and the enforcement change.

- [ ] **Step 2: Post-merge**

Restart the local `:3001` backend so it picks up the new merge logic; otherwise its in-process sync rewrites the file with the old literal-slug dedup and re-appends variants.
