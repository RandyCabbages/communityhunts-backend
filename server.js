const express         = require('express');
// Must run before any router is built: teaches Express 4 to route a rejected async handler
// into the global error handler below instead of letting it kill the process. See lib/asyncErrors.js.
require('./lib/asyncErrors')();

const session         = require('express-session');
const passport        = require('passport');
const DiscordStrategy = require('passport-discord').Strategy;
const cors            = require('cors');
const helmet          = require('helmet');
const http            = require('http');
const { Server }      = require('socket.io');
const fs              = require('fs');
const path            = require('path');

const app    = express();
const server = http.createServer(app);

const PORT         = process.env.PORT || 3001;
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:3000';
// Support comma-separated list of allowed origins (e.g. for domain migrations)
const ALLOWED_ORIGINS = [
  ...new Set([
    FRONTEND_URL,
    'https://communityhunts.gg',
    'https://www.communityhunts.gg',
    ...(process.env.EXTRA_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean),
  ])
];
// ONE CORS policy for both transports — the rules and their rationale now live in
// lib/corsPolicy.js (extracted in the 2026-07-27 audit so they could be unit-tested).
// Allowlisted site origins get credentialed CORS; browser-extension origins are reflected
// WITHOUT credentials (security audit 2026-07-18 #6). Defined once and shared (see globalCors
// below) so Express and Socket.IO cannot drift apart again.
//
// A disallowed origin is refused with `callback(null, false)`, NOT an Error. The Error form
// propagated into the Express error handler and returned 500 + a stack for every ordinary
// cross-origin request — which is why Vercel preview deploys look permanently signed out
// (*.vercel.app isn't allowlisted, so even /auth/me 500s). Add a specific preview URL to
// EXTRA_ORIGINS to let it through; never blanket-allow *.vercel.app.
const { corsDelegate } = require('./lib/corsPolicy').makeCorsPolicy(ALLOWED_ORIGINS);

const io = new Server(server, {
  cors: corsDelegate
});

// Admin Mission Control live data. Both are in-memory and derived — nothing to persist:
// `presence` reads the socket server directly, and `activityFeed` is a transient ticker that a
// deploy clears (same lifecycle as the OverDrop overlay state), NOT an audit trail.
const { makeActivityFeed } = require('./lib/activityFeed');
const { makePresence } = require('./lib/presence');
const activityFeed = makeActivityFeed({ cap: 200 });
const presence = makePresence(io);
const SESSION_SECRET = process.env.SESSION_SECRET || (() => {
  console.warn('[security] SESSION_SECRET is not set — using a random per-boot secret. Set SESSION_SECRET in the environment so sessions/tokens survive restarts and cannot be forged with a known default.');
  return require('crypto').randomBytes(48).toString('hex');
})();
// Set() dedups so a repeated entry in the Railway var (e.g. an ID appended twice)
// doesn't render the same admin twice in the platform-admins list.
const ADMIN_IDS      = [...new Set((process.env.ADMIN_IDS || '').split(',').map(s=>s.trim()).filter(Boolean))];
const VIP_IDS        = [...new Set((process.env.VIP_IDS || '').split(',').map(s=>s.trim()).filter(Boolean))];
// Ticket env config (DISCORD_TICKETS_BOT_TOKEN / DISCORD_TICKETS_CHANNEL_ID / DISCORD_SUGGESTIONS_CHANNEL_ID) lives in routes/misc.routes.js.

// ── Tenant-aware Discord role detection ──────────────────────────────────────
// Role IDs and guild IDs now live per-tenant in the DB (set via admin console).
// The functions below accept a tenant object so each community's Discord config
// is independent — adding a new tenant never touches Railway env vars.

// Derives guild-role flags from a member's role-id list. CRITICAL: a flag is only included
// when its role ID is actually configured — an unconfigured role stays ABSENT (undetermined),
// never a hard `false`. Absent flags let the frontend's "no guild flags → allow" net (roles.js
// hasGuildFlags) fall OPEN, so a missing/mis-set role ID can't mass-deny a role-gated tenant.
function rolesFromMemberRoles(memberRoles, tenant) {
  const flags = {};
  const affId = tenant?.discordAffiliateRoleId;
  const vipId = tenant?.discordVipRoleId;
  const modId = tenant?.discordModRoleId;
  if (affId) flags.isAffiliate  = memberRoles.includes(affId);
  if (vipId) flags.isDiscordVip = memberRoles.includes(vipId);
  if (modId) flags.isDiscordMod = memberRoles.includes(modId);
  // Reaching here at all means Discord returned a member object, so the user IS in the guild —
  // independent of holding any configured role, and set even when the tenant configures none.
  // This is what verifies a self-join for the Partner extension perk (lib/features.js).
  flags.isGuildMember = true;
  return flags;
}

// Fetches a user's roles in the tenant's guild using their OAuth access token
// (guilds.members.read scope). Called at login time; results cached in session.
// Returns null when roles are UNDETERMINED (no guild configured, or the Discord lookup
// failed) — callers must leave the flags absent in that case, never coerce to false.
async function fetchGuildRoles(oauthAccessToken, tenant) {
  const guildId = tenant?.discordGuildId;
  if (!guildId || !oauthAccessToken) {
    console.log(`[discord] fetchGuildRoles skipped (roles undetermined): guild=${!!guildId} token=${!!oauthAccessToken}`);
    return null;
  }
  try {
    const res = await fetch(`https://discord.com/api/v10/users/@me/guilds/${guildId}/member`, {
      headers: { Authorization: `Bearer ${oauthAccessToken}` }
    });
    if (!res.ok) {
      console.log(`[discord] fetchGuildRoles failed (roles undetermined): status=${res.status}`);
      return null;
    }
    const member = await res.json();
    const memberRoles = member.roles || [];
    console.log(`[discord] fetchGuildRoles: user=${member.user?.id} roles=${JSON.stringify(memberRoles)} affRoleId=${tenant?.discordAffiliateRoleId || '(unset)'}`);
    return rolesFromMemberRoles(memberRoles, tenant);
  } catch (e) {
    console.error('[discord] guild role fetch failed (roles undetermined):', e.message);
    return null;
  }
}

// Refreshes guild roles via the tenant's bot token (no user OAuth token needed).
// Called on /auth/me so roles stay current without re-login.
//
// Returns null when roles are UNDETERMINED — same contract as fetchGuildRoles: callers must
// leave the flags absent, never coerce to false (purchase eligibility fails OPEN on absent
// flags, so coercing would silently lock buyers out).
//
// opts.detailed distinguishes the one determinate failure: Discord answers 404 for a user who
// simply is not a guild member, which is "definitely not a VIP", not "lookup failed". Default
// callers keep folding it into null so /auth/me and purchase eligibility are untouched; the
// admin panel opts in so it can tell "no access" from "couldn't verify" instead of warning on
// every non-member.
async function refreshGuildRoles(discordUserId, tenant, opts = {}) {
  const guildId = tenant?.discordGuildId;
  const botToken = tenant?.discordBotToken;
  if (!guildId || !botToken || !discordUserId) return null;
  try {
    const res = await fetch(`https://discord.com/api/v10/guilds/${guildId}/members/${discordUserId}`, {
      headers: { Authorization: `Bot ${botToken}` }
    });
    // 404 = a DETERMINATE "not in this guild", unlike the null returns below which mean
    // "couldn't ask". isGuildMember:false makes that determinate answer readable by callers
    // that only look at the flag.
    if (res.status === 404 && opts.detailed) return { notGuildMember: true, isGuildMember: false };
    if (!res.ok) return null;
    const member = await res.json();
    const memberRoles = member.roles || [];
    const result = rolesFromMemberRoles(memberRoles, tenant);
    if (!result.isAffiliate) {
      console.log(`[discord] role debug for ${discordUserId}: memberRoles=${JSON.stringify(memberRoles)}, expected affiliate=${tenant?.discordAffiliateRoleId || '(unset)'}`);
    }
    return result;
  } catch (e) {
    console.error('[discord] bot role refresh failed:', e.message);
    return null;
  }
}

// Normalize slot name for dedup: strip punctuation, collapse whitespace, lowercase
function normalizeSlot(name) { return (name || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(); }

// Auth + gating logic lives in lib/auth.js (ID-based admin/VIP, HMAC token fallback, hunt-
// permission checks, tenant resolution, gate middlewares). auth.initAuth(...) is called below
// once the lib deps (tenants/admins/hunts/settings) exist — the functions only run at request
// time, so the deferred init is safe. Re-bound into this scope so the inline routes that still
// reference these names keep working until they move into their own routers.
const auth = require('./lib/auth');
const {
  nameOf, isAdmin, isPlatformAdmin, isVipHost,
  signToken, verifyToken, guildFlags,
  canEditHunt, reqCanAdminHunt, isEquityMember,
  requireAuth, reqIsAdmin, reqIsVipHost, requireAdmin, requirePlatformAdmin,
  reqIsMod, requireMod, reqIsTenantAdmin, requireTenantAdmin,
  resolveTenant,
} = auth;

// ── Middleware ─────────────────────────────────────────────────────
app.set('trust proxy', 1);
// Security headers (HSTS, nosniff, frameguard, referrer-policy, …). This is a JSON + media
// API — the frontend on Vercel owns its own CSP — so CSP is disabled here. Critically,
// Cross-Origin-Resource-Policy is set to cross-origin: the frontend (communityhunts.gg)
// loads backend-served images (img-proxy thumbnails, OverDrop media) from api.communityhunts.gg,
// and helmet's default (same-origin) would block them.
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginResourcePolicy: { policy: 'cross-origin' },
  crossOriginEmbedderPolicy: false,
}));
// The public Developer API (routes/public.routes.js) governs its own CORS (open to any origin,
// no credentials — Bearer-key auth, not cookies). This credentialed, origin-allowlisted CORS
// would otherwise 500 on any non-allowlisted browser origin before the public router ever runs,
// blocking third-party browser consumers of the public API — so it's skipped for those paths.
// Per-request CORS delegate: allowlisted site origins get credentialed CORS (cookie sessions);
// browser-extension origins are reflected but WITHOUT credentials (security audit 2026-07-18 #6).
// The extension authenticates by HMAC Bearer token, never cookies, so dropping Allow-Credentials
// for chrome-/moz-extension:// origins stops a *malicious* extension from riding a user's session
// cookie via the reflection, while the CommunityHunts extension keeps working (Bearer, no cookie).
const globalCors = cors(corsDelegate); // same delegate the Socket.IO server uses — see its note above
app.use((req, res, next) => req.path.startsWith('/api/public/') ? next() : globalCors(req, res, next));
// Stripe webhook needs the raw body for signature verification — mount
// before the global JSON parser so it gets the unparsed Buffer.
app.post('/api/stripe/webhook', express.raw({ type: 'application/json' }));
app.use(express.json({ limit: '256kb' }));

// Postgres pool — shared by session store and user_settings
const { Pool } = require('pg');
const { makePoolConfig } = require('./lib/pgConfig');
const { installGracefulShutdown } = require('./lib/shutdown');
let pgPool = null;
if (process.env.DATABASE_URL) {
  // Railway's managed Postgres requires TLS, so SSL is the default. But this was hardcoded ON,
  // which meant the backend could NEVER connect to a plain local Postgres — it fails with
  // "The server does not support SSL connections". That is the reason no test in this repo has
  // ever run against a real database: it was not possible to stand one up locally.
  // Opt out with sslmode=disable, or automatically for a loopback host. Production URLs are
  // neither, so prod behaviour is unchanged.
  // Options (SSL choice, limits, timeouts) live in lib/pgConfig.js so they can be tested.
  const poolCfg = makePoolConfig(process.env.DATABASE_URL);
  pgPool = new Pool(poolCfg);
  // WITHOUT this, an idle-client failure is FATAL. pg-pool re-emits it as an 'error' event on the
  // pool (pg-pool/index.js), and EventEmitter throws when 'error' has no listener — which is
  // exactly the "10x uncaughtException: Connection terminated unexpectedly" seen when Postgres was
  // killed mid-load. The FATAL-GUARD handlers below do catch those, but relying on
  // uncaughtException to absorb a routine, expected event (a database restart) leaves the process
  // in a formally undefined state and buries a real signal. pg discards and replaces the dead
  // client on its own; this just stops it being fatal.
  pgPool.on('error', (err) => console.error('[pg] idle client error:', err && err.message));
  console.log(`[pg] Pool created (ssl=${poolCfg.ssl ? 'on' : 'off — local'}, max=${poolCfg.max})`);
} else {
  console.log('[pg] No DATABASE_URL — sessions and settings will be in-memory only (will reset on redeploy)');
}

// Session config — Postgres-backed if pool is available, otherwise in-memory
const sessionConfig = {
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  rolling: true, // slide expiry forward on every request — was a hard 7-day cutoff from login, logging out anyone who didn't visit weekly
  cookie: { secure: true, sameSite: 'none', maxAge: 30 * 24 * 60 * 60 * 1000 }
};
if (pgPool) {
  const pgSession = require('connect-pg-simple')(session);
  sessionConfig.store = new pgSession({
    pool: pgPool,
    tableName: 'user_sessions',
    createTableIfMissing: true,
  });
  console.log('[session] Using Postgres session store (persists across redeploys)');
} else {
  console.log('[session] Using in-memory session store (will reset on redeploy)');
}
app.use(session(sessionConfig));
app.use(passport.initialize());
app.use(passport.session());

// Token-based auth fallback (Bearer) — for browsers that block third-party cookies. Logic in lib/auth.js.
app.use(auth.bearerFallback);

// Mounted globally so /auth/me also gets tenant context for the isAdmin/isVipHost flags it returns.
app.use(resolveTenant);

// ── Passport ───────────────────────────────────────────────────────
passport.use(new DiscordStrategy({
  clientID: process.env.DISCORD_CLIENT_ID,
  clientSecret: process.env.DISCORD_CLIENT_SECRET,
  callbackURL: process.env.DISCORD_CALLBACK_URL || `${FRONTEND_URL}/auth/discord/callback`,
  scope: ['identify', 'guilds.members.read'],
  passReqToCallback: true,
}, async (req, access, refresh, profile, done) => {
  const guildRoles = await fetchGuildRoles(access, req.tenant);
  done(null, {
    id: profile.id,
    username: profile.username,
    displayName: profile.global_name || profile.username,
    avatar: profile.avatar
      ? `https://cdn.discordapp.com/avatars/${profile.id}/${profile.avatar}.png`
      : `https://cdn.discordapp.com/embed/avatars/${parseInt(profile.discriminator||0)%5}.png`,
    // Spread only the flags we could actually determine. When guildRoles is null (Discord
    // lookup unconfigured/failed) NO guild flags are set — the user is "role undetermined",
    // and role-gated tenants fall open rather than falsely denying. See guildFlags/roles.js.
    ...(guildRoles || {}),
  });
}));
passport.serializeUser((u,d) => d(null,u));
passport.deserializeUser((u,d) => d(null,u));


// ── State ──────────────────────────────────────────────────────────
const viewers = {};

// Persistence layer (hunt/archive state + Postgres hunts_kv) lives in lib/persistence.js.
// hunts/archive are shared singletons owned there — imported by reference, never reassigned.
const persistence = require('./lib/persistence');
const { hunts, archive, shareTokens, persistHunts, persistArchive, persistShareTokens, tokenForOwner, archiveHunt, unarchiveHunt } = persistence;

// User settings + known-users (Postgres-backed, file fallback). Owns user_settings/known_users
// tables, the name-lookup helpers, and the startup backfill. Needs hunts (by reference) for backfill.
const settings = require('./lib/settings');
settings.initSettings({ pgPool, hunts });
const { recordKnownUser } = settings;  // called from the auth callback / Bearer middleware

// Admin-confirmed name→account decisions, held in memory so the hunt save path can replay them
// without a query (see lib/confirmedAliases.js). Loaded once at startup and kept current by the
// Tier 2 apply/unlink routes; the hourly refresh is only a safety net against drift.
const confirmedAliases = require('./lib/confirmedAliases');
confirmedAliases.initConfirmedAliases(pgPool)
  .then(n => console.log(`[confirmed_aliases] ${n} confirmed name(s) loaded`))
  .catch(e => console.error('[confirmed_aliases] initial load failed:', e.message));
// .catch on every detached async interval: without it a rejection is an anonymous
// unhandledRejection (fatal before lib/asyncErrors.js + the process guards, and still
// undiagnosable after). A named log says which sweep died.
setInterval(() => confirmedAliases.refresh().catch(e => console.error('[aliases] refresh failed:', e.message)), 60 * 60 * 1000);

// All-time stats: fxRates (currency conversion) + statsStore (durable per-hunt history + per-user
// rollup, additive to the 100-cap archive). Constructed synchronously; tables are created as part
// of the init promise chain below (this scope is CommonJS top-level, no top-level await).
const makeFxRates = require('./lib/fxRates');
const makeStatsStore = require('./lib/statsStore');
const fxRates = makeFxRates({ pgPool });
const statsStore = makeStatsStore({ pgPool, fxRates });

// One-time tenant-hunt OBS rebrand migration (__mod_hunt__ → __tenant_hunt__). Runs after hunts
// are loaded (initPersistence) so it can re-key live state; the settings copy self-ensures its
// table, so ordering vs initSettings is irrelevant. Idempotent — a no-op once migrated.
const { migrateSharedHuntKeys } = require('./lib/migrateSharedHuntKeys');
persistence.initPersistence({ pgPool, normalizeSlot, statsStore })
  .then(() => migrateSharedHuntKeys({ hunts, pgPool, persistHunts }))
  .then(() => statsStore.ensureTables())
  .then(() => settings.startupBackfill())
  .then(() => settings.loadAnonymousUsers())   // hydrate the anonymous-user set for name redaction
  .catch(e => console.error('[persist] init error:', e.message));

// Audit log (Postgres audit_log table; in-memory ring when there's no pgPool). Owns its own
// table + retention sweep; every write is fire-and-forget so auditing can never break a request.
const auditLog = require('./lib/auditLog');
auditLog.initAuditLog({ pgPool });

// Multi-tenancy config (tenants + roles). Gated by MULTI_TENANT; defaults to Bean.
const tenants = require('./lib/tenants');
const MULTI_TENANT = process.env.MULTI_TENANT === 'true';
tenants.initTenants({ pgPool }).catch(e => console.error('[tenants] init error:', e.message));
const admins = require('./lib/admins');
admins.initAdmins({ pgPool }).catch(e => console.error('[admins] init error:', e.message));
const bans = require('./lib/bans');
bans.initBans({ pgPool }).catch(e => console.error('[bans] init error:', e.message));
const supporters = require('./lib/supporters');
supporters.initSupporters({ pgPool }).catch(e => console.error('[supporters] init error:', e.message));
const subscriptions = require('./lib/subscriptions');
subscriptions.initSubscriptions({ pgPool }).catch(e => console.error('[subscriptions] init error:', e.message));
const featureGrants = require('./lib/featureGrants');
featureGrants.initFeatureGrants({ pgPool }).catch(e => console.error('[grants] init error:', e.message));
const stripeLib = require('./lib/stripe');
stripeLib.initStripe({ pgPool, subscriptions }).catch(e => console.error('[stripe] init error:', e.message));
// Community memberships (which communities a user belongs to). Membership is reconciled from
// the user's role at auth time (see reconcileMembership in auth.routes).
const memberships = require('./lib/memberships');
memberships.initMemberships({ pgPool })
  .catch(e => console.error('[memberships] init error:', e.message));

// Ordered after memberships on purpose: features gates the Partner-plan extension perk on actual
// membership, so it needs that collaborator.
const features = require('./lib/features');
features.initFeatures({ subscriptions, featureGrants, memberships });

// Inject auth deps now that every collaborator exists. The gate functions were already
// re-bound above; they only run at request time, so wiring their deps here is in time.
auth.initAuth({ ADMIN_IDS, VIP_IDS, SESSION_SECRET, MULTI_TENANT, tenants, admins, hunts, recordKnownUser });

// Hunt-domain read/broadcast core (huntSummary, list builders, publicHuntView secret-strip,
// hub/hunt emit helpers, mod/affiliate hunt-key constants, uid/touch). viewers is shared by
// reference with the sockets module so live viewer counts stay coherent. Re-bound into scope
// so the still-inline hunt routes keep working until they move into their own routers.
const huntsCore = require('./lib/hunts-core');
// May a viewer see anonymous members' real names in this hunt? Yes for the hunt runner (host),
// and for mods/admins of the hunt's tenant (auth.isAdmin covers platform admins; isTenantMod folds
// in tenant admins). Everyone else gets 'Anonymous'. Called per-socket on every anonymous-hunt
// broadcast, so it stays synchronous + cache-backed (no DB/awaits).
function isPrivilegedViewer(viewerId, hunt) {
  if (!viewerId || !hunt) return false;
  if (hunt.user && hunt.user.id && String(viewerId) === String(hunt.user.id)) return true; // host
  const u = { id: String(viewerId) };
  if (auth.isAdmin(u)) return true;
  const tenant = tenants.getTenantBySlug(huntsCore.tenantOf(hunt)) || tenants.BEAN_TENANT;
  return tenants.isTenantMod(u, tenant);
}
huntsCore.initHuntsCore({
  hunts, archive, viewers, io, persistHunts,
  isAnonymousUser: settings.isAnonymousUser, isPrivilegedViewer,
  shouldMaskIdentity: settings.shouldMaskIdentity,
});
const {
  MOD_HUNT_ID, AFFILIATE_HUNT_ID, VIP_HUNT_ID, modHuntKey, affiliateHuntKey, vipHuntKey,
  huntSummary, huntCompleted, huntHasContent, tenantOf, inTenant,
  getPublicHunts, getArchivedHunts, getAllHunts, getSlotCallCounts, getGotInLog, getHuntsFullExport,
  emitHubUpdate, publicHuntView, emitHuntUpdate, emitToHuntRoom,
  uid, touch,
} = huntsCore;

// Full (Rainbet) extension entitlement, request-scoped. Thin wrapper over
// features.fullExtensionFor — the OR-list lives there and nowhere else. This passes the
// CACHED session guild flag (req.user.isDiscordVip), never a live Discord lookup: this path
// serves /api/extension/entitlement, which the extension calls on every load. The admin
// panel passes a live lookup instead. Injected into the entitlement route (gates the download
// page view AND the extension's in-app Rainbet features) and the subscribe route (so a VIP is
// never charged). reqIsAdmin is folded into both reqIsVipHost and reqIsMod.
async function reqHasFullExtension(req) {
  if (!req.user) return false;
  // Role flags decide access with zero I/O — short-circuit before fullExtensionFor, which
  // always queries Postgres for the subscription tier (it must, to report every source).
  // This path serves /api/extension/entitlement on every extension load, and the pre-refactor
  // code short-circuited the same way; dropping it would add a per-load query for every VIP.
  // Only the boolean is needed here, so the unreported sources cost nothing.
  if (reqIsVipHost(req) || reqIsMod(req) || !!req.user.isDiscordVip) return true;
  // tenantId as well as tenantPlan: the Partner perk requires membership of THAT tenant, and
  // req.tenant is only ever "the community this request is scoped to". See computeFullExtension.
  // isGuildMember comes from the cached session/token flag (guildFlags) — this runs on every
  // extension load, so it must not add a live Discord call.
  return (await features.fullExtensionFor(req.user.id, {
    tenantPlan:    req.tenant?.plan,
    tenantId:      req.tenant?.id,
    isGuildMember: !!req.user.isGuildMember,
  })).access;
}

// Hard ban gate. A banned user is refused everywhere — website, extension, API, any tenant —
// with a 403 the frontend/extension render as the ban notice. Runs after req.user is populated
// (session + bearer) and before every route mount. Only /auth/logout is exempt so a banned user
// can still sign out and isn't trapped in a redirect loop. Anonymous requests (no req.user) pass.
app.use((req, res, next) => {
  if (req.user && req.path !== '/auth/logout' && bans.isBanned(req.user.id)) {
    return res.status(403).json({ error: 'banned', banned: true,
      message: (bans.getBan(req.user.id) || {}).message || bans.DEFAULT_BAN_MESSAGE });
  }
  next();
});

// Auth + community-membership routes (routes/auth.routes.js). Mounted here, after the lib deps
// exist. Passport strategy is configured above; resolveTenant (global) already set req.tenant.
app.use(require('./routes/auth.routes')({
  passport, FRONTEND_URL, requireAuth,
  reqIsAdmin, reqIsVipHost, reqIsMod, isPlatformAdmin, signToken, guildFlags,
  recordKnownUser, memberships, tenants, pgPool, subscriptions, refreshGuildRoles, featureGrants,
  auditLog, bans, activityFeed,
}));

// Shared privilege gate (owner/king/mod/supporter) — see lib/privilege.js. Used by call-limit,
// ticket-priority, and cosmetics enforcement below.
const { isPrivileged } = require('./lib/privilege')({ reqIsMod, supporters });

// Reject malformed / oversized hunt payloads (memory + DoS protection).
const MAX_BONUSES = 1000, MAX_EQUITY = 300, MAX_CALLS = 1000, MAX_VAULT = 500;
function rejectBadHuntInput(req, res) {
  const { bonuses, equity, calls } = req.body || {};
  if (bonuses !== undefined && (!Array.isArray(bonuses) || bonuses.length > MAX_BONUSES)) { res.status(400).json({error:'Invalid bonuses payload'}); return true; }
  if (equity  !== undefined && (!Array.isArray(equity)  || equity.length  > MAX_EQUITY))  { res.status(400).json({error:'Invalid equity payload'});  return true; }
  if (calls   !== undefined && (!Array.isArray(calls)   || calls.length   > MAX_CALLS))   { res.status(400).json({error:'Invalid calls payload'});   return true; }
  const { vault } = req.body || {};
  if (vault !== undefined && (!Array.isArray(vault) || vault.length > MAX_VAULT)) { res.status(400).json({error:'Invalid vault payload'}); return true; }
  const { currency } = req.body || {};
  if (currency !== undefined && !huntsCore.CURRENCIES.includes(currency)) { res.status(400).json({error:'Invalid currency'}); return true; }
  const { publicCalls, publicCallsPin } = req.body || {};
  if (publicCalls    !== undefined && typeof publicCalls !== 'boolean')                        { res.status(400).json({error:'Invalid publicCalls payload'}); return true; }
  if (publicCallsPin !== undefined && publicCallsPin !== null &&
      (typeof publicCallsPin !== 'string' || publicCallsPin.length > 32))                      { res.status(400).json({error:'Invalid publicCallsPin payload'}); return true; }
  return false;
}

// Creator Twitch live-check (lib/integrations): hunts routes read the cache (wire
// enrichment) + trigger an immediate refresh on /start; the poller starts in startPolling().
const integrations = require('./lib/integrations');
const creatorPollDeps = {
  getAllTenants: () => tenants.getAllTenants(),
  getPublicHunts,
  getSettings: settings.getSettings,
};

// Public-hunt + my-hunt routes (routes/hunts.routes.js). Declaration order inside the router is
// load-bearing: /api/hunts/archived before /api/hunts/:userId.
app.use(require('./routes/hunts.routes')({
  requireAuth, canEditHunt, isEquityMember, reqIsVipHost, reqIsMod,
  hunts, archive, getPublicHunts, getArchivedHunts,
  emitHubUpdate, emitHuntUpdate, publicHuntView, uid, touch,
  persistHunts, archiveHunt, unarchiveHunt, io, rejectBadHuntInput,
  resolveUserIdByName: settings.resolveUserIdByName,
  getCreatorLive: integrations.getCreatorLive,
  refreshCreatorsLive: () => integrations.checkCreatorsLive(io, creatorPollDeps),
  getKnownUser: settings.getKnownUser,
  findAliasOwners: settings.findAliasOwners,
  auditLog, bans, activityFeed,
}));

// Mod hunt + Affiliate hunt — two fixed-key shared hunts (routes/mod-hunt.routes.js).
app.use(require('./routes/mod-hunt.routes')({
  hunts, archive, io, persistHunts, archiveHunt, unarchiveHunt,
  requireMod, modHuntKey, affiliateHuntKey, vipHuntKey, tenants,
  uid, touch, publicHuntView, emitHuntUpdate, rejectBadHuntInput, auditLog,
  getSettings: settings.getSettings, saveSettings: settings.saveSettings,
  persistOverlayConfig: require('./lib/overlayConfig').persistOverlayConfig,
}));

// Tenant-mod management (routes/mods.routes.js). Add/remove by the tenant's own admin (or a
// platform owner) via requireTenantAdmin; view is requireAdmin (covers tenant admins + mods).
app.use(require('./routes/mods.routes')({
  requireAuth, requireAdmin, requirePlatformAdmin, requireTenantAdmin, tenants, pgPool,
}));

// Platform-wide announcements ("patch notes") — public read, owner-only publish.
const announcements = require('./lib/announcements');
announcements.initAnnouncements({ pgPool }).catch(e => console.error('[announce] init error:', e.message));
app.use(require('./routes/announcements.routes')({
  requireAuth, requirePlatformAdmin, announcements,
  getPlatformBotToken: tenants.getPlatformBotToken,
  announcementsChannelId: process.env.DISCORD_ANNOUNCEMENTS_CHANNEL_ID,
}));

// Cross-hunt payout ledger (routes/ledger.routes.js). Reads hunt_history; the per-person
// fold happens in the FRONTEND (giftLedger.js is the only home for gift/vault payout math,
// and a second implementation here would drift). `archive` + `persistArchive` are passed
// because hunt_history and the in-memory archive must both be written, and `huntKey` is
// statsStore's own so the in-memory match uses huntId when present.
app.use(require('./routes/ledger.routes')({
  pgPool, requireAuth, reqIsMod, archive, persistArchive, huntKey: statsStore.huntKey,
}));

// Developer API keys (per-community). initApiKeys gets tenant + feature helpers for the
// middlewares. `features` was already required + initialized above (~line 263) — reused here,
// not re-required. Admin router only (session-authed, owner/platform admin); the public
// key-authed router is mounted by a later task and does NOT re-init apiKeys.
const apiKeys = require('./lib/apiKeys');
apiKeys.initApiKeys({ pgPool, getTenantBySlug: tenants.getTenantBySlug, canUse: features.canUse })
  .catch(e => console.error('[apikeys] init error:', e.message));
app.use(require('./routes/apiKeys.routes')({
  requireAuth, apiKeys, tenants, isPlatformAdmin, canUse: features.canUse,
}));

// Share-token minting + the frontend URL shape behind it. One instance, shared by the share
// routes (a host pressing Share) and the public API (the Discord bot opening a shared hunt) —
// the token must be stable per owner, so a second minting path would break its own promise.
const shareLinks = require('./lib/shareLinks')({
  shareTokens, tokenForOwner, persistShareTokens, hunts, uid, frontendUrl: FRONTEND_URL,
});

// Public Developer API (key-authed, tier-gated). requireApiKey derives the tenant from the key
// and overrides req.tenant, so a post-resolveTenant mount is safe. Handlers use req.apiTenantId.
const serializers = require('./lib/publicSerializers');
serializers._setPublicHuntView(huntsCore.publicHuntView);
const rateLimitLib = require('./lib/rateLimit');
app.use(require('./routes/public.routes')({
  requireApiKey: apiKeys.requireApiKey,
  requireApiFeature: apiKeys.requireApiFeature,
  requireApiScope: apiKeys.requireApiScope,
  rateLimit: rateLimitLib.rateLimit,
  writeRateLimit: rateLimitLib.writeRateLimit,
  ipFloor: rateLimitLib.ipFloor,
  serializers,
  getHuntStats: huntsCore.getHuntStats,
  hunts, archive, tenantOf: huntsCore.tenantOf,
  huntHasContent: huntsCore.huntHasContent,
  huntCompleted: huntsCore.huntCompleted,
  getGotInLog: huntsCore.getGotInLog,
  collectBangers: require('./lib/bangers').collectBangers,
  archiveHunt: persistence.archiveHunt,
  auditLog,
  isKnownAccount: (id) => settings.getKnownUser(id),
  // …and the Discord bot's shared-hunt endpoints, mounted inside that router
  // (routes/publicDiscordHunts.routes.js). Its own `sharedHunts` instance over the same deps as
  // the mod console's — a pure factory, so both build byte-identical runs from one definition.
  affiliateHuntKey, vipHuntKey, sharedHunts: require('./lib/sharedHunts')({ tenants, uid }),
  shareLinks, persistHunts, emitHuntUpdate, uid,
}));

// Global curated slot lists — public read, owner-only writes.
const slotLists = require('./lib/slotLists');
slotLists.initSlotLists({ pgPool }).catch(e => console.error('[slotlists] init error:', e.message));
app.use(require('./routes/slotLists.routes')({
  requireAuth, requirePlatformAdmin, slotLists,
}));

// Custom card commission requests ("Shop Requests") — signed-in submit, owner-only review.
// Posts + phase-updates via the one shared community bot (DISCORD_BOT_TOKEN), same as announcements.
const cardRequests = require('./lib/cardRequests');
cardRequests.initCardRequests({ pgPool }).catch(e => console.error('[cardreq] init error:', e.message));

// Which `hidden` catalog cards are live in the Shop. Read/written by the cosmetics router
// (mounted further down) — required here so it inits alongside the other hunts_kv stores.
const cardReleases = require('./lib/cardReleases');
cardReleases.initCardReleases({ pgPool }).catch(e => console.error('[releases] init error:', e.message));
app.use(require('./routes/cardRequests.routes')({
  requireAuth, requirePlatformAdmin, cardRequests,
  getPlatformBotToken: tenants.getPlatformBotToken,
  getSettings: settings.getSettings,
  // Prove a requester's Discord id before an admin on-behalf create writes anything; backfill the
  // directory when the id was only known to Discord.
  getKnownUser: settings.getKnownUser,
  recordKnownUser,
  channelId: (process.env.DISCORD_SHOP_REQUESTS_CHANNEL_ID || '').trim(),
}));

// Read requester REPLIES to those DMs (lib/dmPoller.js). The backend holds no Discord gateway,
// so replies are polled off each open request's DM channel and folded into its dmLog, with a
// ping to the same shop-requests channel. Same bot, same channel id — no new env var.
require('./lib/dmPoller').startDmPolling({
  cardRequests,
  getPlatformBotToken: tenants.getPlatformBotToken,
  channelId: (process.env.DISCORD_SHOP_REQUESTS_CHANNEL_ID || '').trim(),
});

// Supporter applications ("Support Us" apply flow) — signed-in submit, owner-only review. Posts to
// the same shop-requests channel as Shop Requests; granting adds the user to the supporters table.
const supporterApplications = require('./lib/supporterApplications');
supporterApplications.initSupporterApplications({ pgPool }).catch(e => console.error('[supapp] init error:', e.message));
app.use(require('./routes/supporterApplications.routes')({
  requireAuth, requirePlatformAdmin, supporterApplications,
  getPlatformBotToken: tenants.getPlatformBotToken,
  channelId: (process.env.DISCORD_SHOP_REQUESTS_CHANNEL_ID || '').trim(),
  supporters,
}));

// Bug-tickets / feature-suggestions — public submit (POST /api/tickets in misc.routes), owner-only
// triage here. Persisted (lib/tickets, hunts_kv 'tickets'); the phase-embed edit uses the platform
// bot, same as Shop Requests. Injected into misc.routes below so the public submit can persist.
const tickets = require('./lib/tickets');
tickets.initTickets({ pgPool }).catch(e => console.error('[tickets] init error:', e.message));
app.use(require('./routes/adminTickets.routes')({
  requireAuth, requirePlatformAdmin, tickets,
  getPlatformBotToken: tenants.getPlatformBotToken,
  auditLog,
}));

// OverDrop — mod-controlled stream overlay (routes/overdrop.routes.js). State + socket
// broadcasts live in lib/overdrop.js; sockets stay read-only (see that file's security note).
const overdrop = require('./lib/overdrop');
overdrop.initOverdrop(io);
app.use(require('./routes/overdrop.routes')({ requireMod, overdrop }));

// Slot-call + call-permission routes (routes/calls.routes.js). Owns huntCallRequests state.
app.use(require('./routes/calls.routes')({
  hunts, io, persistHunts,
  requireAuth, canEditHunt, isEquityMember, reqCanAdminHunt, isPrivileged, isPrivilegedViewer, reqIsMod,
  normalizeSlot, nameOf, publicHuntView, emitHubUpdate, emitHuntUpdate, emitToHuntRoom, uid, rejectBadHuntInput,
  auditLog, activityFeed,
  // Vets client-supplied equity discordIds on the editor save path (lib/identityWrites.js).
  getKnownUser: settings.getKnownUser,
}));

// Share-link routes (routes/share.routes.js): token mint + public resolve.
app.use(require('./routes/share.routes')({
  requireAuth, canEditHunt, isEquityMember, hunts, archive, publicHuntView,
  shareTokens, shareLinks,
  // Equipped equity-card ids for the public page (lib/shareCards.js). The tenant comes from the
  // HUNT, not req.tenant — a share link is opened by outsiders and may carry no slug at all.
  equippedCardsFor: require('./lib/shareCards').equippedCardsFor,
  tenantForHunt: h => tenants.getTenantBySlug(huntsCore.tenantOf(h)) || tenants.BEAN_TENANT,
}));

// ── Stale-hunt janitor ─────────────────────────────────────────────
// Hunts are born live. Idle is measured from updatedAt (live) or archivedAt (ended). Rules:
//   • live, no content (empty), idle ≥ 1h  → delete (dead-reap) — regular user hunts only
//   • live, completed (every bonus opened), idle ≥ 10m → auto-end + archive — regular user hunts only
//     (after the last win the hunt keeps a 10m editable grace window for final tweaks; the host has
//     no manual end control, so the janitor is the primary ender. Each edit restamps updatedAt →
//     resets the grace timer; an idle/closed tab ends the hunt ~10-20m later given the 10m sweep.)
//   • live, has content, abandoned ≥ 36h   → auto-end + archive (kept as history)
//   • ended, incomplete, idle ≥ 36h        → delete (+ drop its archive snapshot)
//   • ended/archived, completed            → keep
// The 1h dead-reap skips the persistent shared mod/affiliate hunts and per-user paid tracker
// hunts (tracker:/__tenant_hunt__/__affiliate_hunt__/__vip_hunt__ keys) — those keep the 36h grace so a mod
// clearing the board or a subscriber's idle tracker isn't nuked mid-session.
const STALE_MS = 36 * 60 * 60 * 1000;
const EMPTY_STALE_MS = 60 * 60 * 1000; // 1h — an empty live regular hunt is reaped this fast
const COMPLETED_GRACE_MS = 10 * 60 * 1000; // 10m — a completed hunt stays live/editable this long before auto-end
function cleanupStaleHunts() {
  const now = Date.now();
  const idleMs = ts => now - new Date(ts || 0).getTime();
  const affectedTenants = new Set();
  const touchedRooms = [];
  let huntsChanged = false, archiveChanged = false, deleted = 0, archivedN = 0;

  // Object.entries snapshots the keys, so deleting during the loop is safe.
  for (const [id, h] of Object.entries(hunts)) {
    if (!h || !h.user) continue;
    if (h.isLive) {
      // Dead-reap: an empty regular user hunt idle ≥ 1h → delete outright. Persistent shared
      // (mod/affiliate) and paid tracker hunts are exempt — they fall through to the 36h rules.
      const persistentKey = id.startsWith('tracker:') || id.startsWith(MOD_HUNT_ID) || id.startsWith(AFFILIATE_HUNT_ID) || id.startsWith(VIP_HUNT_ID);
      if (!persistentKey && !huntHasContent(h) && idleMs(h.updatedAt || h.startedAt) >= EMPTY_STALE_MS) {
        delete hunts[id]; deleted++;
        affectedTenants.add(tenantOf(h)); touchedRooms.push([id, tenantOf(h)]); huntsChanged = true;
        continue;
      }
      // Completed-reap: a live hunt whose every bonus has been opened is DONE — but the host keeps a
      // 10-minute editable grace window after the last win to do final tweaks (equity/payouts/win
      // corrections). Only auto-end + archive once it's been idle ≥ COMPLETED_GRACE_MS; each edit
      // restamps updatedAt and resets the window. The frontend no longer fires an immediate /end, so
      // this is the primary ender for a finished hunt (not just a safety net). Regular hunts only —
      // persistent shared (mod/affiliate) and paid tracker hunts reset/reopen and keep the 36h grace.
      if (!persistentKey && huntCompleted(h) && idleMs(h.updatedAt || h.startedAt) >= COMPLETED_GRACE_MS) {
        h.isLive = false;
        h.updatedAt = new Date().toISOString();
        if (!h.archivedAt) h.archivedAt = new Date().toISOString();
        archiveHunt(h); archivedN++;
        affectedTenants.add(tenantOf(h)); touchedRooms.push([id, tenantOf(h)]); huntsChanged = true;
        continue;
      }
      if (idleMs(h.updatedAt || h.startedAt) < STALE_MS) continue;
      h.isLive = false;
      h.updatedAt = new Date().toISOString();
      if (Array.isArray(h.bonuses) && h.bonuses.length > 0) {
        if (!h.archivedAt) h.archivedAt = new Date().toISOString();
        archiveHunt(h); archivedN++;          // keep it as history
      } else {
        delete hunts[id]; deleted++;          // empty — nothing to archive
      }
      affectedTenants.add(tenantOf(h)); touchedRooms.push([id, tenantOf(h)]); huntsChanged = true;
    } else if (h.archivedAt) {
      if (huntCompleted(h) || idleMs(h.archivedAt) < STALE_MS) continue;
      unarchiveHunt(h); delete hunts[id]; deleted++;   // incomplete + idle → drop from both maps
      affectedTenants.add(tenantOf(h)); huntsChanged = true;
    } else {
      if (idleMs(h.updatedAt || h.createdAt) < STALE_MS) continue;
      delete hunts[id]; deleted++;            // created but never run
      affectedTenants.add(tenantOf(h)); huntsChanged = true;
    }
  }

  // Orphan archive snapshots (hunt no longer current): drop incomplete + idle ones.
  for (let i = archive.length - 1; i >= 0; i--) {
    const h = archive[i];
    if (huntCompleted(h) || idleMs(h.archivedAt) < STALE_MS) continue;
    archive.splice(i, 1); deleted++;
    affectedTenants.add(tenantOf(h)); archiveChanged = true;
  }

  if (huntsChanged) persistHunts();
  if (archiveChanged) persistArchive();
  affectedTenants.forEach(t => emitHubUpdate(t));
  // Per-socket, tenant-gated — NOT io.to(room).emit. A room broadcast cannot filter recipients, and
  // a socket that joined `hunt:<id>` before the hunt existed is still in the room no matter which
  // tenant it belongs to (the BE #115 window). This sweep is the one place that had to keep talking
  // about a hunt AFTER deleting it, so the tenant travels with the room id rather than being read
  // back out of `hunts`. Deleted → the stub tells watchers it ended; archived → the masked view.
  touchedRooms.forEach(([id, slug]) => emitToHuntRoom(id, slug, 'hunt:update',
    publicHuntView(hunts[id]) || { isLive:false, archivedAt:new Date().toISOString() }));
  if (deleted || archivedN) console.log(`[janitor] swept stale hunts — ${deleted} deleted, ${archivedN} auto-archived`);
  return { deleted, archived: archivedN };
}
// Run once after persistence settles, then hourly.
setTimeout(cleanupStaleHunts, 30 * 1000);
setInterval(cleanupStaleHunts, 10 * 60 * 1000);

// Re-send hunts whose durable hunt_history write failed. archiveHunt's handoff to statsStore is
// asynchronous and used to be fire-and-forget, so a PG blip left a hunt permanently missing from
// history with nothing to notice. Failures now flag the archive entry; this drains them on the
// same cadence as the janitor. Count is on /api/health as `statsPending`.
setInterval(() => {
  persistence.retryPendingStats().catch(e => console.error('[stats] retry sweep failed:', e.message));
}, 10 * 60 * 1000);

// Audit-log retention sweep (age + row-cap). Same background-timer pattern as the janitor above.
setInterval(() => auditLog.prune().catch(e => console.error('[audit] prune failed:', e.message)), 60 * 60 * 1000);

// Admin routes (routes/admin.routes.js). The janitor above stays here (composition-root
// background task); the manual /api/admin/hunts/cleanup trigger calls the injected cleanupStaleHunts.
app.use(require('./routes/admin.routes')({
  requireAuth, requireAdmin, requirePlatformAdmin, requireTenantAdmin,
  getAllHunts, getArchivedHunts, getGotInLog, getHuntsFullExport, getHuntStats: huntsCore.getHuntStats,
  pgPool, admins, bans, supporters, tenants, ADMIN_IDS, statsStore,
  hunts, archive, archiveHunt, unarchiveHunt, persistArchive,
  emitHubUpdate, publicHuntView, emitHuntUpdate, io, uid, cleanupStaleHunts,
  subscriptions, auditLog, activityFeed, presence,
  getPlatformBotToken: tenants.getPlatformBotToken,
  recordAlias: settings.recordAlias,
  recordKnownUser: settings.recordKnownUser,
  // Identity linking (Tier 2 proposals): findAliasOwners resolves display names to account ids
  // and returns a SET per name, so ambiguity is explicit rather than silently collapsed.
  // The Loose variant is the one the proposals endpoint uses — it matches the way the review
  // queue groups names (whitespace stripped, not merely collapsed).
  findAliasOwners: settings.findAliasOwners,
  findAliasOwnersLoose: settings.findAliasOwnersLoose,
  // Unlinking a name must delete the `admin-link` alias too, or the decision replays on next save.
  deleteAlias: settings.deleteAlias,
  persistHunts,
  // Vets client-asserted equity discordIds on backfill import (fail-closed) — same predicate the
  // public write path uses.
  isKnownAccount: (id) => settings.getKnownUser(id),
}));

// Audit-log read endpoint (routes/audit.routes.js). Owner-only, spans ALL tenants.
app.use(require('./routes/audit.routes')({ requireAuth, requirePlatformAdmin, auditLog }));

// ── User Settings + known-users + admin user management ────────────
// Helpers + tables live in lib/settings.js; routes in routes/settings.routes.js
// (mounted below near the slots router). recordKnownUser/getSettings/saveSettings
// are destructured from the settings module at init.

// /api/tickets moved to routes/misc.routes.js (mounted below near the slots router).

// ── External integrations (Twitch live, leaderboard, Discord) ──────
// Logic lives in lib/integrations.js (required above the hunts routes, which consume the
// creator live cache); routes in routes/integrations.routes.js.
// Poll each active tenant's Twitch channel + every live hunt creator. Runs after tenants load.
function startPolling() {
  integrations.startTenantPolling(io, tenants.getAllTenants());
  integrations.startCreatorPolling(io, creatorPollDeps);
}
// initTenants() is async; give it a beat, then start polling (Bean is in cache immediately anyway).
setTimeout(startPolling, 3000);

app.use(require('./routes/integrations.routes')({
  integrations, tenants, memberships, hunts, requireAuth,
  supporters, getKnownUser: settings.getKnownUser, getSettings: settings.getSettings,
}));


// ── Slot Autocomplete + image proxy ───────────────────────────────
// Logic + caches live in lib/slots.js (self-contained: no hunts/io/auth coupling).
// Routes are mounted via routes/slots.routes.js. Pre-fetch the slot list on startup.
const slots = require('./lib/slots');
slots.prefetchSlots();
app.use(require('./routes/slots.routes')({ slots, getSlotCallCounts }));

// Checks Rainbet for newly-released slots every 10 min in-process (replaces the
// GitHub Actions cron, which was firing every 1.5-5hrs instead of every 30 min).
require('./lib/rainbetSlotSync').startRainbetSlotSync(slots);

// Misc leaf routes: /api/bangers (reads hunts+archive), /api/tickets (persists via tickets store), /api/health.
app.use(require('./routes/misc.routes')({ hunts, archive, tickets, getPlatformBotToken: tenants.getPlatformBotToken, statsStore, isPrivileged,
  persistence: require('./lib/persistence') }));

// User settings + admin user-management routes (helpers in lib/settings.js).
app.use(require('./routes/settings.routes')({
  settings, pgPool, memberships, isPlatformAdmin, reqIsMod, reqIsVipHost, reqHasFullExtension, requireAuth, requireAdmin, requirePlatformAdmin, io, subscriptions, featureGrants,
  hunts, archive, statsStore, refreshGuildRoles, auditLog, supporters,
}));

// Stripe checkout, portal, and webhook routes (routes/stripe.routes.js).
app.use(require('./routes/stripe.routes')({ requireAuth, stripeLib, FRONTEND_URL, tenants }));

// Cosmetics purchase + inventory routes (routes/cosmetics.routes.js).
const cosmeticsRouter = require('./routes/cosmetics.routes')({
  requireAuth, requirePlatformAdmin, settings, stripeLib, subscriptions, FRONTEND_URL, isAdmin, reqHasFullExtension, cardReleases, auditLog,
});
app.use(cosmeticsRouter);
stripeLib.setCosmeticGrantFn(cosmeticsRouter._grantItem);
// Community self-serve: a paid community checkout provisions a tenant; a cancelled sub
// deactivates it. Re-check slug availability at provision time (it could've been claimed since
// checkout started). Owner becomes the tenant admin; Discord/branding are configured afterward.
stripeLib.setCommunityProvisionFn(async (action, meta) => {
  try {
    if (action === 'provision') {
      if (!(await tenants.slugAvailable(meta.communitySlug))) {
        console.error(`[stripe] community slug unavailable at provision: ${meta.communitySlug} — owner ${meta.ownerId} paid, handle manually`);
        return;
      }
      await tenants.createTenant({
        slug: meta.communitySlug, displayName: meta.communityName, ownerId: meta.ownerId,
        plan: meta.plan, accent: meta.accent, twitchChannel: meta.twitchChannel,
      });
      console.log(`[stripe] community provisioned: /${meta.communitySlug} (owner ${meta.ownerId}, ${meta.plan})`);
    } else if (action === 'deactivate') {
      await tenants.setTenantActive(meta.communitySlug, false);
      console.log(`[stripe] community deactivated (sub cancelled): /${meta.communitySlug}`);
    }
  } catch (e) { console.error('[stripe] community provision error:', e.message); }
});
// Full-extension subscription lifecycle → grant/revoke the featureGrants entry.
stripeLib.setFullExtensionFn(async (action, userId) => {
  try {
    if (action === 'grant') await featureGrants.addGrant(userId, 'full_extension', 'stripe-sub');
    else await featureGrants.removeGrant(userId, 'full_extension');
  } catch (e) { console.error('[stripe] full_extension grant error:', e.message); }
});

// Standalone tracker routes (paid product, no tenant context).
app.use(require('./routes/tracker.routes')({
  requireAuth, hunts, persistHunts, subscriptions, rejectBadHuntInput, uid,
}));


// Global error handler. Without one, an uncaught throw in any route returns Express's default
// HTML "Internal Server Error" with the stack thrown away (which is what hid the extension CORS
// 500). Log the full stack server-side (Railway logs) and return a generic JSON error — no stack
// leak in the response body.
app.use((err, req, res, next) => {
  console.error(`[ERR] ${req.method} ${req.originalUrl}\n`, err && err.stack ? err.stack : err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: 'Internal Server Error' });
});

// ── Socket.io ─────────────────────────────────────────────────────
// Connection handling lives in sockets/index.js. viewers is shared by reference with
// hunts-core so live counts stay coherent.
require('./sockets')(io, {
  getPublicHunts, publicHuntView, emitHubUpdate, tenantOf, integrations, viewers, hunts,
  overdrop, verifyToken, isBanned: bans.isBanned,
});

// ── Last-resort process guards ────────────────────────────────────
// lib/asyncErrors.js covers rejections inside route handlers, but not everything runs in a
// request: the janitor intervals, Twitch polling, the Discord announce sweep, socket handlers
// and the rainbet slot sync all run detached. A rejection there still defaults to killing the
// process under Node >= 15, which drops every connected socket and every in-flight hunt save.
// Log loudly and stay up — a degraded API beats a dead one mid-stream. These handlers are
// deliberately last in the file so nothing can register ahead of them and swallow the signal.
process.on('unhandledRejection', (reason) => {
  console.error('[FATAL-GUARD] unhandledRejection — server kept alive:\n',
    reason && reason.stack ? reason.stack : reason);
});
process.on('uncaughtException', (err) => {
  console.error('[FATAL-GUARD] uncaughtException — server kept alive:\n',
    err && err.stack ? err.stack : err);
});

// Railway sends SIGTERM before replacing the container. Without a handler the process was killed
// outright, cutting in-flight persistHunts() writes mid-flight — visible in the Postgres log as a
// burst of "unexpected eof"/"connection reset by peer" at EVERY deploy. Drain instead: stop
// accepting new work, flush hunts/archive to the durable store, then close the pool. Bounded by a
// hard timeout so a stuck flush can never wedge a deploy. See lib/shutdown.js.
installGracefulShutdown({
  server,
  pgPool,
  // MUST be flushAll, not persistHunts()/persistArchive(). Since the write-coalescing change those
  // only SCHEDULE a 250ms trailing write — calling them here would queue a write and then exit
  // before it ran, losing exactly the data this handler exists to save. flushAll forces the
  // pending write AND waits for every in-flight one; it resolves rather than rejects, and takes
  // its own timeout, so a dead database cannot wedge the drain.
  flush: async () => { await persistence.flushAll({ timeoutMs: 5000 }); },
  log: (m) => console.log(m),
});

server.listen(PORT, () => console.log(`✅ Server on port ${PORT}`));
