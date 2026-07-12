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

  return { huntKey, participantsOf };
};
