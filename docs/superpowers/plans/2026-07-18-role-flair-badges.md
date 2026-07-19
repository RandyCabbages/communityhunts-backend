# Role Flair Badges Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show a bold status pill (Owner / The King / Staff / Supporter) next to a user's name wherever names render, assigned by role rather than purchased.

**Architecture:** The backend serves a small, tenant-scoped, public roster at `GET /api/badges`. The frontend fetches it once (re-fetch on tenant change), resolves a single highest-priority badge by Discord ID via a `useBadges()` context, and renders a `<UserBadge>` pill. Supporters are stored in a new `supporters` table managed from the admin panel, mirroring the existing `platform_admins` / `lib/admins.js` pattern.

**Tech Stack:** Node.js/Express + Postgres (`pg`) backend; React 18 + react-router v6 frontend. Backend tests use `node:test` (`node --test`). Frontend pure-logic tests use CRA's jest runner. No new dependencies.

## Global Constraints

- **Two repos:** backend = `C:\Users\kylew\communityhunts-backend` (repo `RandyCabbages/communityhunts-backend`); frontend = `C:\Users\kylew\communityhunts-frontend` (repo `GooferG/communityhunts-frontend`). Each task states which repo.
- **No `Co-Authored-By` / AI-attribution trailers** in any commit (Kyle's standing rule).
- **Never push to `main`.** All work lands on branches: backend `feat/role-flair-badges` (already created, spec committed there); frontend `feat/role-flair-badges` (create it in Task 4). Vercel/Railway auto-deploy from `main` — do not trigger that.
- **Frontend build gate:** `CI=true npm run build` must print "Compiled successfully" before any push (CRA turns warnings into errors).
- **Gate on Discord ID, never display name.** IDs are strings everywhere (`String(id)`).
- **Precedence (single badge, highest wins):** Owner → The King → Staff → Supporter.
- **Badge colours are tenant-invariant** (platform identity), NOT the tenant accent: gold `#fbbf24` (Owner + King), violet `#a78bfa` (Staff), pink `#f472b6` (Supporter). Note `G.gold` is the tenant accent — do NOT use it for badges.
- **No crown on any badge** — 👑 stays Bean's personal streamer icon. Icons: `◆` Owner, `★` The King, `⚡` Staff, `♥` Supporter (placeholders, easily swapped).
- **Frontend file discipline:** new UI → new file; tokens via `useTheme()`; no god-files.

Spec: `docs/superpowers/specs/2026-07-18-role-flair-badges-design.md` (backend repo).

---

## File Structure

**Backend (`communityhunts-backend`):**
- Create `lib/supporters.js` — supporters DB module (mirror `lib/admins.js`).
- Create `lib/supporters.test.js` — unit test (fake pg pool).
- Modify `server.js` — require + `initSupporters`, pass `supporters` into the admin router deps and the integrations router deps.
- Modify `routes/admin.routes.js` — three `/api/admin/supporters` endpoints.
- Modify `routes/integrations.routes.js` — public `GET /api/badges`.

**Frontend (`communityhunts-frontend`):**
- Create `src/badges/roles.js` — pure `pickBadge` + `BADGE_META`.
- Create `src/badges/roles.test.js` — pure unit test.
- Create `src/badges/BadgeContext.js` — `BadgeProvider` + `useBadges`.
- Create `src/badges/UserBadge.js` — the pill component.
- Modify `src/theme/tokens.base.js` — add tenant-invariant badge colour tokens.
- Modify `src/App.js` — wrap tree in `BadgeProvider`.
- Modify `src/hunt/columns/EquityRow.js` — badge replaces HOST for the host row.
- Modify `src/hunt/columns/EquityCard.js` — add badge next to name.
- Modify `src/hunt/columns/EquityColumn.js` — pass `hostId` to both.
- Modify `src/pages/home/UserDropdown.js` — badge on the user's own name.
- Create `src/admin/AdminSupporters.js` — admin management page.
- Modify `src/admin/adminApi.js` — supporters API calls.
- Modify `src/admin/registry/tools.js` — register the Supporters tab.

---

## Task 1: `lib/supporters.js` + unit test (backend)

**Files:**
- Create: `lib/supporters.js`
- Test: `lib/supporters.test.js`

**Interfaces:**
- Consumes: a `pgPool` (node-postgres Pool) via DI, or none (safe no-op).
- Produces: `initSupporters(deps)`, `reloadSupporterCache()`, `isSupporter(id)`, `getSupporterIds()`, `listSupporters()`, `addSupporter(discordId, addedBy)`, `removeSupporter(discordId)`. `isSupporter`/`getSupporterIds` are synchronous (cache-backed); the rest return promises.

- [ ] **Step 1: Write the failing test**

Create `lib/supporters.test.js`:

```javascript
const { test } = require('node:test');
const assert = require('node:assert');
const supporters = require('./supporters');

// Fake pgPool: records queries, returns canned rows for SELECT, [] otherwise. No real DB.
function makeFakePgPool(selectRows) {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql, params });
      if (/^\s*SELECT\b/i.test(sql)) return { rows: selectRows || [] };
      return { rows: [] };
    },
  };
}

test('no DB: isSupporter is false and mutations are safe no-ops', async () => {
  await supporters.initSupporters({}); // no pgPool
  assert.equal(supporters.isSupporter('123'), false);
  await supporters.addSupporter('123', 'admin1'); // must not throw
  assert.deepEqual(supporters.getSupporterIds(), []);
});

test('with DB: cache loads from SELECT and isSupporter matches (string-coerced)', async () => {
  const pool = makeFakePgPool([{ discord_id: '111' }, { discord_id: 222 }]);
  await supporters.initSupporters({ pgPool: pool });
  assert.equal(supporters.isSupporter('111'), true);
  assert.equal(supporters.isSupporter(222), true, 'numeric id coerces to string');
  assert.equal(supporters.isSupporter('999'), false);
  // CREATE TABLE + SELECT ran during init.
  assert.ok(pool.calls.some(c => /CREATE TABLE/i.test(c.sql)));
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test lib/supporters.test.js`
Expected: FAIL — `Cannot find module './supporters'`.

- [ ] **Step 3: Write the implementation**

Create `lib/supporters.js`:

```javascript
// communityhunts-backend/lib/supporters.js
// Supporters — Discord IDs manually marked as donors via the admin UI. Powers the
// "Supporter" flair badge (global, all tenants). DI pattern (see lib/admins.js):
// no-ops safely with no DB.

let pgPool = null;
let cache = new Set(); // discord_id strings

async function initSupporters(deps) {
  pgPool = deps.pgPool || null;
  if (!pgPool) { console.log('[supporters] no DB — UI-managed supporters disabled'); return; }
  try {
    await pgPool.query(`
      CREATE TABLE IF NOT EXISTS supporters (
        discord_id TEXT PRIMARY KEY,
        added_by   TEXT,
        added_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
    await reloadSupporterCache();
    console.log(`[supporters] loaded ${cache.size} supporter(s)`);
  } catch (e) {
    console.error('[supporters] init failed:', e.message);
  }
}

async function reloadSupporterCache() {
  if (!pgPool) return;
  try {
    const r = await pgPool.query('SELECT discord_id FROM supporters');
    cache = new Set(r.rows.map(row => String(row.discord_id)));
  } catch (e) {
    console.error('[supporters] reload failed:', e.message);
  }
}

function isSupporter(userId) { return !!userId && cache.has(String(userId)); }
function getSupporterIds() { return [...cache]; }

async function listSupporters() {
  if (!pgPool) return [];
  try {
    const r = await pgPool.query(
      'SELECT discord_id, added_by, added_at FROM supporters ORDER BY added_at ASC');
    return r.rows.map(row => ({ discordId: row.discord_id, addedBy: row.added_by, addedAt: row.added_at }));
  } catch (e) { console.error('[supporters] list failed:', e.message); return []; }
}

async function addSupporter(discordId, addedBy) {
  if (!pgPool || !discordId) return;
  try {
    await pgPool.query(
      `INSERT INTO supporters (discord_id, added_by) VALUES ($1, $2)
       ON CONFLICT (discord_id) DO NOTHING`,
      [String(discordId), addedBy ? String(addedBy) : null]);
    await reloadSupporterCache();
  } catch (e) { console.error('[supporters] add failed:', e.message); throw e; }
}

async function removeSupporter(discordId) {
  if (!pgPool || !discordId) return;
  try {
    await pgPool.query('DELETE FROM supporters WHERE discord_id=$1', [String(discordId)]);
    await reloadSupporterCache();
  } catch (e) { console.error('[supporters] remove failed:', e.message); throw e; }
}

module.exports = {
  initSupporters, reloadSupporterCache, isSupporter, getSupporterIds,
  listSupporters, addSupporter, removeSupporter,
};
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test lib/supporters.test.js`
Expected: PASS — both tests green (`# pass 2`).

- [ ] **Step 5: Commit**

```bash
cd /c/Users/kylew/communityhunts-backend
git add lib/supporters.js lib/supporters.test.js
git commit -m "feat(supporters): supporters DB module + unit test"
```

---

## Task 2: Admin supporters API + server wiring (backend)

**Files:**
- Modify: `server.js` (require + init near line 276-277; admin router deps near line 599-602)
- Modify: `routes/admin.routes.js` (destructure `supporters` from deps; add 3 endpoints after the platform-admins block, ~line 232)

**Interfaces:**
- Consumes: `supporters` module from Task 1; existing `requireAuth`, `requirePlatformAdmin`, `pgPool`, `tenants`, `admins` in the admin router deps.
- Produces: `GET /api/admin/supporters`, `POST /api/admin/supporters {discordId}`, `DELETE /api/admin/supporters/:id`. GET returns `[{ discordId, addedBy, addedAt, displayName, avatar }]`.

- [ ] **Step 1: Wire the module in `server.js`**

After line 277 (`admins.initAdmins(...)`), add:

```javascript
const supporters = require('./lib/supporters');
supporters.initSupporters({ pgPool }).catch(e => console.error('[supporters] init error:', e.message));
```

In the admin router mount (the `deps` object passed to `require('./routes/admin.routes')({ ... })`, around line 599-602 — the object that already contains `pgPool, admins, tenants, ADMIN_IDS, statsStore,`), add `supporters` to that object:

```javascript
    pgPool, admins, supporters, tenants, ADMIN_IDS, statsStore,
```

- [ ] **Step 2: Add the endpoints in `routes/admin.routes.js`**

In the `const { ... } = deps;` destructure at the top of `module.exports`, add `supporters`:

```javascript
    pgPool, admins, supporters, tenants, ADMIN_IDS, statsStore,
```

Immediately AFTER the `DELETE /api/admin/platform-admins/:id` handler (the end of the "Platform-admin management" block, before the "Create a community tenant" block), add:

```javascript
  // ── Supporter management ───────────────────────────────────────────
  // Supporters are donors marked by hand. Global (all tenants). Platform-admin only.
  router.get('/api/admin/supporters', requireAuth, requirePlatformAdmin, async (req, res) => {
    try {
      const rows = await supporters.listSupporters(); // [{ discordId, addedBy, addedAt }]
      let enriched = rows;
      if (pgPool && rows.length) {
        try {
          const ids = rows.map(r => r.discordId);
          const r = await pgPool.query(
            `SELECT user_id, display_name, avatar FROM known_users WHERE user_id = ANY($1)`, [ids]);
          const byId = {};
          for (const u of r.rows) byId[u.user_id] = u;
          enriched = rows.map(row => ({
            ...row,
            displayName: byId[row.discordId]?.display_name || null,
            avatar: byId[row.discordId]?.avatar || null,
          }));
        } catch (e) { console.error('[admin] supporters enrich failed:', e.message); }
      }
      res.json(enriched);
    } catch (e) {
      console.error('[admin] supporters list failed:', e.message);
      res.status(500).json({ error: 'Failed to list supporters' });
    }
  });

  router.post('/api/admin/supporters', requireAuth, requirePlatformAdmin, async (req, res) => {
    const discordId = String(req.body?.discordId || '').trim();
    if (!/^\d{5,}$/.test(discordId)) return res.status(400).json({ error: 'Valid Discord ID required' });
    try {
      await supporters.addSupporter(discordId, req.user.id);
      res.json({ ok: true });
    } catch (e) {
      console.error('[admin] supporters add failed:', e.message);
      res.status(500).json({ error: 'Failed to add supporter' });
    }
  });

  router.delete('/api/admin/supporters/:id', requireAuth, requirePlatformAdmin, async (req, res) => {
    const id = String(req.params.id || '').trim();
    try {
      await supporters.removeSupporter(id);
      res.json({ ok: true });
    } catch (e) {
      console.error('[admin] supporters remove failed:', e.message);
      res.status(500).json({ error: 'Failed to remove supporter' });
    }
  });
```

- [ ] **Step 3: Verify the server boots and the routes exist**

Start dev server: `npm run dev`
Expected boot log includes `[supporters] no DB — UI-managed supporters disabled` (local, no `DATABASE_URL`) OR `[supporters] loaded N supporter(s)` (with DB).

In a second shell, confirm the route is mounted (401/403 without a session is fine — it proves the route exists, not a 404):

Run: `curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3001/api/admin/supporters`
Expected: `401` or `403` (NOT `404`).

Stop the dev server.

- [ ] **Step 4: Commit**

```bash
cd /c/Users/kylew/communityhunts-backend
git add server.js routes/admin.routes.js
git commit -m "feat(supporters): admin CRUD endpoints + server wiring"
```

---

## Task 3: Public `GET /api/badges` roster (backend)

**Files:**
- Modify: `server.js` (integrations router mount — add `supporters` to its deps)
- Modify: `routes/integrations.routes.js` (destructure `supporters`; add the endpoint)

**Interfaces:**
- Consumes: `req.tenant` (set by global `resolveTenant`), `tenants.PLATFORM_OWNER_IDS`, `req.tenant.hostDiscordId`, `req.tenant.modIds`, `supporters.getSupporterIds()`.
- Produces: `GET /api/badges` → `{ owners: string[], king: string|null, mods: string[], supporters: string[] }`, tenant-scoped, public (no auth).

- [ ] **Step 1: Add `supporters` to the integrations router deps in `server.js`**

Find the `app.use(require('./routes/integrations.routes')({ ... }))` mount. Add `supporters` to the deps object (it already injects `integrations, tenants, memberships, hunts, normalizeSlot, requireAuth`):

```javascript
  supporters,
```

(If integrations mounts BEFORE the `const supporters = ...` line from Task 2, move the two supporters lines from Task 2 up so they run before the integrations mount. `supporters` only needs to exist as an object at mount time; its cache fills asynchronously.)

- [ ] **Step 2: Add the endpoint in `routes/integrations.routes.js`**

In the deps destructure at the top, add `supporters`:

```javascript
  const { integrations, tenants, memberships, hunts, normalizeSlot, requireAuth, supporters } = deps;
```

Immediately AFTER the `GET /api/tenant-config` handler (before `GET /api/tenants`), add:

```javascript
  // Public badge roster for the ACTIVE tenant. owners+supporters are global; king+mods are this
  // tenant's. Powers the frontend flair badges. No secrets — these badges are shown publicly.
  // Served from in-memory caches; no per-request DB hit.
  router.get('/api/badges', (req, res) => {
    const t = req.tenant || {};
    res.json({
      owners: (tenants.PLATFORM_OWNER_IDS || []).map(String),
      king: t.hostDiscordId ? String(t.hostDiscordId) : null,
      mods: (t.modIds || []).map(String),
      supporters: supporters.getSupporterIds(),
    });
  });
```

- [ ] **Step 3: Verify the endpoint returns the roster**

Start `npm run dev`, then:

Run: `curl -s http://localhost:3001/api/badges`
Expected JSON with the four keys, e.g. `{"owners":["135203806676779008","168055630916091904"],"king":"110983319176384512","mods":[],"supporters":[]}` (values depend on local DB; `owners` is always the two owner IDs, `king` is Bean's host id for the default tenant).

Stop the dev server.

- [ ] **Step 4: Commit**

```bash
cd /c/Users/kylew/communityhunts-backend
git add server.js routes/integrations.routes.js
git commit -m "feat(badges): public tenant-scoped GET /api/badges roster"
```

---

## Task 4: Frontend `src/badges/roles.js` pure logic + test

**Files (frontend repo):**
- Create: `src/badges/roles.js`
- Test: `src/badges/roles.test.js`

**Interfaces:**
- Produces: `pickBadge({ isOwner, isKing, isStaff, isSupporter }) → 'owner'|'king'|'staff'|'supporter'|null` and `BADGE_META` (label, icon, `color` token key, `dim` token key, `ink` hex per badge kind).

- [ ] **Step 0: Create the frontend branch**

```bash
cd /c/Users/kylew/communityhunts-frontend
git checkout main && git pull --ff-only
git checkout -b feat/role-flair-badges
```

- [ ] **Step 1: Write the failing test**

Create `src/badges/roles.test.js`:

```javascript
import { pickBadge, BADGE_META } from './roles';

describe('pickBadge precedence', () => {
  test('returns null when no flags set', () => {
    expect(pickBadge({})).toBeNull();
  });
  test('owner outranks everything', () => {
    expect(pickBadge({ isOwner: true, isKing: true, isStaff: true, isSupporter: true })).toBe('owner');
  });
  test('king outranks staff and supporter', () => {
    expect(pickBadge({ isKing: true, isStaff: true, isSupporter: true })).toBe('king');
  });
  test('staff outranks supporter', () => {
    expect(pickBadge({ isStaff: true, isSupporter: true })).toBe('staff');
  });
  test('supporter alone', () => {
    expect(pickBadge({ isSupporter: true })).toBe('supporter');
  });
  test('BADGE_META has every kind with label/icon/color', () => {
    for (const k of ['owner', 'king', 'staff', 'supporter']) {
      expect(BADGE_META[k]).toBeTruthy();
      expect(typeof BADGE_META[k].label).toBe('string');
      expect(typeof BADGE_META[k].icon).toBe('string');
      expect(typeof BADGE_META[k].color).toBe('string');
    }
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `CI=true npx react-scripts test --testPathPattern="badges/roles" --watchAll=false`
Expected: FAIL — cannot find module `./roles`.

- [ ] **Step 3: Write the implementation**

Create `src/badges/roles.js`:

```javascript
// Pure role-flair-badge logic. Single source for precedence + presentation metadata.
// Badges are assigned by status (Owner/King/Staff/Supporter), distinct from cosmetic cards.

// Highest-priority badge wins; one badge per user. Owner > King > Staff > Supporter.
export function pickBadge({ isOwner, isKing, isStaff, isSupporter } = {}) {
  if (isOwner) return 'owner';
  if (isKing) return 'king';
  if (isStaff) return 'staff';
  if (isSupporter) return 'supporter';
  return null;
}

// Presentation per badge. `color`/`dim` are theme token KEYS (tenant-invariant, added to
// tokens.base.js); `ink` is the dark same-family text colour for the solid pill. NO crown.
export const BADGE_META = {
  owner:     { label: 'Owner',     icon: '◆', color: 'badgeGold',   dim: 'badgeGoldDim',   ink: '#3a2a05' },
  king:      { label: 'The King',  icon: '★', color: 'badgeGold',   dim: 'badgeGoldDim',   ink: '#3a2a05' },
  staff:     { label: 'Staff',     icon: '⚡', color: 'badgeViolet', dim: 'badgeVioletDim', ink: '#1c1140' },
  supporter: { label: 'Supporter', icon: '♥', color: 'badgePink',   dim: 'badgePinkDim',   ink: '#3d0f26' },
};
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `CI=true npx react-scripts test --testPathPattern="badges/roles" --watchAll=false`
Expected: PASS — all 6 assertions green.

- [ ] **Step 5: Commit**

```bash
cd /c/Users/kylew/communityhunts-frontend
git add src/badges/roles.js src/badges/roles.test.js
git commit -m "feat(badges): pure pickBadge precedence + metadata"
```

---

## Task 5: Badge colour tokens + `BadgeContext` + App wiring (frontend)

**Files:**
- Modify: `src/theme/tokens.base.js` (add 6 tokens near `gold3`)
- Create: `src/badges/BadgeContext.js`
- Modify: `src/App.js` (import + wrap tree)

**Interfaces:**
- Consumes: `apiFetch` from `../api`, `pickBadge` from `./roles`, `useLocation` from react-router.
- Produces: `BadgeProvider` (component) and `useBadges()` → `{ badgeFor(discordId) }` where `badgeFor` returns a badge kind or null. New theme tokens: `badgeGold`, `badgeGoldDim`, `badgeViolet`, `badgeVioletDim`, `badgePink`, `badgePinkDim`.

- [ ] **Step 1: Add tenant-invariant badge tokens**

In `src/theme/tokens.base.js`, on the line with `gold3:'#fbbf24', teal:'#5eead4',` add after it (same object):

```javascript
  badgeGold:'#fbbf24',   badgeGoldDim:'rgba(251,191,36,0.16)',
  badgeViolet:'#a78bfa', badgeVioletDim:'rgba(167,139,250,0.18)',
  badgePink:'#f472b6',   badgePinkDim:'rgba(244,114,182,0.18)',
```

These flow through `makeTheme()` (base spread) so they resolve on `useTheme()` for every tenant, unaffected by the per-tenant accent override.

- [ ] **Step 2: Create the context**

Create `src/badges/BadgeContext.js`:

```javascript
import { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { useLocation } from 'react-router-dom';
import { apiFetch } from '../api';
import { pickBadge } from './roles';

const EMPTY = { owners: new Set(), king: null, mods: new Set(), supporters: new Set() };
const BadgeCtx = createContext({ badgeFor: () => null });

export function BadgeProvider({ children }) {
  const [roster, setRoster] = useState(EMPTY);
  const loc = useLocation();
  // Re-fetch when the tenant slug (first path segment) changes — king + mods are tenant-scoped.
  const slug = (loc.pathname.split('/')[1] || '').toLowerCase();

  useEffect(() => {
    let live = true;
    apiFetch('/api/badges')
      .then(d => {
        if (!live) return;
        setRoster({
          owners: new Set((d.owners || []).map(String)),
          king: d.king ? String(d.king) : null,
          mods: new Set((d.mods || []).map(String)),
          supporters: new Set((d.supporters || []).map(String)),
        });
      })
      .catch(() => { /* badges are cosmetic; a failed fetch just means no badges */ });
    return () => { live = false; };
  }, [slug]);

  const badgeFor = useCallback((discordId) => {
    if (!discordId) return null;
    const s = String(discordId);
    return pickBadge({
      isOwner: roster.owners.has(s),
      isKing: roster.king === s,
      isStaff: roster.mods.has(s),
      isSupporter: roster.supporters.has(s),
    });
  }, [roster]);

  return <BadgeCtx.Provider value={{ badgeFor }}>{children}</BadgeCtx.Provider>;
}

export const useBadges = () => useContext(BadgeCtx);
```

- [ ] **Step 3: Wrap the app in `BadgeProvider`**

In `src/App.js`, add the import near the other provider import (line ~35, next to `ThemeProvider`):

```javascript
import { BadgeProvider } from './badges/BadgeContext';
```

Then wrap the tree. The render currently is `return ( <ThemeProvider> … </ThemeProvider> );` (lines ~144-207). Put `BadgeProvider` directly inside `ThemeProvider`, wrapping everything it currently contains:

```javascript
  return (
    <ThemeProvider>
      <BadgeProvider>
        {/* …existing children (the <Routes> block etc.) unchanged… */}
      </BadgeProvider>
    </ThemeProvider>
  );
```

`useLocation()` inside `BadgeProvider` is valid — `BrowserRouter` wraps `<App/>` in `src/index.js`.

- [ ] **Step 4: Verify the build compiles**

Run: `CI=true npm run build`
Expected: "Compiled successfully."

- [ ] **Step 5: Commit**

```bash
cd /c/Users/kylew/communityhunts-frontend
git add src/theme/tokens.base.js src/badges/BadgeContext.js src/App.js
git commit -m "feat(badges): badge colour tokens + BadgeProvider context"
```

---

## Task 6: `UserBadge` pill component (frontend)

**Files:**
- Create: `src/badges/UserBadge.js`

**Interfaces:**
- Consumes: `useTheme` (colour tokens from Task 5), `useBadges` (Task 5), `BADGE_META` (Task 4).
- Produces: `<UserBadge userId={string} style={obj?} />` — renders a bold solid pill, or nothing if the user has no badge.

- [ ] **Step 1: Write the component**

Create `src/badges/UserBadge.js`:

```javascript
import { useTheme } from '../theme/ThemeContext';
import { useBadges } from './BadgeContext';
import { BADGE_META } from './roles';

// Bold solid pill next to a name. Renders null when the id has no badge — safe on synthetic
// (creator_auto/bean_auto) and anonymous rows (they pass a null/undefined id → null).
export default function UserBadge({ userId, style = {} }) {
  const G = useTheme();
  const { badgeFor } = useBadges();
  const kind = badgeFor(userId);
  if (!kind) return null;
  const m = BADGE_META[kind];
  return (
    <span style={{
      flexShrink: 0, display: 'inline-flex', alignItems: 'center', gap: 3,
      fontFamily: G.mono, fontWeight: 700, fontSize: 9.5, letterSpacing: '0.04em',
      textTransform: 'uppercase', padding: '2.5px 8px', borderRadius: 6,
      background: G[m.color], color: m.ink, whiteSpace: 'nowrap',
      ...style,
    }}>{m.icon} {m.label}</span>
  );
}
```

- [ ] **Step 2: Verify the build compiles**

Run: `CI=true npm run build`
Expected: "Compiled successfully." (The component isn't rendered anywhere yet — this only checks it parses/imports cleanly.)

- [ ] **Step 3: Commit**

```bash
cd /c/Users/kylew/communityhunts-frontend
git add src/badges/UserBadge.js
git commit -m "feat(badges): UserBadge bold-pill component"
```

---

## Task 7: Equity list integration — badge replaces HOST (frontend)

**Files:**
- Modify: `src/hunt/columns/EquityRow.js`
- Modify: `src/hunt/columns/EquityCard.js`
- Modify: `src/hunt/columns/EquityColumn.js`

**Interfaces:**
- Consumes: `UserBadge`, `useBadges` (badgeFor), the hunt owner's Discord ID (`hunt.user?.id`) threaded as a new `hostId` prop.
- Produces: badge rendered next to each equity member's name; the `creator_auto`/`bean_auto` host row shows the owner's badge (via `hostId`) instead of HOST, falling back to the neutral HOST label only when the host has no badge.

- [ ] **Step 1: Update `EquityRow.js`**

Add imports (after the existing `FlairName` / cosmetics imports, lines 4-6):

```javascript
import UserBadge from '../../badges/UserBadge';
import { useBadges } from '../../badges/BadgeContext';
```

Add `hostId` to the destructured props (in the `EquityRow({ … })` param list, alongside `user`):

```javascript
  hostId,
```

Inside the component body (after `const G = useTheme();`, line 27), add:

```javascript
  const { badgeFor } = useBadges();
  // Synthetic rows carry no real Discord id; resolve the host row's badge from the hunt owner's id.
  const badgeId = (e.id === 'creator_auto' || e.id === 'bean_auto') ? hostId : e.id;
  const badgeKind = badgeFor(badgeId);
```

Replace the existing HOST span (line 59):

```javascript
        {e.id === 'creator_auto' && <span style={{ flexShrink: 0, fontFamily: G.mono, fontSize: 8, fontWeight: 700, letterSpacing: '0.06em', color: G.gold, background: G.gdim, borderRadius: 4, padding: '1px 5px' }}>HOST</span>}
```

with:

```javascript
        {badgeKind
          ? <UserBadge userId={badgeId} />
          : (e.id === 'creator_auto' && <span style={{ flexShrink: 0, fontFamily: G.mono, fontSize: 8, fontWeight: 700, letterSpacing: '0.06em', color: G.gold, background: G.gdim, borderRadius: 4, padding: '1px 5px' }}>HOST</span>)}
```

- [ ] **Step 2: Update `EquityCard.js`**

Add the same two imports at the top (near line 4 `FlairName`):

```javascript
import UserBadge from '../../badges/UserBadge';
```

Add `hostId` to the destructured props of `EquityCard({ … })` (alongside `member: e`).

Right AFTER the `<FlairName … />` at line ~160, add the badge (compute the id inline; EquityCard has no HOST tag to replace, so this is purely additive):

```javascript
              <UserBadge userId={(e.id === 'creator_auto' || e.id === 'bean_auto') ? hostId : e.id} style={{ marginLeft: 6 }} />
```

- [ ] **Step 3: Pass `hostId` from `EquityColumn.js`**

`hunt.user` is already in scope in `EquityColumn` (used at line ~132). Add `hostId={hunt.user?.id}` to BOTH the `<EquityCard … />` call sites (~line 416 and ~480) and the `<EquityRow … />` call site (~line 518). Example for the `EquityRow` site — add one line among its props:

```javascript
              hostId={hunt.user?.id}
```

Do the same in each `<EquityCard>` block.

- [ ] **Step 4: Verify the build compiles**

Run: `CI=true npm run build`
Expected: "Compiled successfully." (CRA does NOT warn on a missed prop — the `hostId` wiring in Step 3 must be checked by eye against Steps 1-2.)

- [ ] **Step 5: Manual preview verification**

Push the branch and open the Vercel preview URL (or run `npm start`). On a hunt where you (an owner) are the host, your equity row must read `◆ Owner` (gold solid pill) — NOT HOST. A member who is a mod reads `⚡ Staff`; a plain member with no role reads no badge; a non-owner host with no role still reads `HOST`.

- [ ] **Step 6: Commit**

```bash
cd /c/Users/kylew/communityhunts-frontend
git add src/hunt/columns/EquityRow.js src/hunt/columns/EquityCard.js src/hunt/columns/EquityColumn.js
git commit -m "feat(badges): show role badge in equity list, replacing HOST for the host"
```

---

## Task 8: Account dropdown integration (frontend)

**Files:**
- Modify: `src/pages/home/UserDropdown.js`

**Interfaces:**
- Consumes: `UserBadge`. Renders the logged-in user's own badge next to their display name in the account button.

- [ ] **Step 1: Add the badge to the account button**

Add the import at the top of `src/pages/home/UserDropdown.js` (near the `getUserRole` import, line 4):

```javascript
import UserBadge from '../../badges/UserBadge';
```

Right AFTER `{user.displayName}` (line 75, before the `{role === 'vip' && …}` block), add:

```javascript
        <UserBadge userId={user.id} style={{ marginLeft: 2 }} />
```

- [ ] **Step 2: Verify the build compiles**

Run: `CI=true npm run build`
Expected: "Compiled successfully."

- [ ] **Step 3: Manual preview verification**

On the preview, sign in as an owner — the account pill (top right) shows `◆ Owner` next to your name.

- [ ] **Step 4: Commit**

```bash
cd /c/Users/kylew/communityhunts-frontend
git add src/pages/home/UserDropdown.js
git commit -m "feat(badges): show own role badge in the account dropdown"
```

---

## Task 9: Admin "Supporters" management page (frontend)

**Files:**
- Modify: `src/admin/adminApi.js` (three calls)
- Create: `src/admin/AdminSupporters.js`
- Modify: `src/admin/registry/tools.js` (import + TOOLS entry)

**Interfaces:**
- Consumes: `apiFetch`; the backend endpoints from Task 2; `isPlatformAdmin` from `../auth/roles`.
- Produces: a `/admin/supporters` tab (platform-admin only) to add/remove supporter Discord IDs.

- [ ] **Step 1: Add the API calls**

In `src/admin/adminApi.js`, after the `removePlatformAdmin` export (line ~68), add:

```javascript
export const fetchSupporters = () => apiFetch('/api/admin/supporters');
export const addSupporter = (discordId) =>
  apiFetch('/api/admin/supporters', { method: 'POST', body: JSON.stringify({ discordId }) });
export const removeSupporter = (id) =>
  apiFetch(`/api/admin/supporters/${encodeURIComponent(id)}`, { method: 'DELETE' });
```

- [ ] **Step 2: Create the page**

Create `src/admin/AdminSupporters.js`:

```javascript
import React from 'react';
import { useOutletContext } from 'react-router-dom';
import { useTheme } from '../theme/ThemeContext';
import { isPlatformAdmin } from '../auth/roles';
import { fetchSupporters, addSupporter, removeSupporter } from './adminApi';

export default function AdminSupporters() {
  const C = useTheme();
  const { user } = useOutletContext();
  const [rows, setRows] = React.useState([]);
  const [newId, setNewId] = React.useState('');
  const [err, setErr] = React.useState('');

  const load = () => fetchSupporters().then(setRows).catch(e => setErr(e.message));
  React.useEffect(() => { load(); }, []);

  const add = () => {
    setErr('');
    addSupporter(newId.trim()).then(() => { setNewId(''); load(); }).catch(e => setErr(e.message));
  };
  const remove = (id) => {
    if (!window.confirm('Remove this supporter?')) return;
    removeSupporter(id).then(load).catch(e => setErr(e.message));
  };

  const canManage = isPlatformAdmin(user);

  return (
    <div>
      <h2 style={{ color: C.t1, fontFamily: C.display }}>Supporters</h2>
      <p style={{ color: C.t3, fontFamily: C.body, fontSize: 13 }}>Supporters donated via the support link and get the ♥ Supporter flair everywhere. Paste a Discord ID to grant it.</p>
      {err && <div style={{ color: C.red, fontFamily: C.body, marginBottom: 10 }}>{err}</div>}

      {canManage && (
        <div style={{ display: 'flex', gap: 6, marginBottom: 16 }}>
          <input value={newId} onChange={e => setNewId(e.target.value)} placeholder="Discord ID to add…"
            style={{ flex: 1, height: 36, background: C.sur, color: C.t1, border: `1px solid ${C.bdr}`, borderRadius: C.rCtl, padding: '0 12px', fontFamily: C.body, fontSize: 13 }} />
          <button onClick={add} disabled={!newId.trim()} style={{ height: 36, padding: '0 16px', background: C.accent || C.gold, color: C.bg, border: 'none', borderRadius: C.rCtl, fontFamily: C.body, fontWeight: 800, fontSize: 13, cursor: 'pointer' }}>Add</button>
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        {rows.length === 0 && <div style={{ color: C.t4, fontFamily: C.body, fontSize: 13 }}>No supporters yet.</div>}
        {rows.map(r => (
          <div key={r.discordId} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px', background: C.sur, border: `1px solid ${C.bdr}`, borderRadius: C.rCtl }}>
            {r.avatar ? <img src={r.avatar} alt="" style={{ width: 28, height: 28, borderRadius: '50%' }} />
                      : <span style={{ width: 28, height: 28, borderRadius: '50%', background: C.bdr, display: 'inline-block' }} />}
            <span style={{ flex: 1, minWidth: 0 }}>
              <span style={{ display: 'block', color: C.t1, fontFamily: C.body, fontSize: 13 }}>{r.displayName || r.discordId}</span>
              <span style={{ display: 'block', color: C.t4, fontFamily: C.mono || C.body, fontSize: 11 }}>{r.discordId}</span>
            </span>
            {canManage && (
              <button onClick={() => remove(r.discordId)} style={{ height: 28, padding: '0 10px', background: 'transparent', border: `1px solid ${C.red}`, borderRadius: C.rCtl, color: C.red, fontFamily: C.body, fontSize: 11, cursor: 'pointer' }}>Remove</button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Register the tab**

In `src/admin/registry/tools.js`, add the import next to `AdminAdmins` (line ~6):

```javascript
import AdminSupporters from '../AdminSupporters';
```

In the `TOOLS` array, right after the `admins` entry (line ~28), add:

```javascript
  { id: 'supporters',    path: 'supporters',    label: 'Supporters',    component: AdminSupporters,      scope: 'platform', visible: platformAdmin },
```

- [ ] **Step 4: Verify the build compiles**

Run: `CI=true npm run build`
Expected: "Compiled successfully."

- [ ] **Step 5: Manual preview verification**

On the preview, as an owner go to `/admin/supporters`. Add a test Discord ID → it appears in the list. Navigate to a hunt where that user is an equity member → their row shows `♥ Supporter`. Remove them from the admin page → the badge disappears on reload.

- [ ] **Step 6: Commit**

```bash
cd /c/Users/kylew/communityhunts-frontend
git add src/admin/adminApi.js src/admin/AdminSupporters.js src/admin/registry/tools.js
git commit -m "feat(badges): admin Supporters management page"
```

---

## Rollout

1. **Backend first** (Tasks 1-3): merge `feat/role-flair-badges` → `main` (Railway auto-deploys). The `/api/badges` endpoint is additive; nothing changes visibly until the frontend consumes it. The `supporters` table is created on boot.
2. **Frontend** (Tasks 4-9): open a PR from `feat/role-flair-badges`, confirm on the Vercel preview URL, then merge → `main`.
3. Mark supporters via `/admin/supporters` as donations arrive.

---

## Self-Review Notes

- **Spec coverage:** supporters table + `lib/supporters.js` (T1); admin CRUD (T2); public tenant-aware `/api/badges` with owners/king/mods/supporters (T3); pure precedence + metadata (T4); `useBadges()` context + tokens + provider (T5); `UserBadge` bold-pill (T6); equity-list integration with role-overrides-HOST + streamer-only King via `hostId` (T7); account dropdown (T8); admin Supporters UI (T9). All spec sections mapped.
- **Type consistency:** `pickBadge` flag names (`isOwner/isKing/isStaff/isSupporter`) match between `roles.js`, its test, and `BadgeContext`. `badgeFor(discordId)` signature consistent across context and every call site. `getSupporterIds()` (sync) vs `listSupporters()` (async) used correctly — roster endpoint uses the sync cache, admin list uses the async enriched version. `BADGE_META` keys (`owner/king/staff/supporter`) match `pickBadge` return values and `UserBadge` lookup.
- **Colour correctness:** badges use fixed `badge*` tokens, never `G.gold` (which is the tenant accent). The HOST fallback keeps its original `G.gold`/`G.gdim` styling verbatim.
