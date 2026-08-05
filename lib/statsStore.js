// lib/statsStore.js
// Durable per-hunt history + per-user rollup. Additive to the 100-cap archive.
const { computeUserHuntStats, STATS_VERSION } = require('./userStats');
const { isRealDiscordId } = require('./userIds');
const { aggregateCommunityStats } = require('./communityStats');

// `whenReady` (optional) is awaited before any rollup is COMPUTED — see recomputeUser.
module.exports = function makeStatsStore({ pgPool, fxRates, whenReady }) {
  function huntKey(hunt) {
    if (hunt && hunt.huntId) return String(hunt.huntId);
    return `${hunt?.user?.id}|${hunt?.startedAt}`;
  }

  // Equity rows identify a person by `discordId` (or, on legacy rows, a stamped one — see
  // stampEquity). The `id` field is a per-row UUID and must never be treated as a user id.
  const PLACEHOLDER_IDS = new Set(['creator_auto', 'bean_auto']);
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const eqUserId = (e) =>
    (e && e.discordId != null && e.discordId !== '') ? String(e.discordId)
      : (e && e.id != null ? String(e.id) : '');
  // A real, attributable user id: not empty, not an auto placeholder, not a per-row UUID.
  const isRealUserId = (x) => !!x && !PLACEHOLDER_IDS.has(x) && !UUID_RE.test(x);

  function participantsOf(hunt) {
    const out = new Map(); // userId -> role
    const hostId = hunt?.user?.id;
    for (const e of (hunt?.equity || [])) {
      const uid = eqUserId(e);
      if (isRealUserId(uid)) out.set(uid, 'member');
    }
    if (hostId) out.set(String(hostId), 'host'); // host wins
    return [...out.entries()].map(([userId, role]) => ({ userId, role }));
  }

  // Name index: lower(display_name|username) -> user_id, from known_users. Ambiguous names
  // (mapping to >1 user) are dropped so we never misattribute. Cached ~5min (per store instance).
  let _nameIdx = null, _nameIdxAt = 0;
  async function getNameIndex() {
    if (_nameIdx && Date.now() - _nameIdxAt < 5 * 60 * 1000) return _nameIdx;
    const idx = new Map();
    if (pgPool) {
      try {
        const r = await pgPool.query('SELECT user_id, display_name, username FROM known_users');
        const dupes = new Set();
        for (const row of r.rows) {
          const uid = String(row.user_id);
          // Skip anything that isn't a real Discord login (e.g. "manual:cabbage") — keeping them
          // makes a shared display name ambiguous, which drops the name from the index and
          // silently under-counts the REAL user who shares that name.
          if (!isRealDiscordId(uid)) continue;
          for (const nm of [row.display_name, row.username]) {
            const k = nm && String(nm).trim().toLowerCase();
            if (!k) continue;
            if (idx.has(k) && idx.get(k) !== uid) dupes.add(k);
            else idx.set(k, uid);
          }
        }
        for (const k of dupes) idx.delete(k);
      } catch (e) { console.error('[stats] name index load failed:', e.message); }
    }
    _nameIdx = idx; _nameIdxAt = Date.now();
    return idx;
  }

  // Fill in equity[].discordId from the name index for rows that lack one, so attribution
  // (which keys on discordId) works for hunts recorded before the frontend captured discordId.
  function stampEquity(hunt, idx) {
    if (!hunt || !Array.isArray(hunt.equity)) return hunt;
    const equity = hunt.equity.map(e => {
      if (e && (e.discordId == null || e.discordId === '') && e.name) {
        const uid = idx.get(String(e.name).trim().toLowerCase());
        if (uid) return { ...e, discordId: uid };
      }
      return e;
    });
    return { ...hunt, equity };
  }

  const isoDate = (d) => (d ? new Date(d) : new Date()).toISOString().slice(0, 10);
  const endedAt = (h) => h.archivedAt || h.updatedAt || h.createdAt || h.startedAt || new Date().toISOString();

  async function ensureTables() {
    if (fxRates) await fxRates.ensureTable();
    if (!pgPool) return;
    await pgPool.query(`
      CREATE TABLE IF NOT EXISTS hunt_history (
        hunt_key     TEXT PRIMARY KEY,
        tenant_id    TEXT NOT NULL,
        host_user_id TEXT,
        currency     TEXT,
        usd_rate     NUMERIC,
        started_at   TIMESTAMPTZ,
        ended_at     TIMESTAMPTZ,
        snapshot     JSONB NOT NULL
      )`);
    await pgPool.query(`CREATE INDEX IF NOT EXISTS hunt_history_tenant_ended ON hunt_history (tenant_id, ended_at)`);
    await pgPool.query(`
      CREATE TABLE IF NOT EXISTS hunt_participants (
        hunt_key  TEXT NOT NULL,
        tenant_id TEXT NOT NULL,
        user_id   TEXT NOT NULL,
        role      TEXT,
        PRIMARY KEY (hunt_key, user_id)
      )`);
    await pgPool.query(`CREATE INDEX IF NOT EXISTS hunt_participants_tenant_user ON hunt_participants (tenant_id, user_id)`);
    // The composite above leads with tenant_id, so it cannot serve the cross-tenant lookup behind
    // getUserStatsAllTenants (user_id alone). That query would otherwise seq-scan the table.
    await pgPool.query(`CREATE INDEX IF NOT EXISTS hunt_participants_user ON hunt_participants (user_id)`);
    await pgPool.query(`
      CREATE TABLE IF NOT EXISTS user_hunt_stats (
        tenant_id TEXT NOT NULL,
        user_id   TEXT NOT NULL,
        hunts INT, hosted INT, joined INT,
        wagered_usd NUMERIC, won_usd NUMERIC, net_usd NUMERIC, win_rate NUMERIC,
        avg_start_usd NUMERIC, avg_x NUMERIC, biggest_win NUMERIC, highest_mult NUMERIC,
        best_hunt_net NUMERIC, worst_hunt_net NUMERIC,
        longest_win_streak INT, longest_loss_streak INT, last_hunt_at TIMESTAMPTZ,
        stats JSONB NOT NULL, updated_at TIMESTAMPTZ DEFAULT now(),
        PRIMARY KEY (tenant_id, user_id)
      )`);
  }

  // Every handle a user is known by, for attributing the free-text `caller` field on a bonus back
  // to them. Best-effort by design: a missing table or a bad row costs the calling record, which
  // must never be allowed to fail a rollup that is otherwise correct.
  async function namesFor(userId, exec = pgPool) {
    if (!exec) return [];
    try {
      const r = await exec.query(
        `SELECT (SELECT display_name FROM known_users  WHERE user_id=$1) AS display_name,
                (SELECT username     FROM known_users  WHERE user_id=$1) AS username,
                (SELECT settings     FROM user_settings WHERE user_id=$1) AS settings`, [userId]);
      const row = r.rows[0] || {};
      const s = row.settings || {};
      return [row.display_name, row.username, s.rainbetName, s.twitchName]
        .map(n => (n == null ? '' : String(n).trim()))
        .filter(Boolean);
    } catch (e) {
      console.error('[stats] name lookup failed for', userId, '-', e.message);
      return [];
    }
  }

  // `exec` is just the query runner, and today every caller uses the default pool: rollups moved
  // OUT of recordHunt/removeHunt's transaction into refreshRollups, which runs after the COMMIT.
  // Worth being precise about, because the `await whenReady()` below would be a genuine deadlock
  // risk if this still ran on a checked-out transaction client — it doesn't.
  async function recomputeUser(tenantId, userId, exec = pgPool) {
    // The rollup stores member NAMES (hostOperator.topMembers), masked at compute time against the
    // anonymity set. Computing before that set is hydrated writes an anonymous member's real name
    // into a cache stamped with the CURRENT version — so it is never recomputed and never heals.
    // Gate the compute, not the read: a rollup that is merely stale is harmless.
    if (whenReady) await whenReady();
    if (!exec) return;
    const r = await exec.query(
      `SELECT h.snapshot FROM hunt_history h
         JOIN hunt_participants p ON p.hunt_key = h.hunt_key
        WHERE p.tenant_id = $1 AND p.user_id = $2`, [tenantId, userId]);
    const hunts = r.rows.map(row => row.snapshot);
    const s = computeUserHuntStats(hunts, userId, { names: await namesFor(userId, exec) });
    const t = s.tiles, rec = s.records;
    const lastHunt = s.pastHunts[0] ? s.pastHunts[0].date : null;
    await exec.query(
      `INSERT INTO user_hunt_stats
         (tenant_id,user_id,hunts,hosted,joined,wagered_usd,won_usd,net_usd,win_rate,
          avg_start_usd,avg_x,biggest_win,highest_mult,best_hunt_net,worst_hunt_net,
          longest_win_streak,longest_loss_streak,last_hunt_at,stats,updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,now())
       ON CONFLICT (tenant_id,user_id) DO UPDATE SET
         hunts=$3,hosted=$4,joined=$5,wagered_usd=$6,won_usd=$7,net_usd=$8,win_rate=$9,
         avg_start_usd=$10,avg_x=$11,biggest_win=$12,highest_mult=$13,best_hunt_net=$14,
         worst_hunt_net=$15,longest_win_streak=$16,longest_loss_streak=$17,last_hunt_at=$18,
         stats=$19,updated_at=now()`,
      [tenantId, userId, t.hunts, t.hosted, t.joined, s.usd.wagered, s.usd.won, s.usd.net,
       t.winRate, s.usd.avgStart, t.avgMult, rec.biggestWin, rec.highestMult, rec.bestHuntNet,
       rec.worstHuntNet, rec.longestWinStreak, rec.longestLossStreak, lastHunt, s]);
  }

  // Refresh the per-user rollups for a set of users, on the POOL and AFTER the caller's
  // transaction has committed.
  //
  // These used to run inside it: `for (const uid of affected) await recomputeUser(..., client)`.
  // recomputeUser reads every snapshot that user has ever participated in (full JSONB, ~16 kB
  // each) and writes back a ~17 kB rollup, so the transaction's cost was
  // O(participants × their lifetime hunts × snapshot size) — serially, on one pooled connection,
  // holding a write transaction open the whole time. Measured worst case 2026-07-27: 711 snapshots
  // ≈ 11 MB for a single archive, and it scales as (hunts per tenant) × (regulars).
  //
  // Rollups are DERIVED. Making the hunt durable must not depend on recomputing them, and they
  // must not extend the transaction that does. A failure here is logged, never thrown: the hunt is
  // already committed, and the stale rollup self-heals on that user's next hunt.
  async function refreshRollups(tenantId, userIds) {
    for (const uid of userIds) {
      try {
        await recomputeUser(tenantId, uid);
      } catch (e) {
        console.error('[stats] rollup recompute failed for', uid, '-', e.message);
      }
    }
  }

  async function recordHunt(hunt, opts = {}) {
    if (!pgPool || !hunt || !hunt.user) return;
    const tenantId = hunt.tenantId || 'bean';
    const key = huntKey(hunt);
    const ended = endedAt(hunt);
    const override = opts.usdRate != null && isFinite(Number(opts.usdRate));
    const usdRate = override
      ? Number(opts.usdRate)
      : (fxRates ? await fxRates.getUsdRate(hunt.currency || 'USD', isoDate(ended)) : null);
    const stamped = stampEquity(hunt, await getNameIndex());  // resolve equity names -> discordId
    // `approx` normally follows the override (an admin-supplied rate is by definition a guess at
    // the historical one). opts.approx lets a caller that is REPLAYING an already-stored rate keep
    // the flag it was stored with — see reassignHuntOwner, where flipping a hunt to "approximate"
    // as a side effect of a name change would be a lie about the money.
    const snapshot = {
      ...stamped, usdRate,
      approx: opts.approx != null ? !!opts.approx : (override ? true : !!hunt._approxRate),
    };
    const newParts = participantsOf(stamped);
    const client = await pgPool.connect();
    let affected = new Set();   // hoisted: the rollups are refreshed AFTER the commit below
    try {
      await client.query('BEGIN');
      // Union old + new participants so a user dropped from equity gets their rollup refreshed too.
      const old = await client.query('SELECT user_id FROM hunt_participants WHERE hunt_key=$1', [key]);
      affected = new Set([...old.rows.map(r => String(r.user_id)), ...newParts.map(p => p.userId)]);
      await client.query(
        `INSERT INTO hunt_history
           (hunt_key,tenant_id,host_user_id,currency,usd_rate,started_at,ended_at,snapshot)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (hunt_key) DO UPDATE SET
           tenant_id=$2,host_user_id=$3,currency=$4,usd_rate=$5,started_at=$6,ended_at=$7,snapshot=$8`,
        [key, tenantId, hunt.user.id, hunt.currency || 'USD', usdRate,
         hunt.startedAt || null, ended, snapshot]);
      await client.query('DELETE FROM hunt_participants WHERE hunt_key=$1', [key]);
      for (const p of newParts) {
        await client.query(
          `INSERT INTO hunt_participants (hunt_key,tenant_id,user_id,role) VALUES ($1,$2,$3,$4)
           ON CONFLICT (hunt_key,user_id) DO UPDATE SET role=$4`,
          [key, tenantId, p.userId, p.role]);
      }
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      client.release();
    }
    // Derived rollups, refreshed only once the hunt is durable — see refreshRollups.
    await refreshRollups(tenantId, affected);
  }

  async function removeHunt(hunt) {
    if (!pgPool || !hunt) return;
    const tenantId = hunt.tenantId || 'bean';
    const key = huntKey(hunt);
    const newParts = participantsOf(stampEquity(hunt, await getNameIndex()));
    const client = await pgPool.connect();
    let affected = new Set();
    try {
      await client.query('BEGIN');
      // Union stored participants with the passed hunt's so every affected rollup is refreshed.
      const old = await client.query('SELECT user_id FROM hunt_participants WHERE hunt_key=$1', [key]);
      affected = new Set([...old.rows.map(r => String(r.user_id)), ...newParts.map(p => p.userId)]);
      await client.query('DELETE FROM hunt_history WHERE hunt_key=$1', [key]);
      await client.query('DELETE FROM hunt_participants WHERE hunt_key=$1', [key]);
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      client.release();
    }
    await refreshRollups(tenantId, affected);
  }

  // Correct a stored hunt's currency IN PLACE in hunt_history and recompute every participant's
  // rollup. Reuses recordHunt's upsert+recompute transaction (no parallel logic to drift). The
  // SELECT is tenant-scoped so an admin can only touch their own tenant's hunts. Optional usdRate
  // overrides the auto-fetched rate (volatile currencies on old hunts — see fxRates latest-only).
  async function correctHuntCurrency(tenantId, huntKey, { currency, usdRate } = {}) {
    if (!pgPool) return { notFound: true };
    const r = await pgPool.query(
      'SELECT snapshot FROM hunt_history WHERE hunt_key=$1 AND tenant_id=$2', [huntKey, tenantId]);
    if (!r.rows[0]) return { notFound: true };
    const corrected = { ...r.rows[0].snapshot, currency };
    await recordHunt(corrected, usdRate != null ? { usdRate } : {});
    return { ok: true };
  }

  // Delete a stored hunt by key (admin tool). Mirrors removeHunt's transaction but keyed, since
  // the admin has no hunt object — participants come from the stored hunt_participants rows.
  async function deleteHuntByKey(tenantId, huntKey) {
    if (!pgPool) return { ok: true };
    const client = await pgPool.connect();
    let affected = new Set();
    try {
      await client.query('BEGIN');
      const old = await client.query('SELECT user_id FROM hunt_participants WHERE hunt_key=$1', [huntKey]);
      affected = new Set(old.rows.map(r => String(r.user_id)));
      await client.query('DELETE FROM hunt_history WHERE hunt_key=$1 AND tenant_id=$2', [huntKey, tenantId]);
      await client.query('DELETE FROM hunt_participants WHERE hunt_key=$1', [huntKey]);
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      client.release();
    }
    await refreshRollups(tenantId, affected);
    return { ok: true };
  }

  // Move a stored hunt to a different owner (admin tool). The durable companion to
  // lib/huntReassign.js, which moves the live + archived copies: without this the Hall of Fame
  // ticket and the Archived tab would say one name while every stats page still credited another.
  //
  // Reuses recordHunt's upsert so participants and rollups come from ONE code path. participantsOf
  // promotes the new owner to 'host'; the previous owner keeps a 'member' row if they hold equity
  // and otherwise drops out entirely — and because recordHunt refreshes the UNION of the stored
  // and new participants, their totals shed this hunt either way.
  async function reassignHuntOwner(tenantId, key, owner) {
    if (!pgPool || !owner || !owner.id) return { notFound: true };
    const r = await pgPool.query(
      'SELECT snapshot FROM hunt_history WHERE hunt_key=$1 AND tenant_id=$2', [key, tenantId]);
    // Not an error: a hunt that was never archived has no hunt_history row yet, and it will be
    // recorded under the new owner whenever it does end.
    if (!r.rows[0]) return { notFound: true };
    const snap = r.rows[0].snapshot || {};
    const moved = {
      ...snap,
      user: {
        ...(snap.user || {}),
        id: String(owner.id),
        displayName: owner.displayName || String(owner.id),
        avatar: owner.avatar ?? null,
      },
    };
    // huntKey() prefers huntId, which survives the move untouched. Without one the key is
    // `user.id|startedAt`, so changing the owner effectively RENAMES the row — drop the old one or
    // the hunt exists twice, with the stale copy still crediting the previous owner everywhere.
    const newKey = huntKey(moved);
    // WRITE FIRST, delete second. If recordHunt throws, the original row is untouched and the whole
    // reassign can be retried; deleting first would turn the same failure into a hunt that exists
    // in nobody's history at all. The reverse failure (delete throws after the write) leaves a
    // visible duplicate, which is recoverable — a hole is not.
    //
    // Replay the STORED fx rate instead of letting recordHunt re-fetch it: fxRates only knows
    // today's rate, so a refetch would quietly restate an old non-USD hunt's USD totals as a side
    // effect of a name change. Same reason correctHuntCurrency exposes a usdRate override.
    await recordHunt(moved, snap.usdRate != null
      ? { usdRate: snap.usdRate, approx: !!snap.approx }
      : {});
    // Ordered after the write for a second reason: this refreshes the OLD owner's rollup, and it
    // has to run once the row it was reading is gone or the totals it recomputes still include it.
    if (newKey !== String(key)) await deleteHuntByKey(tenantId, key);
    return { ok: true, huntKey: newKey };
  }

  async function readRow(tenantId, userId) {
    const r = await pgPool.query('SELECT stats FROM user_hunt_stats WHERE tenant_id=$1 AND user_id=$2', [tenantId, userId]);
    return r.rows[0] ? r.rows[0].stats : null;
  }

  async function getUserStats(tenantId, userId) {
    if (!pgPool) return null;
    let s = await readRow(tenantId, userId);
    // A row written by an OLDER shape is as useless as no row: nothing else recomputes a rollup
    // until that user's next hunt, so a missing version stamp would leave every existing user
    // staring at blank new tiles indefinitely. Recompute on mismatch, once, then it sticks.
    if (!s || s.v !== STATS_VERSION) {
      await recomputeUser(tenantId, userId);
      s = await readRow(tenantId, userId);
    }
    return s;
  }

  // Cross-community totals for the personal stats page. `/tracker/stats` carries no tenant, so
  // without this it silently resolves to Bean and under-reports anyone who hunts in more than one
  // community — while the page's own header claims to cover every community.
  //
  // Deliberately NOT materialized: user_hunt_stats is keyed by (tenant_id, user_id), and a second
  // rollup keyed differently is a second thing that can go stale. Computed on demand and cached
  // briefly instead, same shape of tradeoff as getCommunityStats.
  const ALL_TENANT_TTL = 60 * 1000;
  const ALL_TENANT_CACHE_MAX = 500;
  const _allTenantCache = new Map();   // userId -> { at, stats }

  async function getUserStatsAllTenants(userId) {
    if (!pgPool) return null;
    const hit = _allTenantCache.get(userId);
    if (hit && Date.now() - hit.at < ALL_TENANT_TTL) return hit.stats;
    const r = await pgPool.query(
      `SELECT h.snapshot FROM hunt_history h
         JOIN hunt_participants p ON p.hunt_key = h.hunt_key
        WHERE p.user_id = $1`, [userId]);
    const stats = computeUserHuntStats(
      r.rows.map(row => row.snapshot), userId, { names: await namesFor(userId) });
    // Bounded rather than LRU — entries are 60s-lived, so a flat clear at the cap is enough to
    // stop an unbounded map without pretending to be an eviction policy.
    if (_allTenantCache.size >= ALL_TENANT_CACHE_MAX) _allTenantCache.clear();
    _allTenantCache.set(userId, { at: Date.now(), stats });
    return stats;
  }

  // Tenant-wide proof numbers for the PUBLIC homepage band. Cached ~10 min per tenant.
  // The cache is required, not an optimization: this backs an UNAUTHENTICATED landing-page
  // route and the query pulls every hunt_history snapshot for the tenant (232 JSONB rows for
  // 'bean' today), so uncached, every anonymous homepage visit is a full table scan.
  // Staleness is harmless — these are all-time totals that move a few times a day.
  const COMMUNITY_TTL = 10 * 60 * 1000;
  const _communityCache = new Map();   // tenantId -> { at, stats }

  async function getCommunityStats(tenantId) {
    const empty = { hunts: 0, bonuses: 0, usdWon: 0, approx: 0 };
    if (!pgPool) return empty;
    const hit = _communityCache.get(tenantId);
    if (hit && Date.now() - hit.at < COMMUNITY_TTL) return hit.stats;
    const r = await pgPool.query(
      'SELECT usd_rate, snapshot FROM hunt_history WHERE tenant_id=$1', [tenantId]);
    const stats = aggregateCommunityStats(r.rows);
    _communityCache.set(tenantId, { at: Date.now(), stats });
    return stats;
  }

  return { huntKey, participantsOf, ensureTables, recomputeUser, recordHunt, removeHunt,
    correctHuntCurrency, deleteHuntByKey, reassignHuntOwner,
    getUserStats, getUserStatsAllTenants, getCommunityStats };
};
