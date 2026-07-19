// lib/communityStats.js
// Pure aggregation of a tenant's hunt_history rows into the public homepage proof band.
// No DB, no env, no side effects — lib/statsStore.js owns the query and the caching.
//
// WHY THIS EXISTS: the homepage summed `totalWon` across hunts of MIXED currencies. ARS is
// denominated ~1000x smaller than USD, so 82 peso hunts (worth ~$12.7K) dominated the total
// and the tile read "$19.2M". Every hunt_history row carries the FX rate captured at archive
// time, so the honest number is a per-hunt conversion, then summed.
const { sumVault } = require('./hunts-core');

// Canonical hunt winnings — MUST match lib/userStats.js (bonus wins + vault). Vault money
// counts toward winnings but never toward a multiplier. If these two drift, the homepage and
// the stats pages will quote different totals for the same hunts.
const wonOf = (s) =>
  (s?.bonuses || []).reduce((a, b) => a + (Number(b.win) || 0), 0) + sumVault(s);

function aggregateCommunityStats(rows) {
  let hunts = 0, bonuses = 0, usdWon = 0, approx = 0;
  for (const r of rows || []) {
    const s = r?.snapshot;
    hunts++;
    bonuses += (s?.bonuses || []).length;
    if (s?.approx) approx++;
    // A row with no usable rate is SKIPPED, never counted at 1.0 — silently treating an
    // ARS hunt as USD is the exact bug this module exists to prevent. (Currently zero such
    // rows in prod; this is a guard against a future write path that forgets the rate.)
    const rate = Number(r?.usd_rate);
    if (isFinite(rate) && rate > 0) usdWon += wonOf(s) * rate;
  }
  return { hunts, bonuses, usdWon, approx };
}

module.exports = { aggregateCommunityStats };
