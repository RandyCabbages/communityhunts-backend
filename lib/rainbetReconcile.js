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

module.exports = { nameKey, reconcile, passesLiveGate, providersGateOk, catalogFloorOk };
