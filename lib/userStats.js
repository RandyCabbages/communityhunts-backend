// communityhunts-backend/lib/userStats.js
// Pure per-user hunt aggregation for the admin profile and the personal stats page.
// No DB, no side effects.
//
// The shape is sliced by ROLE. The old single combined stat line answered "how has this person
// done", which merged two unrelated things: running a hunt (you own the whole pot and the whole
// result) and joining one (you own an equity fraction). A host who runs profitably and joins
// badly used to read as roughly even.
//
//   { v, ...combined, calling, host: { …, calling, operator }, joined: { …, calling, player } }
//
// The combined slice stays SPREAD AT THE TOP LEVEL rather than nested under `all`, because
// StatsBox and the admin profile already read stats.tiles / .usd / .byCurrency / .records — this
// way the split is purely additive and no existing reader has to change to keep working.
const { perHunt, eqUserId } = require('./userStatsHunt');
const { aggregate } = require('./userStatsSlice');
const { hostOperator, joinedPlayer, callingRecord } = require('./userStatsGroups');

// Bump when the SHAPE changes. statsStore caches this whole object as JSONB per user and only
// recomputed a MISSING row, so without a version stamp every existing user would sit on a
// pre-split blob forever — new tiles blank until their next hunt happened to refresh it.
const STATS_VERSION = 2;

// opts.names — every handle the user is known by (Discord display name + username, Rainbet,
// Twitch). Only used to attribute the free-text `caller` field on a bonus back to them.
function computeUserHuntStats(hunts, userId, opts = {}) {
  const id = String(userId);
  const mine = (hunts || []).filter(h =>
    String(h.user?.id) === id || (h.equity || []).some(e => eqUserId(e) === id));

  const details = mine.map(h => perHunt(h, id));
  const hostDetails = details.filter(d => d.isOwner);
  const joinedDetails = details.filter(d => !d.isOwner);
  const names = opts.names || [];

  return {
    v: STATS_VERSION,
    ...aggregate(details, { includePastHunts: true }),
    calling: callingRecord(details, names),
    host: {
      ...aggregate(hostDetails),
      calling: callingRecord(hostDetails, names),
      operator: hostOperator(hostDetails),
    },
    joined: {
      ...aggregate(joinedDetails),
      calling: callingRecord(joinedDetails, names),
      player: joinedPlayer(joinedDetails),
    },
  };
}

module.exports = { computeUserHuntStats, STATS_VERSION };
