// Pure reconciliation logic for the Rainbet stale-slot job. No I/O, no browser —
// everything here is unit-tested. The integration crawl lives in
// scripts/reconcile_rainbet.js; the merge gate is consumed by lib/slots.js.

const { canonKey, splitSlug, PROVIDER_ALIASES } = require('./slotSlugCanon');

const DAY_MS = 24 * 60 * 60 * 1000;

// Strip-all normalization: lowercase, & -> and, drop every non-alphanumeric.
// Mirrors the space/punct-insensitive searchKey in lib/slots.js. Distinct from
// normNameKey (which keeps word-separating spaces and must not be reused here).
function nameKey(s) {
  return (s || '').toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]/g, '');
}

// The canonical provider token for a catalog slug, matching how the crawl keys the
// providers it managed to enumerate.
function providerOf(rainbetSlug) {
  const { providerToken } = splitSlug(rainbetSlug || '');
  return PROVIDER_ALIASES[providerToken] || providerToken;
}

// ── The live index ───────────────────────────────────────────────────────────
// `live` is either a bare Set of nameKeys (legacy: pure name matching, no provider
// information, used by the golden fixtures) or:
//   { slugs, names, reachableProviders }
//
// Three things changed after the 2026-08-01 investigation into two unplayable slugs that
// survived reconciliation (avatarux-majestic-meow, voltent-wazdan-bell-wizard):
//
// 1. PRESENCE IS DECIDED BY SLUG. The games API returns `url` — the exact Rainbet slug —
//    and matching on the NAME instead let a dead slug ride forever on a live same-name
//    twin. Measured: 40 entries in that state (pragmatic-play-floating-dragon masked by
//    …-floating-dragon-holdspin, nolimit-gopnik by sneaky-slots-gopnik), across 57
//    collision groups covering 124 entries. `names` is retained only for passesLiveGate.
//
// 2. A PROVIDER THE CRAWL COULD NOT ENUMERATE IS NOT SWEEP-ELIGIBLE. scripts/reconcile_rainbet.js
//    used to `break` silently when a provider's games query returned non-200, contributing
//    zero live names for it — which reads identically to "every game from that provider was
//    delisted". The games query for `voltent` returns HTTP 400 under every parameter
//    combination the API accepts, and Wazdan ships only under voltent, so the live set
//    contained ZERO Wazdan games. Measured: 900 catalog entries across 13 provider tokens
//    (wazdan 381, isoftbet 140, gameart 119, gamomat 92, blueprint 72, push-gaming 61, …)
//    had no coverage at all. Arming the job without this gate would have deleted them.
//    The existing providersGateOk/catalogFloorOk gates do NOT catch a per-provider hole —
//    56 providers and 6,844 games is a healthy-looking crawl that is still blind to 11.8%
//    of the catalog. Entries in an unreachable provider are passed through untouched:
//    not marked, not swept, and their existing stamp is left alone.
//
// 3. A PLAYABILITY VERDICT OVERRIDES THE LISTING, IN BOTH DIRECTIONS. Presence in the
//    catalogue is NOT proof of playability: avatarux-majestic-meow is returned by the games
//    API as type=slots with region_blocked=false and does not launch. `dead` therefore marks
//    an entry the listing still carries, and `alive` rescues one the listing lost (covering a
//    canonKey gap or listing lag). `unknown` — which is what a region_blocked game yields,
//    because it cannot be probed from the crawl's vantage — defers to the listing entirely
//    and can never itself cause a removal.
function reconcile(entries, live, opts = {}) {
  const graceDays = opts.graceDays ?? 3;
  const now = opts.now ?? new Date();
  const cutoff = now.getTime() - graceDays * DAY_MS;
  const today = now.toISOString().slice(0, 10);
  const playability = opts.playability || new Map();

  const legacy = live instanceof Set;
  const liveNameSet = legacy ? live : (live.names || new Set());
  const liveSlugSet = legacy ? null : (live.slugs || new Set());
  // Absent (legacy path) means "no provider information" — every entry stays eligible.
  const reachable = legacy ? null : (live.reachableProviders || null);

  const out = [];
  let marked = 0, cleared = 0, swept = 0, skipped = 0;
  const sweptNames = [], markedNames = [], skippedProviders = new Set();

  for (const e of entries) {
    // Fail closed: no evidence about this provider means no authority to remove from it.
    if (reachable && !reachable.has(providerOf(e.rainbetSlug))) {
      out.push(e);
      skipped++;
      skippedProviders.add(providerOf(e.rainbetSlug));
      continue;
    }

    const verdict = playability.get(e.rainbetSlug);
    const listed = liveSlugSet
      ? liveSlugSet.has(canonKey(e.rainbetSlug || ''))
      : liveNameSet.has(nameKey(e.name));
    const isLive = verdict === 'alive' ? true : verdict === 'dead' ? false : listed;

    if (isLive) {
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

  return {
    entries: out, marked, cleared, swept, skipped,
    sweptNames, markedNames, skippedProviders: [...skippedProviders].sort(),
  };
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

module.exports = {
  nameKey, providerOf, reconcile, passesLiveGate, providersGateOk, catalogFloorOk,
  removalAllowed, MAX_REMOVAL_RATIO,
};
