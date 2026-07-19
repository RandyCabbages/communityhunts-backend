# Anonymous Mode — Mask Identity Everywhere — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make "Show me as anonymous" hide a member's name everywhere it appears to a non-privileged public viewer (equity, slot calls, caller column, archived summaries, Hall of Fame, bangers), give admins/self a 🔒 indicator, and attach a durable Discord ID to equity rows so masking is rename-proof and the payout ledger + profile history can reuse the key.

**Architecture:** A single display-redaction predicate `shouldMaskIdentity({ discordId, name })` in `lib/settings.js`, backed by two hot in-memory sets (`anonymousUsers` IDs + `anonymousNames` names). It is injected into `lib/hunts-core.js` and passed to the pure Hall-of-Fame / bangers collectors, then applied at every serializer. Identity is attached to equity rows via owner-authorized flows only (auto-bind at call-grant; manual admin link) — never by bare name-match. Backend ships first (masking is server-authoritative); frontend adds badges, a self-banner, and the link UI.

**Tech Stack:** Node.js + Express + Socket.IO (backend, `node:test`), React CRA (frontend, `react-scripts test` for pure logic only).

## Global Constraints

- **Redaction predicate is display-only.** `shouldMaskIdentity` / name-match must NEVER be used to grant permissions or attribute payouts — only to hide a name for display. (2026-07-18 security audit #2.)
- **Never stamp `discordId` onto an equity row by bare name-match.** Every ID bind is owner-authorized (call-grant) or admin-authorized (manual link).
- **Privileged viewer or self always sees the real name** + `anonymous: true` flag. Non-privileged public viewers get `name: 'Anonymous'`, `avatar: null`. Privileged = hunt runner / mod / admin, via the existing `isPrivilegedViewer(viewerId, hunt)`.
- **`publicHuntView` must strip identity linkage** (`discordId`, new `callerId`) from every public payload.
- Backend tests: run with `node --test lib/*.test.js` (NOT `node --test lib/` — that is broken on node24). Keep new logic in pure `lib/` helpers so tests don't need `app.listen` (route suites that listen hang).
- Frontend tests: pure-logic modules only — `CI=true npx react-scripts test --testPathPattern="X" --watchAll=false`. No component tests (`@testing-library/react` is not installed). Components verified by `CI=true npm run build` printing "Compiled successfully".
- No `Co-Authored-By` trailers on any commit.
- Deploy order: all backend tasks (Phase A + B) merge + deploy to Railway BEFORE any frontend task ships.

---

## Phase A — Backend: masking predicate + serializers (fixes the visible leak)

### Task A1: `anonymousNames` set + `isAnonymousName` + `shouldMaskIdentity`

**Files:**
- Modify: `communityhunts-backend/lib/settings.js` (anon set block ~L19-32; `saveSettings` ~L157-173; `deleteSettings` ~L178-195; exports ~L254-268)
- Test: `communityhunts-backend/lib/settings.anon.test.js` (new)

**Interfaces:**
- Produces: `isAnonymousName(name): boolean`, `shouldMaskIdentity({ discordId, name }): boolean`, and a mutation-tested `anonymousNames` Set kept in sync by `loadAnonymousUsers` / `saveSettings` / `deleteSettings`. `normAnonName(s): string` (exported for reuse/testing).

- [ ] **Step 1: Write the failing test**

Create `communityhunts-backend/lib/settings.anon.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert');
const settings = require('./settings');

// These operate on the live module-level sets via the exported test seam.
test('isAnonymousName matches case/space-insensitively', () => {
  settings.__seedAnonForTest({ ids: ['111'], names: ['Big Bird'] });
  assert.equal(settings.isAnonymousName('big bird'), true);
  assert.equal(settings.isAnonymousName('  BIG BIRD '), true);
  assert.equal(settings.isAnonymousName('bigbird'), false); // spaces are normalized, not stripped
  assert.equal(settings.isAnonymousName('someone else'), false);
});

test('shouldMaskIdentity is true on id hit OR name hit, false otherwise', () => {
  settings.__seedAnonForTest({ ids: ['111'], names: ['big bird'] });
  assert.equal(settings.shouldMaskIdentity({ discordId: '111', name: 'whatever' }), true); // id
  assert.equal(settings.shouldMaskIdentity({ discordId: '999', name: 'Big Bird' }), true); // name
  assert.equal(settings.shouldMaskIdentity({ discordId: '999', name: 'Nobody' }), false);
  assert.equal(settings.shouldMaskIdentity({}), false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd communityhunts-backend && node --test lib/settings.anon.test.js`
Expected: FAIL — `settings.__seedAnonForTest is not a function`.

- [ ] **Step 3: Implement the predicate + set maintenance**

In `lib/settings.js`, replace the anon block (currently L19-32) with:

```js
// Hot in-memory identity sets for "Show me as anonymous". Kept in sync so the per-viewer
// redaction in hunts-core is an O(1) lookup on every hunt broadcast (no DB round-trip).
//   anonymousUsers — Discord IDs who opted in.
//   anonymousNames — the normalized current display names of those same users (from their
//     settings row's discordDisplayName/discordUsername). The name-match FALLBACK — display
//     redaction only, NEVER a permission/attribution signal (2026-07-18 security audit #2).
const anonymousUsers = new Set();
const anonymousNames = new Set();
const normAnonName = s => (s || '').toString().toLowerCase().replace(/\s+/g, ' ').trim();
function isAnonymousUser(userId) { return !!userId && anonymousUsers.has(String(userId)); }
function isAnonymousName(name) { const n = normAnonName(name); return !!n && anonymousNames.has(n); }
// Display-redaction predicate: mask if the row's bound Discord ID OR its display name belongs
// to an anonymous user. DISPLAY ONLY — never gate permissions or attribution on this.
function shouldMaskIdentity({ discordId, name } = {}) {
  return isAnonymousUser(discordId) || isAnonymousName(name);
}
function addAnonNames(row) {
  for (const cand of [row.discordDisplayName, row.discordUsername]) {
    const n = normAnonName(cand);
    if (n) anonymousNames.add(n);
  }
}
async function loadAnonymousUsers() {
  try {
    const rows = await allSettingsRows();
    anonymousUsers.clear();
    anonymousNames.clear();
    for (const r of rows) {
      if (!r.anonymous) continue;
      anonymousUsers.add(String(r.userId));
      addAnonNames(r);
    }
    console.log(`[settings] tracking ${anonymousUsers.size} anonymous user(s), ${anonymousNames.size} name(s)`);
  } catch (e) { console.error('[settings] loadAnonymousUsers failed:', e.message); }
}
// Test seam: deterministically seed the hot sets without a DB.
function __seedAnonForTest({ ids = [], names = [] } = {}) {
  anonymousUsers.clear(); anonymousNames.clear();
  ids.forEach(id => anonymousUsers.add(String(id)));
  names.forEach(n => { const v = normAnonName(n); if (v) anonymousNames.add(v); });
}
```

In `saveSettings` (currently L158-160), replace the two-line sync with:

```js
  // Keep the hot anonymous sets in sync on every write (both pg + file paths).
  if (data && data.anonymous) { anonymousUsers.add(String(userId)); addAnonNames(data); }
  else {
    anonymousUsers.delete(String(userId));
    for (const cand of [data && data.discordDisplayName, data && data.discordUsername]) {
      const n = normAnonName(cand); if (n) anonymousNames.delete(n);
    }
  }
```

In `deleteSettings` (currently L180), after `anonymousUsers.delete(uid);` add:

```js
  // We don't have the row's names here; a full rebuild is cheap and only runs on manual purge.
  loadAnonymousUsers().catch(() => {});
```

Add to `module.exports`: `isAnonymousName, shouldMaskIdentity, normAnonName, __seedAnonForTest`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd communityhunts-backend && node --test lib/settings.anon.test.js`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
cd communityhunts-backend
git add lib/settings.js lib/settings.anon.test.js
git commit -m "feat(anon): add name-aware masking predicate to settings"
```

---

### Task A2: Inject `shouldMaskIdentity`; extend equity masking to name-match

**Files:**
- Modify: `communityhunts-backend/lib/hunts-core.js` (DI ~L20-34; `maskEquityMember` ~L398-404; `huntSummary` archived equity ~L72-78)
- Modify: `communityhunts-backend/server.js` (`huntsCore.initHuntsCore({...})` call ~L314-317)
- Test: `communityhunts-backend/lib/hunts-core.anon.test.js` (new)

**Interfaces:**
- Consumes: `shouldMaskIdentity` from Task A1.
- Produces: `maskEquityMember(member, viewerId, privileged)` now masks when the row's `discordId` OR `name` is anonymous; injected `shouldMaskIdentity` (defaults to a privacy-safe id-only no-op if not wired). `initHuntsCore` accepts `deps.shouldMaskIdentity`.

- [ ] **Step 1: Write the failing test**

Create `communityhunts-backend/lib/hunts-core.anon.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert');
const core = require('./hunts-core');

function wire() {
  core.initHuntsCore({
    hunts: {}, archive: [], viewers: {}, io: { to: () => ({ emit() {} }) }, persistHunts() {},
    isAnonymousUser: id => id === 'idAnon',
    isPrivilegedViewer: (vid) => vid === 'runner',
    shouldMaskIdentity: ({ discordId, name }) =>
      discordId === 'idAnon' || (name || '').toLowerCase().trim() === 'anon guy',
  });
}

test('maskEquityMember masks a name-only anonymous row for the public', () => {
  wire();
  const row = { id: 'm1', name: 'Anon Guy', amount: 100, avatar: 'a.png' }; // no discordId
  const pub = core.publicHuntView({ equity: [row] }); // no viewerId = unprivileged
  assert.equal(pub.equity[0].name, 'Anonymous');
  assert.equal(pub.equity[0].avatar, null);
  assert.equal(pub.equity[0].anonymous, true);
});

test('privileged viewer keeps the real name + anonymous flag', () => {
  wire();
  const row = { id: 'm1', name: 'Anon Guy', amount: 100 };
  const pv = core.publicHuntView({ user: { id: 'x' }, equity: [row] }, 'runner');
  assert.equal(pv.equity[0].name, 'Anon Guy');
  assert.equal(pv.equity[0].anonymous, true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd communityhunts-backend && node --test lib/hunts-core.anon.test.js`
Expected: FAIL — public row name is still `'Anon Guy'` (name-match not applied yet).

- [ ] **Step 3: Wire DI + extend the mask**

In `lib/hunts-core.js`, in the injected-collaborators block (currently L23-24) add:

```js
let shouldMaskIdentity = ({ discordId }) => isAnonymousUser(discordId); // privacy-safe id-only default
```

In `initHuntsCore` (after the `isPrivilegedViewer` wire, ~L33) add:

```js
  if (deps.shouldMaskIdentity) shouldMaskIdentity = deps.shouldMaskIdentity;
```

Replace `maskEquityMember` (currently L398-404) with:

```js
function maskEquityMember(member, viewerId, privileged) {
  const { discordId, callerId, ...e } = member; // drop internal linkage from every public payload
  if (!shouldMaskIdentity({ discordId, name: e.name })) return e;
  const isSelf = viewerId && discordId && String(viewerId) === String(discordId);
  if (privileged || isSelf) return { ...e, anonymous: true };
  return { ...e, name: 'Anonymous', avatar: null, anonymous: true };
}
```

Update the archived-summary equity map in `huntSummary` (currently L76) from:

```js
          name: (e.discordId && isAnonymousUser(e.discordId)) ? 'Anonymous' : e.name,
```

to:

```js
          name: shouldMaskIdentity({ discordId: e.discordId, name: e.name }) ? 'Anonymous' : e.name,
```

In `server.js`, add `shouldMaskIdentity: settings.shouldMaskIdentity` to the `huntsCore.initHuntsCore({...})` call (currently L314-317, alongside `isAnonymousUser`).

- [ ] **Step 4: Run test to verify it passes**

Run: `cd communityhunts-backend && node --test lib/hunts-core.anon.test.js`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
cd communityhunts-backend
git add lib/hunts-core.js lib/hunts-core.anon.test.js server.js
git commit -m "feat(anon): mask equity by name-match, inject shouldMaskIdentity"
```

---

### Task A3: Mask slot calls + caller column in `publicHuntView`; broaden `huntHasAnon`

**Files:**
- Modify: `communityhunts-backend/lib/hunts-core.js` (`huntHasAnon` ~L391-393; `publicHuntView` ~L409-420)
- Test: `communityhunts-backend/lib/hunts-core.anon.test.js` (append)

**Interfaces:**
- Consumes: `shouldMaskIdentity`, `isPrivilegedViewer` (Task A2).
- Produces: `publicHuntView` masks `calls[].user` and `bonuses[].caller` (adds `anonymous: true` on masked/flagged entries, strips `callerId`); `huntHasAnon(h)` returns true if ANY equity row, call, or bonus-caller is maskable.

- [ ] **Step 1: Write the failing test** (append to `lib/hunts-core.anon.test.js`)

```js
test('publicHuntView masks calls[].user and bonuses[].caller for the public', () => {
  wire();
  const h = {
    equity: [],
    calls: [{ id: 'c1', slot: 'Gates', user: 'Anon Guy', status: 'pending' }],
    bonuses: [{ id: 'b1', slot: 'Gates', caller: 'Anon Guy', callerId: 'idAnon' }],
  };
  const pub = core.publicHuntView(h); // unprivileged
  assert.equal(pub.calls[0].user, 'Anonymous');
  assert.equal(pub.calls[0].anonymous, true);
  assert.equal(pub.bonuses[0].caller, 'Anonymous');
  assert.equal('callerId' in pub.bonuses[0], false); // linkage stripped
});

test('huntHasAnon detects a caller-only anonymous hunt (no anon equity)', () => {
  wire();
  const h = { equity: [{ id: 'm', name: 'Someone', amount: 5 }],
              calls: [{ id: 'c', slot: 'X', user: 'Anon Guy' }], bonuses: [] };
  assert.equal(core.huntHasAnon(h), true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd communityhunts-backend && node --test lib/hunts-core.anon.test.js`
Expected: FAIL — `pub.calls[0].user` is still `'Anon Guy'`.

- [ ] **Step 3: Implement caller masking + broadened detection**

In `lib/hunts-core.js`, replace `huntHasAnon` (currently L391-393) with:

```js
// Any maskable identity in the hunt — an equity row (id or name), a slot-call caller, or a
// bonus caller. Drives the per-socket broadcast path (emitHuntUpdate) and stays a cheap scan.
function huntHasAnon(h) {
  const eq = Array.isArray(h.equity) && h.equity.some(e => shouldMaskIdentity({ discordId: e.discordId, name: e.name }));
  const ca = Array.isArray(h.calls) && h.calls.some(c => shouldMaskIdentity({ discordId: c.callerId, name: c.user }));
  const bo = Array.isArray(h.bonuses) && h.bonuses.some(b => shouldMaskIdentity({ discordId: b.callerId, name: b.caller }));
  return !!(eq || ca || bo);
}
// Mask one call/bonus caller entry. Strips callerId always; privileged/self keep the real name.
function maskCallerEntry(entry, nameField, viewerId, privileged) {
  const { callerId, ...e } = entry;
  if (!shouldMaskIdentity({ discordId: callerId, name: e[nameField] })) return e;
  const isSelf = viewerId && callerId && String(viewerId) === String(callerId);
  if (privileged || isSelf) return { ...e, anonymous: true };
  return { ...e, [nameField]: 'Anonymous', anonymous: true };
}
```

Replace `publicHuntView` (currently L409-420) with:

```js
function publicHuntView(h, viewerId) {
  if (!h) return h;
  const { publicCallsPin, invitedEditors, callsPermissions, ...rest } = h;
  const privileged = viewerId ? isPrivilegedViewer(viewerId, h) : false;
  return {
    ...rest,
    requiresPin: !!publicCallsPin,
    equity: Array.isArray(h.equity) ? h.equity.map(e => maskEquityMember(e, viewerId, privileged)) : h.equity,
    calls: Array.isArray(h.calls) ? h.calls.map(c => maskCallerEntry(c, 'user', viewerId, privileged)) : h.calls,
    bonuses: Array.isArray(h.bonuses) ? h.bonuses.map(b => maskCallerEntry(b, 'caller', viewerId, privileged)) : h.bonuses,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd communityhunts-backend && node --test lib/hunts-core.anon.test.js`
Expected: PASS (4 tests total in file).

- [ ] **Step 5: Commit**

```bash
cd communityhunts-backend
git add lib/hunts-core.js lib/hunts-core.anon.test.js
git commit -m "feat(anon): mask slot-call + bonus caller names in publicHuntView"
```

---

### Task A4: Mask host name in Hall of Fame + bangers

**Files:**
- Modify: `communityhunts-backend/lib/hallOfFame.js` (`collectHallOfFame` ~L16-51)
- Modify: `communityhunts-backend/lib/bangers.js` (`collectBangers` ~L6-44)
- Modify: `communityhunts-backend/routes/misc.routes.js` (the two collector call sites — pass `isAnon`)
- Test: `communityhunts-backend/lib/hallOfFame.anon.test.js` (new)

**Interfaces:**
- Consumes: a predicate `isAnon({ discordId, name })` (pass `settings.shouldMaskIdentity` from the route).
- Produces: `collectHallOfFame(hunts, archive, tenantId, { isAnon })` and `collectBangers(hunts, archive, tenantId, { isAnon, ... })` emit `username: 'Anonymous'`, `avatar: null` for an anonymous host. These rails have no per-viewer context, so an anonymous host is always masked.

- [ ] **Step 1: Write the failing test**

Create `communityhunts-backend/lib/hallOfFame.anon.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert');
const { collectHallOfFame } = require('./hallOfFame');

const bigHit = { slot: 'Gates', bet: 1, win: 400, replayUrl: 'https://x/y' };
const hunt = { user: { id: 'h1', displayName: 'HostGuy', avatar: 'a.png' }, tenantId: 'bean',
               isLive: false, archivedAt: '2026-07-01', bonuses: [bigHit] };

test('collectHallOfFame masks an anonymous host name', () => {
  const isAnon = ({ discordId, name }) => discordId === 'h1' || name === 'HostGuy';
  const out = collectHallOfFame({}, [hunt], 'bean', { isAnon });
  assert.equal(out.length, 1);
  assert.equal(out[0].username, 'Anonymous');
  assert.equal(out[0].avatar, null);
});

test('collectHallOfFame leaves a non-anonymous host untouched', () => {
  const out = collectHallOfFame({}, [hunt], 'bean', { isAnon: () => false });
  assert.equal(out[0].username, 'HostGuy');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd communityhunts-backend && node --test lib/hallOfFame.anon.test.js`
Expected: FAIL — `collectHallOfFame` ignores the 4th arg; `username` is `'HostGuy'`.

- [ ] **Step 3: Implement masking in both collectors**

In `lib/hallOfFame.js`, change the signature (L16) to:

```js
function collectHallOfFame(hunts, archive, tenantId, { isAnon = () => false } = {}) {
```

and replace the `out.push({...})` block (currently L33-38) with:

```js
      const anon = isAnon({ discordId: h.user.id, name: h.user.displayName });
      out.push({
        slot: b.slot || 'Unknown', bet, win, mult: +mult.toFixed(2),
        userId: h.user.id,
        username: anon ? 'Anonymous' : h.user.displayName,
        avatar: anon ? null : h.user.avatar,
        huntType: h.huntType || 'community', live: !!live,
        at, archivedAt: h.archivedAt || null, replayUrl,
      });
```

In `lib/bangers.js`, change the signature (L6) to accept `isAnon` (add to the existing `opts`):

```js
function collectBangers(hunts, archive, tenantId, opts = {}) {
  const minMult = opts.minMult ?? BANGER_MIN_MULT;
  const maxPerUser = opts.maxPerUser ?? 2;
  const cap = opts.cap ?? 24;
  const isAnon = opts.isAnon ?? (() => false);
```

and replace its `out.push({...})` (currently L24-26) with:

```js
      const anon = isAnon({ discordId: h.user.id, name: h.user.displayName });
      out.push({ slot: b.slot || 'Unknown', bet, win, mult: +mult.toFixed(2),
        userId: h.user.id,
        username: anon ? 'Anonymous' : h.user.displayName,
        avatar: anon ? null : h.user.avatar,
        huntType: h.huntType || 'community', live: !!live, at, archivedAt: h.archivedAt || null });
```

In `routes/misc.routes.js`, find each `collectHallOfFame(` and `collectBangers(` call and pass the predicate. Ensure `settings` (or `shouldMaskIdentity`) is in the router's injected deps; add `{ isAnon: shouldMaskIdentity }` to the options arg (merge into existing opts for bangers). Example:

```js
const fame = collectHallOfFame(hunts, archive, tenantId, { isAnon: shouldMaskIdentity });
const bangers = collectBangers(hunts, archive, tenantId, { isAnon: shouldMaskIdentity });
```

If `shouldMaskIdentity` is not yet a router dep, add it to the `initMiscRoutes`/`module.exports` deps destructure and wire it from `server.js` (it is exported by `lib/settings.js`).

- [ ] **Step 4: Run test to verify it passes**

Run: `cd communityhunts-backend && node --test lib/hallOfFame.anon.test.js`
Expected: PASS (2 tests).

- [ ] **Step 5: Verify wiring compiles + commit**

Run: `cd communityhunts-backend && node -e "require('./routes/misc.routes.js'); console.log('ok')"`
Expected: prints `ok` (no missing-reference throw).

```bash
git add lib/hallOfFame.js lib/bangers.js lib/hallOfFame.anon.test.js routes/misc.routes.js server.js
git commit -m "feat(anon): mask anonymous host in hall-of-fame + bangers"
```

---

## Phase B — Backend: durable identity attach (foundation)

### Task B1: `callerId` on new slot calls; already stripped by `publicHuntView`

**Files:**
- Modify: `communityhunts-backend/routes/calls.routes.js` (`addCallToHunt` newCall ~L48)
- Test: `communityhunts-backend/lib/hunts-core.anon.test.js` (append — verifies stripping; strip already implemented in A3)

**Interfaces:**
- Produces: every call created via `addCallToHunt` carries `callerId: <verified req.user.id>`. `publicHuntView` already strips it (Task A3) and masks by it.

- [ ] **Step 1: Write the failing test** (append to `lib/hunts-core.anon.test.js`)

```js
test('publicHuntView strips callerId from calls[] (never reaches the public)', () => {
  wire();
  const h = { equity: [], bonuses: [],
    calls: [{ id: 'c1', slot: 'X', user: 'Someone', callerId: '123', status: 'pending' }] };
  const pub = core.publicHuntView(h);
  assert.equal('callerId' in pub.calls[0], false);
  assert.equal(pub.calls[0].user, 'Someone'); // not anonymous → unchanged
});
```

- [ ] **Step 2: Run test to verify it fails or passes**

Run: `cd communityhunts-backend && node --test lib/hunts-core.anon.test.js`
Expected: PASS already (A3's `maskCallerEntry` destructures out `callerId`). If it fails, fix A3's strip before continuing.

- [ ] **Step 3: Stamp callerId at creation**

In `routes/calls.routes.js`, change the `newCall` construction (currently L48) from:

```js
    const newCall = { id: Math.random().toString(36).slice(2,8), slot: slot.trim(), user: user.displayName||user.username, status: 'pending', ...(source ? { source } : {}) };
```

to:

```js
    const newCall = { id: Math.random().toString(36).slice(2,8), slot: slot.trim(),
      user: user.displayName||user.username, callerId: user.id ? String(user.id) : undefined,
      status: 'pending', ...(source ? { source } : {}) };
```

(`user` is `req.user`, always present — both call routes are `requireAuth`.)

- [ ] **Step 4: Run test to verify it passes**

Run: `cd communityhunts-backend && node --test lib/hunts-core.anon.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add routes/calls.routes.js lib/hunts-core.anon.test.js
git commit -m "feat(anon): stamp verified callerId on new slot calls"
```

---

### Task B2: Auto-bind Discord ID at owner-approved call grant

**Files:**
- Modify: `communityhunts-backend/lib/hunts-core.js` (add pure helper `bindEquityIdentityByName`; export it)
- Modify: `communityhunts-backend/routes/calls.routes.js` (grant handler ~L168-175)
- Test: `communityhunts-backend/lib/hunts-core.bind.test.js` (new)

**Interfaces:**
- Produces: `bindEquityIdentityByName(hunt, { userId, name }): { bound: boolean, memberId: string|null }`. Binds ONLY when exactly one UNLINKED equity row's name matches (case/space-insensitive); 0 or 2+ matches → no-op. Never overwrites an already-linked row. Owner-authorized: caller invokes it only inside the grant handler.

- [ ] **Step 1: Write the failing test**

Create `communityhunts-backend/lib/hunts-core.bind.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert');
const core = require('./hunts-core');

test('binds when exactly one unlinked name matches', () => {
  const hunt = { equity: [{ id: 'm1', name: 'Big Bird', amount: 10 }, { id: 'm2', name: 'Elmo', amount: 5 }] };
  const r = core.bindEquityIdentityByName(hunt, { userId: '111', name: 'big bird' });
  assert.deepEqual(r, { bound: true, memberId: 'm1' });
  assert.equal(hunt.equity[0].discordId, '111');
});

test('no-op on zero matches', () => {
  const hunt = { equity: [{ id: 'm1', name: 'Elmo' }] };
  assert.deepEqual(core.bindEquityIdentityByName(hunt, { userId: '1', name: 'Grover' }), { bound: false, memberId: null });
  assert.equal(hunt.equity[0].discordId, undefined);
});

test('no-op on ambiguous 2+ matches', () => {
  const hunt = { equity: [{ id: 'm1', name: 'Bird' }, { id: 'm2', name: 'bird' }] };
  assert.deepEqual(core.bindEquityIdentityByName(hunt, { userId: '1', name: 'BIRD' }), { bound: false, memberId: null });
});

test('never overwrites an already-linked row', () => {
  const hunt = { equity: [{ id: 'm1', name: 'Bird', discordId: 'existing' }] };
  const r = core.bindEquityIdentityByName(hunt, { userId: 'new', name: 'Bird' });
  assert.deepEqual(r, { bound: false, memberId: null }); // the only match is already linked
  assert.equal(hunt.equity[0].discordId, 'existing');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd communityhunts-backend && node --test lib/hunts-core.bind.test.js`
Expected: FAIL — `core.bindEquityIdentityByName is not a function`.

- [ ] **Step 3: Implement the pure helper**

In `lib/hunts-core.js`, add near `maskEquityMember` (and export it in `module.exports`):

```js
// Owner-authorized identity bind: attach a verified Discord id to the ONE unlinked equity row
// whose name matches. Ambiguous (2+) or no match → no-op (fall back to the manual link). Never
// overwrites an existing discordId. Matching is display-name only and is safe here because the
// caller (the call-grant handler) has just had the OWNER approve this specific person.
function bindEquityIdentityByName(hunt, { userId, name }) {
  if (!hunt || !Array.isArray(hunt.equity) || !userId || !name) return { bound: false, memberId: null };
  const norm = s => (s || '').toString().toLowerCase().replace(/\s+/g, ' ').trim();
  const target = norm(name);
  if (!target) return { bound: false, memberId: null };
  const matches = hunt.equity.filter(e => !e.discordId && norm(e.name) === target);
  if (matches.length !== 1) return { bound: false, memberId: null };
  matches[0].discordId = String(userId);
  return { bound: true, memberId: matches[0].id };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd communityhunts-backend && node --test lib/hunts-core.bind.test.js`
Expected: PASS (4 tests).

- [ ] **Step 5: Call it from the grant handler**

In `routes/calls.routes.js`, inside the `action === 'grant'` branch (currently ~L168-172), after `hunts[userId].callsPermissions.push(reqItem.userId)`, add:

```js
      // Attach the verified, owner-approved identity to the member's equity row if unambiguous.
      // Display name for matching comes from the pending request (reqItem.displayName).
      bindEquityIdentityByName(hunts[userId], { userId: reqItem.userId, name: reqItem.displayName });
```

Ensure `bindEquityIdentityByName` is in the destructured `huntsCore` import at the top of `calls.routes.js` (add it wherever the router pulls helpers from `hunts-core`, or `const { bindEquityIdentityByName } = require('../lib/hunts-core')`).

- [ ] **Step 6: Verify compile + commit**

Run: `cd communityhunts-backend && node -e "require('./routes/calls.routes.js'); console.log('ok')"`
Expected: prints `ok`.

```bash
git add lib/hunts-core.js lib/hunts-core.bind.test.js routes/calls.routes.js
git commit -m "feat(anon): auto-bind verified discord id at owner-approved call grant"
```

---

### Task B3: Manual admin link endpoint

**Files:**
- Modify: `communityhunts-backend/lib/hunts-core.js` (add pure helper `linkEquityMember`; export it)
- Modify: `communityhunts-backend/routes/hunts.routes.js` (add route + route dep `getKnownUser`)
- Modify: `communityhunts-backend/server.js` (pass `getKnownUser` into the hunts router deps if not already present)
- Test: `communityhunts-backend/lib/hunts-core.bind.test.js` (append)

**Interfaces:**
- Consumes: `known_users` lookup `getKnownUser(discordId)` (from `lib/settings.js`) — resolves a real identity, no fabrication.
- Produces: `linkEquityMember(hunt, memberId, discordId): boolean` (writes `discordId` onto the row, returns whether a row changed). Route `POST /api/hunts/:userId/equity/:memberId/link` `{ discordId }`, guarded by `canEditHunt`, audit-logged.

- [ ] **Step 1: Write the failing test** (append to `lib/hunts-core.bind.test.js`)

```js
test('linkEquityMember writes discordId onto the target row', () => {
  const hunt = { equity: [{ id: 'm1', name: 'Bird' }, { id: 'm2', name: 'Elmo' }] };
  assert.equal(core.linkEquityMember(hunt, 'm2', '777'), true);
  assert.equal(hunt.equity[1].discordId, '777');
  assert.equal(core.linkEquityMember(hunt, 'nope', '777'), false); // unknown member id
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd communityhunts-backend && node --test lib/hunts-core.bind.test.js`
Expected: FAIL — `core.linkEquityMember is not a function`.

- [ ] **Step 3: Implement helper + route**

In `lib/hunts-core.js` add (and export):

```js
// Admin-authorized identity link: bind a chosen discordId to a specific equity row by member id.
function linkEquityMember(hunt, memberId, discordId) {
  if (!hunt || !Array.isArray(hunt.equity) || !memberId || !discordId) return false;
  const row = hunt.equity.find(e => e.id === memberId);
  if (!row) return false;
  row.discordId = String(discordId);
  return true;
}
```

In `routes/hunts.routes.js`, add a route (near the other `/api/hunts/:userId` mutations). Assumes `canEditHunt`, `hunts`, `emitHuntUpdate`, `auditLog`, `linkEquityMember`, and `getKnownUser` are available in the router (add any missing to the deps destructure at the top + wire from `server.js`):

```js
  // Admin/owner: bind a Discord user to an equity row (rename-proof identity for masking + payouts).
  router.post('/api/hunts/:userId/equity/:memberId/link', requireAuth, async (req, res) => {
    if (!canEditHunt(req, req.params.userId)) return res.status(403).json({ error: 'Not authorised' });
    const hunt = hunts[req.params.userId];
    if (!hunt) return res.status(404).json({ error: 'Hunt not found' });
    const discordId = String(req.body?.discordId || '').trim();
    if (!/^\d{5,}$/.test(discordId)) return res.status(400).json({ error: 'Valid discordId required' });
    const known = getKnownUser ? await getKnownUser(discordId) : null;
    if (!known) return res.status(404).json({ error: 'No known user for that Discord ID' });
    const _before = { equity: [...(hunt.equity || [])] };
    if (!linkEquityMember(hunt, req.params.memberId, discordId))
      return res.status(404).json({ error: 'Equity member not found' });
    hunt.updatedAt = new Date().toISOString();
    emitHuntUpdate(req.params.userId);
    auditLog.recordHuntChange(req, _before, { equity: hunt.equity },
      { targetId: req.params.userId, targetName: hunt.user && hunt.user.displayName });
    res.json({ ok: true, linked: { memberId: req.params.memberId, discordId, displayName: known.displayName } });
  });
```

- [ ] **Step 4: Run test to verify it passes + compile check**

Run: `cd communityhunts-backend && node --test lib/hunts-core.bind.test.js`
Expected: PASS (6 tests total in file).
Run: `cd communityhunts-backend && node -e "require('./routes/hunts.routes.js'); console.log('ok')"`
Expected: prints `ok`.

- [ ] **Step 5: Commit**

```bash
git add lib/hunts-core.js lib/hunts-core.bind.test.js routes/hunts.routes.js server.js
git commit -m "feat(anon): admin endpoint to link a discord user to an equity row"
```

---

### Task B4: Full backend regression + deploy gate

**Files:** none (verification task)

- [ ] **Step 1: Run the full backend lib suite**

Run: `cd communityhunts-backend && node --test lib/*.test.js`
Expected: all PASS (new `settings.anon`, `hunts-core.anon`, `hunts-core.bind`, `hallOfFame.anon` included; pre-existing suites still green).

- [ ] **Step 2: Boot sanity (no listen-hang; Ctrl-C after the ready log)**

Run: `cd communityhunts-backend && PORT=3199 node -e "require('./server.js')" & sleep 4; curl -s localhost:3199/api/health; kill %1`
Expected: health JSON prints; no startup throw referencing `shouldMaskIdentity`, `bindEquityIdentityByName`, or `linkEquityMember`.

- [ ] **Step 3: Merge backend + deploy**

Follow the repo deploy rule: `git pull --ff-only` on `main`, merge `feat/anonymous-mode-masking`, push → Railway auto-deploys. Backend must be live before any Phase C frontend ships.

---

## Phase C — Frontend: badges, self-banner, link UI

> Frontend receives already-masked names for free (backend is authoritative). These tasks add the 🔒 indicators, the self-banner, and the manual link control. All read flags the backend now emits (`anonymous: true` on masked/flagged equity, calls, bonuses). Verify each with `CI=true npm run build` → "Compiled successfully".

### Task C1: 🔒 badge on slot-call and bonus-caller names

**Files:**
- Modify: `communityhunts-frontend/src/hunt/columns/SlotCallsColumn.js` (caller render ~L238)
- Modify: `communityhunts-frontend/src/hunt/columns/BonusCard.js` (caller render ~L120-127)

**Interfaces:**
- Consumes: `c.anonymous` on a call, `b.anonymous` on a bonus (backend-emitted for privileged/self, and present on public 'Anonymous' entries).

- [ ] **Step 1: Add the badge to the slot-call caller**

In `SlotCallsColumn.js`, replace the caller line (currently L238):

```js
                        <div style={{fontFamily:G.mono,fontSize:12,fontWeight:600,color:G.t3,letterSpacing:'0.02em'}}>{c.user}</div>
```

with:

```js
                        <div style={{fontFamily:G.mono,fontSize:12,fontWeight:600,color:G.t3,letterSpacing:'0.02em'}}>
                          {c.user}
                          {c.anonymous && <span title="Anonymous to the public — only the runner, mods and admins can see this name" style={{marginLeft:4,fontSize:11,opacity:0.65,cursor:'help'}}>🔒</span>}
                        </div>
```

- [ ] **Step 2: Add the badge to the bonus caller (non-editor view)**

In `BonusCard.js`, replace the read-only caller span (currently L126):

```js
              : <span style={{ fontFamily: G.mono, fontSize: 11, color: G.t3 }}>{b.caller}</span>}
```

with:

```js
              : <span style={{ fontFamily: G.mono, fontSize: 11, color: G.t3 }}>
                  {b.caller}
                  {b.anonymous && <span title="Anonymous to the public" style={{ marginLeft: 4, fontSize: 10, opacity: 0.65, cursor: 'help' }}>🔒</span>}
                </span>}
```

- [ ] **Step 3: Build + commit**

Run: `cd communityhunts-frontend && CI=true npm run build`
Expected: "Compiled successfully".

```bash
cd communityhunts-frontend
git add src/hunt/columns/SlotCallsColumn.js src/hunt/columns/BonusCard.js
git commit -m "feat(anon): lock badge on masked slot-call + bonus caller names"
```

---

### Task C2: Self-banner in the Equity Section

**Files:**
- Create: `communityhunts-frontend/src/hunt/SelfAnonymousBanner.js`
- Modify: `communityhunts-frontend/src/hunt/columns/EquityColumn.js` (import + render near the top of the section)

**Interfaces:**
- Consumes: `equity` (masked display list — each row may have `anonymous: true`) and `user`. The self row is the one whose `id`/`discordId` or name matches the logged-in user AND carries `anonymous: true` (self always receives their real name + the flag).

- [ ] **Step 1: Create the banner component**

Create `communityhunts-frontend/src/hunt/SelfAnonymousBanner.js`:

```js
import { useState } from 'react';
import { useTheme } from '../theme/ThemeContext';

// Shown to a logged-in member who is appearing as Anonymous to the public in THIS hunt.
// Condition is computed by the caller and passed as `show`. Dismissable per session.
export default function SelfAnonymousBanner({ show }) {
  const G = useTheme();
  const [dismissed, setDismissed] = useState(() => {
    try { return sessionStorage.getItem('ch_anon_banner_dismissed') === '1'; } catch { return false; }
  });
  if (!show || dismissed) return null;
  const dismiss = () => { try { sessionStorage.setItem('ch_anon_banner_dismissed', '1'); } catch {} setDismissed(true); };
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', marginBottom: 10,
      background: G.gdim || 'rgba(167,139,250,0.12)', border: `1px solid ${G.bdr}`, borderRadius: 8,
      fontFamily: G.body, fontSize: 12, color: G.t2, lineHeight: 1.4 }}>
      <span style={{ fontSize: 13 }}>🔒</span>
      <span style={{ flex: 1 }}>You're appearing as <b>Anonymous</b> to the public in this hunt. The runner, mods and admins can still see you.</span>
      <button onClick={dismiss} style={{ background: 'transparent', border: 'none', color: G.t4, cursor: 'pointer', fontSize: 14, lineHeight: 1 }} title="Dismiss">×</button>
    </div>
  );
}
```

- [ ] **Step 2: Render it in EquityColumn**

In `EquityColumn.js`, add the import (after the other imports, ~L11):

```js
import SelfAnonymousBanner from '../SelfAnonymousBanner';
```

Compute the self-anonymous condition inside the component body (before the returned JSX; `equity` and `user` are already props):

```js
  const selfIsAnon = !!(user && Array.isArray(equityDisplay) && equityDisplay.some(e =>
    e.anonymous && (
      (e.discordId && String(e.discordId) === String(user.id)) ||
      (e.name || '').toLowerCase().trim() === (user.displayName || user.username || '').toLowerCase().trim()
    )));
```

Render `<SelfAnonymousBanner show={selfIsAnon} />` at the top of the section's returned markup (just inside the section wrapper, above the header row). Use the existing `equityDisplay` list already threaded into this component.

- [ ] **Step 3: Build + commit**

Run: `cd communityhunts-frontend && CI=true npm run build`
Expected: "Compiled successfully".

```bash
git add src/hunt/SelfAnonymousBanner.js src/hunt/columns/EquityColumn.js
git commit -m "feat(anon): self anonymous banner in the equity section"
```

---

### Task C3: Manual link control + unlinked warning in EditPersonModal

**Files:**
- Modify: `communityhunts-frontend/src/hunt/modals/EditPersonModal.js` (edit branch, add a Discord-link section)
- Modify: `communityhunts-frontend/src/components/HuntTracker.js` (pass `onLinkDiscord` handler + `hunt` id into the modal; add the API call)
- Modify: `communityhunts-frontend/src/api.js` (add `linkEquityMember` API helper) — or reuse existing `apiFetch`

**Interfaces:**
- Consumes: the edit-mode `data` object; whether the row is linked comes from `data.discordId` (thread it through from the equity display so the modal knows). Backend route: `POST /api/hunts/:userId/equity/:memberId/link { discordId }` (Task B3).
- Produces: `onLinkDiscord(memberId, discordId)` wired in HuntTracker to call the endpoint then refresh hunt state.

- [ ] **Step 1: Add the API helper**

In `src/api.js`, add:

```js
export const linkEquityMember = (userId, memberId, discordId) =>
  apiFetch(`/api/hunts/${userId}/equity/${memberId}/link`, { method: 'POST', body: JSON.stringify({ discordId }) });
```

(Match the file's existing export/apiFetch style; if `apiFetch` isn't the local pattern, mirror a neighboring POST helper.)

- [ ] **Step 2: Surface link state + control in the modal**

In `EditPersonModal.js`, in the `!isAdd` block (after the Rainbet/Twitch rows, ~L120), add a linkage section. `data.discordId`, `data.callerId` (thread the row's `discordId` into `data` when opening the modal), and `canManageUsers` gate it:

```js
        {!isAdd && (
          <div style={row}>
            <label style={label}>Discord identity</label>
            {data.discordId
              ? <div style={{ fontFamily: G.mono, fontSize: 12, color: G.green }}>🔗 Linked · {data.discordId}</div>
              : <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontFamily: G.mono, fontSize: 11, color: G.amber || G.t3 }} title="This row isn't tied to a Discord account, so anonymous mode relies on name-matching and can break if they change their name.">⚠ Not linked</span>
                  {canManageUsers && <button onClick={() => onLinkDiscord && onLinkDiscord(data.id, name.trim())} style={actionBtn}>Link…</button>}
                </div>}
          </div>
        )}
```

(The `Link…` handler resolves a Discord id — for v1 it prompts for/accepts the id or uses the row's known name→id lookup; wire the concrete resolve in Step 3. Keep the warning copy exact.)

Add `onLinkDiscord` to the destructured props in the `EditPersonModal({...})` signature.

- [ ] **Step 3: Wire the handler in HuntTracker**

In `HuntTracker.js`, where `EditPersonModal` is rendered, pass:

```js
        onLinkDiscord={async (memberId, memberName) => {
          try {
            const discordId = window.prompt(`Discord ID to link to "${memberName}"`);
            if (!discordId) return;
            await linkEquityMember(hunt.user.id, memberId, discordId.trim());
            // hunt:update socket event refreshes equity with the new discordId
          } catch (e) { alert(e.message || 'Link failed'); }
        }}
```

Ensure `linkEquityMember` is imported from `../api` and the equity row's `discordId` is included when building the `data` object passed to `EditPersonModal` (so `data.discordId` reflects link state).

- [ ] **Step 4: Build + commit**

Run: `cd communityhunts-frontend && CI=true npm run build`
Expected: "Compiled successfully".

```bash
git add src/api.js src/hunt/modals/EditPersonModal.js src/components/HuntTracker.js
git commit -m "feat(anon): manual discord-link control + unlinked warning on equity members"
```

---

### Task C4: Frontend verification on a Vercel preview

**Files:** none (verification task)

- [ ] **Step 1: Push branch, open PR, get the Vercel preview URL**

```bash
cd communityhunts-frontend && git pull --ff-only && CI=true npm run build && git push -u origin feat/anonymous-mode-masking
```

- [ ] **Step 2: Manual pass on the preview (backend already live)**

Verify, logged in as a NON-privileged viewer of a hunt containing an anonymous member:
- Equity card, slot-call caller, and bonus caller all show **Anonymous**, no avatar.
- As the runner/admin: real names show, each with a 🔒 badge.
- As the anonymous member: own real name shows + the self-banner appears (and dismiss persists for the session).
- Edit a member: unlinked rows show **⚠ Not linked** with a **Link…** button (admin); linking then flips it to **🔗 Linked**, and after a grant the auto-bind shows it linked without a manual step.

- [ ] **Step 3: Merge to main after confirmation**

Merge the PR → Vercel deploys production. Verify the merge-base (past merge races dropped commits).

---

## Self-Review

**Spec coverage:**
- §1 predicate → A1. §2 serializers: equity → A2; calls/caller → A3; archived summary → A2; Hall of Fame + bangers → A4; public API topHunters/biggestHits already dropped by `publicSerializers.publicStats` (no task needed — noted). §3A auto-bind → B2; §3B callerId → B1; §3C manual link → B3. §4 admin 🔒 indicator → A2/A3 (`anonymous` flag) + C1. §5 self-indicator → C2 (banner) + existing `anonTag` self case (C1 covers calls; equity self-badge already renders via the backend `anonymous` flag on the self row). §6 testing → A1–A4, B1–B3, B4, C4.
- **Gap found + closed:** the equity-card self 🔒 badge already works (existing `anonTag` renders on any row with `anonymous: true`, which the backend now emits to self) — no new task required; called out here so it isn't mistaken for missing.

**Placeholder scan:** every code step contains real code; the `Link…` id-resolution uses a `window.prompt` v1 (explicitly minimal, not a placeholder). No TBD/TODO left.

**Type consistency:** `shouldMaskIdentity({ discordId, name })` shape is identical across A1/A2/A3/A4/B. `maskCallerEntry(entry, nameField, viewerId, privileged)` and `maskEquityMember(member, viewerId, privileged)` share the privileged/self contract. `bindEquityIdentityByName → { bound, memberId }` and `linkEquityMember → boolean` match their tests and call sites. `anonymous: true` is the single flag name used by backend emitters and all frontend badge reads.

---

**Deploy order reminder:** Phase A + B (backend) merge and go live on Railway BEFORE any Phase C frontend merges — masking is server-authoritative, so the frontend can only display what the backend already redacts.
