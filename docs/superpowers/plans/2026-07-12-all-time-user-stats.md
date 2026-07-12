# Durable All-Time Per-User Hunt Stats — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist every completed hunt durably per-row and maintain a per-user, per-tenant rollup so users see their own all-time stats (dropdown box) and admins see anyone's, with correct USD conversion of mixed currencies.

**Architecture:** Additive to the existing 100-cap `archive` blob. Three new Postgres tables (`hunt_history` raw rows, `hunt_participants` index, `user_hunt_stats` materialized rollup) plus an `fx_rates` cache. On hunt archive, we record the hunt and recompute each participant's rollup by running the existing pure `computeUserHuntStats` (extended) over that user's rows — the rollup is a refreshed cache, not incremental deltas. Reads are a single indexed SELECT with a compute-and-populate fallback.

**Tech Stack:** Node.js/Express, PostgreSQL (`pg`), `axios` for FX fetch, `node:test` + `node:assert` for tests. Frontend: React 18 (sibling repo `communityhunts-frontend`), no test runner — verified via `CI=true npm run build` + Vercel preview.

## Global Constraints

- **Backend repo:** `C:\Users\kylew\communityhunts-backend` (GitHub `RandyCabbages/communityhunts-backend`, Railway auto-deploy on push to `main`). **Do not push to `main`** during this work — commit to branch `feat/all-time-user-stats`.
- **Frontend repo:** `C:\Users\kylew\communityhunts-frontend` (GitHub `GooferG/communityhunts-frontend`, Vercel auto-deploy on push to `main`). **Never push to `main`** — branch + preview URL; `CI=true npm run build` must print "Compiled successfully" (warnings are errors).
- **Shared-state rule:** `hunts` and `archive` are mutable singletons owned by `lib/persistence.js` — never reassign, only mutate.
- **Tenant scope:** everything keyed by `tenantId`; untagged hunts default to `'bean'` (`tenantOf`/`h.tenantId || 'bean'`).
- **Currencies:** `['USD','GBP','AUD','CAD','ARS']` (`huntsCore.CURRENCIES`). USD is base.
- **FX source:** `https://open.er-api.com/v6/latest/USD` (free, keyless, latest-only). USD rate = `1 / table[currency]`. Failure → `null` rate, hunt counted natively.
- **Purity rule:** `lib/userStats.js` stays a pure function — no I/O; it reads `usdRate` off each hunt object.
- **File discipline (frontend):** new UI → new file; tokens via `useTheme()` only; no god-files; gate via `src/auth/roles.js`; palette is violet/Inter (`#0a0710` bg, accent `#a78bfa`→`#7c3aed`, win `#b6ff2e`, loss `#ff6b6b`).
- **Run one test file:** `node --test lib/<name>.test.js`.
- **Commit style:** Conventional Commits; backend commits end with `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`; frontend commits carry **no** `Co-Authored-By` trailer (repo rule).

---

## File Structure

**Backend (create):**
- `lib/fxRates.js` — FX adapter factory over er-api + `fx_rates` cache table.
- `lib/fxRates.test.js` — unit tests (injected HTTP + pool).
- `lib/statsStore.js` — owns the three stats tables; hunt-key/participant derivation, record/remove, recompute, read-with-fallback.
- `lib/statsStore.test.js` — unit tests (injected fake pool).
- `scripts/backfill-hunt-history.js` — one-shot idempotent backfill from `archive` + live hunts.

**Backend (modify):**
- `lib/userStats.js` — extend the pure aggregator (per-currency + USD, records/streaks, per-slot/per-caller).
- `lib/userStats.test.js` — extend with new-metric tests.
- `lib/persistence.js` — call `statsStore.recordHunt` / `removeHunt` from `archiveHunt` / `unarchiveHunt` (fire-and-forget); accept a `statsStore` via `initPersistence`.
- `server.js` — construct `fxRates` + `statsStore`, pass into `initPersistence` and into `settingsRoutes` deps.
- `routes/settings.routes.js` — add `GET /api/my-stats`; swap the admin profile `stats` to read the rollup.

**Frontend (create):**
- `src/stats/StatsBox.js` — compact personal-stats panel for the account dropdown; reuses `StatsView` renderer; adds native⇄USD toggle.

**Frontend (modify):**
- account dropdown host (`src/hunt/HuntTopBar.js` + `src/pages/hub/HubNav.js`) — add the "📊 My Stats" entry.
- `src/admin/userProfile/ProfileCharts.js` + `PastHunts.js` — render new metric sections.

---

## Task 1: FX rate adapter (`lib/fxRates.js`)

**Files:**
- Create: `lib/fxRates.js`
- Test: `lib/fxRates.test.js`

**Interfaces:**
- Produces: `module.exports = function makeFxRates({ pgPool, httpGet })` → returns
  `{ ensureTable(): Promise<void>, getUsdRate(currency: string, date: string): Promise<number|null> }`.
  `date` is a `YYYY-MM-DD` string (UTC). `httpGet` defaults to `require('axios').get`; injectable for tests. Returns USD value of 1 unit of `currency` (USD → `1.0`), or `null` on failure.

- [ ] **Step 1: Write the failing test**

```js
// lib/fxRates.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const makeFxRates = require('./fxRates');

// Fake pg pool: records queries, returns canned rows by matcher.
function fakePool(handlers = []) {
  const calls = [];
  return {
    calls,
    query: async (sql, params = []) => {
      calls.push({ sql, params });
      for (const h of handlers) if (h.match.test(sql)) return h.rows(params);
      return { rows: [] };
    },
  };
}

test('USD short-circuits to 1.0 without HTTP or DB', async () => {
  let httpCalled = false;
  const fx = makeFxRates({ pgPool: fakePool(), httpGet: async () => { httpCalled = true; } });
  assert.strictEqual(await fx.getUsdRate('USD', '2026-07-12'), 1);
  assert.strictEqual(httpCalled, false);
});

test('cache hit returns stored rate without HTTP', async () => {
  let httpCalled = false;
  const pool = fakePool([{ match: /SELECT usd_rate FROM fx_rates/i, rows: () => ({ rows: [{ usd_rate: '0.00105' }] }) }]);
  const fx = makeFxRates({ pgPool: pool, httpGet: async () => { httpCalled = true; } });
  assert.strictEqual(await fx.getUsdRate('ARS', '2026-07-12'), 0.00105);
  assert.strictEqual(httpCalled, false);
});

test('cache miss fetches er-api, derives 1/table, caches, returns', async () => {
  const pool = fakePool([{ match: /SELECT usd_rate FROM fx_rates/i, rows: () => ({ rows: [] }) }]);
  const httpGet = async (url) => {
    assert.match(url, /open\.er-api\.com\/v6\/latest\/USD/);
    return { data: { result: 'success', rates: { USD: 1, ARS: 1000, GBP: 0.8 } } };
  };
  const fx = makeFxRates({ pgPool: pool, httpGet });
  const rate = await fx.getUsdRate('ARS', '2026-07-12');
  assert.ok(Math.abs(rate - 0.001) < 1e-9);                       // 1/1000
  assert.ok(pool.calls.some(c => /INSERT INTO fx_rates/i.test(c.sql))); // cached
});

test('HTTP failure returns null', async () => {
  const pool = fakePool([{ match: /SELECT usd_rate FROM fx_rates/i, rows: () => ({ rows: [] }) }]);
  const fx = makeFxRates({ pgPool: pool, httpGet: async () => { throw new Error('network'); } });
  assert.strictEqual(await fx.getUsdRate('ARS', '2026-07-12'), null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test lib/fxRates.test.js`
Expected: FAIL — `Cannot find module './fxRates'`.

- [ ] **Step 3: Write minimal implementation**

```js
// lib/fxRates.js
// FX adapter over open.er-api.com (same source the frontend CurrencySwitch uses).
// Latest-only: exact when we capture at archive time; backfill stamps today's rate (approx).
const FX_URL = 'https://open.er-api.com/v6/latest/USD';
const MEM_TTL = 12 * 60 * 60 * 1000; // mirror the frontend's 12h cache

module.exports = function makeFxRates({ pgPool, httpGet }) {
  const get = httpGet || require('axios').get;
  let mem = null; // { ts, rates }

  async function ensureTable() {
    if (!pgPool) return;
    await pgPool.query(`
      CREATE TABLE IF NOT EXISTS fx_rates (
        currency TEXT NOT NULL,
        date     DATE NOT NULL,
        usd_rate NUMERIC NOT NULL,
        PRIMARY KEY (currency, date)
      )`);
  }

  async function fetchTable() {
    if (mem && Date.now() - mem.ts < MEM_TTL) return mem.rates;
    const res = await get(FX_URL);
    const d = res && res.data;
    if (!d || d.result !== 'success' || !d.rates) throw new Error('fx: bad response');
    mem = { ts: Date.now(), rates: d.rates };
    return d.rates;
  }

  async function getUsdRate(currency, date) {
    const cur = String(currency || 'USD').toUpperCase();
    if (cur === 'USD') return 1;
    if (pgPool) {
      const r = await pgPool.query('SELECT usd_rate FROM fx_rates WHERE currency=$1 AND date=$2', [cur, date]);
      if (r.rows[0]) return Number(r.rows[0].usd_rate);
    }
    try {
      const rates = await fetchTable();
      const per = Number(rates[cur]);
      if (!isFinite(per) || per <= 0) return null;
      const usdRate = 1 / per;
      if (pgPool) {
        await pgPool.query(
          `INSERT INTO fx_rates (currency, date, usd_rate) VALUES ($1,$2,$3)
           ON CONFLICT (currency, date) DO NOTHING`, [cur, date, usdRate]);
      }
      return usdRate;
    } catch (e) {
      console.error('[fx] rate lookup failed:', e.message);
      return null;
    }
  }

  return { ensureTable, getUsdRate };
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test lib/fxRates.test.js`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/fxRates.js lib/fxRates.test.js
git commit -m "feat(stats): FX adapter over er-api with fx_rates cache

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: Extend `computeUserHuntStats` — per-currency + USD aggregation

**Files:**
- Modify: `lib/userStats.js` (add per-hunt `usdRate` read + `byCurrency` and `usd` blocks to the return)
- Test: `lib/userStats.test.js` (extend)

**Interfaces:**
- Consumes: each hunt object may carry `usdRate` (number) and `approx` (bool) — added to snapshots by Task 5. Absent `usdRate` ⇒ treat as unconverted for USD sums.
- Produces: `computeUserHuntStats(hunts, userId)` return gains:
  - `byCurrency: { [CODE]: { hunts, wagered, won, net, avgStart } }`
  - `usd: { wagered, won, net, avgStart, unconvertedCount }` (net/won/wagered summed as `nativeValue * usdRate`, skipping hunts with no rate; `unconvertedCount` counts skipped hunts)

- [ ] **Step 1: Write the failing test**

```js
// append to lib/userStats.test.js
test('byCurrency splits mixed-currency hunts, never cross-summing', () => {
  const mixed = [
    { user: { id: 'u' }, currency: 'USD', usdRate: 1, archivedAt: '2026-07-01T00:00:00Z',
      equity: [{ id: 'u', amount: 100 }], bonuses: [{ bet: 10, win: 150, mult: 15 }] },
    { user: { id: 'u' }, currency: 'ARS', usdRate: 0.001, archivedAt: '2026-07-02T00:00:00Z',
      equity: [{ id: 'u', amount: 100000 }], bonuses: [{ bet: 1000, win: 50000, mult: 50 }] },
  ];
  const s = computeUserHuntStats(mixed, 'u');
  assert.strictEqual(s.byCurrency.USD.hunts, 1);
  assert.strictEqual(s.byCurrency.ARS.hunts, 1);
  assert.strictEqual(s.byCurrency.USD.net, 50);       // 150 - 100
  assert.strictEqual(s.byCurrency.ARS.net, -50000);   // 50000 - 100000
});

test('usd block normalizes via usdRate and counts unconverted', () => {
  const mixed = [
    { user: { id: 'u' }, currency: 'USD', usdRate: 1, archivedAt: '2026-07-01T00:00:00Z',
      equity: [{ id: 'u', amount: 100 }], bonuses: [{ bet: 10, win: 150, mult: 15 }] },
    { user: { id: 'u' }, currency: 'ARS', usdRate: 0.001, archivedAt: '2026-07-02T00:00:00Z',
      equity: [{ id: 'u', amount: 100000 }], bonuses: [{ bet: 1000, win: 50000, mult: 50 }] },
    { user: { id: 'u' }, currency: 'GBP', archivedAt: '2026-07-03T00:00:00Z', // no usdRate
      equity: [{ id: 'u', amount: 80 }], bonuses: [{ bet: 8, win: 8, mult: 1 }] },
  ];
  const s = computeUserHuntStats(mixed, 'u');
  // USD net 50 + ARS (-50000 * 0.001 = -50) => 0 ; GBP skipped
  assert.strictEqual(s.usd.net, 0);
  assert.strictEqual(s.usd.unconvertedCount, 1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test lib/userStats.test.js`
Expected: FAIL — `s.byCurrency` is undefined.

- [ ] **Step 3: Write minimal implementation**

In `lib/userStats.js`, inside `computeUserHuntStats`, add accumulators in the per-hunt loop and emit the new blocks. Add near the other `let` accumulators (line ~28):

```js
  const curMap = new Map();   // code -> { hunts, wagered, won, net, potSum }
  let usdWagered = 0, usdWon = 0, usdNet = 0, usdStartSum = 0, usdConv = 0, usdUnconv = 0;
```

Inside the `for (const h of mine)` loop, after `result` is computed (after line ~49), add:

```js
    const code = h.currency || 'USD';
    const cc = curMap.get(code) || { hunts: 0, wagered: 0, won: 0, net: 0, potSum: 0 };
    cc.hunts++; cc.wagered += hw; cc.won += hn; cc.net += result; cc.potSum += pot;
    curMap.set(code, cc);

    const rate = (typeof h.usdRate === 'number' && isFinite(h.usdRate)) ? h.usdRate : null;
    if (rate != null) {
      usdWagered += hw * rate; usdWon += hn * rate; usdNet += result * rate;
      usdStartSum += pot * rate; usdConv++;
    } else {
      usdUnconv++;
    }
```

Before the `return`, build the output blocks:

```js
  const byCurrency = {};
  for (const [code, c] of curMap) byCurrency[code] = {
    hunts: c.hunts, wagered: c.wagered, won: c.won, net: c.net,
    avgStart: c.hunts ? c.potSum / c.hunts : 0,
  };
  const usd = {
    wagered: usdWagered, won: usdWon, net: usdNet,
    avgStart: usdConv ? usdStartSum / usdConv : 0,
    unconvertedCount: usdUnconv,
  };
```

Add `byCurrency, usd,` to the returned object.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test lib/userStats.test.js`
Expected: PASS (all prior + 2 new).

- [ ] **Step 5: Commit**

```bash
git add lib/userStats.js lib/userStats.test.js
git commit -m "feat(stats): per-currency + USD-normalized aggregates

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: Extend `computeUserHuntStats` — records & streaks

**Files:**
- Modify: `lib/userStats.js`
- Test: `lib/userStats.test.js`

**Interfaces:**
- Produces: return gains `records: { biggestWin, biggestWinUsd, highestMult, bestHuntNet, worstHuntNet, longestWinStreak, longestLossStreak }`. A hunt is a "win" when its `result > 0`. Streaks computed over `pastHunts` ordered oldest→newest.

- [ ] **Step 1: Write the failing test**

```js
// append to lib/userStats.test.js
test('records: biggest win, highest mult, best/worst hunt net', () => {
  const hs = [
    { user: { id: 'u' }, currency: 'USD', usdRate: 1, archivedAt: '2026-07-01T00:00:00Z',
      equity: [{ id: 'u', amount: 100 }], bonuses: [{ bet: 10, win: 500, mult: 50 }] },      // net +400
    { user: { id: 'u' }, currency: 'USD', usdRate: 1, archivedAt: '2026-07-02T00:00:00Z',
      equity: [{ id: 'u', amount: 100 }], bonuses: [{ bet: 10, win: 20, mult: 2 }] },         // net -80
  ];
  const s = computeUserHuntStats(hs, 'u');
  assert.strictEqual(s.records.biggestWin, 500);
  assert.strictEqual(s.records.highestMult, 50);
  assert.strictEqual(s.records.bestHuntNet, 400);
  assert.strictEqual(s.records.worstHuntNet, -80);
});

test('records: win/loss streaks over chronological order', () => {
  const mk = (d, amt, win) => ({ user: { id: 'u' }, currency: 'USD', usdRate: 1,
    archivedAt: d, equity: [{ id: 'u', amount: amt }], bonuses: [{ bet: 10, win, mult: win / 10 }] });
  const hs = [ mk('2026-07-01T00:00:00Z', 100, 200),  // win
               mk('2026-07-02T00:00:00Z', 100, 300),  // win
               mk('2026-07-03T00:00:00Z', 100, 10),   // loss
               mk('2026-07-04T00:00:00Z', 100, 5) ];  // loss
  const s = computeUserHuntStats(hs, 'u');
  assert.strictEqual(s.records.longestWinStreak, 2);
  assert.strictEqual(s.records.longestLossStreak, 2);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test lib/userStats.test.js`
Expected: FAIL — `s.records` is undefined.

- [ ] **Step 3: Write minimal implementation**

In `lib/userStats.js`, after `pastHunts.sort(...)` (line ~91), compute records from `pastHunts` (each row has `result`, `endBalance`, `startBalance`) and per-bonus extremes. Track `biggestWin` and `highestMult` inside the bonus loop (add near line ~77):

```js
      // (inside `for (const b of bonuses)`)
      const w = Number(b.win) || 0; if (w > biggestWin) biggestWin = w;
      const mm = Number(b.mult) || 0; if (mm > highestMult) highestMult = mm;
```

Declare with the other accumulators (line ~28): `let biggestWin = 0, highestMult = 0;`

After the sort, add:

```js
  const chron = [...pastHunts].sort((a, b) => new Date(a.date) - new Date(b.date));
  let bestHuntNet = 0, worstHuntNet = 0, wStreak = 0, lStreak = 0, wRun = 0, lRun = 0;
  if (chron.length) { bestHuntNet = -Infinity; worstHuntNet = Infinity; }
  for (const h of chron) {
    if (h.result > bestHuntNet) bestHuntNet = h.result;
    if (h.result < worstHuntNet) worstHuntNet = h.result;
    if (h.result > 0) { wRun++; lRun = 0; } else { lRun++; wRun = 0; }
    if (wRun > wStreak) wStreak = wRun;
    if (lRun > lStreak) lStreak = lRun;
  }
  if (!chron.length) { bestHuntNet = 0; worstHuntNet = 0; }
  const records = {
    biggestWin, biggestWinUsd: biggestWin, highestMult,
    bestHuntNet, worstHuntNet, longestWinStreak: wStreak, longestLossStreak: lStreak,
  };
```

Add `records,` to the returned object. (`biggestWinUsd` is a placeholder equal to native for now; per-currency USD extremes are out of scope — the `usd` block already carries normalized totals.)

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test lib/userStats.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/userStats.js lib/userStats.test.js
git commit -m "feat(stats): records + win/loss streaks

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: Extend `computeUserHuntStats` — per-slot & per-caller breakdowns

**Files:**
- Modify: `lib/userStats.js`
- Test: `lib/userStats.test.js`

**Interfaces:**
- Produces: return gains
  - `bySlot: [{ slot, hunts, bet, win, x }]` sorted by `win` desc (a slot appears once per hunt it's in; `hunts` counts distinct hunts containing it)
  - `byCaller: [{ caller, bet, win, x }]` sorted by `x` desc, money-weighted (`x = win / bet`), only callers with `bet > 0`

- [ ] **Step 1: Write the failing test**

```js
// append to lib/userStats.test.js
test('bySlot aggregates a slot across hunts', () => {
  const hs = [
    { user: { id: 'u' }, currency: 'USD', usdRate: 1, archivedAt: '2026-07-01T00:00:00Z',
      equity: [{ id: 'u', amount: 100 }],
      bonuses: [{ slot: 'Gates of Olympus', bet: 10, win: 100, mult: 10 },
                { slot: 'Sugar Rush', bet: 10, win: 5, mult: 0.5 }] },
    { user: { id: 'u' }, currency: 'USD', usdRate: 1, archivedAt: '2026-07-02T00:00:00Z',
      equity: [{ id: 'u', amount: 100 }],
      bonuses: [{ slot: 'Gates of Olympus', bet: 10, win: 40, mult: 4 }] },
  ];
  const s = computeUserHuntStats(hs, 'u');
  const gates = s.bySlot.find(r => r.slot === 'Gates of Olympus');
  assert.strictEqual(gates.hunts, 2);
  assert.strictEqual(gates.bet, 20);
  assert.strictEqual(gates.win, 140);
});

test('byCaller is money-weighted and sorted by x desc', () => {
  const hs = [
    { user: { id: 'u' }, currency: 'USD', usdRate: 1, archivedAt: '2026-07-01T00:00:00Z',
      equity: [{ id: 'u', amount: 100 }],
      bonuses: [{ slot: 'A', caller: 'alice', bet: 10, win: 200, mult: 20 },
                { slot: 'B', caller: 'bob', bet: 10, win: 5, mult: 0.5 }] },
  ];
  const s = computeUserHuntStats(hs, 'u');
  assert.strictEqual(s.byCaller[0].caller, 'alice');
  assert.strictEqual(s.byCaller[0].x, 20);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test lib/userStats.test.js`
Expected: FAIL — `s.bySlot` undefined.

- [ ] **Step 3: Write minimal implementation**

In `lib/userStats.js`, add accumulators (line ~28):

```js
  const slotMap = new Map();      // slot -> { hunts, bet, win }
  const callerAll = new Map();    // caller -> { bet, win }
```

Inside the `for (const h of mine)` loop, after the existing per-hunt caller block, add (dedup slot-per-hunt with a local set):

```js
    const seenSlots = new Set();
    for (const b of bonuses) {
      const slot = String(b.slot || '').trim();
      if (slot) {
        const sm = slotMap.get(slot) || { hunts: 0, bet: 0, win: 0 };
        if (!seenSlots.has(slot)) { sm.hunts++; seenSlots.add(slot); }
        sm.bet += Number(b.bet) || 0; sm.win += Number(b.win) || 0;
        slotMap.set(slot, sm);
      }
      const caller = String(b.caller || '').trim();
      if (caller) {
        const cm = callerAll.get(caller) || { bet: 0, win: 0 };
        cm.bet += Number(b.bet) || 0; cm.win += Number(b.win) || 0;
        callerAll.set(caller, cm);
      }
    }
```

Before the `return`, build the arrays:

```js
  const bySlot = [...slotMap.entries()]
    .map(([slot, v]) => ({ slot, hunts: v.hunts, bet: v.bet, win: v.win, x: v.bet > 0 ? v.win / v.bet : 0 }))
    .sort((a, b) => b.win - a.win);
  const byCaller = [...callerAll.entries()]
    .filter(([, v]) => v.bet > 0)
    .map(([caller, v]) => ({ caller, bet: v.bet, win: v.win, x: v.win / v.bet }))
    .sort((a, b) => b.x - a.x);
```

Add `bySlot, byCaller,` to the returned object.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test lib/userStats.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/userStats.js lib/userStats.test.js
git commit -m "feat(stats): per-slot + per-caller breakdowns

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 5: `statsStore` — pure derivation helpers (hunt key + participants)

**Files:**
- Create: `lib/statsStore.js`
- Test: `lib/statsStore.test.js`

**Interfaces:**
- Produces: `module.exports = function makeStatsStore({ pgPool, fxRates })` → returns an object exposing (this task) `huntKey(hunt): string` and `participantsOf(hunt): Array<{ userId, role }>`. Later tasks add `ensureTables`, `recordHunt`, `removeHunt`, `recomputeUser`, `getUserStats`.
- `huntKey`: `hunt.huntId` if truthy, else `` `${hunt.user?.id}|${hunt.startedAt}` `` (matches `persistence.sameHuntInstance`).
- `participantsOf`: host (`hunt.user.id`, role `'host'`) plus each `hunt.equity[].id` (role `'member'`), deduped, excluding falsy ids and the auto placeholders `creator_auto`/`bean_auto` only when they carry no real amount... **keep all equity ids that are real** — include `creator_auto`/`bean_auto` (they map to real people via branding); dedup by id, host role wins over member.

- [ ] **Step 1: Write the failing test**

```js
// lib/statsStore.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const makeStatsStore = require('./statsStore');

const store = makeStatsStore({ pgPool: null, fxRates: null });

test('huntKey prefers huntId, falls back to user|startedAt', () => {
  assert.strictEqual(store.huntKey({ huntId: 'H1' }), 'H1');
  assert.strictEqual(store.huntKey({ user: { id: 'u' }, startedAt: 'T0' }), 'u|T0');
});

test('participantsOf returns host + equity members, deduped, host wins', () => {
  const p = store.participantsOf({
    user: { id: 'u1' },
    equity: [{ id: 'u1', amount: 50 }, { id: 'u2', amount: 50 }, { id: '', amount: 0 }],
  });
  const map = Object.fromEntries(p.map(x => [x.userId, x.role]));
  assert.strictEqual(map.u1, 'host');   // host role wins over its equity row
  assert.strictEqual(map.u2, 'member');
  assert.strictEqual(p.length, 2);      // empty id dropped
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test lib/statsStore.test.js`
Expected: FAIL — `Cannot find module './statsStore'`.

- [ ] **Step 3: Write minimal implementation**

```js
// lib/statsStore.js
// Durable per-hunt history + per-user rollup. Additive to the 100-cap archive.
const { computeUserHuntStats } = require('./userStats');

module.exports = function makeStatsStore({ pgPool, fxRates }) {
  function huntKey(hunt) {
    if (hunt && hunt.huntId) return String(hunt.huntId);
    return `${hunt?.user?.id}|${hunt?.startedAt}`;
  }

  function participantsOf(hunt) {
    const out = new Map(); // userId -> role
    const hostId = hunt?.user?.id;
    for (const e of (hunt?.equity || [])) {
      const id = e && e.id;
      if (id) out.set(String(id), 'member');
    }
    if (hostId) out.set(String(hostId), 'host'); // host wins
    return [...out.entries()].map(([userId, role]) => ({ userId, role }));
  }

  return { huntKey, participantsOf };
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test lib/statsStore.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/statsStore.js lib/statsStore.test.js
git commit -m "feat(stats): statsStore hunt-key + participant derivation

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 6: `statsStore` — tables + recompute + write path

**Files:**
- Modify: `lib/statsStore.js`
- Test: `lib/statsStore.test.js`

**Interfaces:**
- Produces (added to the returned object):
  - `ensureTables(): Promise<void>` — CREATE TABLE IF NOT EXISTS for `hunt_history`, `hunt_participants`, `user_hunt_stats`; also calls `fxRates.ensureTable()`.
  - `recomputeUser(tenantId, userId): Promise<void>` — reads that user's hunt snapshots (participants ⋈ history), runs `computeUserHuntStats`, upserts `user_hunt_stats`.
  - `recordHunt(hunt): Promise<void>` — resolves `usdRate`, upserts one `hunt_history` row (carrying `usdRate`/`approx` into `snapshot`), replaces `hunt_participants`, recomputes each participant. Idempotent by `huntKey`.
  - `removeHunt(hunt): Promise<void>` — deletes history+participant rows for the key, recomputes affected participants.
- Consumes: `fxRates.getUsdRate(currency, dateStr)` (Task 1); `huntKey`/`participantsOf` (Task 5).
- `snapshot` JSONB stores the full hunt plus `usdRate` and `approx`. `ended_at` derives from `hunt.archivedAt || updatedAt || createdAt || startedAt`; its `YYYY-MM-DD` slice is the FX date.

- [ ] **Step 1: Write the failing test**

```js
// append to lib/statsStore.test.js
function fakePool() {
  const calls = [];
  const historyRows = [];
  return {
    calls, historyRows,
    query: async (sql, params = []) => {
      calls.push({ sql, params });
      if (/INSERT INTO hunt_history/i.test(sql)) {
        historyRows.push({ hunt_key: params[0], tenant_id: params[1], snapshot: params[7] });
        return { rows: [] };
      }
      if (/SELECT .*snapshot.* FROM hunt_history/i.test(sql)) {
        // params: [tenantId, userId] — return snapshots for that user
        return { rows: historyRows.map(r => ({ snapshot: r.snapshot })) };
      }
      return { rows: [] };
    },
  };
}

test('recordHunt upserts history keyed by huntKey and recomputes participants', async () => {
  const pool = fakePool();
  const fxRates = { ensureTable: async () => {}, getUsdRate: async () => 1 };
  const store = makeStatsStore({ pgPool: pool, fxRates });
  await store.recordHunt({
    huntId: 'H1', tenantId: 'bean', user: { id: 'u1' }, startedAt: 'T0',
    archivedAt: '2026-07-01T00:00:00Z', currency: 'USD',
    equity: [{ id: 'u1', amount: 100 }],
    bonuses: [{ slot: 'A', bet: 10, win: 40, mult: 4 }],
  });
  const ins = pool.calls.find(c => /INSERT INTO hunt_history/i.test(c.sql));
  assert.strictEqual(ins.params[0], 'H1');                                  // hunt_key
  assert.ok(pool.calls.some(c => /ON CONFLICT \(hunt_key\)/i.test(c.sql))); // idempotent upsert
  const roll = pool.calls.find(c => /INSERT INTO user_hunt_stats/i.test(c.sql));
  assert.ok(roll, 'rollup upserted');
  assert.strictEqual(pool.historyRows[0].snapshot.usdRate, 1);             // rate carried into snapshot
});

test('recordHunt with null FX rate still records (unconverted)', async () => {
  const pool = fakePool();
  const fxRates = { ensureTable: async () => {}, getUsdRate: async () => null };
  const store = makeStatsStore({ pgPool: pool, fxRates });
  await store.recordHunt({
    huntId: 'H2', tenantId: 'bean', user: { id: 'u1' }, startedAt: 'T0',
    archivedAt: '2026-07-01T00:00:00Z', currency: 'GBP',
    equity: [{ id: 'u1', amount: 100 }], bonuses: [{ slot: 'A', bet: 10, win: 40, mult: 4 }],
  });
  assert.strictEqual(pool.historyRows[0].snapshot.usdRate, null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test lib/statsStore.test.js`
Expected: FAIL — `store.recordHunt is not a function`.

- [ ] **Step 3: Write minimal implementation**

Add inside `makeStatsStore` (before `return`), and extend the returned object:

```js
  const isoDate = (d) => (d ? new Date(d) : new Date()).toISOString().slice(0, 10);
  const endedAt = (h) => h.archivedAt || h.updatedAt || h.createdAt || h.startedAt || new Date().toISOString();

  async function ensureTables() {
    if (fxRates) await fxRates.ensureTable();
    if (!pgPool) return;
    await pgPool.query(`
      CREATE TABLE IF NOT EXISTS hunt_history (
        hunt_key     TEXT PRIMARY KEY,
        tenant_id    TEXT NOT NULL,
        host_user_id TEXT,
        currency     TEXT,
        usd_rate     NUMERIC,
        started_at   TIMESTAMPTZ,
        ended_at     TIMESTAMPTZ,
        snapshot     JSONB NOT NULL
      )`);
    await pgPool.query(`CREATE INDEX IF NOT EXISTS hunt_history_tenant_ended ON hunt_history (tenant_id, ended_at)`);
    await pgPool.query(`
      CREATE TABLE IF NOT EXISTS hunt_participants (
        hunt_key  TEXT NOT NULL,
        tenant_id TEXT NOT NULL,
        user_id   TEXT NOT NULL,
        role      TEXT,
        PRIMARY KEY (hunt_key, user_id)
      )`);
    await pgPool.query(`CREATE INDEX IF NOT EXISTS hunt_participants_tenant_user ON hunt_participants (tenant_id, user_id)`);
    await pgPool.query(`
      CREATE TABLE IF NOT EXISTS user_hunt_stats (
        tenant_id TEXT NOT NULL,
        user_id   TEXT NOT NULL,
        hunts INT, hosted INT, joined INT,
        wagered_usd NUMERIC, won_usd NUMERIC, net_usd NUMERIC, win_rate NUMERIC,
        avg_start_usd NUMERIC, avg_x NUMERIC, biggest_win NUMERIC, highest_mult NUMERIC,
        best_hunt_net NUMERIC, worst_hunt_net NUMERIC,
        longest_win_streak INT, longest_loss_streak INT, last_hunt_at TIMESTAMPTZ,
        stats JSONB NOT NULL, updated_at TIMESTAMPTZ DEFAULT now(),
        PRIMARY KEY (tenant_id, user_id)
      )`);
  }

  async function userHunts(tenantId, userId) {
    if (!pgPool) return [];
    const r = await pgPool.query(
      `SELECT h.snapshot FROM hunt_history h
         JOIN hunt_participants p ON p.hunt_key = h.hunt_key
        WHERE p.tenant_id = $1 AND p.user_id = $2`, [tenantId, userId]);
    return r.rows.map(row => row.snapshot);
  }

  async function recomputeUser(tenantId, userId) {
    if (!pgPool) return;
    const hunts = await userHunts(tenantId, userId);
    const s = computeUserHuntStats(hunts, userId);
    const t = s.tiles, r = s.records;
    const lastHunt = s.pastHunts[0] ? s.pastHunts[0].date : null;
    await pgPool.query(
      `INSERT INTO user_hunt_stats
         (tenant_id,user_id,hunts,hosted,joined,wagered_usd,won_usd,net_usd,win_rate,
          avg_start_usd,avg_x,biggest_win,highest_mult,best_hunt_net,worst_hunt_net,
          longest_win_streak,longest_loss_streak,last_hunt_at,stats,updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,now())
       ON CONFLICT (tenant_id,user_id) DO UPDATE SET
         hunts=$3,hosted=$4,joined=$5,wagered_usd=$6,won_usd=$7,net_usd=$8,win_rate=$9,
         avg_start_usd=$10,avg_x=$11,biggest_win=$12,highest_mult=$13,best_hunt_net=$14,
         worst_hunt_net=$15,longest_win_streak=$16,longest_loss_streak=$17,last_hunt_at=$18,
         stats=$19,updated_at=now()`,
      [tenantId, userId, t.hunts, t.hosted, t.joined, s.usd.wagered, s.usd.won, s.usd.net,
       t.winRate, s.usd.avgStart, t.avgMult, r.biggestWin, r.highestMult, r.bestHuntNet,
       r.worstHuntNet, r.longestWinStreak, r.longestLossStreak, lastHunt, JSON.stringify(s)]);
  }

  async function recordHunt(hunt) {
    if (!pgPool || !hunt || !hunt.user) return;
    const tenantId = hunt.tenantId || 'bean';
    const key = huntKey(hunt);
    const ended = endedAt(hunt);
    const usdRate = fxRates ? await fxRates.getUsdRate(hunt.currency || 'USD', isoDate(ended)) : null;
    const snapshot = { ...hunt, usdRate, approx: !!hunt._approxRate };
    await pgPool.query(
      `INSERT INTO hunt_history
         (hunt_key,tenant_id,host_user_id,currency,usd_rate,started_at,ended_at,snapshot)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (hunt_key) DO UPDATE SET
         tenant_id=$2,host_user_id=$3,currency=$4,usd_rate=$5,started_at=$6,ended_at=$7,snapshot=$8`,
      [key, tenantId, hunt.user.id, hunt.currency || 'USD', usdRate,
       hunt.startedAt || null, ended, JSON.stringify(snapshot)]);

    const parts = participantsOf(hunt);
    await pgPool.query('DELETE FROM hunt_participants WHERE hunt_key=$1', [key]);
    for (const p of parts) {
      await pgPool.query(
        `INSERT INTO hunt_participants (hunt_key,tenant_id,user_id,role) VALUES ($1,$2,$3,$4)
         ON CONFLICT (hunt_key,user_id) DO UPDATE SET role=$4`,
        [key, tenantId, p.userId, p.role]);
    }
    for (const p of parts) await recomputeUser(tenantId, p.userId);
  }

  async function removeHunt(hunt) {
    if (!pgPool || !hunt) return;
    const tenantId = hunt.tenantId || 'bean';
    const key = huntKey(hunt);
    const parts = participantsOf(hunt);
    await pgPool.query('DELETE FROM hunt_history WHERE hunt_key=$1', [key]);
    await pgPool.query('DELETE FROM hunt_participants WHERE hunt_key=$1', [key]);
    for (const p of parts) await recomputeUser(tenantId, p.userId);
  }
```

Update the return to: `return { huntKey, participantsOf, ensureTables, recomputeUser, recordHunt, removeHunt };`

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test lib/statsStore.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/statsStore.js lib/statsStore.test.js
git commit -m "feat(stats): statsStore tables, recompute, write path

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 7: `statsStore` — read path with fallback

**Files:**
- Modify: `lib/statsStore.js`
- Test: `lib/statsStore.test.js`

**Interfaces:**
- Produces: `getUserStats(tenantId, userId): Promise<object|null>` — returns the parsed `stats` JSONB from `user_hunt_stats`; if no row exists, calls `recomputeUser` then re-reads (compute-and-populate). Returns `null` only when `pgPool` is absent.

- [ ] **Step 1: Write the failing test**

```js
// append to lib/statsStore.test.js
test('getUserStats returns rollup row when present', async () => {
  const pool = {
    calls: [],
    query: async (sql, params = []) => {
      pool.calls.push({ sql, params });
      if (/SELECT stats FROM user_hunt_stats/i.test(sql)) return { rows: [{ stats: { tiles: { hunts: 3 } } }] };
      return { rows: [] };
    },
  };
  const store = makeStatsStore({ pgPool: pool, fxRates: null });
  const s = await store.getUserStats('bean', 'u1');
  assert.strictEqual(s.tiles.hunts, 3);
});

test('getUserStats falls back to recompute when row missing', async () => {
  let selectCount = 0;
  const pool = {
    query: async (sql) => {
      if (/SELECT stats FROM user_hunt_stats/i.test(sql)) {
        selectCount++;
        return selectCount === 1 ? { rows: [] } : { rows: [{ stats: { tiles: { hunts: 0 } } }] };
      }
      if (/FROM hunt_history/i.test(sql)) return { rows: [] };     // recomputeUser reads no hunts
      return { rows: [] };
    },
  };
  const store = makeStatsStore({ pgPool: pool, fxRates: null });
  const s = await store.getUserStats('bean', 'ghost');
  assert.ok(s);                        // recomputed then re-read
  assert.strictEqual(selectCount, 2);  // missed, then hit
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test lib/statsStore.test.js`
Expected: FAIL — `store.getUserStats is not a function`.

- [ ] **Step 3: Write minimal implementation**

Add inside `makeStatsStore`:

```js
  async function readRow(tenantId, userId) {
    const r = await pgPool.query('SELECT stats FROM user_hunt_stats WHERE tenant_id=$1 AND user_id=$2', [tenantId, userId]);
    return r.rows[0] ? r.rows[0].stats : null;
  }
  async function getUserStats(tenantId, userId) {
    if (!pgPool) return null;
    let s = await readRow(tenantId, userId);
    if (!s) { await recomputeUser(tenantId, userId); s = await readRow(tenantId, userId); }
    return s;
  }
```

Add `getUserStats` to the returned object.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test lib/statsStore.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/statsStore.js lib/statsStore.test.js
git commit -m "feat(stats): statsStore read path with compute-and-populate fallback

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 8: Wire into `persistence.js` + `server.js`

**Files:**
- Modify: `lib/persistence.js` (accept `statsStore` in `initPersistence`; call from `archiveHunt`/`unarchiveHunt`)
- Modify: `server.js` (construct `fxRates` + `statsStore`, `ensureTables`, pass into `initPersistence` and route deps)

**Interfaces:**
- Consumes: `statsStore.recordHunt`, `statsStore.removeHunt`, `statsStore.ensureTables` (Tasks 6–7); `makeFxRates` (Task 1).
- Produces: `initPersistence({ pgPool, normalizeSlot, statsStore })` now stores `statsStore` module-side; `archiveHunt` fire-and-forgets `statsStore.recordHunt(snap)`, `unarchiveHunt` fire-and-forgets `statsStore.removeHunt(hunt)`. Failures are caught and logged — never thrown into the hunt lifecycle.

- [ ] **Step 1: Add the hook to `lib/persistence.js`**

Near the top module state (after line ~15), add:
```js
let statsStore = null;
```
In `initPersistence`, after `if (deps.normalizeSlot) normalizeSlot = deps.normalizeSlot;`:
```js
  if (deps.statsStore) statsStore = deps.statsStore;
```
In `archiveHunt`, after `persistArchive();` (line ~202):
```js
  if (statsStore) Promise.resolve(statsStore.recordHunt(snap)).catch(e => console.error('[stats] recordHunt failed:', e.message));
```
In `unarchiveHunt`, inside the `if (idx !== -1)` block after `persistArchive();`:
```js
    if (statsStore) Promise.resolve(statsStore.removeHunt(hunt)).catch(e => console.error('[stats] removeHunt failed:', e.message));
```

- [ ] **Step 2: Construct and wire in `server.js`**

Find where `initPersistence` is called (search `initPersistence`). Immediately before it, construct the modules (use the same `pgPool` variable already in scope there):
```js
  const makeFxRates = require('./lib/fxRates');
  const makeStatsStore = require('./lib/statsStore');
  const fxRates = makeFxRates({ pgPool });
  const statsStore = makeStatsStore({ pgPool, fxRates });
  await statsStore.ensureTables();
```
Add `statsStore` to the `initPersistence({ ... })` deps object. Then find where `settingsRoutes(...)`/the settings router deps are assembled (search `settings.routes` or the `deps` object with `hunts, archive`) and add `statsStore` to that deps object too.

- [ ] **Step 3: Smoke-test the server boots (no DB needed)**

Run: `node -e "require('./lib/persistence'); require('./lib/statsStore'); require('./lib/fxRates'); console.log('requires OK')"`
Expected: prints `requires OK` (catches syntax/require errors without starting Postgres).

- [ ] **Step 4: Run the full backend test suite**

Run: `node --test`
Expected: all `lib/*.test.js` pass.

- [ ] **Step 5: Commit**

```bash
git add lib/persistence.js server.js
git commit -m "feat(stats): wire statsStore into archive lifecycle + server boot

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 9: Backfill script (`scripts/backfill-hunt-history.js`)

**Files:**
- Create: `scripts/backfill-hunt-history.js`

**Interfaces:**
- Consumes: `lib/persistence` (`hunts`, `archive`, `initPersistence`), `makeFxRates`, `makeStatsStore`, and a `pg` Pool from `DATABASE_URL`.
- Behavior: connect, `ensureTables`, load persisted state, then `recordHunt` every archived + live hunt (idempotent by `hunt_key`), marking each `_approxRate = true` so backfilled rows are flagged. Logs counts. Safe to re-run.

- [ ] **Step 1: Write the script**

```js
// scripts/backfill-hunt-history.js
// One-shot, idempotent: seed hunt_history/participants/user_hunt_stats from the current
// archive + live hunts. FX is latest-only, so backfilled rows are flagged approx.
require('dotenv/config');
const { Pool } = require('pg');
const makeFxRates = require('../lib/fxRates');
const makeStatsStore = require('../lib/statsStore');
const persistence = require('../lib/persistence');

(async () => {
  const pgPool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const fxRates = makeFxRates({ pgPool });
  const statsStore = makeStatsStore({ pgPool, fxRates });
  await statsStore.ensureTables();
  await persistence.initPersistence({ pgPool, statsStore });

  const { hunts, archive } = persistence;
  const all = [...Object.values(hunts), ...archive].filter(h => h && h.user && Array.isArray(h.bonuses) && h.bonuses.length);
  let done = 0;
  for (const h of all) {
    try { await statsStore.recordHunt({ ...h, _approxRate: true }); done++; }
    catch (e) { console.error('[backfill] failed for', h.huntId || h.user?.id, e.message); }
  }
  console.log(`[backfill] recorded ${done}/${all.length} hunts`);
  await pgPool.end();
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
```

- [ ] **Step 2: Syntax-check without a DB**

Run: `node --check scripts/backfill-hunt-history.js`
Expected: no output (valid syntax). (Full run requires `DATABASE_URL`; execute during rollout, not in this task.)

- [ ] **Step 3: Commit**

```bash
git add scripts/backfill-hunt-history.js
git commit -m "feat(stats): idempotent backfill script for hunt history

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 10: Endpoints — `GET /api/my-stats` + admin read swap

**Files:**
- Modify: `routes/settings.routes.js`

**Interfaces:**
- Consumes: `statsStore.getUserStats(tenantId, userId)` (Task 7), now present in the settings-route `deps` (Task 8).
- Produces:
  - `GET /api/my-stats` (`requireAuth`): `res.json(await statsStore.getUserStats(req.tenant?.id || 'bean', req.user.id))`.
  - `GET /api/admin/users/:userId`: replace `stats: computeUserHuntStats(rawTenantHunts(tenantId), userId)` with `stats: await statsStore.getUserStats(tenantId, userId)` (keep the existing `rawTenantHunts` compute as a fallback only if `statsStore` is absent).

- [ ] **Step 1: Destructure `statsStore` from deps**

In `routes/settings.routes.js`, add `statsStore` to the deps destructure (line ~21):
```js
  const { settings, pgPool, memberships, isPlatformAdmin, reqIsMod, reqHasFullExtension, requireAuth, requireAdmin, io, subscriptions, featureGrants, hunts, archive, statsStore } = deps;
```

- [ ] **Step 2: Add the `GET /api/my-stats` route**

After the `GET /api/settings` handler (near line ~49), add:
```js
  // GET /api/my-stats — the caller's own all-time hunt stats for the active tenant.
  router.get('/api/my-stats', requireAuth, async (req, res) => {
    try {
      const tenantId = req.tenant?.id || 'bean';
      const stats = statsStore
        ? await statsStore.getUserStats(tenantId, String(req.user.id))
        : computeUserHuntStats(rawTenantHunts(tenantId), String(req.user.id));
      res.json(stats || {});
    } catch (e) {
      console.error('[my-stats] failed:', e.message);
      res.status(500).json({ error: 'Failed to load stats' });
    }
  });
```

- [ ] **Step 3: Swap the admin read**

In `GET /api/admin/users/:userId`, replace the `stats:` line (line ~284):
```js
        stats: statsStore ? await statsStore.getUserStats(tenantId, userId)
                          : computeUserHuntStats(rawTenantHunts(tenantId), userId),
```

- [ ] **Step 4: Smoke-test the router loads**

Run: `node -e "require('./routes/settings.routes'); console.log('route module OK')"`
Expected: prints `route module OK`.

- [ ] **Step 5: Commit**

```bash
git add routes/settings.routes.js
git commit -m "feat(stats): GET /api/my-stats + admin reads rollup

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 11: Frontend — "My Stats" dropdown box

> **Repo:** `communityhunts-frontend`. Branch `feat/all-time-user-stats`. No test runner — verify with `CI=true npm run build` (must print "Compiled successfully") and a Vercel preview. **Never push to `main`.**

**Files:**
- Create: `src/stats/StatsBox.js`
- Modify: `src/hunt/HuntTopBar.js` and `src/pages/hub/HubNav.js` (add the dropdown entry)

**Interfaces:**
- Consumes: `GET /api/my-stats` via `apiFetch` (`src/api.js`); the shared `StatsBlock` / helpers from `src/stats/StatsView.js`; `useTheme()`.
- Produces: `export default function StatsBox({ user, onClose })` — a panel rendering the caller's stats with a native⇄USD toggle. The dropdown host renders a "📊 My Stats" item that opens it.

- [ ] **Step 1: Create the component**

```jsx
// src/stats/StatsBox.js
// Compact personal all-time stats for the account dropdown. Fetches GET /api/my-stats
// (per-tenant rollup) and reuses the shared StatsView renderer. Adds a native<->USD toggle
// (the one thing StatsView doesn't do — its money is currency-grouped only).
import React from 'react';
import { apiFetch } from '../api';
import { useTheme } from '../theme/ThemeContext';
import { moneyIn } from './StatsView';

export default function StatsBox({ user }) {
  const C = useTheme();
  const [stats, setStats] = React.useState(null);
  const [err, setErr] = React.useState('');
  const [usd, setUsd] = React.useState(true);

  React.useEffect(() => {
    if (!user) return;
    apiFetch('/api/my-stats').then(setStats).catch(e => setErr(e.message));
  }, [user]);

  if (err) return <div style={{ padding: 12, color: C.loss || '#ff6b6b' }}>Couldn’t load stats.</div>;
  if (!stats || !stats.tiles) return <div style={{ padding: 12, color: C.t3 }}>Loading…</div>;

  const t = stats.tiles;
  const codes = Object.keys(stats.byCurrency || {});
  const primary = codes[0] || 'USD';
  const money = usd ? moneyIn('USD') : moneyIn(primary);
  const block = usd ? stats.usd : (stats.byCurrency[primary] || { wagered: 0, won: 0, net: 0 });

  const Tile = ({ label, value }) => (
    <div style={{ flex: '1 1 80px', padding: 8, background: C.bg2, borderRadius: C.rCtl || 8 }}>
      <div style={{ fontSize: 11, color: C.t3, fontFamily: C.mono }}>{label}</div>
      <div style={{ fontSize: 16, fontWeight: 700, color: C.t1 }}>{value}</div>
    </div>
  );

  return (
    <div style={{ padding: 12, width: 300 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <span style={{ fontWeight: 700, color: C.t1 }}>Your all-time stats</span>
        <button
          onClick={() => setUsd(v => !v)}
          style={{ fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 6, cursor: 'pointer',
                   background: 'transparent', border: `1px solid ${C.bdr}`, color: C.t2, fontFamily: C.mono }}
        >
          {usd ? 'USD' : primary}
        </button>
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        <Tile label="Hunts" value={t.hunts} />
        <Tile label="Win rate" value={`${Math.round((t.winRate || 0) * 100)}%`} />
        <Tile label="Wagered" value={money(block.wagered)} />
        <Tile label="Won" value={money(block.won)} />
        <Tile label="Net" value={money(block.net)} />
        <Tile label="Best hunt" value={money(stats.records?.bestHuntNet || 0)} />
      </div>
      {usd && stats.usd?.unconvertedCount > 0 && (
        <div style={{ marginTop: 8, fontSize: 10, color: C.t4, fontFamily: C.mono }}>
          Excludes {stats.usd.unconvertedCount} hunt(s) with no conversion rate.
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Add the dropdown entry (HuntTopBar)**

In `src/hunt/HuntTopBar.js`, locate the account/burger dropdown menu list (where items like "Settings"/"Log out" render). Add a "📊 My Stats" button that toggles a local `showStats` state, and render `{showStats && <StatsBox user={user} />}` in the dropdown panel. Import at top: `import StatsBox from '../stats/StatsBox';`. Match the existing dropdown item styling (copy a sibling item's `style`).

- [ ] **Step 3: Add the same entry to HubNav**

In `src/pages/hub/HubNav.js`, mirror Step 2 (the same 3-way nav duplication noted for OverDrop/Manage Mods). Import `StatsBox` and add the "📊 My Stats" item + toggle.

- [ ] **Step 4: Verify the build**

Run: `CI=true npm run build`
Expected: "Compiled successfully". (CRA won't flag a missed prop on an extracted component — confirm `user` is passed at both call sites by hand.)

- [ ] **Step 5: Commit + push to branch, check preview**

```bash
git add src/stats/StatsBox.js src/hunt/HuntTopBar.js src/pages/hub/HubNav.js
git commit -m "feat: My Stats box in account dropdown"
git push -u origin feat/all-time-user-stats
```
Open the Vercel preview URL for the branch, sign in, open the account dropdown → "📊 My Stats", confirm tiles render and the USD/native toggle switches values.

---

## Task 12: Frontend — admin profile new metric sections

> **Repo:** `communityhunts-frontend`. Same branch/verify rules as Task 11.

**Files:**
- Modify: `src/admin/userProfile/ProfileCharts.js` (records + breakdown sections)
- Modify: `src/admin/userProfile/PastHunts.js` (already lists past hunts — no change unless fields moved)

**Interfaces:**
- Consumes: the richer `stats` object now returned by `GET /api/admin/users/:userId` (Task 10) — same shape as `/api/my-stats`: `byCurrency`, `usd`, `records`, `bySlot`, `byCaller`, plus existing `tiles`/`activity`/`profit`/`multHistogram`/`pastHunts`.

- [ ] **Step 1: Render records + breakdowns**

In `src/admin/userProfile/ProfileCharts.js`, add sections that read `stats.records` (biggest win, highest mult, best/worst hunt, streaks) and top-5 slices of `stats.bySlot` / `stats.byCaller`. Reuse existing chart/list primitives from `src/stats/StatsView.js` (`BarChart`, list rows) and `useTheme()` tokens. Keep it presentational; no new logic files.

- [ ] **Step 2: Verify the build**

Run: `CI=true npm run build`
Expected: "Compiled successfully".

- [ ] **Step 3: Commit + push**

```bash
git add src/admin/userProfile/ProfileCharts.js
git commit -m "feat: records + breakdown sections on admin user profile"
git push
```
On the branch preview, open an admin user profile and confirm the new sections render for a user with history.

---

## Rollout (after all tasks merge to previews and are reviewed)

1. Merge the backend branch to `main` (Railway auto-deploys) — tables auto-create via `ensureTables()`; `archiveHunt` starts populating going forward. **Warns everyone logged out on deploy (expected).**
2. Run the backfill once against production: `node scripts/backfill-hunt-history.js` (needs `DATABASE_URL`).
3. Merge the frontend branch to `main` (Vercel) once the backend endpoints are live.

---

## Notes for the implementer

- **DB-less local runs:** all unit tests inject a fake `pgPool`; you do **not** need Postgres to run `node --test`. Only the backfill script and a live server need `DATABASE_URL`.
- **Idempotency is load-bearing:** re-ending or re-archiving a hunt must not double-count — this is guaranteed by the `hunt_key` upsert. If you change key derivation, keep it aligned with `persistence.sameHuntInstance`.
- **Never block the hunt flow:** all `statsStore` calls from `persistence.js` are fire-and-forget with `.catch`. Keep it that way — a stats/DB/FX hiccup must never break archiving a hunt.
- **Purity of `userStats.js`:** do not add I/O to it. It only reads `usdRate` off hunt objects; the rate is resolved upstream in `statsStore.recordHunt`.
