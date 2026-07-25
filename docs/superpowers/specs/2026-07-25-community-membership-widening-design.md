# Community membership: role OR deliberate join

**Date:** 2026-07-25
**Repo:** `communityhunts-backend` (frontend needs no change; see §6)
**Follows:** the Partner-extension membership gate on `fix/full-extension-membership-gate`

## Problem

Three things are wrong, and they share one cause.

**1. The Settings "Join community" button does nothing that lasts.**
`POST /api/communities/:slug/join` (`routes/auth.routes.js:163`) writes a `community_members`
row, and the frontend exposes it as a real Join/Leave control
(`src/pages/settings/SettingsLayout.js:78`). But `reconcileMembership` runs on **every login** and
calls `leaveCommunity` for anyone who does not hold a qualifying Discord role. A user who
deliberately joins is silently evicted at their next sign-in.

**2. `memberCount` is a lie.** The admin community cards, the platform "Members" roll-up
(`routes/admin.routes.js:133/415`) and the public directory (`routes/integrations.routes.js:106`)
all count this table. Because membership is role-derived, they are affiliate counts wearing a
"Members" label.

**3. The Partner extension perk cannot be gated correctly.** The perk is sold as "Full Rainbet
extension free for ALL your members". The membership gate added on
`fix/full-extension-membership-gate` is correct as far as it goes, but it resolves to
"affiliate or role-holder", which is narrower than what was sold.

**The shared cause:** `community_members` conflates two different concepts —
*role-derived attribution* (auto-managed, must track the user's current Discord role) and
*deliberate membership* (user-chosen, must persist) — and the auto-manager destroys the
user-chosen one.

## Design

### 1. One column separates the two concepts

```sql
ALTER TABLE community_members ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'role';
```

Values: `'role'` | `'self'`. Added in `initMemberships`, matching the in-place migration pattern
already used in `lib/tenants.js:116` and `lib/apiKeys.js:43`.

The `DEFAULT 'role'` **is** the backfill: every existing row was written by
`reconcileMembership` (the one-time `bean_membership_wiped_v1` cleanup removed the last of the
retired blanket auto-enroll rows), so labelling them all `'role'` is accurate, not an assumption.

The primary key stays `(user_id, tenant_id)`. One row per user per community; `source` records how
it got there.

**`'self'` is sticky** — a deliberate join outranks role churn:

| Actor | Behaviour |
|---|---|
| `reconcileMembership` join | Writes `source='role'` with `ON CONFLICT DO NOTHING` — cannot downgrade an existing `self` row. |
| `reconcileMembership` evict | Deletes `WHERE source='role'` only — a self-join survives losing a role. |
| Settings Join button | Upserts `source='self'` (`ON CONFLICT … DO UPDATE SET source='self'`), so an affiliate who *also* opts in keeps membership after their role lapses. |
| Settings Leave button | Deletes unconditionally. An explicit Leave means leave, whatever the source. |

Fixing #1 above is entirely a consequence of the evict clause.

### 2. API changes in `lib/memberships.js`

```js
joinCommunity(userId, tenantId, source = 'self')   // 'role' → DO NOTHING; 'self' → DO UPDATE
leaveCommunity(userId, tenantId, { onlySource } = {})
getMembershipSource(userId, tenantId)              // 'role' | 'self' | null
```

`getUserCommunities` and `getMemberCounts` keep their exact current signatures and return shapes,
so every existing caller (`/api/my-communities`, the admin counts, the directory, the admin user
profile) is untouched by this change and simply starts seeing a wider population.

`getMembershipSource` is a single PK lookup. It is called on the extension hot path (§4), so it
must not grow into a join.

`tenantId` throughout is the tenant **slug** (`req.tenant.id`), matching every existing caller and
the `community_members.tenant_id` column — the one-time cleanup deleted `WHERE tenant_id = 'bean'`,
which pins the convention.

### 3. The perk reads VERIFIED membership, not membership

A self-join is unverified by construction. If it alone unlocked the paid extension, anyone could
click Join on a Partner community and take a $5/mo product for free — reopening the hole this work
closed, with one extra click.

So `computeFullExtension`'s flag is **renamed `isTenantMember` → `isVerifiedMember`**. The rename is
the point: a caller passing raw membership would be passing the wrong thing, and the name makes
that visible at every call site.

Verification rule, resolved inside `fullExtensionFor` (never by a caller):

```js
const src = await memberships.getMembershipSource(userId, tenantId); // 'role' | 'self' | null
const isVerifiedMember = src === 'role' || (src === 'self' && !!isGuildMember);
```

- `'role'` → verified by construction: reconcile only wrote it because Discord reported the role.
- `'self'` → verified only by actual presence in that tenant's Discord guild.
- `null` → not a member.

Net effect: a rando who clicks Join is a member for counting and `my-communities`, and gets nothing
free. Fails closed exactly like the subscription and membership lookups already do — any error
yields no `partner_plan`.

### 4. Guild membership needs a new bit

`rolesFromMemberRoles` (`server.js:67`) emits only the three role flags. There is no "is in the
guild" signal today, even though `refreshGuildRoles` already knows: a successful member fetch **is**
membership, and `{ detailed: true }` already returns `{ notGuildMember: true }` for a 404.

- `refreshGuildRoles` adds `isGuildMember: true` to the success result.
- `guildFlags` (`lib/auth.js:80`) carries `isGuildMember` into the session and the signed token,
  alongside `isDiscordVip`.

**Carrying it in the token is a performance requirement, not a convenience.**
`reqHasFullExtension` serves `/api/extension/entitlement` on every extension load and deliberately
short-circuits before any live Discord call. It reads the cached session flag exactly as it already
does for `req.user.isDiscordVip`, so this adds no per-load network hop.

`guildFlags` must keep its existing discipline: only present-and-determined flags are carried, never
a synthetic `false`. An undetermined guild lookup must leave `isGuildMember` absent, which reads as
unverified — the fail-closed direction.

**Inherited caveat, deliberately not fixed here:** cached guild flags describe the guild the user
*authenticated through*. `isDiscordVip` already behaves this way inside this same function, so
`isGuildMember` inherits the property rather than introducing it. Fixing it means per-tenant flag
caching, which is its own piece of work.

### 5. Call sites

Both existing callers of `fullExtensionFor` pass the new flag:

- `server.js` `reqHasFullExtension` → `isGuildMember: !!req.user.isGuildMember` (cached, no I/O).
- `routes/settings.routes.js` admin profile → `isGuildMember: !!guildRoles?.isGuildMember` (it
  already performs the live `{ detailed: true }` lookup, so it reads the same bit §4 adds rather
  than re-deriving it from `notGuildMember`).

### 6. Frontend

No change required. The Join/Leave button already exists and starts working once the evict clause
stops wiping it. `AdminControls`' `partner_plan` label already reads "member of Partner community"
from the companion frontend branch.

The member numbers on the admin community cards, the platform "Members" roll-up, and the directory
**will jump** once ordinary members can persist. That is the correction, not a regression — those
counters were reporting affiliates under a "Members" heading.

`PurchaseGate` routes on `my-communities` being non-empty, so more users route to Cosmetics rather
than the memberships page. Routing only: the enforced purchase gate is the backend
`isEligibleToPurchase` (affiliate/VIP role or an active individual plan), which this does not touch.

## Testing

Extend the existing `node:test` suites; no new framework.

**`lib/memberships.test.js`** (NEW — the module has no suite today; these cases are the reason to
add one) — source stickiness, the heart of the change:
- reconcile-join over an existing `self` row leaves it `self` (no downgrade)
- reconcile-evict removes a `role` row and spares a `self` row
- explicit Leave removes either
- Join upgrades an existing `role` row to `self`

**`lib/features.test.js`** — the verification matrix:
- `role` → `partner_plan`
- `self` + `isGuildMember` → `partner_plan`
- `self` without `isGuildMember` → **no access** (the loophole, pinned)
- no membership row → no access
- membership lookup throws → no access (fails closed)
- the non-Partner paths are unaffected by any of the above

**`lib/auth.test.js`** — `guildFlags` passes `isGuildMember` through when present and omits it when
absent (never a synthetic `false`).

## Verification

- `node --test lib/*.test.js` — full suite green (486 tests before this change).
- `node --test routes/settings.routes.test.js routes/cosmetics.routes.test.js
  routes/securityAuditP0.routes.test.js` — the suites that stub `memberships` / `fullExtensionFor`.
- `node --check server.js`.
- Post-deploy, confirm against the reported case: RADendub reads "No access", and a genuine
  role-holding member of the Partner tenant still reads "member of Partner community".

## Out of scope

- Per-tenant caching of guild flags (see the caveat in §4).
- Whether the "Admin comp" toggle should be locked for paying subscribers. The warning shipped on
  the companion frontend branch; changing the toggle's behaviour is a separate decision.
- Any change to what the Partner pricing card advertises.
