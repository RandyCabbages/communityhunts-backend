// lib/statsStore.js
// Durable per-hunt history + per-user rollup. Additive to the 100-cap archive.
const { computeUserHuntStats } = require('./userStats');

module.exports = function makeStatsStore({ pgPool, fxRates }) {
  function huntKey(hunt) {
    if (hunt && hunt.huntId) return String(hunt.huntId);
    return `${hunt?.user?.id}|${hunt?.startedAt}`;
  }

  function participantsOf(hunt) {
    const out = new Map(); // userId -> role
    const hostId = hunt?.user?.id;
    for (const e of (hunt?.equity || [])) {
      const id = e && e.id;
      if (id) out.set(String(id), 'member');
    }
    if (hostId) out.set(String(hostId), 'host'); // host wins
    return [...out.entries()].map(([userId, role]) => ({ userId, role }));
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

  // exec defaults to pgPool so getUserStats' fallback works without a transaction;
  // recordHunt/removeHunt pass their transaction client so the rollup writes atomically.
  async function recomputeUser(tenantId, userId, exec = pgPool) {
    if (!exec) return;
    const r = await exec.query(
      `SELECT h.snapshot FROM hunt_history h
         JOIN hunt_participants p ON p.hunt_key = h.hunt_key
        WHERE p.tenant_id = $1 AND p.user_id = $2`, [tenantId, userId]);
    const hunts = r.rows.map(row => row.snapshot);
    const s = computeUserHuntStats(hunts, userId);
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

  async function recordHunt(hunt) {
    if (!pgPool || !hunt || !hunt.user) return;
    const tenantId = hunt.tenantId || 'bean';
    const key = huntKey(hunt);
    const ended = endedAt(hunt);
    const usdRate = fxRates ? await fxRates.getUsdRate(hunt.currency || 'USD', isoDate(ended)) : null;
    const snapshot = { ...hunt, usdRate, approx: !!hunt._approxRate };
    const newParts = participantsOf(hunt);
    const client = await pgPool.connect();
    try {
      await client.query('BEGIN');
      // Union old + new participants so a user dropped from equity gets their rollup refreshed too.
      const old = await client.query('SELECT user_id FROM hunt_participants WHERE hunt_key=$1', [key]);
      const affected = new Set([...old.rows.map(r => String(r.user_id)), ...newParts.map(p => p.userId)]);
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
      for (const uid of affected) await recomputeUser(tenantId, uid, client);
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  }

  async function removeHunt(hunt) {
    if (!pgPool || !hunt) return;
    const tenantId = hunt.tenantId || 'bean';
    const key = huntKey(hunt);
    const newParts = participantsOf(hunt);
    const client = await pgPool.connect();
    try {
      await client.query('BEGIN');
      // Union stored participants with the passed hunt's so every affected rollup is refreshed.
      const old = await client.query('SELECT user_id FROM hunt_participants WHERE hunt_key=$1', [key]);
      const affected = new Set([...old.rows.map(r => String(r.user_id)), ...newParts.map(p => p.userId)]);
      await client.query('DELETE FROM hunt_history WHERE hunt_key=$1', [key]);
      await client.query('DELETE FROM hunt_participants WHERE hunt_key=$1', [key]);
      for (const uid of affected) await recomputeUser(tenantId, uid, client);
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  }

  async function readRow(tenantId, userId) {
    const r = await pgPool.query('SELECT stats FROM user_hunt_stats WHERE tenant_id=$1 AND user_id=$2', [tenantId, userId]);
    return r.rows[0] ? r.rows[0].stats : null;
  }

  async function getUserStats(tenantId, userId) {
    if (!pgPool) return null;
    let s = await readRow(tenantId, userId);
    if (!s) { await recomputeUser(tenantId, userId); s = await readRow(tenantId, userId); }
    return s;
  }

  return { huntKey, participantsOf, ensureTables, recomputeUser, recordHunt, removeHunt, getUserStats };
};
