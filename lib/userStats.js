// communityhunts-backend/lib/userStats.js
// Pure per-user hunt aggregation for the admin profile. No DB, no side effects.
function isoWeek(d) {
  const dt = new Date(d);
  const day = (dt.getUTCDay() + 6) % 7;
  dt.setUTCDate(dt.getUTCDate() - day + 3);
  const firstThu = new Date(Date.UTC(dt.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round(((dt - firstThu) / 86400000 - 3 + ((firstThu.getUTCDay() + 6) % 7)) / 7);
  return `${dt.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

function multBucket(m) {
  if (m < 1) return '<1x';
  if (m < 5) return '1–5x';
  if (m < 20) return '5–20x';
  if (m < 100) return '20–100x';
  return '100x+';
}

function computeUserHuntStats(hunts, userId) {
  const id = String(userId);
  const mine = (hunts || []).filter(h =>
    String(h.user?.id) === id || (h.equity || []).some(e => String(e.id) === id));

  const BUCKETS = ['<1x', '1–5x', '5–20x', '20–100x', '100x+'];
  const histo = Object.fromEntries(BUCKETS.map(b => [b, 0]));
  const activityMap = new Map();
  let wagered = 0, won = 0, wins = 0, multSum = 0, multN = 0;
  const pastHunts = [];
  const profitByPeriod = new Map();

  for (const h of mine) {
    const bonuses = h.bonuses || [];
    const hw = bonuses.reduce((a, b) => a + (Number(b.bet) || 0), 0);
    const hn = bonuses.reduce((a, b) => a + (Number(b.win) || 0), 0);
    const isOwner = String(h.user?.id) === id;
    let net = hn - hw;
    if (!isOwner) {
      const total = (h.equity || []).reduce((a, e) => a + (Number(e.amount) || 0), 0) || 1;
      const share = (Number((h.equity || []).find(e => String(e.id) === id)?.amount) || 0) / total;
      net = net * share;
    }
    wagered += hw; won += hn;
    if (hn > hw) wins++;
    for (const b of bonuses) { const m = Number(b.mult) || 0; histo[multBucket(m)]++; multSum += m; multN++; }
    const when = h.archivedAt || h.updatedAt || h.createdAt || h.startedAt;
    const period = when ? isoWeek(when) : 'unknown';
    activityMap.set(period, (activityMap.get(period) || 0) + 1);
    profitByPeriod.set(period, (profitByPeriod.get(period) || 0) + net);
    pastHunts.push({ huntId: h.huntId || h.id, date: when, huntType: h.huntType || null,
      slots: bonuses.length, wagered: hw, won: hn, net, currency: h.currency || 'USD' });
  }

  pastHunts.sort((a, b) => new Date(b.date) - new Date(a.date));
  const activity = [...activityMap.entries()].sort().map(([period, count]) => ({ period, count }));
  let running = 0;
  const profit = [...profitByPeriod.entries()].sort().map(([period, n]) => { running += n; return { period, net: running }; });

  return {
    tiles: {
      hunts: mine.length,
      winRate: mine.length ? wins / mine.length : 0,
      wagered, won,
      avgMult: multN ? multSum / multN : 0,
    },
    activity, profit,
    multHistogram: BUCKETS.map(b => ({ bucket: b, count: histo[b] })),
    pastHunts,
  };
}

module.exports = { computeUserHuntStats };
