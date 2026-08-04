// communityhunts-backend/lib/userStats.js
// Pure per-user hunt aggregation for the admin profile and the personal stats page.
// No DB, no side effects.
//
// The shape is sliced on TWO axes. ROLE (all / host / joined) separates running a hunt — you own
// the whole pot and the whole result — from joining one, where you own an equity fraction; a host
// who runs profitably and joins badly used to read as roughly even. TYPE (the derived public
// category) separates solo grinding from community hunts, which is the same failure one axis over.
//
//   { v, ...combined, calling, host: {…}, joined: {…}, pastHunts: [], byType: { solo: {…}, … } }
//
// The combined slice stays SPREAD AT THE TOP LEVEL rather than nested under `all`, because
// StatsBox and the admin profile already read stats.tiles / .usd / .byCurrency / .records — this
// way both splits are purely additive and no existing reader has to change to keep working.
const { perHunt, eqUserId } = require('./userStatsHunt');
const { aggregate } = require('./userStatsSlice');
const { hostOperator, joinedPlayer, callingRecord } = require('./userStatsGroups');
const { PUBLIC_HUNT_CATEGORIES } = require('./hunts-core');

// Bump when the SHAPE changes. statsStore caches this whole object as JSONB per user and only
// recomputed a MISSING row, so without a version stamp every existing user would sit on a
// pre-split blob forever — new tiles blank until their next hunt happened to refresh it.
const STATS_VERSION = 3;

// Nested type slices are capped harder than the top-level ones. The per-week series, histogram and
// records PARTITION their parent (all the types together are about one parent's worth), but the
// top-N lists do NOT — five categories could each carry a full 25 slots and 10 hosts.
const TYPE_LIST_CAP = 10;
const TYPE_GROUP_CAP = 5;

// The three role slices over one set of hunts. Runs over all hunts, and again per hunt type —
// which is the point: a type slice and the combined slice are the same code over different
// inputs, so they cannot disagree.
function slicesFor(details, names, { includePastHunts = false, listCap, groupCap } = {}) {
  const hostDetails = details.filter(d => d.isOwner);
  const joinedDetails = details.filter(d => !d.isOwner);
  return {
    ...aggregate(details, { includePastHunts, listCap }),
    calling: callingRecord(details, names),
    host: {
      ...aggregate(hostDetails, { listCap }),
      calling: callingRecord(hostDetails, names),
      operator: hostOperator(hostDetails, { cap: groupCap }),
    },
    joined: {
      ...aggregate(joinedDetails, { listCap }),
      calling: callingRecord(joinedDetails, names),
      player: joinedPlayer(joinedDetails, { cap: groupCap }),
    },
  };
}

// opts.names — every handle the user is known by (Discord display name + username, Rainbet,
// Twitch). Only used to attribute the free-text `caller` field on a bonus back to them.
function computeUserHuntStats(hunts, userId, opts = {}) {
  const id = String(userId);
  const mine = (hunts || []).filter(h =>
    String(h.user?.id) === id || (h.equity || []).some(e => eqUserId(e) === id));

  const details = mine.map(h => perHunt(h, id));
  const names = opts.names || [];

  // Sparse: a category the user has never touched gets no key at all, so the frontend can offer
  // exactly the type buttons this person has rather than a row of dead zeroes. Iterating the
  // published vocabulary (not the data) keeps the key order stable for the toggle.
  const byType = {};
  for (const cat of PUBLIC_HUNT_CATEGORIES) {
    const sub = details.filter(d => d.category === cat);
    if (sub.length) {
      byType[cat] = slicesFor(sub, names, { listCap: TYPE_LIST_CAP, groupCap: TYPE_GROUP_CAP });
    }
  }

  return {
    v: STATS_VERSION,
    // pastHunts is carried ONCE, here. Every row has `role` and `huntType`, so both the role and
    // the type view filter the table client-side instead of the blob storing it many times over.
    ...slicesFor(details, names, { includePastHunts: true }),
    byType,
  };
}

module.exports = { computeUserHuntStats, STATS_VERSION, TYPE_LIST_CAP, TYPE_GROUP_CAP };
