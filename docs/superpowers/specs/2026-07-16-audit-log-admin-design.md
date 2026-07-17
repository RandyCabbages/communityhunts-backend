# Audit Log + Admin Review — Design

**Date:** 2026-07-16
**Repos:** backend (`communityhunts-backend`, primary + first-to-deploy) · frontend (`communityhunts-frontend`, one admin page)
**Status:** approved, ready for planning

## Problem

When something goes wrong with a hunt — a bonus disappears, a hunt gets reset, someone
with access deletes a bonus and doesn't remember — there is currently **no record** of who
did what, when. Troubleshooting is guesswork. We want an owner-facing audit log that
captures the important state-changing actions across the site and an admin section to
review them.

## Scope (decided)

**Log these categories:**

1. **Hunt / bonus changes** — bonus deletions, hunt reset / delete / clear. Detected by
   diffing the hunt on `PUT`.
2. **Admin / mod actions** — force-end hunt, delete any hunt, cosmetics grant/revoke, card
   release, editor invite/remove, ticket triage.
3. **Auth events** — login, logout.

**Explicitly out of scope (noise):** slot-call queue churn, equity value edits, and — for
hunt edits — win-amount / bet tweaks and reorders. See the noise filter below.

**Who can view:** platform owners only (Kyle + Goofer, `requirePlatformAdmin` /
`PLATFORM_OWNER_IDS`), across **all tenants** in one global log. Every row is still stamped
with `tenant_id` so a per-tenant streamer view is a future frontend-only addition — no
re-instrumentation.

**Detail level:** each destructive event stores a human `summary` **plus** a trimmed
before-snapshot (`{ bonuses, equity, calls }`), so an owner can *see* exactly what was lost
and restore it manually. No one-click restore (it would race in-flight edits — deferred).

## Why a new Postgres table, not the `hunts_kv` blob

The existing stores (`tickets`, `cardRequests`) keep their whole array in a single
`hunts_kv` JSONB row, rewritten on every save. That is O(n) per write and wrong for an
append-only, high-volume, queryable log — it would rewrite the entire log on every action
and grow unbounded in one cell. Audit gets a **real table with indexed rows**.

## Architecture

### Storage — `lib/auditLog.js` owns an `audit_log` table

```sql
CREATE TABLE IF NOT EXISTS audit_log (
  id          BIGSERIAL PRIMARY KEY,
  ts          TIMESTAMPTZ NOT NULL DEFAULT now(),
  tenant_id   TEXT,
  category    TEXT NOT NULL,   -- 'hunt' | 'admin' | 'auth'
  action      TEXT NOT NULL,   -- see action vocabulary below
  actor_id    TEXT,            -- Discord id — WHO (never name-gated)
  actor_name  TEXT,            -- display name at the time (denormalized, readable)
  target_id   TEXT,            -- whose hunt/resource was affected (a user id)
  summary     TEXT NOT NULL,   -- human line for the table
  detail      JSONB,           -- { before?, removed?, counts?, meta? }
  ip          TEXT
);
CREATE INDEX IF NOT EXISTS audit_ts     ON audit_log (ts DESC);
CREATE INDEX IF NOT EXISTS audit_cat    ON audit_log (category, ts DESC);
CREATE INDEX IF NOT EXISTS audit_actor  ON audit_log (actor_id, ts DESC);
CREATE INDEX IF NOT EXISTS audit_target ON audit_log (target_id, ts DESC);
```

**Action vocabulary:** `bonus.delete`, `hunt.clear`, `hunt.reset`, `hunt.delete`,
`admin.force_end`, `admin.delete_hunt`, `cosmetic.grant`, `cosmetic.revoke`,
`card.release`, `editor.invite`, `editor.remove`, `ticket.triage`, `auth.login`,
`auth.logout`.

**Module contract** (`lib/auditLog.js`, DI'd via `initAuditLog({ pgPool })` like the other
lib stores):

- `record({ category, action, actorId, actorName, targetId, tenantId, summary, detail, ip })`
  — fire-and-forget insert. **Never throws to the caller** (`.catch` logs to console). Audit
  must never break or slow a user action.
- `recordHuntChange(req, before, after)` — the diff helper for `PUT` handlers. Computes the
  bonus delta, applies the noise filter, and calls `record()` only when something loggable
  happened. Returns nothing.
- `query({ category, actorId, targetId, q, from, to, cursor, limit })` — keyset pagination
  on `(ts, id)` descending. **Does not filter by tenant** (owner-global). `q` matches
  `summary ILIKE`.
- `prune()` — deletes rows older than `AUDIT_RETENTION_DAYS` (default 90) beyond a
  `AUDIT_MAX_ROWS` cap (default 50 000), whichever binds first. Called on an interval,
  reusing the existing stale-hunt janitor cadence.

**No file-array fallback.** Prod always has `pgPool`. Local dev with no Postgres → an
in-memory ring buffer (last ~500 entries), ephemeral by design — never written to disk.
Rationale: a JSON-file fallback would reintroduce the O(n)-rewrite problem we are avoiding,
and local audit history has no value.

### Diff logic (pure, unit-tested)

`diffBonuses(before, after)` in `lib/auditLog.js`:

- Match bonuses by identity: `id` if present, else `slot + index`.
- `removed` = bonuses in `before` not in `after`.
- Emit **only** when `removed.length > 0` or the array went non-empty → empty. This *is*
  the noise filter — value edits (win/bet), additions, and pure reorders produce no row.
- Classify: array emptied → `hunt.clear`; otherwise → `bonus.delete` with the `removed`
  list.

`summarize(action, ctx)` builds the human line, e.g.
`"removed 3 bonuses (Gates of Olympus, Sugar Rush, +1) from <name>'s hunt"`.

Both functions are pure (no DB, no `req`) so they unit-test cleanly under
`node --test lib/*.test.js`.

### Instrumentation points (backend)

| File / handler | Event |
|---|---|
| `routes/hunts.routes.js` `PUT /api/my-hunt` | snapshot `bonuses/equity/calls` at entry → `recordHuntChange(req, before, after)` before responding |
| `routes/hunts.routes.js` `PUT /api/hunts/:userId` (editor edit) | same diff hook |
| `routes/hunts.routes.js` `POST /api/my-hunt/reset` | `hunt.reset` + before-snapshot |
| `routes/hunts.routes.js` `DELETE /api/my-hunt` | `hunt.delete` + before-snapshot |
| `routes/admin.routes.js` `POST /api/admin/hunts/:userId/end` | `admin.force_end` |
| `routes/admin.routes.js` `DELETE /api/admin/hunts/:userId` | `admin.delete_hunt` + before-snapshot |
| `routes/hunts.routes.js` invite/remove editor | `editor.invite` / `editor.remove` |
| cosmetics grant/revoke (`routes/admin.routes.js` users/:id/cosmetics) | `cosmetic.grant` / `cosmetic.revoke` |
| `lib/cardReleases.js` release path | `card.release` |
| `routes/adminTickets.routes.js` status change | `ticket.triage` |
| auth: Passport OAuth callback success + `/auth/logout` | `auth.login` / `auth.logout` |

`actor_*` comes from `req.user`; `ip` from `req.ip`; `tenant_id` from `req.tenant?.id`.
For diff hooks, the before-snapshot is a shallow clone of the arrays taken **before** the
handler mutates `hunts[...]`.

### Read API (backend)

```
GET /api/admin/audit
    ?category=hunt|admin|auth
    &actor=<discordId>
    &target=<discordId>
    &q=<text>            -- summary ILIKE
    &from=<iso>&to=<iso>
    &cursor=<ts,id>      -- keyset page cursor
    &limit=<n, default 50, max 200>
```

Gated `requireAuth, requirePlatformAdmin` (owners only — NOT `requireAdmin`, which would
let tenant admins read every community's log). Returns `{ rows: [...], nextCursor }`. New
`routes/audit.routes.js`, DI-wired in `server.js` alongside the others.

### Admin UI (frontend)

- **Registry entry** — one row in `src/admin/registry/tools.js`:
  `{ id: 'audit', path: 'audit', label: 'Audit Log', component: AdminAuditLog, scope: 'both', visible: platformAdmin }`.
  Routes + sidebar generate automatically (Phase-4 registry console).
- **`src/admin/AdminAuditLog.js`** — presentational page: filter bar (category chips,
  actor/target search, date range, free-text) + a table (Time · Category · Actor · Action ·
  Target · Summary). Each row expands to pretty-print `detail` (the before-snapshot) for the
  recovery case. "Load more" uses `nextCursor`.
- **`src/admin/adminApi.js`** — add `fetchAuditLog(params)` via `apiFetch('/api/admin/audit?…')`.
- **Pure formatter** in a small `src/admin/auditFormat.js` (row summary / relative time /
  category label) so it can be unit-tested per the repo's pure-logic testing rule; the
  component stays presentational and untested.

## Errors & edge cases

- Audit write failure is swallowed + `console.error`'d — never surfaces to the user, never
  blocks the request or the response.
- Login burst after a deploy (everyone re-auths) produces many `auth.login` rows; acceptable
  under 90-day retention. Noted, not mitigated.
- `target_id` is a user id for both hunt targets and cosmetics-grant targets; the `summary`
  disambiguates. Schema stays uniform.
- Missing `pgPool` (local dev) → ring buffer; `query()` reads from it so the admin page still
  works locally, just without history across restarts.

## Testing

- **Backend unit** (`lib/auditLog.test.js`, `node --test lib/*.test.js`): `diffBonuses`
  detects a deletion, ignores a value edit, ignores a pure reorder, classifies clear;
  `summarize` renders the expected line. Pure functions only — no route/`app.listen` suite
  (those hang per the repo's node-test gotcha).
- **Frontend unit** (`src/admin/auditFormat.test.js`): summary/label formatters, per the
  pure-logic-only rule (no component test).
- **Manual**: trigger a bonus delete, confirm one row with the before-snapshot; confirm a
  win-amount edit produces **no** row; confirm a tenant admin gets 403 on `/api/admin/audit`.

## Deploy order

Backend first (table + endpoint + instrumentation must exist before the frontend calls it),
then frontend. Standard for this codebase.

## Out of scope / deferred

- One-click restore (race risk).
- Per-tenant streamer-facing view (rows already carry `tenant_id`; future frontend work).
- Logging slot-call and equity-value churn.
