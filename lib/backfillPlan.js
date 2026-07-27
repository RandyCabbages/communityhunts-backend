// Which hunts does a hunt_history backfill actually need to write?
//
// The script used to stamp EVERY hunt with `_approxRate: true` and re-record it. Because
// statsStore.recordHunt re-fetches the LATEST fx rate for an approx row, a second run silently
// downgraded hunts that were recorded live with an exact same-day rate and overwrote their
// usd_rate. Measured 2026-07-27: 93 of 374 hunts already carry approx; re-running pushed that
// toward 100% and moved the public usdWon figure.
//
// A backfill fills GAPS. Anything already in hunt_history is left exactly as it is.

// Must match statsStore.huntKey — if these disagree, every legacy hunt looks missing and gets
// re-recorded, which is the bug this module exists to prevent.
function huntKeyOf(hunt) {
  if (hunt && hunt.huntId) return String(hunt.huntId);
  return `${hunt?.user?.id}|${hunt?.startedAt}`;
}

function planBackfill({ hunts = [], existingKeys = new Set() } = {}) {
  const toRecord = [];
  const skipped = [];
  const seen = new Set();

  for (const h of hunts) {
    // Same shape guard archiveHunt applies: no user or no bonuses means there is nothing to
    // analyse, and recordHunt would only create an empty row.
    if (!h || !h.user || !Array.isArray(h.bonuses) || h.bonuses.length === 0) continue;

    const key = huntKeyOf(h);
    if (seen.has(key)) continue;      // the archive can hold the same instance twice
    seen.add(key);

    if (existingKeys.has(key)) { skipped.push(h); continue; }
    // Only rows we are genuinely creating get the approx flag — they have no same-day rate, so
    // for THESE it is honest rather than a downgrade.
    toRecord.push({ ...h, _approxRate: true });
  }

  return { toRecord, skipped };
}

module.exports = { planBackfill, huntKeyOf };
