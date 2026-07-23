# Rainbet Stale-Slot Reconciliation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A daily GitHub Actions job that authoritatively enumerates Rainbet's live catalog and prunes stale games from `rainbet_slots.json` (mark-then-sweep, 3-day grace), and gates the slot.report merge feed so games Rainbet doesn't carry never reach the picker.

**Architecture:** A pure, unit-tested transform (`lib/rainbetReconcile.js`) holds all the decision logic — name normalization, mark/sweep, and the safety gates. An integration script (`scripts/reconcile_rainbet.js`) does the Cloudflare-cleared per-provider games-API crawl and calls the pure transform. `lib/slots.js` loads a committed live-name-set artifact and drops slot.report merge candidates not in it (fail-open). A scheduled workflow runs the script off Railway's IP.

**Tech Stack:** Node.js, `node:test` + `node:assert` (backend test convention), `patchright` (Cloudflare-clearing Chromium, already a dependency), GitHub Actions + `xvfb`.

## Global Constraints

- Test runner: `node --test <file>` — backend uses `node:test`/`node:assert`, golden fixtures in `lib/__fixtures__/*.json`. No jest, no new devDeps.
- Grace period: **3 days**. Sweep is **strictly older-than** grace (a stamp exactly `graceDays` old is kept).
- Name matching everywhere uses `nameKey` = `s.toLowerCase().replace(/&/g,'and').replace(/[^a-z0-9]/g,'')` (strip ALL spaces + punctuation). Do NOT reuse `normNameKey` from `lib/slots.js` (that one keeps spaces and is load-bearing for pool dedup).
- Safety gates (abort with non-zero exit, write nothing): provider count **≥ 20**; live-name-set covers **≥ 50%** of current catalog entries.
- `missingSince` stored as a `YYYY-MM-DD` string on the entry object.
- Merge gate is **fail-open**: an empty/missing live-name-set gates nothing (current behavior).
- No `Co-Authored-By` trailers on commits (repo rule).
- Deploy note: pushing to `main` auto-deploys the backend on Railway. These changes are add-only/behavior-preserving until the workflow is armed.

---

### Task 1: Pure reconciliation module + safety gates

**Files:**
- Create: `lib/rainbetReconcile.js`
- Create: `lib/rainbetReconcile.test.js`
- Create: `lib/__fixtures__/rainbetReconcileGolden.json`

**Interfaces:**
- Produces:
  - `nameKey(s: string) => string` — strip-all normalization.
  - `reconcile(entries: Array<{name,rainbetSlug,thumb,missingSince?}>, liveNameSet: Set<string>, opts?: {graceDays?: number, now?: Date}) => { entries: Array, marked: number, cleared: number, swept: number, sweptNames: string[], markedNames: string[] }` — mark-then-sweep transform.
  - `passesLiveGate(name: string, liveNameSet: Set<string>) => boolean` — fail-open merge gate check.
  - `providersGateOk(providerCount: number, opts?: {min?: number}) => boolean`.
  - `catalogFloorOk(liveCount: number, catalogCount: number, opts?: {minRatio?: number}) => boolean`.

- [ ] **Step 1: Write the golden fixture**

Create `lib/__fixtures__/rainbetReconcileGolden.json`:

```json
{
  "cases": [
    {
      "name": "live game with old stamp is cleared and kept",
      "graceDays": 3,
      "now": "2026-07-23T12:00:00Z",
      "liveNames": ["sixsixsix"],
      "entries": [{ "name": "SixSixSix", "rainbetSlug": "hacksaw-sixsixsix", "thumb": "t", "missingSince": "2026-07-01" }],
      "expect": { "keptNames": ["SixSixSix"], "missingSinceByName": { "SixSixSix": null }, "marked": 0, "cleared": 1, "swept": 0 }
    },
    {
      "name": "live game without stamp is unchanged",
      "graceDays": 3,
      "now": "2026-07-23T12:00:00Z",
      "liveNames": ["gatesofolympus"],
      "entries": [{ "name": "Gates of Olympus", "rainbetSlug": "pragmatic-play-gates-of-olympus", "thumb": "t" }],
      "expect": { "keptNames": ["Gates of Olympus"], "missingSinceByName": { "Gates of Olympus": null }, "marked": 0, "cleared": 0, "swept": 0 }
    },
    {
      "name": "newly-absent game is stamped now and kept",
      "graceDays": 3,
      "now": "2026-07-23T12:00:00Z",
      "liveNames": ["gatesofolympus"],
      "entries": [{ "name": "Payday", "rainbetSlug": "nolimit-payday", "thumb": "t" }],
      "expect": { "keptNames": ["Payday"], "missingSinceByName": { "Payday": "2026-07-23" }, "marked": 1, "cleared": 0, "swept": 0 }
    },
    {
      "name": "absent stamped 2 days ago is kept (within grace)",
      "graceDays": 3,
      "now": "2026-07-23T12:00:00Z",
      "liveNames": ["gatesofolympus"],
      "entries": [{ "name": "Payday", "rainbetSlug": "nolimit-payday", "thumb": "t", "missingSince": "2026-07-21" }],
      "expect": { "keptNames": ["Payday"], "missingSinceByName": { "Payday": "2026-07-21" }, "marked": 0, "cleared": 0, "swept": 0 }
    },
    {
      "name": "absent stamped 4 days ago is swept",
      "graceDays": 3,
      "now": "2026-07-23T12:00:00Z",
      "liveNames": ["gatesofolympus"],
      "entries": [{ "name": "Payday", "rainbetSlug": "nolimit-payday", "thumb": "t", "missingSince": "2026-07-19" }],
      "expect": { "keptNames": [], "missingSinceByName": {}, "marked": 0, "cleared": 0, "swept": 1 }
    },
    {
      "name": "absent stamped exactly graceDays ago is kept (strictly older-than)",
      "graceDays": 3,
      "now": "2026-07-23T00:00:00Z",
      "liveNames": ["gatesofolympus"],
      "entries": [{ "name": "Payday", "rainbetSlug": "nolimit-payday", "thumb": "t", "missingSince": "2026-07-20" }],
      "expect": { "keptNames": ["Payday"], "missingSinceByName": { "Payday": "2026-07-20" }, "marked": 0, "cleared": 0, "swept": 0 }
    },
    {
      "name": "name differing only by spacing/punctuation matches via nameKey",
      "graceDays": 3,
      "now": "2026-07-23T12:00:00Z",
      "liveNames": ["phoenixduelreels"],
      "entries": [{ "name": "Phoenix Duel Reels", "rainbetSlug": "hacksaw-phoenix-duelreels", "thumb": "t", "missingSince": "2026-07-01" }],
      "expect": { "keptNames": ["Phoenix Duel Reels"], "missingSinceByName": { "Phoenix Duel Reels": null }, "marked": 0, "cleared": 1, "swept": 0 }
    }
  ]
}
```

- [ ] **Step 2: Write the failing test**

Create `lib/rainbetReconcile.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
const { reconcile, nameKey, passesLiveGate, providersGateOk, catalogFloorOk } = require('./rainbetReconcile');
const golden = require('./__fixtures__/rainbetReconcileGolden.json');

for (const c of golden.cases) {
  test(`reconcile golden: ${c.name}`, () => {
    const liveSet = new Set(c.liveNames);
    const res = reconcile(c.entries, liveSet, { graceDays: c.graceDays, now: new Date(c.now) });
    assert.deepStrictEqual(res.entries.map(e => e.name), c.expect.keptNames);
    assert.strictEqual(res.marked, c.expect.marked);
    assert.strictEqual(res.cleared, c.expect.cleared);
    assert.strictEqual(res.swept, c.expect.swept);
    for (const [name, ms] of Object.entries(c.expect.missingSinceByName)) {
      const e = res.entries.find(x => x.name === name);
      assert.ok(e, `expected kept entry ${name}`);
      assert.strictEqual(e.missingSince ?? null, ms);
    }
  });
}

test('nameKey strips spaces and punctuation', () => {
  assert.strictEqual(nameKey("Mr. Null's Wicked Wares"), 'mrnullswickedwares');
  assert.strictEqual(nameKey('Six Six Six'), 'sixsixsix');
  assert.strictEqual(nameKey('Rock & Roll'), 'rockandroll');
});

test('passesLiveGate fails open on empty set', () => {
  assert.strictEqual(passesLiveGate('Anything', new Set()), true);
});

test('passesLiveGate gates when set is non-empty', () => {
  const set = new Set(['gatesofolympus']);
  assert.strictEqual(passesLiveGate('Gates of Olympus', set), true);
  assert.strictEqual(passesLiveGate('Power of Ninja', set), false);
});

test('providersGateOk requires >= 20', () => {
  assert.strictEqual(providersGateOk(56), true);
  assert.strictEqual(providersGateOk(19), false);
});

test('catalogFloorOk requires >= 50% coverage', () => {
  assert.strictEqual(catalogFloorOk(5000, 8000), true);
  assert.strictEqual(catalogFloorOk(100, 8000), false);
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `node --test lib/rainbetReconcile.test.js`
Expected: FAIL — `Cannot find module './rainbetReconcile'`.

- [ ] **Step 4: Write the implementation**

Create `lib/rainbetReconcile.js`:

```js
// Pure reconciliation logic for the Rainbet stale-slot job. No I/O, no browser —
// everything here is unit-tested. The integration crawl lives in
// scripts/reconcile_rainbet.js; the merge gate is consumed by lib/slots.js.

const DAY_MS = 24 * 60 * 60 * 1000;

// Strip-all normalization: lowercase, & -> and, drop every non-alphanumeric.
// Mirrors the space/punct-insensitive searchKey in lib/slots.js. Distinct from
// normNameKey (which keeps word-separating spaces and must not be reused here).
function nameKey(s) {
  return (s || '').toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]/g, '');
}

// Mark-then-sweep. For each entry:
//   - name in liveNameSet  -> clear any missingSince (present/back-live)
//   - name absent, unstamped -> stamp missingSince = today
//   - name absent, stamped   -> keep unless the stamp is strictly older than graceDays
function reconcile(entries, liveNameSet, opts = {}) {
  const graceDays = opts.graceDays ?? 3;
  const now = opts.now ?? new Date();
  const cutoff = now.getTime() - graceDays * DAY_MS;
  const today = now.toISOString().slice(0, 10);

  const out = [];
  let marked = 0, cleared = 0, swept = 0;
  const sweptNames = [], markedNames = [];

  for (const e of entries) {
    const live = liveNameSet.has(nameKey(e.name));
    if (live) {
      if (e.missingSince) {
        const { missingSince, ...rest } = e;
        out.push(rest);
        cleared++;
      } else {
        out.push(e);
      }
      continue;
    }
    // absent from Rainbet's live set
    if (!e.missingSince) {
      out.push({ ...e, missingSince: today });
      marked++;
      markedNames.push(e.name);
      continue;
    }
    const stampMs = Date.parse(e.missingSince);
    if (!Number.isNaN(stampMs) && stampMs < cutoff) {
      swept++;
      sweptNames.push(e.name);
      // drop
    } else {
      out.push(e);
    }
  }

  return { entries: out, marked, cleared, swept, sweptNames, markedNames };
}

// Fail-open merge gate: an empty live set gates nothing (preserves current behavior).
function passesLiveGate(name, liveNameSet) {
  if (!liveNameSet || liveNameSet.size === 0) return true;
  return liveNameSet.has(nameKey(name));
}

function providersGateOk(providerCount, opts = {}) {
  return providerCount >= (opts.min ?? 20);
}

function catalogFloorOk(liveCount, catalogCount, opts = {}) {
  const minRatio = opts.minRatio ?? 0.5;
  if (catalogCount <= 0) return false;
  return liveCount >= catalogCount * minRatio;
}

module.exports = { nameKey, reconcile, passesLiveGate, providersGateOk, catalogFloorOk };
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `node --test lib/rainbetReconcile.test.js`
Expected: PASS — all `reconcile golden:` cases + the gate/nameKey tests pass.

- [ ] **Step 6: Commit**

```bash
git add lib/rainbetReconcile.js lib/rainbetReconcile.test.js lib/__fixtures__/rainbetReconcileGolden.json
git commit -m "feat: pure rainbet reconcile transform + safety gates"
```

---

### Task 2: Live-name-set loader + slot.report merge gating in `lib/slots.js`

**Files:**
- Modify: `lib/slots.js` (add loader near the `SOFTSWISS_HITS` block ~line 162; add gate in `rebuildSearchPool` step 2 ~line 343; refresh in `reloadRainbetSlots` ~line 145)
- Create: `lib/rainbetLiveNames.test.js`

**Interfaces:**
- Consumes: `nameKey`, `passesLiveGate` from `./rainbetReconcile` (Task 1).
- Produces: `loadLiveNames(file?: string) => Set<string>` exported from `lib/slots.js` for testing.

- [ ] **Step 1: Write the failing loader test**

Create `lib/rainbetLiveNames.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadLiveNames } = require('./slots');

test('loadLiveNames returns a Set of the artifact names', () => {
  const tmp = path.join(os.tmpdir(), `live-names-${Date.now()}.json`);
  fs.writeFileSync(tmp, JSON.stringify({ generatedAt: 'x', names: ['sixsixsix', 'gatesofolympus'] }));
  const set = loadLiveNames(tmp);
  fs.unlinkSync(tmp);
  assert.ok(set instanceof Set);
  assert.strictEqual(set.size, 2);
  assert.ok(set.has('sixsixsix'));
  assert.ok(set.has('gatesofolympus'));
});

test('loadLiveNames returns an empty Set when the file is missing (fail-open)', () => {
  const set = loadLiveNames(path.join(os.tmpdir(), 'does-not-exist-xyz.json'));
  assert.ok(set instanceof Set);
  assert.strictEqual(set.size, 0);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test lib/rainbetLiveNames.test.js`
Expected: FAIL — `loadLiveNames is not a function` (not yet exported).

- [ ] **Step 3: Add the import at the top of `lib/slots.js`**

Near the other top-of-file requires (after the existing `const path = require('path')`-style lines), add:

```js
const { passesLiveGate } = require('./rainbetReconcile');
```

- [ ] **Step 4: Add the loader + module state**

Immediately after the `SOFTSWISS_HITS` load block (the `} catch(e) { console.error('[slots] Failed to load softswiss hits:', e.message); }` line, ~line 170), add:

```js
// Rainbet's authoritative live-name-set, produced daily by scripts/reconcile_rainbet.js.
// Gates the slot.report merge (step 2 of rebuildSearchPool) so games Rainbet doesn't carry
// never enter the pool. Fail-open: a missing/empty file gates nothing.
const RAINBET_LIVE_NAMES_FILE = path.join(ROOT, 'rainbet_live_names.json');

function loadLiveNames(file = RAINBET_LIVE_NAMES_FILE) {
  try {
    if (!fs.existsSync(file)) return new Set();
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    const names = Array.isArray(parsed) ? parsed : (parsed.names || []);
    return new Set(names);
  } catch (e) {
    console.error('[slots] Failed to load rainbet_live_names.json:', e.message);
    return new Set();
  }
}

let LIVE_NAMES = loadLiveNames();
if (LIVE_NAMES.size) console.log(`[slots] Loaded ${LIVE_NAMES.size} live Rainbet names (merge gate active)`);
```

- [ ] **Step 5: Refresh the set on hot-reload**

In `reloadRainbetSlots()` (~line 145), add the reload of `LIVE_NAMES` before rebuilding the pool:

```js
function reloadRainbetSlots() {
  RAINBET_SLOTS = loadRainbetSlots();
  LIVE_NAMES = loadLiveNames();
  rebuildSearchPool();
}
```

- [ ] **Step 6: Add the gate in the slot.report merge (step 2)**

In `rebuildSearchPool`, right after the existing name-dedup guard `if (seenNames.has(normNameKey(name))) continue;` (~line 343), add:

```js
      // Ghost gate: slot.report's catalog is broader than Rainbet's. Drop any merge
      // candidate whose game Rainbet doesn't actually carry (fail-open when no set loaded).
      if (!passesLiveGate(name, LIVE_NAMES)) continue;
```

- [ ] **Step 7: Export `loadLiveNames`**

In the `module.exports = { ... }` block (~line 480), add `loadLiveNames` to the exported names.

- [ ] **Step 8: Run the loader test to verify it passes**

Run: `node --test lib/rainbetLiveNames.test.js`
Expected: PASS — both cases.

- [ ] **Step 9: Verify the existing slot suite still passes**

Run: `node --test lib/slotLists.test.js lib/rainbetReconcile.test.js lib/rainbetLiveNames.test.js`
Expected: PASS (no regressions).

- [ ] **Step 10: Commit**

```bash
git add lib/slots.js lib/rainbetLiveNames.test.js
git commit -m "feat: gate slot.report merge with rainbet live-name-set"
```

---

### Task 3: Reconciliation crawl script

**Files:**
- Create: `scripts/reconcile_rainbet.js`

**Interfaces:**
- Consumes: `reconcile`, `nameKey`, `providersGateOk`, `catalogFloorOk` from `../lib/rainbetReconcile` (Task 1).
- Produces: a CLI entrypoint. Writes `rainbet_slots.json` (pruned) + `rainbet_live_names.json` (artifact). `--dry-run` writes nothing and prints the would-sweep list.

- [ ] **Step 1: Write the script**

Create `scripts/reconcile_rainbet.js`:

```js
#!/usr/bin/env node
//
// Daily reconciliation: authoritatively enumerate Rainbet's live catalog via the
// games API (per-provider, region-inclusive) and mark-then-sweep stale entries from
// rainbet_slots.json, plus emit rainbet_live_names.json (gates the slot.report merge
// in lib/slots.js). Runs headed under xvfb in GitHub Actions — a bare fetch/curl 403s
// (Cloudflare), so the API is called from a CF-cleared patchright page via page.evaluate.
//
// Local dry-run (Windows desktop, real display):
//   SCRAPE_HEADLESS=false node scripts/reconcile_rainbet.js --dry-run

const fs = require('fs');
const path = require('path');
const { reconcile, nameKey, providersGateOk, catalogFloorOk } = require('../lib/rainbetReconcile');

const ROOT = process.cwd();
const SLOTS_FILE = path.join(ROOT, 'rainbet_slots.json');
const LIVE_NAMES_FILE = path.join(ROOT, 'rainbet_live_names.json');

const PROVIDERS_URL = 'https://services.rainbet.com/v1/public/providers/list?country=US';
const GAMES_URL = 'https://services.rainbet.com/v1/public/games/list';

const HEADLESS = process.env.SCRAPE_HEADLESS !== 'false';
const CF_TITLE_MARKERS = ['just a moment', 'attention required', 'cloudflare', 'checking your browser'];
const isCfTitle = t => { const s = (t || '').toLowerCase(); return CF_TITLE_MARKERS.some(m => s.includes(m)); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

// One API GET from inside the CF-cleared page (inherits Cloudflare cookies).
function apiGet(page, url) {
  return page.evaluate(async (u) => {
    const r = await fetch(u, { headers: { accept: 'application/json' } });
    let body = null;
    try { body = await r.json(); } catch {}
    return { status: r.status, body };
  }, url);
}

async function clearCloudflare(page) {
  await page.goto('https://rainbet.com/casino/slots', { waitUntil: 'domcontentloaded', timeout: 60000 });
  for (let i = 0; i < 30; i++) {
    const title = await page.title().catch(() => '');
    if (!isCfTitle(title)) return true;
    await sleep(2000);
  }
  return false;
}

async function enumerateLiveNames(page) {
  const provRes = await apiGet(page, PROVIDERS_URL);
  const providers = ((provRes.body && (provRes.body.providers || provRes.body)) || [])
    .map(p => p.url).filter(Boolean);

  const liveNames = new Set();
  let gameCount = 0;

  for (const prov of providers) {
    let cursor = null;
    do {
      const url = `${GAMES_URL}?provider=${encodeURIComponent(prov)}&country=US&region=IA&limit=64`
        + (cursor ? `&cursor=${encodeURIComponent(cursor)}` : '');
      let res = await apiGet(page, url);
      // Aggressive rate limit: back off 90s and retry the same page.
      let guard = 0;
      while (res.status === 429 && guard++ < 5) { await sleep(90000); res = await apiGet(page, url); }
      if (res.status !== 200 || !res.body) break;
      for (const g of (res.body.games || [])) { liveNames.add(nameKey(g.name)); gameCount++; }
      cursor = res.body.next_cursor || null;
      await sleep(1800); // throttle
    } while (cursor);
  }

  return { liveNames, providerCount: providers.length, gameCount };
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const { chromium } = require('patchright');

  const browser = await chromium.launch({ headless: HEADLESS });
  let liveNames, providerCount, gameCount;
  try {
    const ctx = await browser.newContext({ userAgent: 'Mozilla/5.0' });
    const page = await ctx.newPage();
    if (!(await clearCloudflare(page))) {
      console.error('[reconcile] Cloudflare did not clear — aborting, no write');
      process.exit(1);
    }
    ({ liveNames, providerCount, gameCount } = await enumerateLiveNames(page));
  } finally {
    await browser.close().catch(() => {});
  }

  const entries = JSON.parse(fs.readFileSync(SLOTS_FILE, 'utf8'));

  // Safety gates — a broken/rate-limited crawl must never sweep the catalog.
  if (!providersGateOk(providerCount)) {
    console.error(`[reconcile] provider gate failed (got ${providerCount}, need >= 20) — no write`);
    process.exit(1);
  }
  if (!catalogFloorOk(liveNames.size, entries.length)) {
    console.error(`[reconcile] catalog-floor gate failed (live ${liveNames.size} vs catalog ${entries.length}) — no write`);
    process.exit(1);
  }

  const r = reconcile(entries, liveNames, { graceDays: 3 });
  console.log(`[reconcile] providers=${providerCount} games=${gameCount} live=${liveNames.size} | marked=${r.marked} cleared=${r.cleared} swept=${r.swept}`);
  if (r.markedNames.length) console.log(`[reconcile] newly marked: ${r.markedNames.slice(0, 30).join(', ')}${r.markedNames.length > 30 ? ' …' : ''}`);
  if (r.sweptNames.length) console.log(`[reconcile] swept: ${r.sweptNames.slice(0, 30).join(', ')}${r.sweptNames.length > 30 ? ' …' : ''}`);

  if (dryRun) {
    console.log('[reconcile] --dry-run: no files written');
    return;
  }

  fs.writeFileSync(SLOTS_FILE, JSON.stringify(r.entries, null, 2) + '\n');
  fs.writeFileSync(LIVE_NAMES_FILE, JSON.stringify({ generatedAt: new Date().toISOString(), names: [...liveNames].sort() }) + '\n');
  console.log(`[reconcile] wrote ${SLOTS_FILE} (${r.entries.length} entries) + ${LIVE_NAMES_FILE} (${liveNames.size} names)`);
}

main().catch(e => { console.error('[reconcile] fatal:', e); process.exit(1); });
```

- [ ] **Step 2: Verify it parses/loads without crashing**

Run: `node -e "require('./scripts/reconcile_rainbet.js')" 2>&1 | head -5` is NOT valid (the script self-runs). Instead syntax-check:
Run: `node --check scripts/reconcile_rainbet.js`
Expected: no output, exit 0 (syntactically valid).

- [ ] **Step 3: Local dry-run against real Rainbet (manual integration validation)**

On the Windows desktop with a real display:
Run: `SCRAPE_HEADLESS=false node scripts/reconcile_rainbet.js --dry-run`
Expected: logs `providers=56 games=<thousands> live=<thousands> | marked=N cleared=0 swept=0`, prints a "newly marked" list, and `--dry-run: no files written`. Spot-check 2-3 names in the "newly marked" list on rainbet.com to confirm they are genuinely delisted. If the marked list contains obviously-live games, STOP — the crawl or matching is wrong; do not proceed to arm the workflow.

- [ ] **Step 4: Commit**

```bash
git add scripts/reconcile_rainbet.js
git commit -m "feat: rainbet reconciliation crawl script (--dry-run supported)"
```

---

### Task 4: Scheduled GitHub Actions workflow

**Files:**
- Create: `.github/workflows/reconcile-rainbet-slots.yml`

**Interfaces:**
- Consumes: `scripts/reconcile_rainbet.js` (Task 3).

- [ ] **Step 1: Write the workflow (armed for manual first, schedule commented)**

Create `.github/workflows/reconcile-rainbet-slots.yml`. Ship with the schedule present but start by running it via `workflow_dispatch` until a couple of manual runs confirm the sweep list is clean.

```yaml
name: Reconcile Rainbet catalog (prune stale)

# Authoritatively enumerates Rainbet's live catalog (games API, per-provider,
# region-inclusive) and mark-then-sweeps stale entries from rainbet_slots.json,
# plus emits rainbet_live_names.json (gates the slot.report merge). Runs OFF
# Railway's IP so it never contends with the in-process 10-min live sync.
on:
  workflow_dispatch: {}
  schedule:
    - cron: '0 9 * * *'   # daily ~09:00 UTC; grace period tolerates Actions timing drift

permissions:
  contents: write

jobs:
  reconcile:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
      - name: Checkout
        uses: actions/checkout@v5

      - name: Setup Node
        uses: actions/setup-node@v5
        with:
          node-version: '22'

      - name: Install dependencies
        run: npm ci

      - name: Install Chromium for Playwright
        run: npx playwright install --with-deps chromium

      - name: Install xvfb (headed browser needs a virtual display)
        run: sudo apt-get update && sudo apt-get install -y xvfb

      - name: Run reconciliation
        env:
          SCRAPE_HEADLESS: 'false'
        run: xvfb-run -a node scripts/reconcile_rainbet.js

      - name: Commit & push if catalog changed
        run: |
          if [ -z "$(git status --porcelain rainbet_slots.json rainbet_live_names.json)" ]; then
            echo "No changes to commit."
            exit 0
          fi
          git config user.name "rainbet-slots-bot"
          git config user.email "actions@users.noreply.github.com"
          git add rainbet_slots.json rainbet_live_names.json
          git commit -m "auto: reconcile rainbet catalog ($(date -u +%Y-%m-%d))"
          # The Railway live sync may have pushed a new-releases commit meanwhile.
          git pull --rebase origin main || { echo "rebase failed"; exit 1; }
          git push
```

- [ ] **Step 2: Validate the YAML**

Run: `node -e "const fs=require('fs');const s=fs.readFileSync('.github/workflows/reconcile-rainbet-slots.yml','utf8');if(!/reconcile_rainbet\.js/.test(s)||!/schedule/.test(s))throw new Error('workflow missing key content');console.log('workflow ok')"`
Expected: prints `workflow ok`.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/reconcile-rainbet-slots.yml
git commit -m "ci: daily rainbet catalog reconciliation workflow"
```

- [ ] **Step 4: Arm — rollout gate (manual, after merge)**

After pushing to `main`: trigger the workflow manually from the Actions tab (`workflow_dispatch`) once. Inspect the run log's `swept:`/`newly marked:` lines and the resulting commit diff. Confirm swept names are genuine delistings (spot-check on rainbet.com). Only once a manual run's sweep list is verified clean is the daily `schedule` trusted to run unattended. If a run's gates abort (non-zero exit), that's the safety net working — investigate the crawl, do not loosen the gates without cause.

---

## Notes for the implementer

- Run each task's tests from the backend repo root (`C:\Users\kylew\communityhunts-backend`).
- The live 10-min sync (`lib/rainbetSlotSync.js` / `check_new_slots.js`) is **unchanged** by this plan — it stays add-only. This job is the only remover.
- If a local backend is running on `:3001` during work, it rewrites `rainbet_slots.json` on its own timer (stale in-memory config) — stop it before committing catalog changes to avoid churn/merge conflicts.
