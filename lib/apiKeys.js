// Per-community Developer API keys. One active key per tenant (keyed by slug).
// Stored HASHED (sha256, optional API_KEY_PEPPER → HMAC). Postgres-backed with an
// in-memory fallback Map (like other lib/* modules) so unit tests + no-DB boots work.
//
// DI: initApiKeys({ pgPool, getTenantBySlug, canUse }) — the latter two back requireApiKey /
// requireApiFeature (tenant resolution + tier gating) exported below.

const crypto = require('crypto');

const PEPPER = (process.env.API_KEY_PEPPER || '').trim();
let pgPool = null;
let getTenantBySlug = () => null;
let canUse = () => false;

// In-memory mirror: slug -> { keyHash, prefix, createdBy, createdAt, lastUsedAt }.
// Authoritative when no pgPool; a write-through cache when pgPool is set.
const mem = new Map();
// Positive lookup cache: keyHash -> { slug, at }. Invalidated on roll/revoke.
const hashCache = new Map();
const HASH_CACHE_TTL = 45 * 1000;
// Throttle last_used_at writes: slug -> last write ms.
const lastUsedWrite = new Map();

async function initApiKeys(deps) {
  pgPool = (deps && deps.pgPool) || null;
  if (deps && deps.getTenantBySlug) getTenantBySlug = deps.getTenantBySlug;
  if (deps && deps.canUse) canUse = deps.canUse;
  if (!pgPool) return;
  try {
    await pgPool.query(`
      CREATE TABLE IF NOT EXISTS tenant_api_keys (
        tenant_slug  TEXT PRIMARY KEY,
        key_hash     TEXT NOT NULL,
        key_prefix   TEXT NOT NULL,
        created_by   TEXT NOT NULL,
        created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
        last_used_at TIMESTAMPTZ
      )
    `);
    await pgPool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_tenant_api_keys_hash ON tenant_api_keys(key_hash)`);
    const r = await pgPool.query('SELECT tenant_slug,key_hash,key_prefix,created_by,created_at,last_used_at FROM tenant_api_keys');
    for (const x of r.rows) {
      mem.set(x.tenant_slug, {
        keyHash: x.key_hash,
        prefix: x.key_prefix,
        createdBy: x.created_by,
        // Postgres returns Date objects; normalize to ISO strings to match generateKey's shape.
        createdAt: x.created_at ? new Date(x.created_at).toISOString() : null,
        lastUsedAt: x.last_used_at ? new Date(x.last_used_at).toISOString() : null,
      });
    }
    console.log(`[apikeys] table ready (${mem.size} keys loaded)`);
  } catch (e) { console.error('[apikeys] init failed:', e.message); }
}

function hashKey(rawKey) {
  return PEPPER
    ? crypto.createHmac('sha256', PEPPER).update(rawKey).digest('hex')
    : crypto.createHash('sha256').update(rawKey).digest('hex');
}

function maskPrefix(rawKey) {
  // "ch_live_" + first 6 + "…" + last 4
  const body = rawKey.slice('ch_live_'.length);
  return `ch_live_${body.slice(0, 6)}…${body.slice(-4)}`;
}

function generateKey(slug, createdBy) {
  const rawKey = 'ch_live_' + crypto.randomBytes(32).toString('base64url');
  const keyHash = hashKey(rawKey);
  const prefix = maskPrefix(rawKey);
  const createdAt = new Date().toISOString();
  // Roll: drop any prior hash from the positive cache.
  const prior = mem.get(slug);
  if (prior) hashCache.delete(prior.keyHash);
  mem.set(slug, { keyHash, prefix, createdBy, createdAt, lastUsedAt: null });
  if (pgPool) {
    pgPool.query(
      `INSERT INTO tenant_api_keys(tenant_slug,key_hash,key_prefix,created_by,created_at)
       VALUES($1,$2,$3,$4,now())
       ON CONFLICT(tenant_slug) DO UPDATE SET key_hash=$2, key_prefix=$3, created_by=$4, created_at=now(), last_used_at=null`,
      [slug, keyHash, prefix, String(createdBy)]
    ).catch(e => console.error('[apikeys] save failed:', e.message));
  }
  return { rawKey, prefix };
}

function getKeyMeta(slug) {
  const row = mem.get(slug);
  if (!row) return null;
  return { prefix: row.prefix, createdAt: row.createdAt, lastUsedAt: row.lastUsedAt };
}

function revokeKey(slug) {
  const row = mem.get(slug);
  if (!row) return false;
  hashCache.delete(row.keyHash);
  mem.delete(slug);
  if (pgPool) pgPool.query(`DELETE FROM tenant_api_keys WHERE tenant_slug=$1`, [slug])
    .catch(e => console.error('[apikeys] delete failed:', e.message));
  return true;
}

function touchLastUsed(slug) {
  const now = Date.now();
  if ((lastUsedWrite.get(slug) || 0) > now - 60000) return; // throttle to ≤1/min
  lastUsedWrite.set(slug, now);
  const row = mem.get(slug);
  if (row) row.lastUsedAt = new Date(now).toISOString();
  if (pgPool) pgPool.query(`UPDATE tenant_api_keys SET last_used_at=now() WHERE tenant_slug=$1`, [slug])
    .catch(() => {});
}

// Returns { slug } or null. Uses the in-memory mirror (authoritative) + a short positive cache.
function lookupByRawKey(rawKey) {
  if (typeof rawKey !== 'string' || !rawKey.startsWith('ch_live_')) return null;
  const keyHash = hashKey(rawKey);
  const cached = hashCache.get(keyHash);
  if (cached && Date.now() - cached.at < HASH_CACHE_TTL) { touchLastUsed(cached.slug); return { slug: cached.slug }; }
  for (const [slug, row] of mem) {
    if (row.keyHash === keyHash) {
      hashCache.set(keyHash, { slug, at: Date.now() });
      touchLastUsed(slug);
      return { slug };
    }
  }
  return null;
}

function sendErr(res, status, code, message) {
  return res.status(status).json({ error: { code, message } });
}

// Public-layer auth: identify the tenant FROM THE KEY. Ignores X-Tenant-Slug — the public router
// is mounted AFTER resolveTenant (with the other DI routers), so req.tenant is already set from
// the header/default when this runs; we overwrite it with the key's tenant below. Rejects unknown
// keys, missing/deactivated tenants.
function requireApiKey(req, res, next) {
  const auth = req.headers.authorization || '';
  const raw = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  if (!raw) return sendErr(res, 401, 'unauthorized', 'Missing API key');
  let hit;
  try { hit = lookupByRawKey(raw); }
  catch (e) { return sendErr(res, 503, 'unavailable', 'Temporarily unavailable'); }
  if (!hit) return sendErr(res, 401, 'unauthorized', 'Invalid API key');
  const tenant = getTenantBySlug(hit.slug);
  if (!tenant || tenant.isActive === false) return sendErr(res, 403, 'forbidden', 'Community not available');
  req.apiTenant = tenant;
  req.apiTenantId = tenant.id;      // hunts-core data fns are keyed by tenant.id
  req.apiTier = tenant.plan;        // already normalized in the tenants cache
  // Defense-in-depth: resolveTenant ran earlier and set req.tenant from the header/default.
  // Overwrite it with the KEY's tenant so any stray req.tenant read can't cross tenants.
  req.tenant = tenant;
  next();
}

// Tier gate via the existing feature system. individualTier is always null (community capability).
function requireApiFeature(featureName) {
  return (req, res, next) => {
    if (!canUse(featureName, null, req.apiTier)) {
      return sendErr(res, 403, 'forbidden_tier', 'Your plan does not include this endpoint');
    }
    next();
  };
}

module.exports = {
  initApiKeys, hashKey, generateKey, getKeyMeta, revokeKey, lookupByRawKey,
  requireApiKey, requireApiFeature, sendErr,
};
