// Multi-tenancy: per-tenant config (concierge-authored) + roles, in Postgres.
// Cached in memory; resolved per request via the X-Tenant-Slug header (see server.js).
// When MULTI_TENANT is off or no slug is sent, callers use BEAN_TENANT (single-tenant behavior).

// Bean's own Discord ID — used ONLY for Bean's tenant branding (host id, crown icon on his
// own hunts). Distinct from PLATFORM_OWNER_ID below: this constant was previously (wrongly)
// aliased to PLATFORM_OWNER_ID, which is actually Kyle's ID, not Bean's — Bean is the tenant
// and gets the crown; Kyle is a site co-owner and does not.
const BEAN_DISCORD_ID = '110983319176384512';

// Kyle is a platform co-owner (site founder/developer). Keep this a scalar — some legacy
// code paths reference it directly.
const PLATFORM_OWNER_ID = '135203806676779008';

// Platform OWNERS (plural) — the only site-wide admins: Kyle + Goofer, full stop. Hardcoded
// (not purely env-driven) so this doesn't depend on a Railway env var being set correctly —
// same reasoning as the Bean-mod seed below. Show the "Owner" badge and can never be removed
// via the admin UI. Extra owners can still be layered on via the PLATFORM_OWNER_IDS env var.
const PLATFORM_OWNER_IDS = [...new Set([
  PLATFORM_OWNER_ID,      // Kyle
  '168055630916091904',   // Goofer
  ...(process.env.PLATFORM_OWNER_IDS || '').split(',').map(s => s.trim()).filter(Boolean),
])];
function isPlatformOwnerId(id) { return !!id && PLATFORM_OWNER_IDS.includes(String(id)); }

// Default/fallback tenant — mirrors today's single-tenant Bean behavior.
// Env vars are used as initial seed values; once the DB row exists, the admin
// console is the source of truth (the seed is ON CONFLICT DO NOTHING).
const BEAN_TENANT = {
  id: 'bean', slug: 'bean', displayName: 'Bean',
  twitchChannel: 'bean',
  discordBotToken: process.env.DISCORD_BOT_TOKEN || '',
  discordGuildId: process.env.DISCORD_GUILD_ID || '',
  discordAffiliateRoleId: process.env.DISCORD_AFFILIATE_ROLE_ID || '',
  discordVipRoleId: process.env.DISCORD_VIP_ROLE_ID || '',
  discordModRoleId: process.env.DISCORD_MOD_ROLE_ID || '',
  discordCallsChannelId: process.env.DISCORD_CALLS_CHANNEL_ID || '',
  discordVipWinnersChannelId: process.env.DISCORD_WINNERS_CHANNEL_ID || '',
  discordAffiliateWinnersChannelId: process.env.DISCORD_AFFILIATE_WINNERS_CHANNEL_ID || '',
  leaderboardUrl: 'https://api-v2.beantwitch.com',
  hostDiscordId: BEAN_DISCORD_ID,
  // `casino` drives the slot-thumbnail deep links (front-end slotThumb.js). Bean is a
  // Rainbet partner, so his slots link to Rainbet. Tenants without a casino set render
  // slot art with NO casino link (white-label default — and no casino links on stream).
  branding: { hostName: 'Bean', crownDiscordId: BEAN_DISCORD_ID, accent: '#a78bfa', requiredRoles: ['affiliate'], discordInvite: 'https://discord.gg/beantwitch', casino: 'rainbet' },
  isActive: true,
  adminIds: [...new Set((process.env.ADMIN_IDS || '').split(',').map(s => s.trim()).filter(Boolean))],
  vipIds:   [...new Set((process.env.VIP_IDS   || '').split(',').map(s => s.trim()).filter(Boolean))],
  modIds:   [],
};

let pgPool = null;
const cache = new Map(); // slug -> tenant

async function initTenants(deps) {
  pgPool = deps.pgPool;
  cache.set('bean', BEAN_TENANT); // always available, even with no DB
  if (!pgPool) { console.log('[tenants] no DB — using in-memory Bean only'); return; }
  try {
    await pgPool.query(`
      CREATE TABLE IF NOT EXISTS tenants (
        id            TEXT PRIMARY KEY,
        slug          TEXT NOT NULL UNIQUE,
        display_name  TEXT NOT NULL,
        twitch_channel TEXT,
        discord_bot_token TEXT,
        discord_calls_channel_id TEXT,
        discord_winners_channel_id TEXT,
        leaderboard_url TEXT,
        host_discord_id TEXT,
        branding      JSONB NOT NULL DEFAULT '{}',
        is_active     BOOLEAN NOT NULL DEFAULT true,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
    await pgPool.query(`
      CREATE TABLE IF NOT EXISTS tenant_roles (
        tenant_id  TEXT NOT NULL,
        discord_id TEXT NOT NULL,
        role       TEXT NOT NULL CHECK (role IN ('admin','vip')),
        PRIMARY KEY (tenant_id, discord_id, role)
      )`);
    // Widen the role CHECK to allow 'community_mod' (per-community Mod role). CREATE TABLE
    // IF NOT EXISTS above is a no-op against the already-existing production table, so the
    // new value must be added via explicit ALTER. Safe on every boot: DROP CONSTRAINT IF
    // EXISTS never errors, and re-adding a strictly wider constraint doesn't affect existing
    // 'admin'/'vip' rows. Postgres's default name for an unnamed table CHECK is
    // `{table}_{column}_check`, matching what CREATE TABLE implicitly created above.
    await pgPool.query(`ALTER TABLE tenant_roles DROP CONSTRAINT IF EXISTS tenant_roles_role_check`);
    await pgPool.query(`ALTER TABLE tenant_roles ADD CONSTRAINT tenant_roles_role_check CHECK (role IN ('admin','vip','community_mod'))`);
    // New columns for per-tenant Discord role detection (moved from env vars).
    await pgPool.query(`ALTER TABLE tenants ADD COLUMN IF NOT EXISTS discord_guild_id TEXT`);
    await pgPool.query(`ALTER TABLE tenants ADD COLUMN IF NOT EXISTS discord_affiliate_role_id TEXT`);
    await pgPool.query(`ALTER TABLE tenants ADD COLUMN IF NOT EXISTS discord_vip_role_id TEXT`);
    await pgPool.query(`ALTER TABLE tenants ADD COLUMN IF NOT EXISTS discord_mod_role_id TEXT`);
    await pgPool.query(`ALTER TABLE tenants ADD COLUMN IF NOT EXISTS discord_affiliate_winners_channel_id TEXT`);
    // Seed Bean row if absent (from current env vars)
    await pgPool.query(
      `INSERT INTO tenants(id,slug,display_name,twitch_channel,discord_bot_token,
         discord_guild_id,discord_affiliate_role_id,discord_vip_role_id,discord_mod_role_id,
         discord_calls_channel_id,discord_winners_channel_id,discord_affiliate_winners_channel_id,
         leaderboard_url,host_discord_id,branding)
       VALUES('bean','bean','Bean',$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT(id) DO NOTHING`,
      [BEAN_TENANT.twitchChannel, BEAN_TENANT.discordBotToken,
       BEAN_TENANT.discordGuildId, BEAN_TENANT.discordAffiliateRoleId,
       BEAN_TENANT.discordVipRoleId, BEAN_TENANT.discordModRoleId,
       BEAN_TENANT.discordCallsChannelId, BEAN_TENANT.discordVipWinnersChannelId,
       BEAN_TENANT.discordAffiliateWinnersChannelId,
       BEAN_TENANT.leaderboardUrl, BEAN_TENANT.hostDiscordId,
       JSON.stringify(BEAN_TENANT.branding)]);
    // beantwitch.com moved its API host (api → api-v2, found 2026-07-04); the old origin 502s.
    // The seed above is ON CONFLICT DO NOTHING, so the existing prod row keeps the stale URL —
    // rewrite it here. Idempotent: only matches the exact old value, so a future manual change
    // to this column is never clobbered.
    await pgPool.query(
      `UPDATE tenants SET leaderboard_url='https://api-v2.beantwitch.com'
       WHERE leaderboard_url='https://api.beantwitch.com'`);
    // Activate role-gating for Bean's tenant: users need the 'affiliate' Discord role.
    await pgPool.query(
      `UPDATE tenants SET branding = branding || '{"requiredRoles":["affiliate"],"discordInvite":"https://discord.gg/beantwitch"}'::jsonb
       WHERE id='bean' AND NOT (branding ? 'requiredRoles')`);
    // Bean is a Rainbet partner → tag his tenant so slot thumbnails deep-link to Rainbet.
    // Idempotent; only sets it if unset, so a future manual change is never clobbered.
    await pgPool.query(
      `UPDATE tenants SET branding = branding || '{"casino":"rainbet"}'::jsonb
       WHERE id='bean' AND NOT (branding ? 'casino')`);
    // Correct Bean's host/crown id. Early seeds ran while BEAN_DISCORD_ID was wrongly aliased to
    // PLATFORM_OWNER_ID (135203806676779008, Kyle), so the prod row's host_discord_id +
    // branding.crownDiscordId point at Kyle, not Bean. The seed above is ON CONFLICT DO NOTHING, so
    // the stale value survived the constant being fixed. Repoint both to Bean's real account so the
    // crown and the auto-injected host equity row's cosmetics (frontend reads them by crownDiscordId)
    // resolve to Bean. Idempotent: only writes when a value still differs.
    await pgPool.query(
      `UPDATE tenants
         SET host_discord_id = $1,
             branding = branding || jsonb_build_object('crownDiscordId', $1::text)
       WHERE id='bean'
         AND (host_discord_id IS DISTINCT FROM $1
              OR (branding->>'crownDiscordId') IS DISTINCT FROM $1)`,
      [BEAN_DISCORD_ID]);
    // Seed Bean roles from current env (ADMIN_IDS/VIP_IDS) so nobody loses access
    for (const id of BEAN_TENANT.adminIds) await pgPool.query(`INSERT INTO tenant_roles VALUES('bean',$1,'admin') ON CONFLICT DO NOTHING`, [id]);
    for (const id of BEAN_TENANT.vipIds)   await pgPool.query(`INSERT INTO tenant_roles VALUES('bean',$1,'vip')   ON CONFLICT DO NOTHING`, [id]);
    // Seed Bean's initial Mod roster. Hardcoded (not env-driven) — no Railway env var or
    // manual script needed, this just works on the next deploy. Idempotent via ON CONFLICT
    // on the (tenant_id, discord_id, role) primary key. Includes Bean himself — he'll rarely
    // use the site personally, but the mods run everything for him under his own account too.
    const BEAN_MOD_SEED = [
      BEAN_DISCORD_ID,       // Bean
      '102963341407838208', // Mcflury
      '158594379773247489', // Missingiscool
      '197365493516992512', // mihailimou (nickname "Mih" — this spelling is canonical)
      '91723222743015424',  // Cuda
    ];
    for (const id of BEAN_MOD_SEED) await pgPool.query(`INSERT INTO tenant_roles VALUES('bean',$1,'community_mod') ON CONFLICT DO NOTHING`, [id]);
    await reloadCache();
    console.log(`[tenants] loaded ${cache.size} tenant(s)`);
  } catch(e) {
    console.error('[tenants] init failed (falling back to in-memory Bean):', e.message);
  }
}

async function reloadCache() {
  if (!pgPool) return;
  const { rows } = await pgPool.query('SELECT * FROM tenants WHERE is_active=true');
  const roleRows = (await pgPool.query('SELECT * FROM tenant_roles')).rows;
  cache.clear();
  for (const r of rows) {
    cache.set(r.slug, {
      id: r.id, slug: r.slug, displayName: r.display_name,
      twitchChannel: r.twitch_channel, discordBotToken: r.discord_bot_token,
      discordGuildId: r.discord_guild_id || '',
      discordAffiliateRoleId: r.discord_affiliate_role_id || '',
      discordVipRoleId: r.discord_vip_role_id || '',
      discordModRoleId: r.discord_mod_role_id || '',
      discordCallsChannelId: r.discord_calls_channel_id,
      discordVipWinnersChannelId: r.discord_winners_channel_id || '',
      discordAffiliateWinnersChannelId: r.discord_affiliate_winners_channel_id || '',
      leaderboardUrl: r.leaderboard_url, hostDiscordId: r.host_discord_id,
      branding: r.branding || {}, isActive: r.is_active,
      adminIds: roleRows.filter(x => x.tenant_id === r.id && x.role === 'admin').map(x => x.discord_id),
      vipIds:   roleRows.filter(x => x.tenant_id === r.id && x.role === 'vip').map(x => x.discord_id),
      modIds:   roleRows.filter(x => x.tenant_id === r.id && x.role === 'community_mod').map(x => x.discord_id),
    });
  }
  if (!cache.has('bean')) cache.set('bean', BEAN_TENANT);
  // When MULTI_TENANT is off, resolveTenant uses the static BEAN_TENANT object directly
  // (not the cache). Sync DB values back so admin-console changes take effect immediately.
  const dbBean = cache.get('bean');
  if (dbBean && dbBean !== BEAN_TENANT) Object.assign(BEAN_TENANT, dbBean);
}

function getTenantBySlug(slug) { return cache.get(slug) || null; }
function getAllTenants() { return [...cache.values()]; }
function isPlatformOwner(user) { return isPlatformOwnerId(user?.id); }
function isTenantAdmin(user, tenant) {
  if (!user?.id || !tenant) return false;
  if (isPlatformOwner(user)) return true;
  return (tenant.adminIds || []).includes(user.id);
}
function isTenantVip(user, tenant) {
  if (!user?.id || !tenant) return false;
  return isTenantAdmin(user, tenant) || (tenant.vipIds || []).includes(user.id);
}
// Per-community Mod role. Tenant admins (incl. platform owner) are always at least as
// powerful as a mod; otherwise must be in this tenant's modIds.
function isTenantMod(user, tenant) {
  if (!user?.id || !tenant) return false;
  if (isTenantAdmin(user, tenant)) return true;
  return (tenant.modIds || []).includes(user.id);
}

// ── Tenant-mod CRUD (DB-backed via tenant_roles role='community_mod') ──────
// Mirrors lib/admins.js's listDbAdmins/addDbAdmin/removeDbAdmin pattern, but tenant-scoped.
async function listTenantMods(tenantId) {
  if (!pgPool) return [];
  try {
    const r = await pgPool.query(
      `SELECT discord_id FROM tenant_roles WHERE tenant_id=$1 AND role='community_mod'`,
      [tenantId]);
    return r.rows.map(row => String(row.discord_id));
  } catch (e) { console.error('[tenants] listTenantMods failed:', e.message); return []; }
}
async function addTenantMod(tenantId, discordId) {
  if (!pgPool || !tenantId || !discordId) return;
  try {
    await pgPool.query(
      `INSERT INTO tenant_roles (tenant_id, discord_id, role) VALUES ($1,$2,'community_mod')
       ON CONFLICT DO NOTHING`,
      [tenantId, String(discordId)]);
    await reloadCache();
  } catch (e) { console.error('[tenants] addTenantMod failed:', e.message); throw e; }
}
async function removeTenantMod(tenantId, discordId) {
  if (!pgPool || !tenantId || !discordId) return;
  try {
    await pgPool.query(
      `DELETE FROM tenant_roles WHERE tenant_id=$1 AND discord_id=$2 AND role='community_mod'`,
      [tenantId, String(discordId)]);
    await reloadCache();
  } catch (e) { console.error('[tenants] removeTenantMod failed:', e.message); throw e; }
}

// ── Tenant Discord config CRUD (admin console) ──────────────────────────────
// Returns the Discord-related fields for a tenant (safe for admin eyes, never public).
function getTenantDiscordConfig(tenant) {
  if (!tenant) return null;
  return {
    discordBotToken: tenant.discordBotToken || '',
    discordGuildId: tenant.discordGuildId || '',
    discordAffiliateRoleId: tenant.discordAffiliateRoleId || '',
    discordVipRoleId: tenant.discordVipRoleId || '',
    discordModRoleId: tenant.discordModRoleId || '',
    discordCallsChannelId: tenant.discordCallsChannelId || '',
    discordVipWinnersChannelId: tenant.discordVipWinnersChannelId || '',
    discordAffiliateWinnersChannelId: tenant.discordAffiliateWinnersChannelId || '',
  };
}

async function updateTenantDiscordConfig(tenantId, config) {
  if (!pgPool || !tenantId) return;
  const camelToSnake = {
    discordBotToken: 'discord_bot_token',
    discordGuildId: 'discord_guild_id',
    discordAffiliateRoleId: 'discord_affiliate_role_id',
    discordVipRoleId: 'discord_vip_role_id',
    discordModRoleId: 'discord_mod_role_id',
    discordCallsChannelId: 'discord_calls_channel_id',
    discordVipWinnersChannelId: 'discord_winners_channel_id',
    discordAffiliateWinnersChannelId: 'discord_affiliate_winners_channel_id',
  };
  const sets = [];
  const vals = [];
  let idx = 1;
  for (const [camel, snake] of Object.entries(camelToSnake)) {
    if (camel in config) {
      sets.push(`${snake} = $${idx++}`);
      vals.push(String(config[camel] || '').trim());
    }
  }
  if (!sets.length) return;
  vals.push(tenantId);
  await pgPool.query(`UPDATE tenants SET ${sets.join(', ')} WHERE id = $${idx}`, vals);
  await reloadCache();
}

// ── Community socials (owner-editable) ──────────────────────────────────────
// Socials live in the branding JSONB (not columns), so update via jsonb_set — other branding
// keys (accent, plan, theme…) are untouched. Sanitized through sanitizeSocials so a community
// can never inject junk/markup or another identity; passing an empty array clears them. A tenant
// admin (the owner) may call this for their OWN tenant. Returns the saved list.
async function updateTenantSocials(tenantId, socials) {
  if (!pgPool || !tenantId) return [];
  const clean = sanitizeSocials(socials);
  await pgPool.query(
    `UPDATE tenants SET branding = jsonb_set(COALESCE(branding, '{}'::jsonb), '{socials}', $2::jsonb, true) WHERE id = $1`,
    [tenantId, JSON.stringify(clean)]);
  await reloadCache();
  return clean;
}

// ── Provision a new community tenant ───────────────────────────────────────
// Reserved first-path segments that can't be a community slug — mirrors the frontend
// RESERVED set (src/api.js currentSlug) plus backend-only routes + Bean.
const RESERVED_SLUGS = new Set([
  '', 'communities', 'explore', 'hunt', 'overlay', 'settings', 'auth', 'api', 'login', 'logout',
  'privacy', 'terms', 'demo', 'admin', 'extension', 'tracker', 'pricing', 'add-community',
  'widget', 'overdrop', 'share', 'affiliate-hunt', 'beans-hunt', 'bean', 'www', 'app', 'static',
]);
function isValidSlug(s) {
  return typeof s === 'string' && /^[a-z0-9](?:[a-z0-9-]{1,30})[a-z0-9]$/.test(s);
}
// Is this slug free to claim? (valid shape, not reserved, not already taken)
async function slugAvailable(slug) {
  const s = String(slug || '').toLowerCase().trim();
  if (!isValidSlug(s) || RESERVED_SLUGS.has(s)) return false;
  if (cache.has(s)) return false;
  if (pgPool) {
    const r = await pgPool.query('SELECT 1 FROM tenants WHERE slug=$1 OR id=$1', [s]);
    if (r.rows.length) return false;
  }
  return true;
}
// Create a community tenant: insert the row, make the owner a tenant admin, reload cache.
// Whitelisted social platform types (mirror the frontend SOCIAL_META keys). Each link must be
// an http(s) URL; unknown types and junk are dropped so a community can never inject arbitrary
// markup or someone else's identity into another hub.
const SOCIAL_TYPES = new Set(['rainbet', 'twitch', 'kick', 'discord', 'youtube', 'tiktok', 'x', 'instagram', 'website']);
function sanitizeSocials(input) {
  if (!Array.isArray(input)) return [];
  const out = [];
  for (const item of input) {
    if (!item || !SOCIAL_TYPES.has(item.type)) continue;
    const url = String(item.url || '').trim();
    if (!/^https?:\/\//i.test(url) || url.length > 300) continue;
    out.push({ type: item.type, url });
    if (out.length >= 12) break;
  }
  return out;
}

// The plan (community_starter/pro) is stored in branding so tenant-config + feature gating
// can read it. Discord is NOT configured here — a new community starts open (no role-gating)
// and wires its bot later via the admin Discord-config UI. This is the primitive both the
// admin "create community" action and (later) the Stripe self-serve webhook call.
async function createTenant({ slug, displayName, ownerId, plan, accent, twitchChannel, socials }) {
  const s = String(slug || '').toLowerCase().trim();
  const name = String(displayName || '').trim().slice(0, 60);
  const owner = String(ownerId || '').trim();
  if (!name) throw new Error('displayName required');
  if (!/^\d{5,}$/.test(owner)) throw new Error('valid ownerId (Discord ID) required');
  if (!(await slugAvailable(s))) throw new Error('Slug is taken or invalid');
  if (!pgPool) throw new Error('No database — cannot create tenant');
  const branding = { hostName: name, accent: accent || '#a78bfa', crownDiscordId: owner, plan: plan || 'community_starter' };
  const cleanSocials = sanitizeSocials(socials);
  if (cleanSocials.length) branding.socials = cleanSocials;
  await pgPool.query(
    `INSERT INTO tenants(id,slug,display_name,twitch_channel,host_discord_id,branding,is_active)
     VALUES($1,$1,$2,$3,$4,$5,true)`,
    [s, name, String(twitchChannel || '').trim() || null, owner, JSON.stringify(branding)]);
  await pgPool.query(`INSERT INTO tenant_roles VALUES($1,$2,'admin') ON CONFLICT DO NOTHING`, [s, owner]);
  await reloadCache();
  return getTenantBySlug(s);
}

// Delete a community tenant (row + its roles). Bean can never be deleted. Hunts tagged to the
// tenant are left in place — they simply stop resolving once the tenant is gone (harmless), and
// deleting user hunt data on a tenant removal would be surprising. Mainly for cleaning up tests.
async function deleteTenant(slug) {
  const s = String(slug || '').toLowerCase().trim();
  if (!s || s === 'bean') throw new Error('This tenant cannot be deleted');
  if (!pgPool) throw new Error('No database — cannot delete tenant');
  const r = await pgPool.query('SELECT 1 FROM tenants WHERE id=$1 OR slug=$1', [s]);
  if (!r.rows.length) throw new Error('Tenant not found');
  await pgPool.query('DELETE FROM tenant_roles WHERE tenant_id=$1', [s]);
  await pgPool.query('DELETE FROM tenants WHERE id=$1 OR slug=$1', [s]);
  await reloadCache();
  return { ok: true };
}

// Activate/deactivate a tenant (used when a community subscription is cancelled/reinstated).
// A deactivated tenant drops out of getAllTenants (directory) + reloadCache; Bean is never touched.
async function setTenantActive(slug, active) {
  const s = String(slug || '').toLowerCase().trim();
  if (!s || s === 'bean' || !pgPool) return;
  await pgPool.query('UPDATE tenants SET is_active=$2 WHERE id=$1 OR slug=$1', [s, !!active]);
  await reloadCache();
}

module.exports = { PLATFORM_OWNER_ID, PLATFORM_OWNER_IDS, isPlatformOwnerId,
  BEAN_TENANT, initTenants, reloadCache,
  getTenantBySlug, getAllTenants, isPlatformOwner, isTenantAdmin, isTenantVip, isTenantMod,
  listTenantMods, addTenantMod, removeTenantMod,
  getTenantDiscordConfig, updateTenantDiscordConfig, updateTenantSocials,
  isValidSlug, slugAvailable, createTenant, deleteTenant, setTenantActive };
