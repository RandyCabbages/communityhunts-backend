# Shop Request DM — History + Assignee Tip Handle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show the full DM message history (text + sender) on each Shop Request card, and auto-fill the assigned person's Rainbet tip handle (from their profile) into the Awaiting-payment template.

**Architecture:** Additive. `recordDm` stores two more per-entry fields (`message`, `by`); the DM route passes them from `req.user`. `GET /api/admin/card-requests` also returns an `assignees` array carrying each owner's live `rainbetName`. The frontend maps handles by assignee id and adds a collapsible history list.

**Tech Stack:** Node/Express + `node:test` (backend); React CRA (frontend).

**Spec:** [docs/superpowers/specs/2026-07-14-shop-request-dm-history-and-tip-handle-design.md](../specs/2026-07-14-shop-request-dm-history-and-tip-handle-design.md)

## Global Constraints

- **Two repos, backend-first.** Backend (Railway) merges + verifies before the frontend (Vercel) PR.
- **No `Co-Authored-By` / Claude authorship trailers.**
- **Backend tests:** `node --test lib/cardRequests.test.js routes/cardRequests.routes.test.js` must pass (Node 24 — explicit file paths).
- **Frontend:** `CI=true npm run build` prints "Compiled successfully"; verify on a branch preview URL, never push to `main` to test.
- **No hardcoded handles.** The tip handle comes only from the assignee's profile `rainbetName`; unassigned / unset → generic tip clause.
- **`dmLog` cap stays 10 newest.** `message` stored ≤2000 chars.
- **File Discipline (frontend):** history list is an in-file `DmHistory` sub-component of `ShopRequestDm.js` (same-feature, codebase precedent = `RequestCard` inside `AdminShopRequests.js`).
- **Branch:** `feat/shop-request-dm-history` in both repos.

---

## Task 1: `recordDm` stores `message` + `by` (lib)

**Files:**
- Modify: `communityhunts-backend/lib/cardRequests.js`
- Test: `communityhunts-backend/lib/cardRequests.test.js`

**Interfaces:**
- Produces: `recordDm(id, { template, ok, error, message, by })` — entry now also carries
  `message` (String, ≤2000) and `by` (`{ id, name }`) when provided. Still caps at 10,
  still leaves status/adminNotes untouched.

- [ ] **Step 1: Write the failing test** — append to `lib/cardRequests.test.js`:

```javascript
test('recordDm stores the message text and sender', () => {
  const r = cardRequests.createRequest({ idea: 'store text' }, USER);
  const after = cardRequests.recordDm(r.id, {
    template: 'awaiting_payment', ok: true,
    message: 'Great news — tip RandyCabbage $25 on Rainbet',
    by: { id: '135203806676779008', name: 'Cabbage' },
  });
  assert.strictEqual(after.dmLog[0].message, 'Great news — tip RandyCabbage $25 on Rainbet');
  assert.deepStrictEqual(after.dmLog[0].by, { id: '135203806676779008', name: 'Cabbage' });
  // Omitting message/by is still valid (legacy-shaped entry).
  const after2 = cardRequests.recordDm(r.id, { template: 'card_ready', ok: true });
  assert.strictEqual(after2.dmLog[1].message, undefined);
  assert.strictEqual(after2.dmLog[1].by, undefined);
  cardRequests.deleteRequest(r.id);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test lib/cardRequests.test.js`
Expected: FAIL — `after.dmLog[0].message` is `undefined`.

- [ ] **Step 3: Implement** — in `lib/cardRequests.js`, replace the body of `recordDm` (the destructure + entry build) so it also captures `message` and `by`:

```javascript
function recordDm(id, { template, ok, error, message, by } = {}) {
  const r = requests.find(x => x.id === id);
  if (!r) return null;
  if (!Array.isArray(r.dmLog)) r.dmLog = [];
  const at = new Date().toISOString();
  const entry = { at, template: String(template || ''), ok: !!ok };
  if (error) entry.error = String(error).slice(0, 300);
  if (message) entry.message = String(message).slice(0, 2000);
  if (by && by.id) entry.by = { id: String(by.id), name: String(by.name || '') };
  r.dmLog.push(entry);
  if (r.dmLog.length > MAX_DM_LOG) r.dmLog = r.dmLog.slice(-MAX_DM_LOG);
  r.lastDmAt = at;
  persist();
  return r;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test lib/cardRequests.test.js`
Expected: PASS (all tests).

- [ ] **Step 5: Commit**

```bash
git checkout -b feat/shop-request-dm-history   # skip if it exists
git add lib/cardRequests.js lib/cardRequests.test.js
git commit -m "feat: recordDm stores message text + sender"
```

---

## Task 2: DM route passes `message` + `by`

**Files:**
- Modify: `communityhunts-backend/routes/cardRequests.routes.js`
- Test: `communityhunts-backend/routes/cardRequests.routes.test.js`

**Interfaces:**
- Consumes: `recordDm` (Task 1); `req.user` from `requireAuth`.
- Produces: every `dmLog` entry written by the DM route carries `message` (the sent text)
  and `by` (`{ id, name }` from `req.user`).

- [ ] **Step 1: Update the test harness to supply `req.user`, and add assertions.**

In `routes/cardRequests.routes.test.js`, change the `requireAuth` stub in `appWith` to set a user:

```javascript
  const requireAuth = (req, res, next) => { req.user = { id: 'admin1', displayName: 'Cabbage' }; next(); };
```

Then extend the success test (`'a successful DM opens the channel then posts the message, and records ok:true'`) with, before its closing brace:

```javascript
  // Message text + sender are recorded on the entry.
  assert.strictEqual(stored.dmLog[0].message, 'hello there');
  assert.deepStrictEqual(stored.dmLog[0].by, { id: 'admin1', name: 'Cabbage' });
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test routes/cardRequests.routes.test.js`
Expected: FAIL — `stored.dmLog[0].message` is `undefined` (route doesn't pass it yet).

- [ ] **Step 3: Implement.** In `routes/cardRequests.routes.js`, inside the
`POST /api/admin/card-requests/:id/dm` handler, add a `by`/`message` context right after the
404 check (after `if (!r) return res.status(404)...`):

```javascript
    const by = req.user ? { id: String(req.user.id), name: req.user.displayName || req.user.username || 'admin' } : undefined;
```

Then update all three `recordDm(...)` calls in that handler to pass `message` + `by`:

```javascript
      // 403 / other failure path:
        const updated = cardRequests.recordDm(r.id, { template, ok: false, error, message, by });
```

```javascript
      // success path:
      const updated = cardRequests.recordDm(r.id, { template, ok: true, message, by });
```

```javascript
      // catch path:
      const updated = cardRequests.recordDm(r.id, { template, ok: false, error: CANT_DM, message, by });
```

(`message` and `template` are already in scope in that handler.)

- [ ] **Step 4: Run to verify it passes**

Run: `node --test routes/cardRequests.routes.test.js`
Expected: PASS (all 7 tests, with the extended success assertions).

- [ ] **Step 5: Commit**

```bash
git add routes/cardRequests.routes.js routes/cardRequests.routes.test.js
git commit -m "feat: DM route records message text + sender"
```

---

## Task 3: `GET /api/admin/card-requests` returns `assignees` with live Rainbet handles

**Files:**
- Modify: `communityhunts-backend/routes/cardRequests.routes.js`
- Modify: `communityhunts-backend/server.js` (inject `getSettings`)
- Test: `communityhunts-backend/routes/cardRequests.routes.test.js`

**Interfaces:**
- Consumes: injected `getSettings(id) → Promise<{ rainbetName, ... }>`; `ASSIGNEES` (already
  imported at the top of the routes file).
- Produces: `GET` response `{ requests, assignees: [{ id, label, rainbet }] }` where
  `rainbet = getSettings(id).rainbetName || ''`.

- [ ] **Step 1: Add the failing GET test.** In `routes/cardRequests.routes.test.js`, add a
`getSettings` option to `appWith` (default returns empty settings), and pass it into the
router deps:

```javascript
function appWith({ requests = [], admin = true, platformToken = 'ptok', getSettings } = {}) {
  const app = express();
  app.use(express.json());
  const requireAuth = (req, res, next) => { req.user = { id: 'admin1', displayName: 'Cabbage' }; next(); };
  const requirePlatformAdmin = admin ? (req, res, next) => next() : (req, res, next) => res.status(403).json({ error: 'forbidden' });
  const cardRequests = fakeCardRequests(requests);
  const gs = getSettings || (async () => ({ rainbetName: '' }));
  app.use(cardRequestsRoutes({ requireAuth, requirePlatformAdmin, cardRequests, getPlatformBotToken: () => platformToken, getSettings: gs, channelId: '999' }));
  app._cardRequests = cardRequests;
  return app;
}
```

Add a GET helper + test at the end of the file:

```javascript
async function getRequests(app) {
  const server = await new Promise(resolve => { const s = app.listen(0, () => resolve(s)); });
  try {
    const r = await realFetch(`http://127.0.0.1:${server.address().port}/api/admin/card-requests`);
    return { status: r.status, body: await r.json().catch(() => null) };
  } finally {
    server.close();
  }
}

test('GET returns assignees with each owner\\'s rainbet handle from getSettings', async () => {
  const handles = { '135203806676779008': 'RandyCabbage', '168055630916091904': 'GooferBeans' };
  const app = appWith({ requests: [{ ...REQ }], getSettings: async (id) => ({ rainbetName: handles[id] || '' }) });
  const r = await getRequests(app);
  assert.strictEqual(r.status, 200);
  assert.ok(Array.isArray(r.body.assignees), 'assignees present');
  const cab = r.body.assignees.find(a => a.id === '135203806676779008');
  const goof = r.body.assignees.find(a => a.id === '168055630916091904');
  assert.strictEqual(cab.rainbet, 'RandyCabbage');
  assert.strictEqual(goof.rainbet, 'GooferBeans');
  assert.strictEqual(r.body.requests.length, 1, 'requests still returned');
});

test('GET yields empty rainbet when a handle is unset', async () => {
  const app = appWith({ requests: [], getSettings: async () => ({ rainbetName: '' }) });
  const r = await getRequests(app);
  assert.strictEqual(r.body.assignees.every(a => a.rainbet === ''), true);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test routes/cardRequests.routes.test.js`
Expected: FAIL — `r.body.assignees` is `undefined` (GET returns only `requests`).

- [ ] **Step 3: Implement.** In `routes/cardRequests.routes.js`:

3a. Add `getSettings` to the deps destructure at the top of the exported function:

```javascript
  const { requireAuth, requirePlatformAdmin, cardRequests, getPlatformBotToken, getSettings, channelId } = deps;
```

3b. Replace the GET handler:

```javascript
  router.get('/api/admin/card-requests', requireAuth, requirePlatformAdmin, async (req, res) => {
    // Resolve each owner's live Rainbet tip handle from their profile (rainbetName). Small
    // fixed set (the platform owners); computed at read time so it always reflects the profile.
    const getS = typeof getSettings === 'function' ? getSettings : async () => ({});
    const assignees = await Promise.all(ASSIGNEES.map(async (a) => {
      let rainbet = '';
      try { const s = await getS(a.id); rainbet = (s && s.rainbetName) ? String(s.rainbetName) : ''; } catch (e) {}
      return { id: a.id, label: a.label, rainbet };
    }));
    res.json({ requests: cardRequests.listRequests(), assignees });
  });
```

3c. In `communityhunts-backend/server.js`, add `getSettings` to the `cardRequests.routes` mount (the `app.use(require('./routes/cardRequests.routes')({ ... }))` block ~line 395):

```javascript
app.use(require('./routes/cardRequests.routes')({
  requireAuth, requirePlatformAdmin, cardRequests,
  getPlatformBotToken: tenants.getPlatformBotToken,
  getSettings: settings.getSettings,
  channelId: (process.env.DISCORD_SHOP_REQUESTS_CHANNEL_ID || '').trim(),
}));
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test routes/cardRequests.routes.test.js`
Expected: PASS (all tests, incl. the two GET tests).

- [ ] **Step 5: Commit**

```bash
git add routes/cardRequests.routes.js server.js routes/cardRequests.routes.test.js
git commit -m "feat: GET card-requests returns assignees with profile rainbet handles"
```

---

## Task 4: Backend — full suite, push, PR, verify on Railway

**Files:** none (integration/deploy gate).

- [ ] **Step 1: Run both suites**

Run: `node --test lib/cardRequests.test.js routes/cardRequests.routes.test.js`
Expected: PASS.

- [ ] **Step 2: Push + PR**

```bash
git pull --ff-only origin main
git push -u origin feat/shop-request-dm-history
gh pr create --title "feat: Shop Request DM history fields + assignee tip handle" \
  --body "Backend for two DM follow-ups: recordDm now stores message text + sender (by); the DM route passes them from req.user; GET /api/admin/card-requests also returns an assignees array with each owner's live rainbetName handle. Additive, no schema migration. Frontend PR follows. Includes the spec + plan under docs/superpowers/."
```

- [ ] **Step 3: Merge + verify live**

Merge → Railway deploys. Then set the two `rainbetName` values (Cabbage → `RandyCabbage`,
Goofer → `GooferBeans`) via the admin user-profile panel. The frontend PR must not merge
until this is live.

---

## Task 5: Frontend — Awaiting-payment wording + tip handle

**Files:**
- Modify: `communityhunts-frontend/src/admin/shopRequestDmTemplates.js`

**Interfaces:**
- Produces: `DM_TEMPLATES[*].build(r, ctx = {})` — the *awaiting_payment* builder reads
  `ctx.assigneeRainbet`; the others ignore `ctx`.

- [ ] **Step 1: Update the awaiting_payment template.** In `shopRequestDmTemplates.js`,
replace the `awaiting_payment` entry with:

```javascript
  {
    key: 'awaiting_payment',
    label: 'Awaiting payment',
    build: (r, ctx = {}) => {
      const handle = (ctx.assigneeRainbet && ctx.assigneeRainbet.trim()) || '';
      const tip = handle ? `tip ${handle} $25 on Rainbet` : 'send a $25 tip on Rainbet';
      return `Great news — ${whoOf(r)} is ready to make your card "${cardOf(r)}"! To lock it in, ` +
        `just ${tip} whenever you're ready and we'll get started. Thanks so much for the support 🎨${SIGN}`;
    },
  },
```

- [ ] **Step 2: Verify it compiles**

Run: `cd communityhunts-frontend && CI=true npm run build`
Expected: "Compiled successfully".

- [ ] **Step 3: Commit**

```bash
cd communityhunts-frontend
git checkout -b feat/shop-request-dm-history   # skip if it exists
git add src/admin/shopRequestDmTemplates.js
git commit -m "feat: awaiting-payment template names the assignee tip handle"
```

---

## Task 6: Frontend — `ShopRequestDm` tip-handle ctx + collapsible history

**Files:**
- Modify: `communityhunts-frontend/src/admin/ShopRequestDm.js`

**Interfaces:**
- Consumes: `DM_TEMPLATES` (with `build(r, ctx)`); a new `assigneeRainbet` prop (Task 7 supplies it).
- Produces: `<ShopRequestDm r C onSent assigneeRainbet />` — prefills templates with the
  handle and renders a `▸ History (N)` collapsible list.

- [ ] **Step 1: Accept the prop + pass it to the builder.** Change the signature and `pick`:

```javascript
export default function ShopRequestDm({ r, C, onSent, assigneeRainbet }) {
```

```javascript
  const pick = (key) => {
    setTemplateKey(key);
    setErr('');
    const tpl = DM_TEMPLATES.find(t => t.key === key);
    setText(tpl ? tpl.build(r, { assigneeRainbet }) : '');
  };
```

- [ ] **Step 2: Add history state + toggle + list.** Add near the other `useState` calls:

```javascript
  const [showHistory, setShowHistory] = useState(false);
```

Replace the `const last = ...` line with a log-aware version:

```javascript
  const log = Array.isArray(r.dmLog) ? r.dmLog : [];
  const last = log.length ? log[log.length - 1] : null;
```

In the header row (the `div` that holds the DM REQUESTER label + select + last-outcome
span), add a history toggle right after the `{last && (...)}` status span:

```javascript
        {log.length > 0 && (
          <button onClick={() => setShowHistory(v => !v)}
            style={{ background: 'none', border: 'none', color: C.t3, fontFamily: C.body, fontSize: 11, cursor: 'pointer', padding: 0 }}>
            {showHistory ? '▾' : '▸'} History ({log.length})
          </button>
        )}
```

Then, just before the final `{err && ...}` line, render the list when open:

```javascript
      {showHistory && <DmHistory log={log} C={C} />}
```

- [ ] **Step 3: Add the in-file `DmHistory` sub-component** at the bottom of the file
(after the default export function's closing brace):

```javascript
// Newest-first list of past DM attempts for one request. Reads the persisted dmLog; legacy
// entries (pre message/sender capture) show "(message not recorded)".
function DmHistory({ log, C }) {
  const LABEL = Object.fromEntries(DM_TEMPLATES.map(t => [t.key, t.label]));
  return (
    <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 8 }}>
      {log.slice().reverse().map((e, i) => (
        <div key={i} style={{ fontSize: 11, borderLeft: `2px solid ${e.ok ? C.green : C.red}`, paddingLeft: 8 }}>
          <div style={{ color: C.t3 }}>
            <span style={{ color: e.ok ? C.green : C.red, fontWeight: 700 }}>{e.ok ? '✓' : '✗'}</span>{' '}
            {LABEL[e.template] || 'Message'}
            {e.at ? ` · ${new Date(e.at).toLocaleString()}` : ''}
            {e.by && e.by.name ? ` · sent by ${e.by.name}` : ''}
          </div>
          {!e.ok && e.error && <div style={{ color: C.red, marginTop: 2 }}>{e.error}</div>}
          <div style={{ color: C.t2, whiteSpace: 'pre-wrap', marginTop: 2 }}>
            {e.message ? e.message : <span style={{ color: C.t4, fontStyle: 'italic' }}>(message not recorded)</span>}
          </div>
        </div>
      ))}
    </div>
  );
}
```

- [ ] **Step 4: Verify it compiles**

Run: `cd communityhunts-frontend && CI=true npm run build`
Expected: "Compiled successfully".

- [ ] **Step 5: Commit**

```bash
git add src/admin/ShopRequestDm.js
git commit -m "feat: DM history list + assignee tip-handle prefill in ShopRequestDm"
```

---

## Task 7: Frontend — thread `assigneeRainbet` from `AdminShopRequests`, build, PR, preview

**Files:**
- Modify: `communityhunts-frontend/src/admin/AdminShopRequests.js`

**Interfaces:**
- Consumes: `getCardRequests()` (now returns `{ requests, assignees }`); `<ShopRequestDm assigneeRainbet />` (Task 6).

- [ ] **Step 1: Hold a handle map + read `assignees` on load.** Add a state near the others
(after `const [error, setError] = useState('');`):

```javascript
  const [rainbetFor, setRainbetFor] = useState({}); // assignee id → rainbet handle
```

Replace the `useEffect` load body:

```javascript
  useEffect(() => {
    getCardRequests()
      .then(r => {
        setRows((r && r.requests) || []);
        const map = {};
        ((r && r.assignees) || []).forEach(a => { if (a.rainbet) map[a.id] = a.rainbet; });
        setRainbetFor(map);
      })
      .catch(e => setError(e.message || 'Failed to load requests'))
      .finally(() => setLoading(false));
  }, []);
```

- [ ] **Step 2: Pass the resolved handle to each card.** In the `rows.map(...)`, add the
`assigneeRainbet` prop:

```javascript
          {rows.map(r => <RequestCard key={r.id} r={r} C={C} onStatus={setStatus} onAssign={setAssignee} onNotes={saveNotes} onDelete={remove} onDm={u => setRows(rs => rs.map(x => (x.id === u.id ? u : x)))} assigneeRainbet={rainbetFor[r.assignee] || ''} />)}
```

- [ ] **Step 3: Thread it through `RequestCard` to `ShopRequestDm`.** Update the signature:

```javascript
function RequestCard({ r, C, onStatus, onAssign, onNotes, onDelete, onDm, assigneeRainbet }) {
```

And the render:

```javascript
      <ShopRequestDm r={r} C={C} onSent={onDm} assigneeRainbet={assigneeRainbet} />
```

- [ ] **Step 4: Verify it compiles**

Run: `cd communityhunts-frontend && CI=true npm run build`
Expected: "Compiled successfully".

> Heads-up: CRA does not flag a missed prop. Confirm by hand that `assigneeRainbet` flows
> `AdminShopRequests` → `RequestCard` → `ShopRequestDm`, and `onDm` still does too.

- [ ] **Step 5: Commit, push, PR**

```bash
git add src/admin/AdminShopRequests.js
git commit -m "feat: thread assignee rainbet handle into Shop Request DM control"
git pull --ff-only origin main
git push -u origin feat/shop-request-dm-history
gh pr create --title "feat: Shop Request DM history + assignee tip handle" \
  --body "Adds a collapsible per-request DM history (message text + sender) and auto-fills the assigned owner's Rainbet tip handle (from their profile) into the Awaiting-payment template. Pairs with the backend PR (message/by + assignees). Requires the two owners' rainbetName set."
```

- [ ] **Step 6: Preview-verify, then merge.** On the branch preview, as a platform owner:
  set an assignee whose `rainbetName` is set → pick **Awaiting payment** → confirm it reads
  "…tip `<handle>` $25 on Rainbet…"; unassigned/unset → generic clause. Send a DM → expand
  **`▸ History (N)`** → confirm the message text + "sent by <you>" appear; a pre-existing
  entry shows "(message not recorded)". Merge to `main` only after this passes.

---

## Self-Review (completed during planning)

- **Spec coverage:** message+by capture (Tasks 1–2) · assignees/rainbet in GET + getSettings injection (Task 3) · wording + handle in template (Task 5) · ctx prefill + collapsible history + DmHistory (Task 6) · handle map threading (Task 7) · rollout incl. rainbetName setup (Task 4 step 3). All covered.
- **Type consistency:** `recordDm({..., message, by})` defined in Task 1, passed in Task 2. `assignees: [{id,label,rainbet}]` returned in Task 3, consumed into `rainbetFor` (Task 7), read via `assigneeRainbet` prop (Tasks 6–7) into `build(r, {assigneeRainbet})` (Task 5). `by`/`message` entry fields rendered by `DmHistory` (Task 6). Names align across tasks.
- **Placeholder scan:** none — every step carries full code or exact commands.
