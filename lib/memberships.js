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
    // One-time cleanup: the retired blanket auto-enroll attributed every signed-in user to Bean.
    // Now that membership == role (see reconcileMembership in auth.routes), wipe those stale rows
    // ONCE; Task 1's reconcile repopulates real affiliates as they authenticate. The meta_flags
    // INSERT is the guard — RETURNING yields a row only the first time, so the DELETE runs once
    // (a plain unguarded DELETE on every deploy would nuke affiliates who joined since).
    await pgPool.query(`CREATE TABLE IF NOT EXISTS meta_flags (
      key        TEXT PRIMARY KEY,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    const wipeFlag = await pgPool.query(
      `INSERT INTO meta_flags (key) VALUES ('bean_membership_wiped_v1')
       ON CONFLICT (key) DO NOTHING RETURNING key`
    );
    if (wipeFlag.rowCount > 0) {
      const del = await pgPool.query(`DELETE FROM community_members WHERE tenant_id = 'bean'`);
      console.log(`[memberships] one-time stale-bean wipe: removed ${del.rowCount} row(s)`);
    }
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
module.exports = {
  initMemberships, joinCommunity, leaveCommunity,
  getUserCommunities, getMemberCounts,
};
