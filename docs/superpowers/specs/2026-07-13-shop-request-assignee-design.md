# Shop Request Assignee — Design

**Date:** 2026-07-13
**Repos:** communityhunts-backend (first), communityhunts-frontend

## Problem

Custom card commissions ("Shop Requests") are worked by the two platform owners
(Cabbage and Goofer). Nothing records *whose plate* a request is on, so open
requests fall through the cracks. Add an "Assigned to" control so either owner
can claim a request and both see the current owner at a glance.

## Approach

An `assignee` field on each request, **orthogonal to `status`** — not a new
pipeline stage. A status like "assigned to Cabbage" would collide with the real
stage (new / awaiting_tip / in_progress); assignment and stage must be
independent. So: a second dropdown next to the existing status dropdown.

Assignee is stored as a **platform-owner Discord ID** (or `null` = unassigned),
consistent with the repo's gate-on-ID-never-display-name doctrine. Storing the
ID also lets the panel later highlight "assigned to me" (`assignee === user.id`).

```
Cabbage → 135203806676779008   (Kyle / PLATFORM_OWNER_IDS)
Goofer  → 168055630916091904   (Goofer / ADMIN_IDS)
```

The id↔label map is defined once per repo: `lib/cardRequests.js` (backend),
`src/auth/roles.js` (frontend — guardrail: never inline a Discord ID in a
component). If a third owner is ever added, it's a one-line map entry.

The `assignee` field is a **label, not an auth gate** — it grants and blocks
nothing. Access to assign is the existing `requirePlatformAdmin` gate, which both
owners already pass.

## Changes

### Backend — communityhunts-backend

- `lib/cardRequests.js`
  - Add `ASSIGNEES = [{ id, label }, …]` + an id `Set`; export `ASSIGNEES`.
  - `createRequest`: seed `assignee: null`.
  - `validateUpdate`: accept `assignee` when it is `null` or a known id; else
    return `'Invalid assignee'`.
  - `updateRequest`: `if (patch.assignee !== undefined) r.assignee = patch.assignee`.
- `routes/cardRequests.routes.js`
  - `buildRequestEmbed`: when `r.assignee` is set, push an inline **"Assigned to"**
    field (label from `ASSIGNEES`). Rides the existing PUT→embed-PATCH, so
    reassigning updates the Discord message live.
- `lib/cardRequests.test.js`
  - `validateUpdate` accepts `null` + a valid id, rejects an unknown id.
  - `updateRequest` sets `assignee` and can clear it back to `null`.

### Frontend — communityhunts-frontend

- `src/auth/roles.js`: export `SHOP_ASSIGNEES = [{ id, label }]` (Cabbage, Goofer).
- `src/admin/AdminShopRequests.js`: second `<select>` in each card header —
  **Unassigned / Cabbage / Goofer**; `onChange → updateCardRequest(id, { assignee })`.
  `adminApi.updateCardRequest` already forwards an arbitrary patch — no change.

## Non-goals / notes

- **No migration:** requests predating this read `assignee === undefined` →
  treated as unassigned; the select shows "Unassigned".
- **No PUT-contract break:** `assignee` is additive and optional.
- **Deploy order:** backend first — the PUT must accept `assignee` before the
  frontend starts sending it.
- No self-assign restriction; either owner may assign to either owner.
