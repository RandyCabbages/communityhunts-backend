// Authentication + authorization: identity helpers, HMAC-signed token fallback,
// ID-based admin/VIP gating, hunt-permission checks, tenant resolution, and the
// Express gate middlewares. Extracted from server.js (de-slop refactor, 2026-06-20).
// BEHAVIOR UNCHANGED — this is a pure move. Gating stays ID-based, never display name.
//
// DI: initAuth(deps) injects config + collaborators that used to be in server.js scope.
// The gate functions only run at request time, so initAuth may be called after the
// middlewares are registered (it just needs to run before the first request).
//
//   deps = {
//     ADMIN_IDS, VIP_IDS,        // env-derived id lists (string[])
//     SESSION_SECRET,            // HMAC key for token sign/verify
//     MULTI_TENANT,              // boolean flag
//     tenants, admins,           // lib modules (PLATFORM_OWNER_ID, isDbAdmin, isTenant*, BEAN_TENANT, getTenantBySlug)
//     hunts,                     // persistence-owned singleton (by reference, read only here)
//     recordKnownUser,           // settings helper (called by the Bearer fallback)
//   }

const crypto = require('crypto');

let ADMIN_IDS = [];
let VIP_IDS = [];
let SESSION_SECRET = '';
let MULTI_TENANT = false;
let tenants = null;
let admins = null;
let hunts = null;
let recordKnownUser = () => {};

function initAuth(deps) {
  ADMIN_IDS       = deps.ADMIN_IDS || [];
  VIP_IDS         = deps.VIP_IDS || [];
  SESSION_SECRET  = deps.SESSION_SECRET || '';
  MULTI_TENANT    = !!deps.MULTI_TENANT;
  tenants         = deps.tenants;
  admins          = deps.admins;
  hunts           = deps.hunts;
  recordKnownUser = deps.recordKnownUser || (() => {});
}

function nameOf(user) { return (user?.displayName || user?.username || '').toLowerCase().trim(); }

function isAdmin(user) {
  // ID-based only — display names are spoofable. Admins live in ADMIN_IDS (env),
  // the platform_admins DB table, or are a hardcoded platform owner (tenants.PLATFORM_OWNER_IDS —
  // checks the full owner list, not just the single PLATFORM_OWNER_ID scalar, so every
  // hardcoded co-owner counts, not only the first one).
  if (!user || !user.id) return false;
  return ADMIN_IDS.includes(user.id)
      || tenants.isPlatformOwnerId(user.id)
      || admins.isDbAdmin(user.id);
}
// Platform admin = admin on ALL tenants (owner + env + DB). Distinct from a
// per-tenant community admin (tenant_roles). Used by admin-management endpoints.
function isPlatformAdmin(user) { return isAdmin(user); }
function isVipHost(user) {
  // ID-based only (see isAdmin). VIP hosts — and admins, who are also listed — in VIP_IDS.
  return !!(user && user.id && VIP_IDS.includes(user.id));
}

// ── HMAC-signed auth tokens ────────────────────────────────────────
// Fallback when third-party cookies are blocked (Safari, Brave, etc).
// Token format: base64url(payload) + "." + base64url(hmacSha256(payload))
// Payload: JSON {id, username, displayName, avatar, exp}
function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
}
function b64urlDecode(s) {
  s = s.replace(/-/g,'+').replace(/_/g,'/');
  while (s.length % 4) s += '=';
  return Buffer.from(s, 'base64').toString('utf8');
}
// Copies ONLY the guild-role flags that are actually present on `src`, preserving the
// crucial distinction between "role determined false" and "role undetermined" (absent).
// The backend leaves a flag ABSENT when Discord role detection isn't configured or the
// lookup failed (see fetchGuildRoles/refreshGuildRoles in server.js) — coercing those to
// `false` here (the old `!!user.isAffiliate`) is what let a missing DISCORD_GUILD_ID /
// role-ID env var mass-lock-out a role-gated tenant: the frontend's "no guild flags → allow"
// net (roles.js hasGuildFlags) only fires when the flags are genuinely absent. Keep them absent.
function guildFlags(src) {
  const f = {};
  if (src && 'isAffiliate'  in src) f.isAffiliate  = !!src.isAffiliate;
  if (src && 'isDiscordVip' in src) f.isDiscordVip = !!src.isDiscordVip;
  if (src && 'isDiscordMod' in src) f.isDiscordMod = !!src.isDiscordMod;
  return f;
}

function signToken(user) {
  const payload = {
    id: user.id, username: user.username,
    displayName: user.displayName, avatar: user.avatar,
    // Guild-role flags travel in the token so cookie-blocked users (Bearer fallback) keep their
    // affiliate/vip/mod access without depending on the bot-token refresh in /auth/me. Renewed
    // there on every call, so they stay fresh. See bearerFallback below + routes/auth.routes.js.
    // Only present-and-determined flags are carried (guildFlags) — never a synthetic `false`.
    ...guildFlags(user),
    exp: Date.now() + 30 * 24 * 60 * 60 * 1000, // 30 days, renewed on /auth/me — see routes/auth.routes.js
  };
  const payloadB64 = b64url(JSON.stringify(payload));
  const sig = b64url(crypto.createHmac('sha256', SESSION_SECRET).update(payloadB64).digest());
  return `${payloadB64}.${sig}`;
}
function verifyToken(token) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return null;
  const [payloadB64, sig] = token.split('.');
  const expectedSig = b64url(crypto.createHmac('sha256', SESSION_SECRET).update(payloadB64).digest());
  const sigBuf = Buffer.from(sig || ''), expBuf = Buffer.from(expectedSig);
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) return null;
  try {
    const payload = JSON.parse(b64urlDecode(payloadB64));
    if (!payload.exp || payload.exp < Date.now()) return null;
    return payload;
  } catch(e) { return null; }
}

// Takes `req` (not bare user) so admin status resolves through reqIsAdmin — the SAME
// authority used by /auth/me, requireAdmin, and the admin tabs (platform owner + tenant
// admins + env ADMIN_IDS). Using bare isAdmin(user) here was the bug: the nav showed the
// owner as admin while every hunt they didn't own stayed read-only.
// Is the caller an admin/mod with authority over THIS hunt's tenant?
// Platform owners span every tenant; a tenant admin/mod only reaches hunts in their OWN tenant.
// (Security audit 2026-07-18 #1: canEditHunt/reqIsAdmin honored the CALLER's tenant context and
// never checked the target hunt belongs to it — a cross-tenant write/read hole the moment
// MULTI_TENANT is on, since `hunts` is one global map keyed by Discord id across all tenants.
// Mirrors the inTenant(h, req.tenant.id) guard already used throughout routes/admin.routes.js.)
function reqCanAdminHunt(req, huntOwnerId) {
  if (!req || !req.user) return false;
  if (isPlatformAdmin(req.user)) return true;         // owner + env + DB admin → every tenant
  if (!reqIsAdmin(req)) return false;                 // not a tenant admin/mod → no admin reach
  const hunt = hunts[huntOwnerId];
  if (!hunt) return false;
  return (hunt.tenantId || 'bean') === ((req.tenant && req.tenant.id) || 'bean');
}
function canEditHunt(req, huntOwnerId) {
  const user = req?.user;
  if (!user) return false;
  if (reqCanAdminHunt(req, huntOwnerId)) return true; // admin/mod, tenant-scoped (audit #1)
  if (user.id === huntOwnerId) return true;
  const hunt = hunts[huntOwnerId];
  if (!hunt) return false;
  // Match invited co-editors by Discord ID ONLY. Invites used to match by display name,
  // which let anyone rename themselves to an invited name and gain edit access (violating the
  // repo's #1 gate-by-ID rule). invitedEditors now holds Discord IDs; legacy display-name
  // entries are non-numeric and never equal a real user.id, so they're inert — owners re-invite.
  return (hunt.invitedEditors || []).includes(user.id);
}
function isEquityMember(user, huntOwnerId) {
  if (!user || !user.id) return false;
  const hunt = hunts[huntOwnerId];
  if (!hunt) return false;
  // ID-ONLY gate (repo rule — display names are spoofable). Two reliable paths:
  //  1. callsPermissions: owner-approved via the request-calls flow.
  //  2. an equity row already linked to this Discord ID.
  // Name-variant / startsWith matching was removed (security audit 2026-07-18, #2):
  // any logged-in user could rename to an equity member's name and gain call-add +
  // payout attribution. Members without an ID link now go through request-calls.
  if (hunt.callsPermissions && hunt.callsPermissions.includes(user.id)) return true;
  return Array.isArray(hunt.equity) && hunt.equity.some(e => e.discordId && e.discordId === user.id);
}

// ── Gate middlewares ───────────────────────────────────────────────
function requireAuth(req, res, next)  { if (!req.user) return res.status(401).json({error:'Not authenticated'}); next(); }
// Tenant-aware gates: when MULTI_TENANT is on, resolve against req.tenant; else the env-based globals.
// reqIsMod resolves against req.tenant UNCONDITIONALLY — unlike reqIsAdmin/reqIsVipHost, it does
// NOT check MULTI_TENANT first. Mods are a brand-new role with no legacy env-var behavior to
// preserve, and resolveTenant() already guarantees req.tenant is always set (to BEAN_TENANT when
// the flag is off or no slug is sent) — so this is correct in both flag states, and is what makes
// the Mod role work in production today regardless of MULTI_TENANT's value.
function reqIsMod(req) {
  if (isPlatformAdmin(req.user)) return true;   // owner + env + DB admin → mod everywhere
  return tenants.isTenantMod(req.user, req.tenant);
}
// Mods get the same admin-equivalent visibility tenant admins already get (additive only — never
// removes access; the MULTI_TENANT-gated tenant-admin branch below is untouched).
function reqIsAdmin(req) {
  if (isPlatformAdmin(req.user)) return true;               // owner + env + DB → admin everywhere
  if (reqIsMod(req)) return true;                            // mods get admin-equivalent visibility
  return MULTI_TENANT ? tenants.isTenantAdmin(req.user, req.tenant) : false;
}
// Tenant admin = platform owner OR this tenant's admin (tenant_roles role=admin). Deliberately does
// NOT fold in reqIsMod — this is the stricter gate for sensitive per-tenant config and owner tools,
// where a mod must not pass. Resolves against req.tenant unconditionally (always set by resolveTenant),
// mirroring the promoted reference impl from routes/apiKeys.routes.js.
function reqIsTenantAdmin(req) {
  if (isPlatformAdmin(req.user)) return true;
  return tenants.isTenantAdmin(req.user, req.tenant);
}
function reqIsVipHost(req) { if (isPlatformAdmin(req.user)) return true; return MULTI_TENANT ? tenants.isTenantVip(req.user, req.tenant) : (isAdmin(req.user)||isVipHost(req.user)); }
function requireAdmin(req, res, next) { if (!req.user||!reqIsAdmin(req)) return res.status(403).json({error:'Admin only'}); next(); }
function requirePlatformAdmin(req, res, next) {
  if (!req.user || !isPlatformAdmin(req.user)) return res.status(403).json({error:'Platform admin only'});
  next();
}
function requireTenantAdmin(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
  if (!reqIsTenantAdmin(req)) return res.status(403).json({ error: 'Tenant admin only' });
  next();
}
function requireMod(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
  if (!reqIsMod(req)) return res.status(403).json({ error: 'Access denied' });
  next();
}

// ── Tenant resolution + Bearer fallback (global middlewares) ───────
// Resolve the tenant for every /api request. Defaults to Bean when MULTI_TENANT is off
// or no X-Tenant-Slug is sent (back-compat — the current frontend may not send it yet).
function resolveTenant(req, res, next) {
  const slug = req.headers['x-tenant-slug'] || req.query._tenant;
  if (!MULTI_TENANT || !slug) { req.tenant = tenants.BEAN_TENANT; return next(); }
  const t = tenants.getTenantBySlug(String(slug));
  if (!t) return res.status(404).json({ error: 'Unknown tenant' });
  req.tenant = t;
  next();
}

// Token-based auth fallback — for browsers that block third-party cookies.
// If req.user wasn't set by passport session, check for Authorization: Bearer <token>
function bearerFallback(req, res, next) {
  if (!req.user) {
    const auth = req.headers.authorization || '';
    if (auth.startsWith('Bearer ')) {
      const payload = verifyToken(auth.slice(7));
      if (payload) {
        req.user = {
          id: payload.id, username: payload.username,
          displayName: payload.displayName, avatar: payload.avatar,
          // Restore guild-role flags from the token so affiliate/vip/mod gating survives
          // when there's no session cookie (third-party cookies blocked). /auth/me still
          // refreshes these via the bot token when it can; this is the reliable floor.
          // Only present flags are restored (guildFlags) — an absent flag stays absent so
          // "role undetermined" never collapses into a hard "false" that denies access.
          ...guildFlags(payload),
        };
        // Also record in known_users so they show in equity autocomplete for others
        recordKnownUser(req.user);
      }
    }
  }
  next();
}

module.exports = {
  initAuth,
  nameOf,
  isAdmin, isPlatformAdmin, isVipHost,
  b64url, b64urlDecode, signToken, verifyToken, guildFlags,
  canEditHunt, reqCanAdminHunt, isEquityMember,
  requireAuth, reqIsAdmin, reqIsVipHost, requireAdmin, requirePlatformAdmin,
  reqIsMod, requireMod, reqIsTenantAdmin, requireTenantAdmin,
  resolveTenant, bearerFallback,
};
