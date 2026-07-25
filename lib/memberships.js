// Community memberships — which communities (tenants) a user belongs to.
// A user can be a member of MANY communities (many-to-many), so this is its own table
// rather than a field on user_settings. Powers the homepage "Community members" stat
// and the per-user "your communities" list in Settings.
//
// A row carries HOW it got there (`source`), because two different things write this table and
// only one of them should ever be auto-removed:
//   'role' — reconcileMembership (auth.routes) mirroring the user's current Discord role. It runs
//            on EVERY login and evicts when the role is gone, so it must only ever touch its own
//            rows.
//   'self' — the user pressed Join in Settings. Deliberate, so it outranks role churn and
//            survives losing a role. Only an explicit Leave removes it.
// Before `source` existed, reconcile evicted indiscriminately and silently wiped every deliberate
// join at the user's next sign-in — the Join button did nothing that lasted (2026-07-25).
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
    // In-place migration (same pattern as lib/tenants.js / lib/apiKeys.js). The DEFAULT *is* the
    // backfill: every pre-existing row was written by reconcileMembership, so 'role' is accurate
    // for all of them rather than an assumption.
    await pgPool.query(
      `ALTER TABLE community_members ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'role'`);
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

// Add a user to a community. Idempotent (keeps the original joined_at). Returns true if the
// membership exists after the call.
//
// The two sources conflict-resolve differently, and that asymmetry is the whole mechanism:
//   'self' (default, the Settings button) UPGRADES an existing 'role' row, so a user who opts in
//          keeps membership after their Discord role lapses.
//   'role' (reconcileMembership, on every login) DOES NOTHING on conflict, so it can never
//          downgrade a deliberate join back to something it is then allowed to evict.
async function joinCommunity(userId, tenantId, source = 'self') {
  if (!pgPool || !userId || !tenantId) return false;
  const src = source === 'role' ? 'role' : 'self';
  const onConflict = src === 'self'
    ? `ON CONFLICT (user_id, tenant_id) DO UPDATE SET source = 'self'`
    : `ON CONFLICT (user_id, tenant_id) DO NOTHING`;
  try {
    await pgPool.query(
      `INSERT INTO community_members (user_id, tenant_id, source) VALUES ($1, $2, $3)
       ${onConflict}`,
      [String(userId), String(tenantId), src]
    );
    return true;
  } catch (e) {
    console.error('[memberships] join failed:', e.message);
    return false;
  }
}

// Remove a user from a community. Returns true on success.
//
// `onlySource` scopes the delete. reconcileMembership passes 'role' so an automatic eviction can
// never remove a deliberate join; an explicit Leave passes nothing, because choosing to leave
// means leave regardless of how the row got there.
async function leaveCommunity(userId, tenantId, { onlySource } = {}) {
  if (!pgPool || !userId || !tenantId) return false;
  try {
    if (onlySource) {
      await pgPool.query(
        `DELETE FROM community_members WHERE user_id=$1 AND tenant_id=$2 AND source=$3`,
        [String(userId), String(tenantId), String(onlySource)]
      );
    } else {
      await pgPool.query(
        `DELETE FROM community_members WHERE user_id=$1 AND tenant_id=$2`,
        [String(userId), String(tenantId)]
      );
    }
    return true;
  } catch (e) {
    console.error('[memberships] leave failed:', e.message);
    return false;
  }
}

// How this user's membership of this tenant came about: 'role' | 'self' | null (not a member).
//
// Read on the extension entitlement hot path, so it stays a single PK lookup — never grow this
// into a join. Fails closed to null: "not a member" denies the Partner extension perk, which is
// the safe direction for a paid product.
async function getMembershipSource(userId, tenantId) {
  if (!pgPool || !userId || !tenantId) return null;
  try {
    const r = await pgPool.query(
      `SELECT source FROM community_members WHERE user_id=$1 AND tenant_id=$2`,
      [String(userId), String(tenantId)]
    );
    return r.rows.length ? String(r.rows[0].source) : null;
  } catch (e) {
    console.error('[memberships] getMembershipSource failed:', e.message);
    return null;
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
  getUserCommunities, getMemberCounts, getMembershipSource,
};
