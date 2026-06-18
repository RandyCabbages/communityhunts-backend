// Community memberships — which communities (tenants) a user belongs to.
// A user can be a member of MANY communities (many-to-many), so this is its own table
// rather than a field on user_settings. Powers the homepage "Community members" stat
// and the per-user "your communities" list in Settings.
//
// Keyed by Discord user id + tenant slug. Safe with no DB (no-ops, returns empty).
// Injected pgPool via initMemberships() to avoid a circular require with server.js.

let pgPool = null;

async function initMemberships(deps) {
  pgPool = deps.pgPool;
  if (!pgPool) { console.log('[memberships] no DB — community membership disabled'); return; }
  try {
    await pgPool.query(`
      CREATE TABLE IF NOT EXISTS community_members (
        user_id    TEXT NOT NULL,
        tenant_id  TEXT NOT NULL,
        joined_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (user_id, tenant_id)
      )`);
    await pgPool.query(`CREATE INDEX IF NOT EXISTS community_members_tenant_idx ON community_members (tenant_id)`);
    console.log('[memberships] Postgres table ready');
  } catch (e) {
    console.error('[memberships] init failed:', e.message);
  }
}

// Add a user to a community. Idempotent (does nothing if already a member, keeps original joined_at).
// Safe to call on every login — that's how existing users get auto-attributed to the slug they
// signed in through. Returns true if the membership exists after the call.
async function joinCommunity(userId, tenantId) {
  if (!pgPool || !userId || !tenantId) return false;
  try {
    await pgPool.query(
      `INSERT INTO community_members (user_id, tenant_id) VALUES ($1, $2)
       ON CONFLICT (user_id, tenant_id) DO NOTHING`,
      [String(userId), String(tenantId)]
    );
    return true;
  } catch (e) {
    console.error('[memberships] join failed:', e.message);
    return false;
  }
}

// Remove a user from a community. Returns true on success.
async function leaveCommunity(userId, tenantId) {
  if (!pgPool || !userId || !tenantId) return false;
  try {
    await pgPool.query(
      `DELETE FROM community_members WHERE user_id=$1 AND tenant_id=$2`,
      [String(userId), String(tenantId)]
    );
    return true;
  } catch (e) {
    console.error('[memberships] leave failed:', e.message);
    return false;
  }
}

// Tenant slugs this user belongs to (most-recently-joined first).
async function getUserCommunities(userId) {
  if (!pgPool || !userId) return [];
  try {
    const r = await pgPool.query(
      `SELECT tenant_id FROM community_members WHERE user_id=$1 ORDER BY joined_at DESC`,
      [String(userId)]
    );
    return r.rows.map(row => row.tenant_id);
  } catch (e) {
    console.error('[memberships] getUserCommunities failed:', e.message);
    return [];
  }
}

// Member counts for every tenant → { [tenantId]: count }. One query; used by the directory.
async function getMemberCounts() {
  if (!pgPool) return {};
  try {
    const r = await pgPool.query(
      `SELECT tenant_id, COUNT(*)::int AS n FROM community_members GROUP BY tenant_id`
    );
    const out = {};
    for (const row of r.rows) out[row.tenant_id] = row.n;
    return out;
  } catch (e) {
    console.error('[memberships] getMemberCounts failed:', e.message);
    return {};
  }
}

// One-time backfill: attribute every previously-known user to Bean so existing stats aren't empty.
// Pulls from known_users (everyone who's ever logged in or appeared in a hunt). Idempotent — the
// INSERT ... ON CONFLICT DO NOTHING means re-running on every deploy is harmless.
async function backfillExistingUsersToBean(beanTenantId = 'bean') {
  if (!pgPool) return;
  try {
    const r = await pgPool.query(
      `INSERT INTO community_members (user_id, tenant_id)
       SELECT user_id, $1 FROM known_users
       ON CONFLICT (user_id, tenant_id) DO NOTHING`,
      [beanTenantId]
    );
    console.log(`[memberships] backfilled ${r.rowCount} existing user(s) → ${beanTenantId}`);
  } catch (e) {
    // known_users may not exist yet on a fresh DB; not fatal.
    console.error('[memberships] backfill failed:', e.message);
  }
}

module.exports = {
  initMemberships, joinCommunity, leaveCommunity,
  getUserCommunities, getMemberCounts, backfillExistingUsersToBean,
};
