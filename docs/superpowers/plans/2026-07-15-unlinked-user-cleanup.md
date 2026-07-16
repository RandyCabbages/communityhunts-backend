# Unlinked User Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop synthetic `manual:<name>` rows from masquerading as real users in the equity autocomplete and `/admin/users`, and give admins a way to see and purge the existing ones.

**Architecture:** One shared `isRealDiscordId` predicate in a new `lib/userIds.js` becomes the single definition of "attached to a Discord login", replacing the three drifting copies of that rule that already exist. It gates four consumers: the `/api/known-users` autocomplete query (filter), `backfillKnownUsers` (skip, so purged rows don't resurrect on restart), `GET /api/admin/users?unlinked=1` (filter), and a new admin-only `DELETE /api/admin/users/:userId` whose safety rail refuses real snowflake ids outright.

**Tech Stack:** Node.js + Express (backend, no build step, `node:test`), React CRA (frontend).

**Spec:** `docs/superpowers/specs/2026-07-15-unlinked-user-cleanup-design.md`

## Global Constraints

- **Backend deploys first.** The frontend Remove button 404s until the route exists. Backend → Railway (auto on push to `main`), frontend → Vercel (auto on push to `main`).
- **Never gate on display name.** Discord ID only. This is the #1 historical regression in both apps.
- **Two repos, different-owner remotes.** Backend `RandyCabbages/communityhunts.gg-backend`, frontend `GooferG/communityhunts-frontend`. Run git only from inside the app subdirectory. `git pull --ff-only` before branching.
- **`main` is shared and auto-deploys to production.** Work on a branch, test on the Vercel preview URL, PR to `main`.
- **Never `git add -A`** — parallel Claude sessions share this worktree. Stage named files only.
- **`rainbet_slots.json` and `package-lock.json` are frequently dirty** (auto-generated). Do not stage them. If `rainbet_slots.json` blocks a checkout, the local change is a duplicate of the upstream auto-commit — stash it.
- **No `Co-Authored-By` trailers, no Claude attribution** in commits or PR bodies.
- **Frontend build gate:** `CI=true npm run build` must print "Compiled successfully" before any push (Vercel turns warnings into errors).
- **Frontend testing rule:** pure-logic modules get a `.test.js`; components do NOT (`@testing-library/react` is not installed — don't add it).
- **Backend test command:** `node --test lib/`. Do NOT write route suites — they call `app.listen` and hang on exit in this repo, and a piped exit code masks failures.
- **Snowflake regex, exact:** `/^\d{17,20}$/`. Discord ids are 17-19 digits today; 20 is deliberate headroom.
- **Frontend tokens via `useTheme()` only** — never a local `const C = {…}` token object.

---

### Task 1: The shared `isRealDiscordId` predicate

**Files:**
- Create: `communityhunts-backend/lib/userIds.js`
- Test: `communityhunts-backend/lib/userIds.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: `isRealDiscordId(id: any) => boolean` — CommonJS named export. Every later backend task imports this.

- [ ] **Step 1: Write the failing test**

Create `communityhunts-backend/lib/userIds.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert');
const { isRealDiscordId } = require('./userIds');

test('real Discord snowflakes pass', () => {
  assert.equal(isRealDiscordId('110983319176384512'), true); // Bean, 18 digits
  assert.equal(isRealDiscordId('135203806676779008'), true); // Kyle, 18 digits
  assert.equal(isRealDiscordId('12345678901234567'), true);  // 17, lower bound
  assert.equal(isRealDiscordId('12345678901234567890'), true); // 20, upper bound (headroom)
});

test('synthetic manual: rows fail — this is the junk set', () => {
  assert.equal(isRealDiscordId('manual:cabbage'), false);
  assert.equal(isRealDiscordId('manual:'), false);
  assert.equal(isRealDiscordId('MANUAL:Cabbage'), false);
});

test('placeholders and per-row uuids fail', () => {
  assert.equal(isRealDiscordId('creator_auto'), false);
  assert.equal(isRealDiscordId('bean_auto'), false);
  assert.equal(isRealDiscordId('550e8400-e29b-41d4-a716-446655440000'), false);
});

test('out-of-range digit strings fail', () => {
  assert.equal(isRealDiscordId('1234567890123456'), false);      // 16, too short
  assert.equal(isRealDiscordId('123456789012345678901'), false); // 21, too long
});

test('empty and non-string inputs fail without throwing', () => {
  assert.equal(isRealDiscordId(''), false);
  assert.equal(isRealDiscordId(null), false);
  assert.equal(isRealDiscordId(undefined), false);
  assert.equal(isRealDiscordId({}), false);
  assert.equal(isRealDiscordId([]), false);
});

test('a numeric snowflake passes — callers pass ids from pg and from req.params', () => {
  assert.equal(isRealDiscordId(110983319176384512n), true);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run from `communityhunts-backend/`:

```bash
node --test lib/userIds.test.js
```

Expected: FAIL — `Cannot find module './userIds'`.

- [ ] **Step 3: Write the minimal implementation**

Create `communityhunts-backend/lib/userIds.js`:

```js
// The single definition of "attached to a real Discord login".
//
// Discord snowflakes are 17-19 digits today; 20 is headroom. Anything else in our id-space is
// synthetic: `manual:<name>` rows minted by the name-only path of POST /api/admin/set-rainbet-name,
// the `creator_auto`/`bean_auto` equity placeholders, or a per-row equity UUID.
//
// This exists because three near-identical copies of this rule had already drifted apart
// (statsStore used a `manual:` prefix test, resolveUserIdByName used a 17-19 regex). Import from
// here rather than re-deriving it — a fourth copy is how the next bug gets in.
const isRealDiscordId = (id) => /^\d{17,20}$/.test(String(id ?? ''));

module.exports = { isRealDiscordId };
```

Note `id ?? ''` rather than `id || ''`: both work here, but `??` states the intent (only null/undefined get the empty-string default).

- [ ] **Step 4: Run the test to verify it passes**

```bash
node --test lib/userIds.test.js
```

Expected: PASS — 6 tests, 0 failures.

- [ ] **Step 5: Run the whole lib suite to confirm nothing regressed**

```bash
node --test lib/
```

Expected: PASS. If a pre-existing suite is red, note it and move on — do not fix unrelated tests in this task.

- [ ] **Step 6: Commit**

```bash
git add lib/userIds.js lib/userIds.test.js
git commit -m "feat(userids): add shared isRealDiscordId predicate"
```

---

### Task 2: Adopt the predicate in the two drifted copies

**Files:**
- Modify: `communityhunts-backend/lib/statsStore.js:44-47`
- Modify: `communityhunts-backend/lib/settings.js:208-222` (`resolveUserIdByName`)

**Interfaces:**
- Consumes: `isRealDiscordId` from Task 1.
- Produces: no new exports. Behavior is unchanged — this task is a no-op tightening.

**Why this is a no-op:** `recordKnownUser` is only ever called from the Discord OAuth callback / Bearer middleware (`server.js:251`) and from hunt owners (`lib/settings.js:130`) — both snowflakes. So every non-`manual:` row in `known_users` already passes the regex, and swapping the prefix test for the predicate cannot change which rows are skipped. Verify this claim against production data in Task 6 before merging.

- [ ] **Step 1: Add the import to statsStore.js**

At the top of `communityhunts-backend/lib/statsStore.js`, below the existing `computeUserHuntStats` require:

```js
const { computeUserHuntStats } = require('./userStats');
const { isRealDiscordId } = require('./userIds');
```

- [ ] **Step 2: Replace the `manual:` prefix test in `getNameIndex`**

In `getNameIndex`, replace these lines:

```js
          // Skip manual/placeholder accounts (e.g. "manual:cabbage") — they aren't real Discord
          // logins, and keeping them makes a shared display name ambiguous, which drops the name
          // from the index and silently under-counts the REAL user who shares that name.
          if (uid.startsWith('manual:')) continue;
```

with:

```js
          // Skip anything that isn't a real Discord login (e.g. "manual:cabbage") — keeping them
          // makes a shared display name ambiguous, which drops the name from the index and
          // silently under-counts the REAL user who shares that name.
          if (!isRealDiscordId(uid)) continue;
```

- [ ] **Step 3: Replace the inline regex in `resolveUserIdByName`**

In `communityhunts-backend/lib/settings.js`, add the import near the top (after the `fs`/`path` requires):

```js
const { isRealDiscordId } = require('./userIds');
```

Then replace the sort block inside `resolveUserIdByName`:

```js
  // Prefer real Discord-id rows (17-19 digit ids) over synthetic manual: rows so we keep
  // identity attached to the real account when both happen to exist.
  rows.sort((a, b) => {
    const aReal = /^\d{17,19}$/.test(a.userId) ? 0 : 1;
    const bReal = /^\d{17,19}$/.test(b.userId) ? 0 : 1;
    return aReal - bReal;
  });
```

with:

```js
  // Prefer real Discord-id rows over synthetic manual: rows so we keep identity attached to the
  // real account when both happen to exist.
  rows.sort((a, b) => {
    const aReal = isRealDiscordId(a.userId) ? 0 : 1;
    const bReal = isRealDiscordId(b.userId) ? 0 : 1;
    return aReal - bReal;
  });
```

- [ ] **Step 4: Run the suite to confirm the no-op**

```bash
node --test lib/
```

Expected: PASS, with `lib/statsStore.test.js` and `lib/userStats.test.js` unchanged from their pre-task result. **These suites are the proof this refactor is behavior-preserving** — if any assertion that passed before now fails, stop and investigate rather than editing the test.

- [ ] **Step 5: Confirm no copies of the rule survive**

```bash
grep -rn "startsWith('manual:')\|\\\\d{17,19}\|\\\\d{17,20}" lib/ routes/ server.js
```

Expected: hits **only** in `lib/userIds.js` (the definition) and `lib/userIds.test.js`. Any other hit is a fifth copy — fold it into the predicate.

- [ ] **Step 6: Commit**

```bash
git add lib/statsStore.js lib/settings.js
git commit -m "refactor(userids): route the two drifted id checks through isRealDiscordId"
```

---

### Task 3: Filter the autocomplete and stop re-minting

**Files:**
- Modify: `communityhunts-backend/routes/auth.routes.js:92-106`
- Modify: `communityhunts-backend/lib/settings.js:106-135` (`backfillKnownUsers`)

**Interfaces:**
- Consumes: `isRealDiscordId` from Task 1.
- Produces: no new exports. `GET /api/known-users` response shape is unchanged (`[{id, displayName, avatar}]`) — only rows are removed.

**This is the task that actually fixes the bug.** The backfill guard is load-bearing: without it, every row purged in Task 4 resurrects in `known_users` on the next restart and the autocomplete junk comes back.

- [ ] **Step 1: Filter the `/api/known-users` query**

In `communityhunts-backend/routes/auth.routes.js`, replace the query in the `/api/known-users` handler:

```js
      const r = await pgPool.query(
        `SELECT user_id AS id, display_name AS "displayName", avatar
         FROM known_users
         ORDER BY last_seen DESC
         LIMIT 500`
      );
```

with:

```js
      // Real Discord logins only. Synthetic `manual:<name>` rows reach known_users via the
      // startup backfill and are indistinguishable from a login once there — they cluttered the
      // equity dropdown with people who never had an account. Filtering here rather than at the
      // call site keeps every consumer of this endpoint honest. Mirrors lib/userIds.isRealDiscordId;
      // the regex is inlined because this runs in Postgres, not Node.
      const r = await pgPool.query(
        `SELECT user_id AS id, display_name AS "displayName", avatar
         FROM known_users
         WHERE user_id ~ '^[0-9]{17,20}$'
         ORDER BY last_seen DESC
         LIMIT 500`
      );
```

Also update the handler's doc comment above `router.get('/api/known-users', ...)` — it currently says "for everyone who's logged in", which stays true, but append: `Synthetic manual: rows are excluded (see lib/userIds.js).`

- [ ] **Step 2: Guard the backfill**

In `communityhunts-backend/lib/settings.js`, in `backfillKnownUsers`, replace the `user_settings` loop body:

```js
    const r = await pgPool.query('SELECT user_id, settings FROM user_settings');
    for (const row of r.rows) {
      const s = row.settings || {};
      const dn = s.discordDisplayName || s.rainbetName;
      if (dn) {
```

with:

```js
    const r = await pgPool.query('SELECT user_id, settings FROM user_settings');
    for (const row of r.rows) {
      // Synthetic `manual:<name>` rows carry a rainbetName + discordDisplayName, so the `dn`
      // check below cannot tell them from a real login and used to launder them into
      // known_users on every boot. Without this guard, anything an admin purges resurrects on
      // the next restart.
      if (!isRealDiscordId(row.user_id)) continue;
      const s = row.settings || {};
      const dn = s.discordDisplayName || s.rainbetName;
      if (dn) {
```

- [ ] **Step 3: Guard the hunts loop for symmetry**

Still in `backfillKnownUsers`, replace:

```js
  for (const id in hunts) {
    const u = hunts[id]?.user;
    if (u?.id && u?.displayName) {
```

with:

```js
  for (const id in hunts) {
    const u = hunts[id]?.user;
    if (u?.id && u?.displayName && isRealDiscordId(u.id)) {
```

Hunt-owner ids are already snowflakes, so this changes nothing today — it keeps the two loops symmetrical so a future non-Discord hunt owner can't reopen the hole.

- [ ] **Step 4: Verify the backend still boots**

`npm start` does NOT load `.env`; `npm run dev` does (via `-r dotenv/config`). A local boot needs dummy Discord creds. Run from `communityhunts-backend/`:

```bash
npm install
PORT=3101 npm run dev
```

Expected: the log prints `[known_users] backfill queued N users` and `[known_users] Postgres table ready` with no error, then the server listens. Use port 3101 (a stale listener on the default is a known trap). Stop it with Ctrl-C.

If there's no `DATABASE_URL`, `backfillKnownUsers` returns early (`if (!pgPool) return`) and the guard is untested locally — that's expected. Task 6's restart check on a real deploy is what proves this.

- [ ] **Step 5: Run the suite**

```bash
node --test lib/
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add routes/auth.routes.js lib/settings.js
git commit -m "fix(known-users): real logins only in autocomplete; stop backfilling manual: rows"
```

---

### Task 4: `deleteSettings` + the purge route + the unlinked filter

**Files:**
- Modify: `communityhunts-backend/lib/settings.js` (add `deleteSettings`, export it)
- Modify: `communityhunts-backend/routes/settings.routes.js:232-273` (add `unlinked` filter, add DELETE route, update header comment)

**Interfaces:**
- Consumes: `isRealDiscordId` from Task 1.
- Produces:
  - `deleteSettings(userId: string) => Promise<boolean>` — exported from `lib/settings.js`. Resolves `true` if a row was removed, `false` if there was nothing to remove.
  - `DELETE /api/admin/users/:userId` → `200 { ok: true, deleted: { knownUsers: number, userSettings: number } }` | `400 { error }` | `404 { error }`.
  - `GET /api/admin/users?unlinked=1` — same response shape as today, filtered.

- [ ] **Step 1: Add `deleteSettings` to lib/settings.js**

Add directly below `saveSettings` (which ends around line 165). It must mirror `saveSettings`'s dual-path structure **and** keep the hot `anonymousUsers` set in sync — a deleted row can't stay in the anonymous set or `publicHuntView` would keep redacting a name that no longer exists.

```js
// Remove a settings row entirely. Only ever called for unlinked (non-Discord) ids — the route
// enforces that; this helper does not, so callers must check isRealDiscordId first.
// Returns true if a row was actually removed.
async function deleteSettings(userId) {
  const uid = String(userId);
  anonymousUsers.delete(uid); // keep the hot set in sync, exactly as saveSettings does
  if (pgPool) {
    try {
      const r = await pgPool.query('DELETE FROM user_settings WHERE user_id=$1', [uid]);
      return r.rowCount > 0;
    } catch (e) {
      console.error('[settings] pg deleteSettings error:', e.message);
      return false;
    }
  }
  // Fallback to file
  if (!(uid in userSettings)) return false;
  delete userSettings[uid];
  try { fs.writeFileSync(SETTINGS_FILE, JSON.stringify(userSettings), 'utf8'); } catch(e) {}
  return true;
}
```

- [ ] **Step 2: Export it**

In the `module.exports` block at the bottom of `lib/settings.js`, add `deleteSettings` after `saveSettings`:

```js
  getSettings,
  saveSettings,
  deleteSettings,
  nameMatchesSettings,
```

- [ ] **Step 3: Destructure it in the route file**

In `communityhunts-backend/routes/settings.routes.js`, extend the existing destructure (around line 22):

```js
  const { getSettings, saveSettings, resolveUserIdByName } = settings;
```

to:

```js
  const { getSettings, saveSettings, deleteSettings, resolveUserIdByName } = settings;
```

Add the predicate import beside the other requires at the top of the file:

```js
const { isRealDiscordId } = require('../lib/userIds');
```

- [ ] **Step 4: Add the `unlinked` filter to `GET /api/admin/users`**

In the handler at line 235, replace the `where` construction:

```js
      const params = [];
      let where = '';
      if (q) {
        params.push(`%${q}%`);
        where = `WHERE (LOWER(ku.display_name) LIKE $${params.length}
                     OR LOWER(ku.username) LIKE $${params.length}
                     OR ku.user_id LIKE $${params.length})`;
      }
```

with:

```js
      const params = [];
      const conds = [];
      if (q) {
        params.push(`%${q}%`);
        conds.push(`(LOWER(ku.display_name) LIKE $${params.length}
                  OR LOWER(ku.username) LIKE $${params.length}
                  OR ku.user_id LIKE $${params.length})`);
      }
      // ?unlinked=1 — rows that are NOT a real Discord login (legacy `manual:<name>` rows).
      // Deliberately opt-in: this list is the one place the junk SHOULD stay visible, because
      // it's where an admin reviews and purges it.
      if (String(req.query.unlinked || '') === '1') {
        conds.push(`ku.user_id !~ '^[0-9]{17,20}$'`);
      }
      const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
```

The rest of the handler is unchanged — `params.push(limit, offset)` and the `$${params.length - 1}` / `$${params.length}` placeholders still line up, because the two new conditions add either one param (`q`) or zero (`unlinked`), exactly as before.

- [ ] **Step 5: Add the purge route**

Add immediately after the `GET /api/admin/users/:userId` handler (so the three user routes sit together). It must come after that GET, not before, or Express would still route correctly but the file would read out of order.

```js
  // DELETE /api/admin/users/:userId — purge an unlinked (non-Discord) account.
  //
  // These are synthetic `manual:<name>` rows minted by the name-only path of
  // POST /api/admin/set-rainbet-name and then laundered into known_users by the startup backfill.
  // They never attributed anything (getNameIndex skips them), so removing one cannot move any
  // stat — it only clears the admin list and the equity autocomplete.
  //
  // SAFETY RAIL: a real Discord id is refused outright. There is no path from this route to
  // deleting a real user's settings, even by typo'ing a URL. Do not "improve" this into a
  // generic user-delete.
  router.delete('/api/admin/users/:userId', requireAuth, requireAdmin, async (req, res) => {
    const userId = String(req.params.userId || '');
    if (isRealDiscordId(userId)) {
      return res.status(400).json({ error: 'Only unlinked (non-Discord) accounts can be removed' });
    }
    try {
      let knownUsers = 0;
      if (pgPool) {
        const r = await pgPool.query('DELETE FROM known_users WHERE user_id=$1', [userId]);
        knownUsers = r.rowCount || 0;
      }
      const userSettingsDeleted = await deleteSettings(userId) ? 1 : 0;
      // A miss means NEITHER row existed. The two tables fall out of sync by design: a fresh
      // manual: row lives in user_settings with no known_users row (the backfill no longer
      // copies it), and deleting that must still succeed.
      if (!knownUsers && !userSettingsDeleted) {
        return res.status(404).json({ error: 'User not found' });
      }
      console.log(`[admin] purged unlinked user ${userId} by ${req.user?.id}`);
      res.json({ ok: true, deleted: { knownUsers, userSettings: userSettingsDeleted } });
    } catch (e) {
      console.error('[admin] user purge failed:', e.message);
      res.status(500).json({ error: 'Failed to remove user' });
    }
  });
```

Note the two DB writes are not wrapped in a transaction. The spec called for one; it isn't worth a pooled client here, because the operations are independent deletes of independent rows and a partial failure is self-correcting — a leftover `known_users` row is re-purgeable from the same button, and a leftover `user_settings` row no longer reaches `known_users` (Task 3). If you disagree, use `pgPool.connect()` + `BEGIN`/`COMMIT`/`ROLLBACK` and release the client in a `finally`.

- [ ] **Step 6: Update the route file's header comment**

In the endpoint list at the top of `routes/settings.routes.js`, add below the `GET /api/admin/users/:userId` line:

```
//   DELETE /api/admin/users/:userId     → purge an unlinked (non-Discord) account
```

- [ ] **Step 7: Verify the route is mounted and the rail holds**

Boot the backend (`PORT=3101 npm run dev`) and check the route is reachable and refuses a real id. The rail is the assertion that matters — a 400 here means no real account can ever be destroyed by this endpoint:

```bash
curl -s -o /dev/null -w "%{http_code}\n" -X DELETE http://localhost:3101/api/admin/users/135203806676779008
```

Expected: `401` (unauthenticated — proves the route exists and is auth-gated; a `404` would mean it isn't mounted).

Authenticated verification of the 400 rail and the 404 path happens on a real deploy in Task 6, since local auth needs a Discord session.

- [ ] **Step 8: Run the suite**

```bash
node --test lib/
```

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add lib/settings.js routes/settings.routes.js
git commit -m "feat(admin): purge unlinked users + ?unlinked=1 filter"
```

---

### Task 5: Frontend — unlinked filter toggle + Remove button

**Files:**
- Modify: `communityhunts-frontend/src/admin/adminApi.js:5-12`
- Modify: `communityhunts-frontend/src/admin/AdminUsers.js`

**Interfaces:**
- Consumes: `DELETE /api/admin/users/:userId` and `GET /api/admin/users?unlinked=1` from Task 4.
- Produces: `deleteUser(userId) => Promise<{ok, deleted}>` exported from `adminApi.js`; `fetchUsers({q, limit, offset, unlinked})`.

`apiFetch` throws `new Error(err.error)`, so the backend's copy surfaces verbatim — do not re-word backend errors in the UI.

- [ ] **Step 1: Extend `fetchUsers` and add `deleteUser`**

In `communityhunts-frontend/src/admin/adminApi.js`, replace:

```js
export const fetchUsers = ({ q = '', limit = 50, offset = 0 } = {}) => {
  const p = new URLSearchParams();
  if (q) p.set('q', q);
  p.set('limit', limit); p.set('offset', offset);
  return apiFetch(`/api/admin/users?${p.toString()}`);
};

export const fetchUser = (id) => apiFetch(`/api/admin/users/${encodeURIComponent(id)}`);
```

with:

```js
export const fetchUsers = ({ q = '', limit = 50, offset = 0, unlinked = false } = {}) => {
  const p = new URLSearchParams();
  if (q) p.set('q', q);
  if (unlinked) p.set('unlinked', '1');
  p.set('limit', limit); p.set('offset', offset);
  return apiFetch(`/api/admin/users?${p.toString()}`);
};

export const fetchUser = (id) => apiFetch(`/api/admin/users/${encodeURIComponent(id)}`);

// Purge an unlinked (non-Discord) account. The backend refuses real Discord ids with a 400,
// so this can only ever remove synthetic `manual:<name>` rows.
export const deleteUser = (id) =>
  apiFetch(`/api/admin/users/${encodeURIComponent(id)}`, { method: 'DELETE' });
```

- [ ] **Step 2: Add a pure `isUnlinkedUser` helper with a test**

The Remove button must render only on unlinked rows, which is a pure predicate — so it gets a test, per the repo's testing rule (components do NOT get tests; pure logic does).

Create `communityhunts-frontend/src/admin/userIds.js`:

```js
// Mirror of the backend's lib/userIds.js. A real Discord login is a 17-20 digit snowflake;
// anything else in the admin user list is a synthetic `manual:<name>` row.
// Keep this in sync with the backend — the backend is authoritative and will refuse a real id
// with a 400 regardless of what this says.
export const isRealDiscordId = (id) => /^\d{17,20}$/.test(String(id ?? ''));
export const isUnlinkedUser = (u) => !!u && !isRealDiscordId(u.id);
```

Create `communityhunts-frontend/src/admin/userIds.test.js`:

```js
import { isRealDiscordId, isUnlinkedUser } from './userIds';

test('real snowflakes are linked', () => {
  expect(isRealDiscordId('110983319176384512')).toBe(true);
  expect(isUnlinkedUser({ id: '110983319176384512' })).toBe(false);
});

test('manual: rows are unlinked', () => {
  expect(isRealDiscordId('manual:cabbage')).toBe(false);
  expect(isUnlinkedUser({ id: 'manual:cabbage' })).toBe(true);
});

test('edge inputs do not throw', () => {
  expect(isRealDiscordId('')).toBe(false);
  expect(isRealDiscordId(null)).toBe(false);
  expect(isUnlinkedUser(null)).toBe(false);
  expect(isUnlinkedUser(undefined)).toBe(false);
});
```

- [ ] **Step 3: Run the frontend test to verify it passes**

Run from `communityhunts-frontend/`:

```bash
CI=true npx react-scripts test --testPathPattern="userIds" --watchAll=false
```

Expected: PASS — 3 tests. (Note: `src/overlay/overlayStats.test.js` is known-red on `main`. Don't run the full suite and assume you broke it.)

- [ ] **Step 4: Wire the toggle + Remove button into AdminUsers.js**

Replace the whole of `communityhunts-frontend/src/admin/AdminUsers.js` with:

```jsx
import React from 'react';
import { useTheme } from '../theme/ThemeContext';
import { fetchUsers, deleteUser } from './adminApi';
import { isUnlinkedUser } from './userIds';
import UserProfile from './UserProfile';

export default function AdminUsers() {
  const C = useTheme();
  const [q, setQ] = React.useState('');
  const [unlinked, setUnlinked] = React.useState(false);
  const [users, setUsers] = React.useState([]);
  const [offset, setOffset] = React.useState(0);
  const [loading, setLoading] = React.useState(false);
  const [busyId, setBusyId] = React.useState(null);
  const [err, setErr] = React.useState('');
  const [selected, setSelected] = React.useState(null);
  const LIMIT = 50;

  const load = React.useCallback((query, off, append, onlyUnlinked) => {
    setLoading(true);
    fetchUsers({ q: query, limit: LIMIT, offset: off, unlinked: onlyUnlinked })
      .then(d => setUsers(prev => append ? [...prev, ...d.users] : d.users))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  // debounce search; re-fetch when the unlinked filter flips
  React.useEffect(() => {
    const t = setTimeout(() => { setOffset(0); load(q, 0, false, unlinked); }, 300);
    return () => clearTimeout(t);
  }, [q, unlinked, load]);

  const remove = async (u, e) => {
    e.stopPropagation(); // the row itself is a button that opens the profile
    const ok = window.confirm(
      `Remove ${u.displayName || u.id}?\n\n` +
      `This is not a Discord account. Their saved Rainbet handle will be deleted and equity rows ` +
      `naming them will no longer resolve one. Existing hunts are not changed.`
    );
    if (!ok) return;
    setErr(''); setBusyId(u.id);
    try {
      await deleteUser(u.id);
      setUsers(prev => prev.filter(x => x.id !== u.id));
    } catch (ex) {
      setErr(ex.message || 'Failed to remove user'); // backend copy, verbatim
    } finally {
      setBusyId(null);
    }
  };

  if (selected) {
    return <UserProfile userId={selected} onBack={() => setSelected(null)} />;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      <div style={{ flex: '1 1 auto', minWidth: 0 }}>
        <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search users by name or ID…"
          style={{ width: '100%', height: 38, background: C.sur, color: C.t1, border: `1px solid ${C.bdr}`, borderRadius: C.rCtl, padding: '0 12px', fontFamily: C.body, fontSize: 14, marginBottom: 8, boxSizing: 'border-box' }} />
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12, color: C.t3, fontFamily: C.body, fontSize: 12, cursor: 'pointer' }}>
          <input type="checkbox" checked={unlinked} onChange={e => setUnlinked(e.target.checked)} />
          Unlinked only — accounts with no Discord login
        </label>
        {err && <div style={{ color: C.red, fontFamily: C.body, fontSize: 12, marginBottom: 8 }}>{err}</div>}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {users.map(u => (
            <button key={u.id} onClick={() => setSelected(u.id)}
              style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px', background: selected === u.id ? C.bdr : C.sur, border: `1px solid ${C.bdr}`, borderRadius: C.rCtl, cursor: 'pointer', textAlign: 'left' }}>
              {u.avatar ? <img src={u.avatar} alt="" style={{ width: 28, height: 28, borderRadius: '50%' }} />
                        : <span style={{ width: 28, height: 28, borderRadius: '50%', background: C.bdr }} />}
              <span style={{ flex: 1, minWidth: 0 }}>
                <span style={{ display: 'block', color: C.t1, fontFamily: C.body, fontSize: 13, fontWeight: 600 }}>{u.displayName || u.id}</span>
                <span style={{ display: 'block', color: C.t4, fontFamily: C.mono || C.body, fontSize: 11 }}>{u.username || u.id}</span>
              </span>
              {isUnlinkedUser(u) && (
                <span style={{ color: C.t4, fontFamily: C.body, fontSize: 10, border: `1px solid ${C.bdr}`, borderRadius: 4, padding: '1px 5px' }}>UNLINKED</span>
              )}
              <span style={{ color: C.t3, fontFamily: C.body, fontSize: 11 }}>{u.slotPickCount} picks</span>
              {isUnlinkedUser(u) && (
                <span role="button" tabIndex={0} onClick={e => remove(u, e)}
                  onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') remove(u, e); }}
                  style={{ color: C.red, fontFamily: C.body, fontSize: 11, border: `1px solid ${C.bdr}`, borderRadius: C.rCtl, padding: '3px 8px', cursor: busyId === u.id ? 'default' : 'pointer', opacity: busyId === u.id ? 0.5 : 1 }}>
                  {busyId === u.id ? '…' : 'Remove'}
                </span>
              )}
            </button>
          ))}
        </div>
        {!loading && users.length >= LIMIT && (
          <button onClick={() => { const next = offset + LIMIT; setOffset(next); load(q, next, true, unlinked); }}
            style={{ marginTop: 10, height: 32, padding: '0 14px', background: 'transparent', border: `1px solid ${C.bdr}`, borderRadius: C.rCtl, color: C.t2, fontFamily: C.body, fontSize: 12, cursor: 'pointer' }}>Load more</button>
        )}
        {loading && <div style={{ color: C.t3, fontFamily: C.body, marginTop: 8 }}>Loading…</div>}
        {!loading && !users.length && (
          <div style={{ color: C.t3, fontFamily: C.body, fontSize: 12, marginTop: 8 }}>
            {unlinked ? 'No unlinked accounts — nothing to clean up.' : 'No users found.'}
          </div>
        )}
      </div>
    </div>
  );
}
```

Two deliberate details:
- **The Remove control is a `<span role="button">`, not a `<button>`.** The row itself is already a `<button>`, and nesting a button inside a button is invalid HTML that React will warn about. `e.stopPropagation()` is what stops a Remove click from also opening the profile.
- **The loss-red token is `C.red`, NOT `C.loss`.** There is no `loss` key in `src/theme/tokens.base.js` — `StatsBox.js:21` writes `C.loss || '#ff6b6b'` and only renders correctly because of that fallback. `C.loss` alone is `undefined`, and CRA will not warn. Use `C.red` and do not hardcode `#ff6b6b`.

- [ ] **Step 5: Verify the build**

```bash
CI=true npm run build
```

Expected: "Compiled successfully". Vercel turns warnings into errors, so a warning here is a failure.

- [ ] **Step 6: Commit**

```bash
git add src/admin/adminApi.js src/admin/AdminUsers.js src/admin/userIds.js src/admin/userIds.test.js
git commit -m "feat(admin): unlinked-only filter + Remove on /admin/users"
```

---

### Task 6: Deploy, verify on real infra, PR

**Files:** none — this is the verification gate.

**Interfaces:**
- Consumes: everything above.
- Produces: two merged PRs.

**Backend merges and deploys FIRST.** The frontend Remove button 404s until the route is live.

- [ ] **Step 1: Push the backend branch and open a PR**

From `communityhunts-backend/`:

```bash
git push -u origin docs/unlinked-user-cleanup-spec
gh pr create --title "Unlinked user cleanup: purge manual: rows, filter autocomplete" --body "$(cat <<'EOF'
Synthetic `manual:<name>` rows masquerade as real users in the equity autocomplete and /admin/users.

They're minted by the name-only path of `POST /api/admin/set-rainbet-name` and then laundered into
`known_users` by the startup backfill, which can't tell them from a real login. They never
attributed anything (`getNameIndex` already skipped them), so purging one cannot move any stat.

- New `lib/userIds.js` — one `isRealDiscordId` predicate, replacing four drifted copies
- `/api/known-users` filtered to real logins (fixes the dropdown)
- Backfill guard so purged rows don't resurrect on restart (this is the load-bearing bit)
- `DELETE /api/admin/users/:userId` — refuses real snowflake ids with a 400
- `GET /api/admin/users?unlinked=1`

Free-text equity names are unchanged. Profile aliases are a follow-on spec.

Spec: `docs/superpowers/specs/2026-07-15-unlinked-user-cleanup-design.md`
EOF
)"
```

- [ ] **Step 2: Verify the no-op claim against production data BEFORE merging**

Task 2 asserts that every non-`manual:` row in `known_users` is already a snowflake. If that's false in production, Task 2's refactor silently drops a real user from stats attribution. Check it against the live DB:

```sql
SELECT user_id FROM known_users
WHERE user_id !~ '^[0-9]{17,20}$' AND user_id NOT LIKE 'manual:%';
```

Expected: **zero rows.** If any row comes back, stop — that id is neither a snowflake nor a `manual:` row, and both Task 2's premise and Task 3's autocomplete filter would silently drop it. Report it rather than proceeding.

- [ ] **Step 3: Merge the backend, confirm Railway deployed**

Merge the PR, then confirm the deploy came up:

```bash
curl -s https://api.communityhunts.gg/api/health
```

Expected: a healthy response. Remember every backend deploy clears in-memory sessions — everyone gets logged out. That's expected.

- [ ] **Step 4: Push the frontend branch, open a PR, test on the preview URL**

From `communityhunts-frontend/`:

```bash
git pull --ff-only
git push -u origin feat/unlinked-user-cleanup
gh pr create --title "Admin: unlinked-only filter + Remove on /admin/users" --body "$(cat <<'EOF'
Adds an "Unlinked only" filter and a per-row Remove to /admin/users, so synthetic `manual:<name>`
accounts can be reviewed and purged. Rows that are real Discord logins show neither the badge nor
the Remove control, and the backend refuses a real snowflake id with a 400 regardless.

Requires the backend change (already merged + deployed) — `DELETE /api/admin/users/:userId` and
`GET /api/admin/users?unlinked=1`.

Confirm copy names what dies: the saved Rainbet handle. Existing hunts are not touched — equity
rows keep their name and amount, they just stop resolving a handle.

Plan: `docs/superpowers/plans/2026-07-15-unlinked-user-cleanup.md` (backend repo)
EOF
)"
```

If `gh pr create` says "No commits between…", the branch is already merged — check `git log origin/main` before re-cutting it.

Then on the **Vercel preview URL** (not production), signed in as an admin, walk `/admin/users`:

- [ ] The **Unlinked only** checkbox filters the list to `manual:` rows.
- [ ] Those rows show an `UNLINKED` badge and a **Remove** control.
- [ ] A **real** user shows neither badge nor Remove.
- [ ] Clicking Remove opens the confirm; cancelling changes nothing.
- [ ] Confirming removes the row from the list.
- [ ] Clicking Remove does NOT also open the user's profile (proves `stopPropagation`).
- [ ] With the filter on and everything purged, the empty state reads "No unlinked accounts — nothing to clean up."
- [ ] The purged name is gone from the **equity autocomplete** dropdown on a hunt page.

- [ ] **Step 5: The load-bearing check — restart the backend and confirm the purge stuck**

This is the one step that distinguishes a real fix from a fix that only looks real. Trigger a Railway restart (any redeploy), then:

```sql
SELECT user_id FROM known_users WHERE user_id LIKE 'manual:%';
```

Expected: **zero rows.** If purged rows are back, the Task 3 backfill guard isn't working — the autocomplete will re-pollute on every deploy and the feature is not done.

- [ ] **Step 6: Merge the frontend PR**

Merge to `main` (→ Vercel production) only after every box above is ticked.

- [ ] **Step 7: Verify the merge-base**

Merge races have dropped commits in this repo before. From each repo:

```bash
git pull --ff-only && git log --oneline -5
```

Confirm your commits are actually in `origin/main`, in both repos.

---

## Follow-on

**Profile aliases** — user-registered alternate names resolving to a real Discord id — is the next spec, and it's the bigger win: an alias would make equity rows actually attribute, which `manual:` rows never did. Its crux is impersonation: a name collision in `getNameIndex` (`lib/statsStore.js:51`) drops the name for *everyone*, so a user claiming the alias "Bean" would silently strip attribution from the real Bean. That needs a globally-unique namespace with first-come-first-served rejection. Brainstorm it separately; this cleanup is its prerequisite, so the namespace it validates against holds only real people.
