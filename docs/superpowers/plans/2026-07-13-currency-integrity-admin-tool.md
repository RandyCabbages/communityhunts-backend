# Currency Integrity: Admin Fix/Delete Tool + Creation-Time Prevention — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give admins a tool to correct (relabel currency + re-stamp rate) or delete a past hunt in the durable stats store, recomputing every participant's rollup; and make hunt-creation currency a deliberate, visible choice so the mislabel can't recur.

**Architecture:** Backend adds three `statsStore` capabilities that operate on the Postgres `hunt_history`/`hunt_participants`/`user_hunt_stats` tables (the stats source of truth — NOT the 100-cap file archive), exposed via two `requireAdmin` routes. A one-time recompute script backfills the new addressing field onto existing rollups. Frontend adds admin-only Fix/Delete controls to the profile's Past Hunts list, and a currency-restate line to the Open-Hunt modal.

**Tech Stack:** Node.js + Express + `pg` (backend, `node:test`); React CRA (frontend, no test suite — verified by build + manual).

## Global Constraints

- **Two repos, two remotes.** Backend tasks: run from `communityhunts-backend/`, push to `RandyCabbages/communityhunts.gg-backend`. Frontend tasks: run from `communityhunts-frontend/`, push to `GooferG/communityhunts-frontend`. The wrapper dir is not a git repo — never run git from it.
- **Backend:** no build step. Tests: `node --test lib/*.test.js` (Node 24 needs the explicit glob). Push to `main` auto-deploys to Railway and clears in-memory sessions (expected). `git pull --ff-only` before pushing.
- **Frontend:** `CI=true npm run build` must print "Compiled successfully" (Vercel treats warnings as errors). No test runner. Push to a **branch**, verify on the Vercel preview URL, PR → `main`; never test on `main`.
- **Deploy order is backend-first** — the frontend calls the new routes, so backend must be live first.
- **Stats source of truth = `hunt_history`.** The live `hunts` map and the file `archive` are separate; do not route corrections through them (the existing `retag-currency` route does, and that is exactly why it never fixes the rollup).
- **Auth is ID-based via `requireAdmin`.** Never gate on display name.
- **No `Co-Authored-By` trailers** in any commit.

---

### Task 1: `recordHunt` accepts an optional USD-rate override

Lets the correction path re-stamp a hunt with an admin-supplied rate instead of the auto-fetched one. Existing callers are unaffected (opts defaults to `{}`).

**Files:**
- Modify: `communityhunts-backend/lib/statsStore.js` (function `recordHunt`, ~line 145)
- Test: `communityhunts-backend/lib/statsStore.test.js`

**Interfaces:**
- Produces: `recordHunt(hunt, opts?)` where `opts` = `{ usdRate?: number }`. When `usdRate` is a number it is used verbatim and the snapshot's `approx` flag is set `true`; otherwise behavior is unchanged (auto-fetch via `fxRates`).

- [ ] **Step 1: Write the failing test**

Add to `communityhunts-backend/lib/statsStore.test.js`:

```javascript
test('recordHunt uses an explicit usdRate override and marks the snapshot approx', async () => {
  const pool = fakePool();
  const fxRates = { ensureTable: async () => {}, getUsdRate: async () => 999 }; // would be used if no override
  const store = makeStatsStore({ pgPool: pool, fxRates });
  await store.recordHunt({
    huntId: 'H1', tenantId: 'bean', user: { id: 'u1' }, startedAt: 'T0',
    archivedAt: '2026-07-01T00:00:00Z', currency: 'ARS',
    equity: [{ id: 'u1', amount: 100 }], bonuses: [{ slot: 'A', bet: 10, win: 40, mult: 4 }],
  }, { usdRate: 0.001 });
  const snap = pool.historyRows[0].snapshot;
  assert.strictEqual(snap.usdRate, 0.001); // override used, NOT the fx 999
  assert.strictEqual(snap.approx, true);   // admin-supplied rate flagged approximate
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test lib/statsStore.test.js`
Expected: FAIL — snapshot `usdRate` is `999` (override ignored) / `approx` not `true`.

- [ ] **Step 3: Write minimal implementation**

In `communityhunts-backend/lib/statsStore.js`, change the `recordHunt` signature and rate/approx lines. Current (~line 145-152):

```javascript
  async function recordHunt(hunt) {
    if (!pgPool || !hunt || !hunt.user) return;
    const tenantId = hunt.tenantId || 'bean';
    const key = huntKey(hunt);
    const ended = endedAt(hunt);
    const usdRate = fxRates ? await fxRates.getUsdRate(hunt.currency || 'USD', isoDate(ended)) : null;
    const stamped = stampEquity(hunt, await getNameIndex());  // resolve equity names -> discordId
    const snapshot = { ...stamped, usdRate, approx: !!hunt._approxRate };
```

Replace with:

```javascript
  async function recordHunt(hunt, opts = {}) {
    if (!pgPool || !hunt || !hunt.user) return;
    const tenantId = hunt.tenantId || 'bean';
    const key = huntKey(hunt);
    const ended = endedAt(hunt);
    const override = opts.usdRate != null && isFinite(Number(opts.usdRate));
    const usdRate = override
      ? Number(opts.usdRate)
      : (fxRates ? await fxRates.getUsdRate(hunt.currency || 'USD', isoDate(ended)) : null);
    const stamped = stampEquity(hunt, await getNameIndex());  // resolve equity names -> discordId
    const snapshot = { ...stamped, usdRate, approx: override ? true : !!hunt._approxRate };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test lib/statsStore.test.js`
Expected: PASS (all existing tests still pass — the override path is additive).

- [ ] **Step 5: Commit**

Run from `communityhunts-backend/`:

```bash
git add lib/statsStore.js lib/statsStore.test.js
git commit -m "feat(stats): let recordHunt accept a usdRate override"
```

---

### Task 2: `correctHuntCurrency` — relabel a stored hunt's currency + recompute

**Files:**
- Modify: `communityhunts-backend/lib/statsStore.js` (new function + add to the returned object at ~line 220)
- Test: `communityhunts-backend/lib/statsStore.test.js`

**Interfaces:**
- Consumes: `recordHunt(hunt, opts)` (Task 1), `huntKey`.
- Produces: `correctHuntCurrency(tenantId, huntKey, { currency, usdRate? }) → Promise<{ ok: true } | { notFound: true }>`. Loads the snapshot for `(huntKey, tenantId)`, sets its `currency`, and re-runs `recordHunt` (with `usdRate` override when supplied, else auto-fetch for the new currency). Recomputes host + all participants via `recordHunt`'s existing transaction.

- [ ] **Step 1: Write the failing tests**

Add to `communityhunts-backend/lib/statsStore.test.js`:

```javascript
test('correctHuntCurrency relabels currency, re-stamps override rate, marks approx', async () => {
  const pool = fakePool();
  const fxRates = { ensureTable: async () => {}, getUsdRate: async () => 1 };
  const store = makeStatsStore({ pgPool: pool, fxRates });
  await store.recordHunt({
    huntId: 'H1', tenantId: 'bean', user: { id: 'u1' }, startedAt: 'T0',
    archivedAt: '2026-07-01T00:00:00Z', currency: 'USD',
    equity: [{ id: 'u1', amount: 100 }], bonuses: [{ slot: 'A', bet: 10, win: 40, mult: 4 }],
  });
  const res = await store.correctHuntCurrency('bean', 'H1', { currency: 'ARS', usdRate: 0.001 });
  assert.deepStrictEqual(res, { ok: true });
  const inserts = pool.calls.filter(c => /INSERT INTO hunt_history/i.test(c.sql));
  const last = inserts[inserts.length - 1];
  assert.strictEqual(last.params[3], 'ARS');         // currency relabeled
  assert.strictEqual(last.params[4], 0.001);         // override rate persisted to the row
  assert.strictEqual(last.params[7].usdRate, 0.001); // ...and into the snapshot
  assert.strictEqual(last.params[7].approx, true);   // flagged approximate
});

test('correctHuntCurrency without an override auto-fetches the rate for the new currency', async () => {
  const pool = fakePool();
  let askedFor = null;
  const fxRates = { ensureTable: async () => {}, getUsdRate: async (cur) => { askedFor = cur; return 0.0011; } };
  const store = makeStatsStore({ pgPool: pool, fxRates });
  await store.recordHunt({
    huntId: 'H1', tenantId: 'bean', user: { id: 'u1' }, startedAt: 'T0',
    archivedAt: '2026-07-01T00:00:00Z', currency: 'USD',
    equity: [{ id: 'u1', amount: 100 }], bonuses: [{ slot: 'A', bet: 10, win: 40, mult: 4 }],
  });
  askedFor = null; // ignore the fetch done during the seed record
  await store.correctHuntCurrency('bean', 'H1', { currency: 'ARS' });
  assert.strictEqual(askedFor, 'ARS');
  const inserts = pool.calls.filter(c => /INSERT INTO hunt_history/i.test(c.sql));
  assert.strictEqual(inserts[inserts.length - 1].params[4], 0.0011);
});

test('correctHuntCurrency returns notFound when the key is absent', async () => {
  const pool = fakePool(); // no history seeded
  const store = makeStatsStore({ pgPool: pool, fxRates: { ensureTable: async () => {}, getUsdRate: async () => 1 } });
  const res = await store.correctHuntCurrency('bean', 'NOPE', { currency: 'ARS' });
  assert.deepStrictEqual(res, { notFound: true });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test lib/statsStore.test.js`
Expected: FAIL — `store.correctHuntCurrency is not a function`.

- [ ] **Step 3: Write minimal implementation**

In `communityhunts-backend/lib/statsStore.js`, add this function right after `removeHunt` (before `readRow`):

```javascript
  // Correct a stored hunt's currency IN PLACE in hunt_history and recompute every participant's
  // rollup. Reuses recordHunt's upsert+recompute transaction (no parallel logic to drift). The
  // SELECT is tenant-scoped so an admin can only touch their own tenant's hunts. Optional usdRate
  // overrides the auto-fetched rate (volatile currencies on old hunts — see fxRates latest-only).
  async function correctHuntCurrency(tenantId, huntKey, { currency, usdRate } = {}) {
    if (!pgPool) return { notFound: true };
    const r = await pgPool.query(
      'SELECT snapshot FROM hunt_history WHERE hunt_key=$1 AND tenant_id=$2', [huntKey, tenantId]);
    if (!r.rows[0]) return { notFound: true };
    const corrected = { ...r.rows[0].snapshot, currency };
    await recordHunt(corrected, usdRate != null ? { usdRate } : {});
    return { ok: true };
  }
```

Then add `correctHuntCurrency` to the returned object (currently `return { huntKey, participantsOf, ensureTables, recomputeUser, recordHunt, removeHunt, getUserStats };`):

```javascript
  return { huntKey, participantsOf, ensureTables, recomputeUser, recordHunt, removeHunt,
    correctHuntCurrency, getUserStats };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test lib/statsStore.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

Run from `communityhunts-backend/`:

```bash
git add lib/statsStore.js lib/statsStore.test.js
git commit -m "feat(stats): correctHuntCurrency to relabel a stored hunt + recompute"
```

---

### Task 3: `deleteHuntByKey` — delete a stored hunt by key + recompute

`removeHunt` requires a full hunt object and is only reached via the reopen path. The admin tool addresses hunts by key, so add a keyed variant.

**Files:**
- Modify: `communityhunts-backend/lib/statsStore.js` (new function + add to returned object)
- Test: `communityhunts-backend/lib/statsStore.test.js`

**Interfaces:**
- Produces: `deleteHuntByKey(tenantId, huntKey) → Promise<{ ok: true }>`. Deletes the `hunt_history` (tenant-scoped) + `hunt_participants` rows for the key and recomputes every stored participant, in one transaction.

- [ ] **Step 1: Write the failing test**

Add to `communityhunts-backend/lib/statsStore.test.js`:

```javascript
test('deleteHuntByKey removes the hunt and recomputes stored participants', async () => {
  const pool = fakePool(['u1']); // u1 stored as a participant of the key
  const store = makeStatsStore({ pgPool: pool, fxRates: null });
  const res = await store.deleteHuntByKey('bean', 'H1');
  assert.deepStrictEqual(res, { ok: true });
  assert.ok(pool.calls.some(c => /DELETE FROM hunt_history WHERE hunt_key=\$1/i.test(c.sql) && c.params[0] === 'H1'));
  assert.ok(pool.calls.some(c => /DELETE FROM hunt_participants WHERE hunt_key=\$1/i.test(c.sql) && c.params[0] === 'H1'));
  assert.ok(pool.calls.some(c => /SELECT .*snapshot.* FROM hunt_history/i.test(c.sql) && c.params[1] === 'u1'));
  const beginIdx = pool.calls.findIndex(c => /^\s*BEGIN\s*$/i.test(c.sql));
  const commitIdx = pool.calls.findIndex(c => /^\s*COMMIT\s*$/i.test(c.sql));
  assert.ok(beginIdx >= 0 && commitIdx > beginIdx, 'wrapped in a transaction');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test lib/statsStore.test.js`
Expected: FAIL — `store.deleteHuntByKey is not a function`.

- [ ] **Step 3: Write minimal implementation**

In `communityhunts-backend/lib/statsStore.js`, add after `correctHuntCurrency`:

```javascript
  // Delete a stored hunt by key (admin tool). Mirrors removeHunt's transaction but keyed, since
  // the admin has no hunt object — participants come from the stored hunt_participants rows.
  async function deleteHuntByKey(tenantId, huntKey) {
    if (!pgPool) return { ok: true };
    const client = await pgPool.connect();
    try {
      await client.query('BEGIN');
      const old = await client.query('SELECT user_id FROM hunt_participants WHERE hunt_key=$1', [huntKey]);
      const affected = new Set(old.rows.map(r => String(r.user_id)));
      await client.query('DELETE FROM hunt_history WHERE hunt_key=$1 AND tenant_id=$2', [huntKey, tenantId]);
      await client.query('DELETE FROM hunt_participants WHERE hunt_key=$1', [huntKey]);
      for (const uid of affected) await recomputeUser(tenantId, uid, client);
      await client.query('COMMIT');
      return { ok: true };
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  }
```

Add `deleteHuntByKey` to the returned object:

```javascript
  return { huntKey, participantsOf, ensureTables, recomputeUser, recordHunt, removeHunt,
    correctHuntCurrency, deleteHuntByKey, getUserStats };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test lib/statsStore.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

Run from `communityhunts-backend/`:

```bash
git add lib/statsStore.js lib/statsStore.test.js
git commit -m "feat(stats): deleteHuntByKey to remove a stored hunt + recompute"
```

---

### Task 4: `userStats` — expose `huntKey` + `srcCurrency` per past-hunt row

The frontend needs the durable `hunt_key` to address a row, and the hunt's **stored** currency (rows currently report the USD-normalized *display* currency, which hides that e.g. a converted GBP hunt is stored as GBP).

**Files:**
- Modify: `communityhunts-backend/lib/userStats.js` (the `pastHunts.push({...})` block, ~line 151)
- Test: `communityhunts-backend/lib/userStats.test.js`

**Interfaces:**
- Produces: each `pastHunts[i]` gains `huntKey: string` (same rule as `statsStore.huntKey`: `h.huntId || \`${h.user?.id}|${h.startedAt}\``) and `srcCurrency: string` (the hunt's stored `currency`, default `'USD'`).

- [ ] **Step 1: Write the failing tests**

Add to `communityhunts-backend/lib/userStats.test.js`:

```javascript
test('pastHunts rows carry huntKey (huntId, else user|startedAt) and srcCurrency', () => {
  const withId = computeUserHuntStats([
    { huntId: 'H1', user: { id: 'u1' }, startedAt: 'T0', archivedAt: '2026-07-01T00:00:00Z',
      currency: 'USD', usdRate: 1, equity: [{ id: 'u1', amount: 100 }],
      bonuses: [{ slot: 'A', bet: 10, win: 40, mult: 4 }] },
  ], 'u1');
  assert.strictEqual(withId.pastHunts[0].huntKey, 'H1');
  assert.strictEqual(withId.pastHunts[0].srcCurrency, 'USD');

  const noId = computeUserHuntStats([
    { user: { id: 'u1' }, startedAt: 'T0', archivedAt: '2026-07-01T00:00:00Z',
      currency: 'USD', usdRate: 1, equity: [{ id: 'u1', amount: 100 }],
      bonuses: [{ slot: 'A', bet: 10, win: 40, mult: 4 }] },
  ], 'u1');
  assert.strictEqual(noId.pastHunts[0].huntKey, 'u1|T0');
});

test('pastHunts srcCurrency is the STORED currency, distinct from the USD display currency', () => {
  const s = computeUserHuntStats([
    { huntId: 'H1', user: { id: 'u1' }, startedAt: 'T0', archivedAt: '2026-07-01T00:00:00Z',
      currency: 'GBP', usdRate: 1.25, equity: [{ id: 'u1', amount: 100 }],
      bonuses: [{ slot: 'A', bet: 10, win: 40, mult: 4 }] },
  ], 'u1');
  assert.strictEqual(s.pastHunts[0].currency, 'USD');    // display (normalized)
  assert.strictEqual(s.pastHunts[0].srcCurrency, 'GBP'); // stored
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test lib/userStats.test.js`
Expected: FAIL — `huntKey` / `srcCurrency` are `undefined`.

- [ ] **Step 3: Write minimal implementation**

In `communityhunts-backend/lib/userStats.js`, the current row push (~line 150) is:

```javascript
    const usd = rate != null;
    pastHunts.push({
      huntId: h.huntId || h.id, date: when, huntType: h.huntType || null,
      role: isOwner ? 'host' : 'member', slots: bonuses.length,
      currency: usd ? 'USD' : (h.currency || 'USD'),
      startBalance: usd ? invested * rate : invested,
      endBalance: usd ? returned * rate : returned,
      result: usd ? result * rate : result,
      reqX, avgX, bestCaller, worstCaller,
    });
```

Add the two fields (keep the `huntKey` rule in sync with `statsStore.huntKey`):

```javascript
    const usd = rate != null;
    pastHunts.push({
      huntId: h.huntId || h.id,
      // Durable address for the admin fix/delete tool. MUST match statsStore.huntKey.
      huntKey: h.huntId || `${h.user?.id}|${h.startedAt}`,
      srcCurrency: h.currency || 'USD',   // stored currency (display `currency` is USD-normalized)
      date: when, huntType: h.huntType || null,
      role: isOwner ? 'host' : 'member', slots: bonuses.length,
      currency: usd ? 'USD' : (h.currency || 'USD'),
      startBalance: usd ? invested * rate : invested,
      endBalance: usd ? returned * rate : returned,
      result: usd ? result * rate : result,
      reqX, avgX, bestCaller, worstCaller,
    });
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test lib/userStats.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

Run from `communityhunts-backend/`:

```bash
git add lib/userStats.js lib/userStats.test.js
git commit -m "feat(stats): expose huntKey + srcCurrency on past-hunt rows"
```

---

### Task 5: One-time recompute script (backfills the new row fields onto existing rollups)

Existing `user_hunt_stats` rows hold a cached `stats` JSON computed **before** Task 4, so their `pastHunts` rows lack `huntKey`/`srcCurrency` — the admin tool can't address them until each user is recomputed. This idempotent script regenerates every rollup once after deploy.

**Files:**
- Create: `communityhunts-backend/scripts/recompute-all-user-stats.js`
- Reference (read for the Pool construction): `communityhunts-backend/scripts/backfill-hunt-history.js`

**Interfaces:**
- Consumes: `statsStore.recomputeUser` (existing), `statsStore.ensureTables`.

- [ ] **Step 1: Create the script**

Create `communityhunts-backend/scripts/recompute-all-user-stats.js`. Copy the `new Pool({...})` construction **verbatim** from `scripts/backfill-hunt-history.js` (it already connects this DB with the correct SSL config) in place of the `makePool()` note below:

```javascript
// scripts/recompute-all-user-stats.js
// ONE-TIME (idempotent): regenerate every (tenant,user) rollup so stats fields added in code
// (huntKey, srcCurrency) appear without waiting for each user's next hunt. Safe to re-run.
//   node -r dotenv/config scripts/recompute-all-user-stats.js
require('dotenv').config();
const makeFxRates = require('../lib/fxRates');
const makeStatsStore = require('../lib/statsStore');

// >>> Copy the exact `const pgPool = new Pool({...})` block from scripts/backfill-hunt-history.js here.
const { Pool } = require('pg');
const pgPool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

(async () => {
  const fxRates = makeFxRates({ pgPool });
  const store = makeStatsStore({ pgPool, fxRates });
  await store.ensureTables();
  const r = await pgPool.query('SELECT DISTINCT tenant_id, user_id FROM hunt_participants');
  console.log(`recomputing ${r.rows.length} (tenant,user) rollups…`);
  let n = 0;
  for (const row of r.rows) {
    await store.recomputeUser(row.tenant_id, row.user_id);
    if (++n % 25 === 0) console.log(`  …${n}/${r.rows.length}`);
  }
  console.log(`done — ${n} rollups recomputed`);
  await pgPool.end();
})().catch(e => { console.error(e); process.exit(1); });
```

- [ ] **Step 2: Verify it parses (no DB needed)**

Run: `node --check scripts/recompute-all-user-stats.js`
Expected: no output (syntax OK). Do NOT run it against the DB yet — it runs as an operational step after the backend deploys (see "Operational rollout").

- [ ] **Step 3: Commit**

Run from `communityhunts-backend/`:

```bash
git add scripts/recompute-all-user-stats.js
git commit -m "chore(stats): one-time recompute-all-user-stats backfill script"
```

---

### Task 6: Admin routes + wire `statsStore` into the admin router

**Files:**
- Modify: `communityhunts-backend/routes/admin.routes.js` (deps destructure ~line 27; new routes after the `retag-currency` route ~line 337; route doc block ~line 16)
- Modify: `communityhunts-backend/server.js` (admin.routes deps object, line ~507-514)

**Interfaces:**
- Consumes: `statsStore.correctHuntCurrency`, `statsStore.deleteHuntByKey`, `CURRENCIES` (already imported at admin.routes.js:24), `req.tenant.id`.
- Produces:
  - `PATCH /api/admin/hunt-history/:huntKey/currency` — body `{ currency, usdRate? }` → `{ ok: true }` | 400 | 404.
  - `DELETE /api/admin/hunt-history/:huntKey` → `{ ok: true }`.

- [ ] **Step 1: Add `statsStore` to the router deps in `server.js`**

In `communityhunts-backend/server.js`, the admin.routes mount (line ~507) currently is:

```javascript
app.use(require('./routes/admin.routes')({
  requireAuth, requireAdmin, requirePlatformAdmin,
  getAllHunts, getArchivedHunts, getGotInLog, getHuntsFullExport, getHuntStats: huntsCore.getHuntStats,
  pgPool, admins, tenants, ADMIN_IDS,
  hunts, archive, archiveHunt, unarchiveHunt, persistArchive,
  emitHubUpdate, publicHuntView, emitHuntUpdate, io, uid, cleanupStaleHunts,
  subscriptions,
}));
```

Add `statsStore` to the deps (it is in scope from line 243):

```javascript
  pgPool, admins, tenants, ADMIN_IDS, statsStore,
```

(i.e. append `statsStore` to that line.)

- [ ] **Step 2: Destructure `statsStore` and add the routes in `admin.routes.js`**

In `communityhunts-backend/routes/admin.routes.js`, add `statsStore` to the deps destructure (~line 30, alongside `pgPool, admins, tenants, ADMIN_IDS`):

```javascript
    pgPool, admins, tenants, ADMIN_IDS, statsStore,
```

Then add the two routes immediately after the `retag-currency` route (after its closing `});`, ~line 337):

```javascript
  // Correct a past hunt's currency in the DURABLE stats store (hunt_history) and recompute the
  // rollup for the host + every participant. Distinct from retag-currency above, which only
  // touches the live/file-archive copies (not the stats source of truth). Optional usdRate lets
  // an admin supply the rate that applied at hunt time (fxRates otherwise stamps today's rate for
  // an old date — meaningful for volatile currencies like ARS). :huntKey may contain '|'.
  router.patch('/api/admin/hunt-history/:huntKey/currency', requireAuth, requireAdmin, async (req, res) => {
    const { currency, usdRate } = req.body || {};
    if (!CURRENCIES.includes(currency)) return res.status(400).json({ error: 'Invalid currency' });
    if (usdRate != null && !(Number(usdRate) > 0)) return res.status(400).json({ error: 'Invalid rate' });
    if (!statsStore) return res.status(503).json({ error: 'Stats store unavailable' });
    try {
      const r = await statsStore.correctHuntCurrency(req.tenant.id, req.params.huntKey,
        { currency, usdRate: usdRate != null ? Number(usdRate) : undefined });
      if (r && r.notFound) return res.status(404).json({ error: 'Hunt not found in history' });
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Delete a past hunt from the durable stats store and recompute affected participants.
  router.delete('/api/admin/hunt-history/:huntKey', requireAuth, requireAdmin, async (req, res) => {
    if (!statsStore) return res.status(503).json({ error: 'Stats store unavailable' });
    try {
      await statsStore.deleteHuntByKey(req.tenant.id, req.params.huntKey);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
```

Also add two lines to the route doc block at the top of the file (after the `retag-currency` line, ~line 16):

```javascript
//   PATCH  /api/admin/hunt-history/:huntKey/currency     — correct a stored hunt's currency (+recompute)
//   DELETE /api/admin/hunt-history/:huntKey              — delete a stored hunt (+recompute)
```

- [ ] **Step 3: Verify parse + lib tests still green**

Run:
```bash
node --check routes/admin.routes.js
node --check server.js
node --test lib/*.test.js
```
Expected: no parse errors; all lib tests PASS.

- [ ] **Step 4: Local boot smoke (optional but recommended)**

The backend needs dummy Discord creds to boot locally (see backend CLAUDE.md / [[backend-local-dev-gotchas]]). With a local `.env`, start it and confirm no startup crash and the router mounts:

Run: `npm run dev`
Expected: server logs "listening" with no throw. Stop it (Ctrl-C). (Full auth'd curl of the new routes is covered by manual QA after deploy — they are `requireAdmin`.)

- [ ] **Step 5: Commit**

Run from `communityhunts-backend/`:

```bash
git add routes/admin.routes.js server.js
git commit -m "feat(admin): hunt-history currency-correct + delete routes"
```

---

## Operational rollout (after the backend tasks are merged)

Do these in order, once, before/while shipping the frontend:

1. **Deploy backend:** from `communityhunts-backend/`, `git pull --ff-only` then `git push origin main`. Railway auto-deploys (~1-3 min; clears sessions — expected).
2. **Run the backfill once** against production (Railway shell or locally with the prod `DATABASE_URL`):
   `node -r dotenv/config scripts/recompute-all-user-stats.js`
   Expected: "done — N rollups recomputed". Every profile's past-hunt rows now carry `huntKey`/`srcCurrency`.
3. **Fix ShooterMcGavin** either via the UI once the frontend ships (Task 8), or immediately via an admin-session curl:
   `PATCH /api/admin/hunt-history/<huntKey>/currency` with `{ "currency": "ARS", "usdRate": <ARS→USD rate at hunt time> }` for each affected hunt. Confirm his profile tiles/records drop to sane values and co-participants correct too.

---

### Task 7: Frontend admin API — correct/delete hunt history

**Files:**
- Modify: `communityhunts-frontend/src/admin/adminApi.js`

**Interfaces:**
- Produces:
  - `correctHuntHistory(huntKey, currency, usdRate?) → Promise` — `PATCH /api/admin/hunt-history/:huntKey/currency`.
  - `deleteHuntHistory(huntKey) → Promise` — `DELETE /api/admin/hunt-history/:huntKey`.

- [ ] **Step 1: Add the two functions**

In `communityhunts-frontend/src/admin/adminApi.js`, add after the `retagCurrency` export (~line 42):

```javascript
// Durable stats-store corrections (hunt_history — the source the admin profile reads). Distinct
// from retagCurrency, which only fixes the live/file-archive copies. huntKey comes from a
// pastHunts row (row.huntKey). usdRate is optional (rate at hunt time for volatile currencies).
export const correctHuntHistory = (huntKey, currency, usdRate) =>
  apiFetch(`/api/admin/hunt-history/${encodeURIComponent(huntKey)}/currency`, {
    method: 'PATCH',
    body: JSON.stringify({ currency, ...(usdRate != null ? { usdRate } : {}) }),
  });

export const deleteHuntHistory = (huntKey) =>
  apiFetch(`/api/admin/hunt-history/${encodeURIComponent(huntKey)}`, { method: 'DELETE' });
```

- [ ] **Step 2: Verify build**

Run from `communityhunts-frontend/`: `CI=true npm run build`
Expected: "Compiled successfully".

- [ ] **Step 3: Commit**

Run from `communityhunts-frontend/`:

```bash
git add src/admin/adminApi.js
git commit -m "feat(admin): correctHuntHistory + deleteHuntHistory api calls"
```

---

### Task 8: Past Hunts admin controls + UserProfile wiring

Add per-row **Fix currency** (currency dropdown defaulting to the row's `srcCurrency` + optional rate + Apply) and **Delete** (confirm) controls, admin-gated by the presence of the handlers (the whole profile page is already admin-only). On success, reload the profile so the recomputed rollup shows.

**Files:**
- Modify: `communityhunts-frontend/src/admin/userProfile/PastHunts.js`
- Modify: `communityhunts-frontend/src/admin/UserProfile.js`

**Interfaces:**
- Consumes: `correctHuntHistory`, `deleteHuntHistory` (Task 7); row fields `huntKey`, `srcCurrency` (Task 4); `CURRENCIES` from `src/hunt/huntMath`.
- Produces: `PastHunts` accepts optional `onCorrect(huntKey, currency, usdRate?)` and `onDelete(huntKey)` props; renders row controls only when both are present.

- [ ] **Step 1: Wire handlers in `UserProfile.js`**

In `communityhunts-frontend/src/admin/UserProfile.js`:

Update the import (line 3) to add the two calls:

```javascript
import { fetchUser, setUserField, setFeatureGrant, setUserCosmetics, correctHuntHistory, deleteHuntHistory } from './adminApi';
```

Add handlers after `onCosmetics` (~line 30), reusing a reload that re-fetches the whole profile (so co-participant-affecting recomputes are reflected):

```javascript
  const reload = () => fetchUser(userId).then(setU).catch(e => setErr(e.message));
  const onCorrectHunt = (huntKey, currency, usdRate) =>
    correctHuntHistory(huntKey, currency, usdRate).then(reload).catch(e => setErr(e.message));
  const onDeleteHunt = (huntKey) =>
    deleteHuntHistory(huntKey).then(reload).catch(e => setErr(e.message));
```

Pass them to `PastHunts` (line ~51):

```javascript
      <PastHunts hunts={u.stats?.pastHunts || []} onCorrect={onCorrectHunt} onDelete={onDeleteHunt} />
```

- [ ] **Step 2: Add the controls to `PastHunts.js`**

In `communityhunts-frontend/src/admin/userProfile/PastHunts.js`, replace the whole file with the version below (adds `useState` for the inline editor, a currency import, and an admin action area per row; the money/stats layout is unchanged):

```javascript
import React, { useState } from 'react';
import { useTheme } from '../../theme/ThemeContext';
import { moneyIn } from '../../stats/StatsView';
import { CURRENCIES } from '../../hunt/huntMath';

// Full-width list of the user's past hunts (as host or equity member), two-tier per row:
// a money line (date · type · role · start→end · result) and a muted stats/caller sub-line.
// Per-row currency is honored (a user's hunts can span currencies). When admin handlers
// (onCorrect/onDelete) are passed, each row also gets Fix-currency + Delete controls.
export default function PastHunts({ hunts, onCorrect, onDelete }) {
  const C = useTheme();
  const rows = hunts || [];
  const admin = !!(onCorrect && onDelete);
  const [editKey, setEditKey] = useState(null);   // huntKey being edited, or null
  const [cur, setCur] = useState('USD');
  const [rate, setRate] = useState('');
  const [busy, setBusy] = useState(false);

  const box = { background: C.sur, border: `1px solid ${C.bdr}`, borderRadius: C.rCard, padding: 16 };
  const fmtDate = (d) => (d ? new Date(d).toLocaleDateString(undefined, { year: '2-digit', month: 'short', day: 'numeric' }) : '—');
  const fmtX = (x) => (x == null ? '—' : `${x.toFixed(1)}x`);

  const openEdit = (h) => { setEditKey(h.huntKey); setCur(h.srcCurrency || 'USD'); setRate(''); };
  const applyEdit = async () => {
    setBusy(true);
    const r = rate.trim() === '' ? undefined : Number(rate);
    try { await onCorrect(editKey, cur, r); setEditKey(null); } finally { setBusy(false); }
  };
  const removeRow = async (h) => {
    if (!window.confirm('Delete this hunt from all-time stats? This recomputes everyone in it and cannot be undone.')) return;
    setBusy(true);
    try { await onDelete(h.huntKey); } finally { setBusy(false); }
  };

  const btn = (extra) => ({ height: 24, padding: '0 8px', borderRadius: C.rCtl, border: `1px solid ${C.bdr}`,
    background: 'transparent', color: C.t3, fontFamily: C.body, fontSize: 11, fontWeight: 700, cursor: 'pointer', ...extra });

  return (
    <div style={box}>
      <div style={{ color: C.t2, fontFamily: C.display, fontWeight: 700, fontSize: 13, letterSpacing: '0.02em', marginBottom: 10 }}>PAST HUNTS</div>
      {rows.length === 0
        ? <div style={{ color: C.t4, fontFamily: C.mono || C.body, fontSize: 13, padding: '1.5rem', textAlign: 'center' }}>No hunts yet</div>
        : (
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            {rows.map((h, i) => {
              const money = moneyIn(h.currency || 'USD');
              const pos = (h.result || 0) >= 0;
              const rowKey = h.huntKey || h.huntId || i;
              const editing = admin && editKey && editKey === h.huntKey;
              return (
                <div key={rowKey}
                  style={{ padding: '10px 2px', borderTop: i === 0 ? 'none' : `1px solid ${C.bdr}` }}>
                  {/* Primary money line */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                    <span style={{ color: C.t2, fontFamily: C.body, fontSize: 13, minWidth: 62 }}>{fmtDate(h.date)}</span>
                    <span style={{ color: C.t3, fontFamily: C.body, fontSize: 13, textTransform: 'capitalize' }}>{h.huntType || '—'}</span>
                    <span style={{ padding: '2px 8px', borderRadius: C.rCtl, fontSize: 11, fontWeight: 700,
                      background: C.bg, border: `1px solid ${C.bdr}`,
                      color: h.role === 'host' ? (C.gold || C.t1) : C.t3 }}>
                      {h.role === 'host' ? 'Host' : 'Member'}
                    </span>
                    <span style={{ flex: 1 }} />
                    <span style={{ fontFamily: C.mono, fontSize: 13, color: C.t3, whiteSpace: 'nowrap' }}>
                      {money(h.startBalance)} → {money(h.endBalance)}
                    </span>
                    <span style={{ fontFamily: C.mono, fontSize: 13, fontWeight: 700, minWidth: 88, textAlign: 'right',
                      color: pos ? (C.green || '#b6ff2e') : (C.red || '#ff6b6b') }}>
                      {pos ? '+' : '−'}{money(Math.abs(h.result || 0))}
                    </span>
                  </div>
                  {/* Muted stats / caller sub-line */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
                    marginTop: 4, color: C.t4, fontFamily: C.body, fontSize: 12 }}>
                    <span>{h.slots} slots</span>
                    <span style={{ opacity: 0.5 }}>·</span>
                    <span style={{ fontFamily: C.mono }}>Req {fmtX(h.reqX)} / Got {fmtX(h.avgX)}</span>
                    {(h.bestCaller || h.worstCaller) && <span style={{ opacity: 0.5 }}>·</span>}
                    {h.bestCaller && (
                      <span>Best <span style={{ color: C.t3, fontWeight: 600 }}>{h.bestCaller.name}</span> {fmtX(h.bestCaller.x)}</span>
                    )}
                    {h.worstCaller && (
                      <span>Worst <span style={{ color: C.t3, fontWeight: 600 }}>{h.worstCaller.name}</span> {fmtX(h.worstCaller.x)}</span>
                    )}
                    {admin && (
                      <>
                        <span style={{ flex: 1 }} />
                        <span style={{ fontFamily: C.mono, opacity: 0.8 }}>stored: {h.srcCurrency || 'USD'}</span>
                        <button style={btn()} disabled={busy} onClick={() => (editing ? setEditKey(null) : openEdit(h))}>Fix currency</button>
                        <button style={btn({ color: C.red || '#ff6b6b', borderColor: C.red || '#ff6b6b' })} disabled={busy} onClick={() => removeRow(h)}>Delete</button>
                      </>
                    )}
                  </div>
                  {/* Inline currency editor */}
                  {editing && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginTop: 8,
                      padding: 8, background: C.bg, border: `1px solid ${C.bdr}`, borderRadius: C.rCtl }}>
                      <span style={{ color: C.t3, fontFamily: C.body, fontSize: 12 }}>Set currency</span>
                      <select value={cur} onChange={(e) => setCur(e.target.value)}
                        style={{ height: 28, background: C.inputBg || C.bg, color: C.t1, border: `1px solid ${C.bdrInput || C.bdr}`, borderRadius: C.rCtl, fontFamily: C.body, fontSize: 13 }}>
                        {CURRENCIES.map((c) => <option key={c} value={c}>{c}</option>)}
                      </select>
                      <input type="number" min="0" step="any" inputMode="decimal" value={rate}
                        onChange={(e) => setRate(e.target.value)} placeholder="rate at hunt time (optional)"
                        style={{ height: 28, width: 190, padding: '0 8px', background: C.inputBg || C.bg, color: C.t1, border: `1px solid ${C.bdrInput || C.bdr}`, borderRadius: C.rCtl, fontFamily: C.body, fontSize: 12 }} />
                      <button style={btn({ background: C.green, color: '#0a0710', border: 'none', fontWeight: 800 })} disabled={busy} onClick={applyEdit}>{busy ? 'Applying…' : 'Apply'}</button>
                      <button style={btn()} disabled={busy} onClick={() => setEditKey(null)}>Cancel</button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
    </div>
  );
}
```

- [ ] **Step 3: Verify build**

Run from `communityhunts-frontend/`: `CI=true npm run build`
Expected: "Compiled successfully".

- [ ] **Step 4: Commit**

Run from `communityhunts-frontend/`:

```bash
git add src/admin/userProfile/PastHunts.js src/admin/UserProfile.js
git commit -m "feat(admin): fix-currency + delete controls on profile past hunts"
```

- [ ] **Step 5: Manual verification (Vercel preview)**

Push the branch, open the preview URL, sign in as an admin, open a user's profile:
- A mislabeled hunt shows "stored: USD"; click **Fix currency** → pick `ARS`, optionally enter the era rate → **Apply** → the row's amounts + the tiles/records above update to sane values.
- **Delete** → confirm → the row disappears and tiles recompute.
- Non-admin (or a non-admin build path) shows no controls.

---

### Task 9: Creation-time prevention — restate currency in the Open-Hunt modal

**Files:**
- Modify: `communityhunts-frontend/src/hunt/StartHuntModal.js`

**Interfaces:**
- Consumes: `SYMBOLS` from `src/hunt/huntMath` (already exports it); existing `currency` state + `user` prop.

- [ ] **Step 1: Import `SYMBOLS`**

In `communityhunts-frontend/src/hunt/StartHuntModal.js`, line 5:

```javascript
import { CURRENCIES, SYMBOLS } from './huntMath';   // single source — a currency added there appears here too
```

- [ ] **Step 2: Show symbol + code in both currency dropdowns**

There are two identical currency `<select>` blocks (community/vip block ~line 150; solo/beans block ~line 193). In **both**, change the option label and widen the control:
- Option: `<option key={cur} value={cur}>{cur}</option>` → `<option key={cur} value={cur}>{SYMBOLS[cur]} · {cur}</option>`
- Select style `width: '7ch'` → `width: '11ch'`

- [ ] **Step 3: Restate the chosen currency at the commit point**

In `communityhunts-frontend/src/hunt/StartHuntModal.js`, insert this block immediately before the `{/* Actions */}` comment (~line 210), so the active currency is restated right above the Open-Hunt button:

```javascript
        {user && (
          <div style={{ textAlign: 'center', fontSize: 12, color: C.t3, marginBottom: 12 }}>
            Tracking in <strong style={{ color: C.t1, fontWeight: 800 }}>{SYMBOLS[currency]} ({currency})</strong> — make sure this matches the casino balance.
          </div>
        )}
```

- [ ] **Step 4: Verify build**

Run from `communityhunts-frontend/`: `CI=true npm run build`
Expected: "Compiled successfully".

- [ ] **Step 5: Commit**

Run from `communityhunts-frontend/`:

```bash
git add src/hunt/StartHuntModal.js
git commit -m "feat(hunt): restate currency in Open-Hunt modal to prevent mislabels"
```

- [ ] **Step 6: Manual verification (Vercel preview)**

Open the Open-Hunt modal for solo and community types: the dropdown reads e.g. `AR$ · ARS`, and above the button a line reads "Tracking in AR$ (ARS) — make sure this matches the casino balance." Changing the dropdown updates the restated line live.

---

## Self-Review

**Spec coverage:**
- Admin fix (relabel + rate) → Tasks 1,2,6,7,8. ✅
- Admin delete → Tasks 3,6,7,8. ✅
- Operates on `hunt_history`, not file archive → Tasks 2,3 (tenant-scoped SELECT/DELETE on `hunt_history`). ✅
- Recompute host + co-participants → reuse of `recordHunt`/keyed transaction (Tasks 2,3). ✅
- Rate override for volatile ARS → Tasks 1,2,6 (`usdRate`), surfaced in UI Task 8. ✅
- ShooterMcGavin fix via the tool (no throwaway script) → Operational rollout step 3. ✅
- Addressability of existing rollups → Tasks 4 (`huntKey`) + 5 (backfill). ✅ (gap the spec implied; covered.)
- Stored-vs-display currency for the Fix default → Task 4 (`srcCurrency`), Task 8. ✅
- Prevention, modal-only, no nag → Task 9. ✅
- Backend-first deploy → Operational rollout ordering. ✅

**Placeholder scan:** No TBD/TODO. The one "copy this block" instruction (Task 5 Pool construction) points at a real existing file and is called out explicitly, because the DB SSL config must match the app's and is not visible in this plan's context.

**Type consistency:** `correctHuntCurrency(tenantId, huntKey, {currency, usdRate})` and `deleteHuntByKey(tenantId, huntKey)` are used identically in statsStore (Tasks 2,3), routes (Task 6), and — via `correctHuntHistory(huntKey, currency, usdRate)` / `deleteHuntHistory(huntKey)` — in adminApi (Task 7) and UserProfile (Task 8). Row field names `huntKey`/`srcCurrency` (Task 4) match their reads in PastHunts (Task 8). `recordHunt(hunt, opts)` override (Task 1) is consumed by `correctHuntCurrency` (Task 2). Consistent.
