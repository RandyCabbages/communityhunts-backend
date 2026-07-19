# Anonymous Mode — Mask Identity Everywhere

**Date:** 2026-07-18
**Status:** Design approved, pending plan
**Repos:** backend (core), frontend (UI). Backend-first deploy.

## Problem

The Profile Settings toggle **"Show me as anonymous"** promises: *"Your name is
hidden and shown as 'Anonymous' to other viewers everywhere your equity appears.
Only the hunt runner, mods, and admins can still see who you are."*

In practice it does effectively nothing for anyone except the hunt host.

### Root cause

The redaction predicate keys **only** on `equity[].discordId`
(`lib/hunts-core.js` `maskEquityMember`):

```js
if (!discordId || !isAnonymousUser(discordId)) return e; // no discordId ⇒ never masked
```

But the only equity row that ever carries a `discordId` is the **auto-seeded host
row** (`routes/hunts.routes.js`, from `tenant.hostDiscordId`). No other member row
gets one:

- The frontend never sends `discordId` on equity rows.
- `addCallToHunt` (`routes/calls.routes.js`) stores the caller as
  `user.displayName` — a plain string, no ID.
- The request-calls grant flow writes only to `callsPermissions`, not the equity row.
- The old display-name → discordId auto-link was **removed** in the 2026-07-18
  security audit (renaming to a member's name let anyone claim their payout row).

Meanwhile every other surface attributes people by **display-name string**, never by
ID: slot calls (`calls[].user`), the caller column (`bonuses[].caller`), the got-in
log, Hall of Fame, and the public API (`topHunters` / `biggestHits`).

**Net effect:** the mask can only ever fire for the host. Every other opted-in user
shows their real name to the public, everywhere.

## Goals

1. Anonymous applies **everywhere a person's name appears** to a non-privileged
   public viewer: equity (live + archived), slot calls, caller column, Hall of Fame,
   public API, and the public got-in log.
2. **Privileged viewers** (hunt runner, mods, admins) and the **person themselves**
   always see the real name, with a 🔒 badge marking who is anonymous — so admins can
   see at a glance that the setting is in use.
3. The anonymous user gets a clear **self-indication** that they are hidden from the
   public.
4. Do not reintroduce the name-based **privilege/attribution** vuln the security audit
   closed. Name matching is used for **display redaction only** — never to grant
   permissions or attribute payouts.

## Non-goals

- Reworking the hunt data model to be ID-first. Attribution stays name-string based;
  we add an authoritative ID link as an opt-in overlay, not a rewrite.
- Masking privileged/admin-only surfaces. The admin xlsx got-in export keeps real
  names (it is a privileged surface).

## Approach: Hybrid (ID link + name-match fallback)

Chosen over ID-link-only (leaves hand-added rows visible) and name-match-only (a name
change de-anonymizes; same-name collisions). Hybrid gives immediate coverage via name
matching and a rename-proof authoritative path via explicit ID linking.

### 1. The masking predicate (`lib/settings.js`)

Maintain, alongside the existing `anonymousUsers` (Set of Discord IDs), a parallel
`anonymousNames` (Set of **normalized current display names** of those users, resolved
from `known_users` via `getKnownUser`). Both are:

- Rebuilt together in `loadAnonymousUsers()` on startup.
- Kept in sync on every `saveSettings` / `deleteSettings` (add/remove the user's ID
  **and** their current known display name).

Name normalization reuses `nameOf`-style lowercasing/trim so it matches how calls store
names.

Expose:

```js
isAnonymousUser(discordId)          // exists
isAnonymousName(name)               // new — normalized lookup in anonymousNames
shouldMaskIdentity({ discordId, name }) // new — id OR name; DISPLAY REDACTION ONLY
```

`shouldMaskIdentity` is injected into `hunts-core` the same way `isAnonymousUser` is
today. It is never called from any permission/attribution path.

### 2. Redaction at every serializer

Apply the predicate wherever a **non-privileged public viewer** receives a name.
Uniform rule: **privileged viewer OR self → real name + `anonymous: true` flag;
everyone else → `name: 'Anonymous'`, `avatar: null`.**

| Surface | Location | Field(s) |
| --- | --- | --- |
| Equity (live) | `maskEquityMember` / `publicHuntView` | `name`, `avatar` |
| Equity (archived summary) | `huntSummary` equity map | `name` |
| Slot calls | `publicHuntView` | `calls[].user` |
| Caller column | `publicHuntView` | `bonuses[].caller` |
| Got-in log (public consumers) | `getGotInLog` | `caller` |
| Hall of Fame | `lib/hallOfFame.js` | hunter/name |
| Public API | `lib/publicSerializers.js` | `topHunters`, `biggestHits` names |

`maskEquityMember` extends from `discordId`-only to `shouldMaskIdentity({ discordId, name })`.

**Per-socket broadcast:** `huntHasAnon(h)` broadens from "any equity row with an
anonymous discordId" to "any maskable identity in the hunt" — equity rows (by id or
name) **or** any `calls[].user` / `bonuses[].caller` whose name is anonymous. When true,
`emitHuntUpdate` already serializes per-socket so privileged sockets keep real names
while the public room gets `Anonymous`; the fully-masked fallback on error stays.

**Got-in export vs public log:** the admin xlsx export is privileged → real names. Only
non-privileged consumers of `getGotInLog` are masked.

### 3. Authoritative ID link (rename-proof half)

Name-match covers the common case immediately but breaks if a user changes their Discord
display name after being added under the old one. So add an **owner/admin action to bind
a Discord user to an equity row**, writing `discordId` to that row.

- This is the **only** safe auto-stamp path. We do **not** stamp `discordId` by
  name-match (that is exactly the audit vuln). Stamping happens only via this explicit,
  owner-authorized action.
- Once linked, the row masks by ID regardless of later name changes, and payout
  attribution is rename-proof.
- **Warning badge** on unlinked equity rows (runner/admin view only): signals the row is
  not ID-bound and relies on name-match, so a name change could de-anonymize it.

Endpoint shape (illustrative): `POST /api/hunts/:userId/equity/:memberId/link`
`{ discordId }`, guarded by `canEditHunt` (owner/editor/admin). Resolves the target via
`known_users` (no fabricated identities). Writes `discordId` onto the matching equity row
and audit-logs the change.

### 4. Admin / privileged indicator

The existing 🔒 `anonTag` (frontend `EquityCard.js` / `EquityRow.js`) is extended to
appear next to the **real** name on every surface a privileged viewer sees — equity,
slot calls, caller column, and the admin got-in view — with tooltip *"Anonymous to the
public — only the runner, mods, and admins can see this name."* This is an always-on,
inline signal; no separate admin screen to check. (A dedicated admin roster/count is
possible later but is out of scope here.)

The `anonymous: true` flag surfaced by the backend for privileged/self views is what
drives the badge; it is already emitted for equity and will also be emitted alongside
masked call/caller entries so the frontend can badge them.

### 5. Self-indication

For the logged-in user who is anonymous and appears in the current hunt:

- 🔒 **"You're anonymous to the public"** badge on their own equity row (the existing
  `anonTag` handles the self case — self already receives the `anonymous: true` flag with
  their real name).
- A **dismissable-per-session banner** in the hunt view (e.g. *"You're appearing as
  Anonymous to the public in this hunt. Runners, mods and admins can still see you."*),
  keyed off the same self + anonymous condition, dismissal stored in `sessionStorage`.

### 6. Testing

Backend unit tests (`node --test lib/*.test.js`):

- `shouldMaskIdentity`: ID hit, name hit, name miss, same-name collision (over-hides —
  documented as acceptable), redaction-only (never grants).
- `maskEquityMember`: masks by name when no discordId; privileged + self bypass; avatar
  dropped for public.
- `publicHuntView`: masks `calls[].user` and `bonuses[].caller`; `huntHasAnon` detects a
  caller-only anonymous hunt.
- `getGotInLog`, Hall of Fame, `publicSerializers`: public output masked, privileged
  output real.
- Regression: an anonymous name string cannot be used to gain call/edit permission
  (extend `securityAuditP0.routes.test.js` coverage).

Frontend: pure-logic checks where they exist; the badge/banner are visual (verified in
preview).

## Rollout

1. Backend: predicate + `anonymousNames` set + serializer masking + link endpoint +
   tests. Deploy first (masking is server-authoritative — the frontend cannot leak what
   it never receives).
2. Frontend: 🔒 badge on all surfaces, self-badge, hunt banner, link UI + warning badge
   on unlinked rows.

Both are additive; no data migration. Existing hunts gain masking immediately via
name-match on deploy of step 1.

## Open considerations

- **Same-name collision:** two users sharing a display name where one is anonymous will
  hide both. Acceptable for a privacy feature (fails toward hiding). The authoritative ID
  link (§3) is the escape hatch for anyone affected.
- **Name-change drift:** covered by §3 for linked rows; unlinked rows carry the warning
  badge so the runner knows the risk.
