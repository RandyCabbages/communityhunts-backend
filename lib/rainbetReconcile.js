// Pure reconciliation logic for the Rainbet stale-slot job. No I/O, no browser —
// everything here is unit-tested. The integration crawl lives in
// scripts/reconcile_rainbet.js; the merge gate is consumed by lib/slots.js.

const DAY_MS = 24 * 60 * 60 * 1000;

// Strip-all normalization: lowercase, & -> and, drop every non-alphanumeric.
// Mirrors the space/punct-insensitive searchKey in lib/slots.js. Distinct from
// normNameKey (which keeps word-separating spaces and must not be reused here).
function nameKey(s) {
  return (s || '').toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]/g, '');
}

// Mark-then-sweep. For each entry:
//   - name in liveNameSet  -> clear any missingSince (present/back-live)
//   - name absent, unstamped -> stamp missingSince = today
//   - name absent, stamped   -> keep unless the stamp is strictly older than graceDays
function reconcile(entries, liveNameSet, opts = {}) {
  const graceDays = opts.graceDays ?? 3;
  const now = opts.now ?? new Date();
  const cutoff = now.getTime() - graceDays * DAY_MS;
  const today = now.toISOString().slice(0, 10);

  const out = [];
  let marked = 0, cleared = 0, swept = 0;
  const sweptNames = [], markedNames = [];

  for (const e of entries) {
    const live = liveNameSet.has(nameKey(e.name));
    if (live) {
      if (e.missingSince) {
        const { missingSince, ...rest } = e;
        out.push(rest);
        cleared++;
      } else {
        out.push(e);
      }
      continue;
    }
    // absent from Rainbet's live set
    if (!e.missingSince) {
      out.push({ ...e, missingSince: today });
      marked++;
      markedNames.push(e.name);
      continue;
    }
    const stampMs = Date.parse(e.missingSince);
    if (!Number.isNaN(stampMs) && stampMs < cutoff) {
      swept++;
      sweptNames.push(e.name);
      // drop
    } else {
      out.push(e);
    }
  }

  return { entries: out, marked, cleared, swept, sweptNames, markedNames };
}

// Fail-open merge gate: an empty live set gates nothing (preserves current behavior).
function passesLiveGate(name, liveNameSet) {
  if (!liveNameSet || liveNameSet.size === 0) return true;
  return liveNameSet.has(nameKey(name));
}

function providersGateOk(providerCount, opts = {}) {
  return providerCount >= (opts.min ?? 20);
}

function catalogFloorOk(liveCount, catalogCount, opts = {}) {
  const minRatio = opts.minRatio ?? 0.5;
  if (catalogCount <= 0) return false;
  return liveCount >= catalogCount * minRatio;
}

// ── Removal authorisation for the UNATTENDED sync ────────────────────────────
// scripts/check_new_slots.js runs every 10 minutes and AUTO-COMMITS to main. Its removal path had
// a single guard — "fewer than 50% removed" — while the manual reconcile script hard-aborts on
// three (provider count, catalog floor, Cloudflare-didn't-clear). The unattended one needed them
// more, not less.
//
// The scenario this exists for: slot.report has an outage, so `isFullCatalog` arms on the DOM
// crawl alone; the crawl comes back partial (Cloudflare half-cleared, the maxClicks cap hit, or
// the "Load more" markup changed) with 4,000 of 7,568 slots. Under the old rule
// `3568 < 7568*0.5` passed and ~3,500 real slots were deleted and pushed to main by a bot.
//
// MAX_REMOVAL_RATIO is deliberately far tighter than the old 0.5: genuine churn is a handful of
// slots per run. A real mass delisting is rare enough to be worth a human setting
// RAINBET_ALLOW_MASS_REMOVAL — and note the override cannot bypass the crawl-health gates, only
// the size cap. A broken crawl is not a delisting, whatever the operator forces.
const MAX_REMOVAL_RATIO = 0.10;

function removalAllowed({
  isFullCatalog, removedCount = 0, existingCount = 0,
  providerCount = 0, liveCount = 0, override = false, maxRatio = MAX_REMOVAL_RATIO,
} = {}) {
  if (!isFullCatalog)   return { ok: false, reason: 'not a full catalog crawl — removal never arms on a partial source' };
  if (existingCount <= 0) return { ok: false, reason: 'nothing in the catalog to remove from' };
  if (removedCount <= 0)  return { ok: false, reason: 'nothing to remove' };
  if (!providersGateOk(providerCount))
    return { ok: false, reason: `provider gate failed (${providerCount} providers, need >= 20) — the crawl looks broken` };
  if (!catalogFloorOk(liveCount, existingCount))
    return { ok: false, reason: `catalog floor failed (${liveCount} live vs ${existingCount} known) — the crawl looks partial` };
  if (!override && removedCount > existingCount * maxRatio)
    return { ok: false, reason: `removal cap exceeded (${removedCount} of ${existingCount}, cap ${Math.round(maxRatio * 100)}%) — set RAINBET_ALLOW_MASS_REMOVAL=1 if this delisting is real` };
  return { ok: true, reason: '' };
}

module.exports = { nameKey, reconcile, passesLiveGate, providersGateOk, catalogFloorOk, removalAllowed, MAX_REMOVAL_RATIO };
