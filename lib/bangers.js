// Top recent big-multiplier wins ("bangers", >=300x) for a tenant. Extracted from
// routes/misc.routes.js so the Developer API can reuse the exact selection logic.

// huntRunnerOf/huntCategoryOf are pure reads over a hunt object (no injected state), and
// hunts-core requires nothing from here — no cycle.
const { huntRunnerOf, huntCategoryOf } = require('./hunts-core');

const BANGER_MIN_MULT = 300;

function collectBangers(hunts, archive, tenantId, opts = {}) {
  const minMult = opts.minMult ?? BANGER_MIN_MULT;
  const maxPerUser = opts.maxPerUser ?? 2;
  const cap = opts.cap ?? 24;
  // FAIL CLOSED. This used to default to `() => false` (mask nobody), which is an opt-in privacy
  // control — and the second call site duly forgot it: the Developer API's /bangers passed no
  // opts, so a host who had turned on anonymous mode showed as 'Anonymous' on the public hub and
  // by REAL NAME to anyone holding the community's API key. Defaulting to "mask everyone" means a
  // forgotten call site over-masks (obvious, harmless) instead of leaking (silent, not).
  // Callers that want real names must pass settings.shouldMaskIdentity explicitly.
  const isAnon = opts.isAnon ?? (() => true);
  const tid = tenantId || 'bean';
  const out = [], seen = new Set();
  const collect = (h, live) => {
    if (!h || !h.user || !Array.isArray(h.bonuses)) return;
    if ((h.tenantId || 'bean') !== tid) return;
    const at = h.archivedAt || h.startedAt || null;
    for (const b of h.bonuses) {
      const bet = +b.bet || 0, win = +b.win || 0;
      if (bet <= 0 || win <= 0) continue;
      const mult = win / bet;
      if (mult < minMult) continue;
      const key = `${h.user.id}|${(b.slot || '').toLowerCase()}|${bet}|${win}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const anon = isAnon({ discordId: h.user.id, name: h.user.displayName });
      // A shared VIP/Affiliate hunt is owned by the COMMUNITY, so `user.displayName` is the tenant
      // host ("Bean") regardless of which mod ran it. huntSummary has resolved that through
      // huntRunnerOf since these started appearing on the hub; this rail did not, so the same
      // archived run read "Mcflury" on /api/hunts/archived and "Bean" here. Null for every other
      // hunt — a personal hunt's owner name is already right. Name and avatar are taken from the
      // SAME source: the creator_auto fallback has no avatar, and borrowing the host's would put
      // Bean's face next to the runner's name.
      const runner = huntRunnerOf(h, isAnon);
      // replayUrl is sanitized at write time (sanitizeBonusReplayUrls, lib/hunts-core.js);
      // the http(s) check here is defense-in-depth for pre-sanitizer rows. Unlike Hall of
      // Fame this is NOT a gate — a banger without a replay still shows (it just links to
      // the hunt page); the field only lets the rail play a replay when one is attached.
      const replay = typeof b.replayUrl === 'string' ? b.replayUrl.trim() : '';
      out.push({ slot: b.slot || 'Unknown', bet, win, mult: +mult.toFixed(2),
        userId: h.user.id,
        username: runner ? runner.name : (anon ? 'Anonymous' : h.user.displayName),
        avatar: runner ? runner.avatar : (anon ? null : h.user.avatar),
        // `huntType` is kept verbatim (frozen field, and publicBanger ships it), but it CANNOT
        // tell an Affiliate run from a VIP one — emptyAffiliateHunt stamps huntType 'vip'. The
        // derived category resolves it from the hunt KEY, same as huntSummary sends to the hub.
        huntType: h.huntType || 'community', category: huntCategoryOf(h),
        live: !!live, at, archivedAt: h.archivedAt || null,
        replayUrl: /^https?:\/\//i.test(replay) ? replay : null });
    }
  };
  Object.values(hunts).forEach(h => { if (h.isLive) collect(h, true); });
  archive.forEach(h => collect(h, false));
  out.sort((a, b) => {
    const ta = a.at ? new Date(a.at).getTime() : 0, tb = b.at ? new Date(b.at).getTime() : 0;
    return tb - ta || b.mult - a.mult;
  });
  const userCount = new Map(), diverse = [];
  for (const b of out) {
    const c = userCount.get(b.userId) || 0;
    if (c >= maxPerUser) continue;
    userCount.set(b.userId, c + 1);
    diverse.push(b);
    if (diverse.length >= cap) break;
  }
  return diverse;
}

module.exports = { collectBangers, BANGER_MIN_MULT };
