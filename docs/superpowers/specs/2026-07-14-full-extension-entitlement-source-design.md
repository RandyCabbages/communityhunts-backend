# Full Extension entitlement source — design

**Date:** 2026-07-14
**Status:** approved, not implemented
**Repos:** `communityhunts-backend` (core + route), `communityhunts-frontend` (admin panel)
**Merge order:** backend first, frontend after.

## Problem

The admin user profile shows a **"Full Extension"** on/off toggle. It reads as "this user's
access", but it only writes the `full_extension` row in `feature_grants` — one of **six** OR'd
paths in `reqHasFullExtension` (`server.js`):

```js
async function reqHasFullExtension(req) {
  if (!req.user) return false;
  const isTenantVip = reqIsVipHost(req) || reqIsMod(req) || !!req.user.isDiscordVip;
  return isTenantVip || await features.hasFullExtension(req.user.id, req.tenant?.plan);
}
```

The six paths: VIP host, community mod, Discord-guild VIP, Partner community plan, Ultimate
individual sub, and the grant row.

Consequences today:

- For a VIP, the toggle reads **OFF** while the user **has** full access.
- Flipping it OFF for a VIP **revokes nothing**.
- An admin cannot tell *why* a user has access, or what revoking a role would actually do.

This is what prompted "why can VIPs download the extension?" — they can, by design (2026-07-09
VIP extension gating), but the panel gives no way to see that.

## Non-goals

- Changing **who** gets the Full extension. Entitlement rules are unchanged; this is about
  *reporting* them and making the control honest.
- The `shop` grant. Removed separately (backend #53 / frontend #194).
- Per-tenant scoping of the admin profile route (still P4, see the route's existing comment).

## Decisions

| Decision | Choice | Why |
| --- | --- | --- |
| Control model | Read-only status line + separate **Admin comp** toggle | The grant can add access, never remove it. One control cannot honestly represent both. |
| Comp toggle editable when redundant? | **Yes, always** | Lets an admin pre-grant a comp before someone loses VIP. |
| Guild-VIP lookup | Live `refreshGuildRoles` per profile load | Five paths are cache/DB reads; only this one needs Discord. Accuracy beats ~100–300ms on an admin page. |
| Lookup failure | Report **undetermined**, never `false` | Matches the existing rule in `fetchGuildRoles`: "callers must leave the flags absent, never coerce to false". |
| Overlapping paths | List **every** contributing source | Answers "if I revoke their VIP, do they still have it?" — a single source cannot. |
| Logic location | One shared pure core; callers inject the guild flag | Avoids a Discord call on the extension's hot path while keeping ONE OR-list. |

## Architecture

### Core — `lib/features.js`

One pure function owns the OR-list and returns *why*. It fetches nothing; every caller supplies
inputs.

```js
const FULL_EXT_SOURCES = ['vip_host', 'community_mod', 'discord_vip',
                          'partner_plan', 'ultimate_sub', 'admin_comp'];

function computeFullExtension({ isVipHost, isCommunityMod, isDiscordVip,
                                tenantPlan, subTier, hasComp }) {
  const sources = [];
  if (isVipHost)      sources.push('vip_host');
  if (isCommunityMod) sources.push('community_mod');
  if (isDiscordVip)   sources.push('discord_vip');
  if (canUse('full_extension', 'free', tenantPlan)) sources.push('partner_plan');
  if (canUse('full_extension', subTier, 'free'))    sources.push('ultimate_sub');
  if (hasComp)        sources.push('admin_comp');
  return { access: sources.length > 0, sources };
}
```

Passing the neutral `'free'` into the *other* ladder isolates which ladder fired — `canUse`
alone cannot report that.

**Why pure:** it is the single definition of "who has the Full extension", it is trivially
table-testable, and it cannot drift from the real gate because the real gate calls it.

### Fetch layer — `lib/features.js`

`features.js` already owns `subscriptions` + `featureGrants` via `initFeatures`. It keeps that
job: one async helper fetches the two user-scoped inputs and calls the pure core. Callers supply
**only the role flags**, which is the sole thing that genuinely differs between them.

```js
// Role flags come from the caller (session vs live lookup); sub tier + comp are fetched here.
async function fullExtensionFor(userId, { tenantPlan, isVipHost, isCommunityMod, isDiscordVip }) {
  let subTier = 'free';
  if (userId && subscriptions) {
    try { subTier = (await subscriptions.getSubscription(userId))?.tier || 'free'; } catch {}
  }
  return computeFullExtension({
    isVipHost, isCommunityMod, isDiscordVip, tenantPlan, subTier,
    hasComp: !!(featureGrants && featureGrants.hasGrant(userId, 'full_extension')),
  });
}
```

Fails closed to `'free'` on a subscription lookup error, matching `userCanUse`'s existing
behavior.

### `hasFullExtension` is replaced, not kept

`hasFullExtension(userId, tenantPlan)` has **exactly one caller** — `reqHasFullExtension`
(`server.js:318`). Once that delegates, it is dead. Delete it and drop it from the exports:
leaving it would recreate the orphaned-function problem this work exists to clean up (cf. the
`canAccessShop` removal, backend #53 / frontend #194).

`initFeatures` keeps **both** deps: `subscriptions` (still used by `userCanUse`, `requireTier`,
and `fullExtensionFor`) and `featureGrants` (now used by `fullExtensionFor`). The `server.js:269`
call site is unchanged.

### Wiring — `server.js`

`reqHasFullExtension` keeps its signature and behavior, passing the **session** guild flag (free):

```js
async function reqHasFullExtension(req) {
  if (!req.user) return false;
  return (await features.fullExtensionFor(req.user.id, {
    tenantPlan:     req.tenant?.plan,
    isVipHost:      reqIsVipHost(req),
    isCommunityMod: reqIsMod(req),
    isDiscordVip:   !!req.user.isDiscordVip,
  })).access;
}
```

**Hot path preserved:** `/api/extension/entitlement` is called by the extension on every load.
It must NOT gain a Discord API call. That is the whole reason role flags are injected by the
caller instead of fetched in the core.

### Admin route — `routes/settings.routes.js`

`GET /api/admin/users/:userId` builds the same input bag for the **target** user (not `req.user`)
and adds one field to its existing response. No new endpoint.

```js
const guildRoles = await refreshGuildRoles(userId, tenant);   // null = undetermined OR no guild
const target = { id: userId };
const fullExtension = await features.fullExtensionFor(userId, {
  tenantPlan:     tenant?.plan,
  isVipHost:      tenants.isTenantVip(target, tenant),
  isCommunityMod: tenants.isTenantMod(target, tenant),
  isDiscordVip:   !!guildRoles?.isDiscordVip,
});
const guildConfigured = !!(tenant?.discordGuildId && tenant?.discordBotToken);
res.json({
  /* ...existing fields... */
  fullExtension: { ...fullExtension, discordVipUndetermined: guildConfigured && !guildRoles },
});
```

Response addition:

```json
"fullExtension": {
  "access": true,
  "sources": ["discord_vip", "ultimate_sub"],
  "discordVipUndetermined": false
}
```

`featureGrants` stays as-is — the comp toggle still reads it.

**`isTenantVip`/`isTenantMod` need only `user.id`**, so `{ id: userId }` is a valid target.
**`refreshGuildRoles` uses the bot token**, not a user OAuth token, so it works for any target ID.

#### Undetermined is narrower than `null`

`refreshGuildRoles` returns `null` in two different situations:

1. **No guild configured** (`!tenant.discordGuildId` or no bot token) → the guild path does not
   apply. NOT undetermined.
2. **Configured but the lookup failed** (non-OK response, network error) → genuinely unknown.

Only case 2 sets `discordVipUndetermined: true`. Conflating them would show a permanent spurious
"couldn't verify" warning on every tenant that has no Discord guild.

#### Admins resolve as `vip_host`

`isTenantVip` folds in `isTenantAdmin`, which folds in platform owner. Rather than invent
precision the real gate does not have, `vip_host` is labeled **"VIP host or admin"**. This keeps
the reported sources identical to what `reqHasFullExtension` actually evaluates.

## Frontend — `src/admin/userProfile/AdminControls.js`

Takes a new `fullExtension` prop. It arrives free in the existing `fetchUser` response, so
`adminApi.js` is unchanged. The single toggle is replaced by a read-only status line + a comp
toggle:

```text
Feature Access

 Full Extension    ✅ Has access
                   via Discord VIP role, Ultimate plan

 Admin comp                      OFF  [ o]
 └ Covered by VIP role, Ultimate plan —
   a comp would change nothing.
```

### States

| Condition | Status line |
| --- | --- |
| `access` | ✅ Has access — `via <source labels>` |
| `!access && !discordVipUndetermined` | — No access |
| `!access && discordVipUndetermined` | ⚠ Couldn't verify — "Discord role lookup failed; other paths say no access." |

The comp toggle's redundancy note keys off `sources.filter(s => s !== 'admin_comp')`:
non-empty → show the note; empty → no note, because there the comp genuinely decides access.

### Label map — sync constraint

```js
const SOURCE_LABELS = {
  vip_host: 'VIP host or admin',   community_mod: 'Community mod',
  discord_vip: 'Discord VIP role', partner_plan: 'Partner community plan',
  ultimate_sub: 'Ultimate plan',   admin_comp: 'admin comp',
};
```

Keys MUST match `FULL_EXT_SOURCES` in the backend core. Same class of constraint as
`catalog.js` ↔ `ITEM_TIERS`. Comment it on both sides.

### File discipline

`AdminControls.js` lands at ~110 lines, well under the ~400–500 extract threshold in the
frontend CLAUDE.md. The status line stays alongside the existing `FeatureToggle` rather than
becoming its own file.

### Staleness after toggling

Toggling the comp updates `featureGrants` from the POST response, but `fullExtension.sources`
and `access` would go stale — the status line would contradict the toggle immediately after a
flip.

**Fix:** re-fetch the profile after a grant toggle, reusing the `reload()` helper already in
`UserProfile.js` (the pattern `onCorrectHunt` / `onDeleteHunt` use). Costs one fetch on a rare
admin action and duplicates zero logic. Recomputing `access` client-side was rejected: it
re-introduces exactly the drift this design exists to prevent.

## Testing

**Backend — new `lib/features.test.js`.** `computeFullExtension` is pure, so it is table-driven:

- each source alone → `access: true`, exactly that source
- several at once → all listed, in `FULL_EXT_SOURCES` order
- none → `access: false`, `sources: []`
- comp only → `access: true`, `sources: ['admin_comp']` (the case where the toggle decides)
- `partner_plan` vs `ultimate_sub` isolation — a Partner tenant with a free sub reports only
  `partner_plan`, and vice versa

Plus a small set for `fullExtensionFor`, using stub deps via `initFeatures` (the pattern
`featureGrants.test.js` already uses for `pgPool`):

- no `subscriptions` dep → falls back to `'free'`, does not throw
- `getSubscription` rejects → falls back to `'free'` (fails closed), does not throw
- comp grant present → `admin_comp` appears in `sources`

This is the first test coverage for this entitlement logic and is what would have caught the
original bug.

Run: `node --test lib/features.test.js`. Capture to a file rather than piping — piped exit codes
have masked failures in this repo before.

**Frontend.** No test suite. `CI=true npm run build` must print "Compiled successfully", then
verify on a Vercel branch preview: open a VIP user's profile, confirm the line reads "✅ Has
access — via Discord VIP role" with the comp toggle OFF and the redundancy note shown.

## Risk

Entitlement behavior is unchanged — `reqHasFullExtension` returns exactly what it returned
before, now via the core. The reportable regression to watch is a Discord call leaking onto
`/api/extension/entitlement`; the injected-flag design is what prevents it, and the hot path
must keep passing `req.user.isDiscordVip`.
