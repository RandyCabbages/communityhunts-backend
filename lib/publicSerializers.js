// Stable public shapes for the Developer API. Whitelist-only: a new internal field can NEVER
// auto-leak. Anonymous-member masking + secret stripping is inherited from publicHuntView.
const { sumVault, huntCategoryOf } = require('./hunts-core');

// Fail-closed default: if _setPublicHuntView is never called, mask all names rather than leak.
let publicHuntView = h => (h && Array.isArray(h.equity))
  ? { ...h, equity: h.equity.map(e => ({ ...e, name: 'Hidden', avatar: null })) }
  : h; // injected from server.js (lib/hunts-core.publicHuntView)
function _setPublicHuntView(fn) { publicHuntView = fn; }

// Money + ratios are float-accumulated upstream; round for a clean public contract.
// Non-numbers (null, undefined) pass through untouched — null must stay null, never become 0.
const round2 = v => (typeof v === 'number' && Number.isFinite(v)) ? +v.toFixed(2) : v;
// Round only an explicit allowlist of field names on an object — never every numeric-looking
// key — so a count field added later can't get silently mangled. Skips fields the object
// doesn't actually own, so we never introduce a stray `undefined` key on a smaller/mocked shape.
const roundFields = (obj, fields) => {
  if (!obj) return obj;
  const out = { ...obj };
  for (const f of fields) {
    if (Object.prototype.hasOwnProperty.call(out, f)) out[f] = round2(out[f]);
  }
  return out;
};

// hunts-core.js getHuntStats() statsFor().summary — money/ratio fields only. Deliberately
// excludes integer counts (totalHunts, completedHunts, liveNow, totalBonuses, openedBonuses,
// pnlHunts, untagged) and the `types` breakdown — those are exact counts, never float-accumulated.
const SUMMARY_ROUND_FIELDS = ['totalBet', 'totalWon', 'overallMulti', 'avgSlotsPerHunt', 'avgPot', 'totalPot', 'pnl'];
// hunts-core.js getHuntStats() statsFor().topGotIn entries — money/ratio fields only.
// `entries`/`hunts` are counts. `bestWin` is a raw per-bonus win value tracked via max(), the
// same "source value, not accumulated" category as bonuses[].win in publicHunt — left alone.
const TOP_GOT_IN_ROUND_FIELDS = ['totalBet', 'totalWin', 'avgMulti', 'bestMulti'];

function huntStatus(h) {
  if (h.archivedAt) return 'archived';
  return h.isLive ? 'live' : 'ended';
}

function publicHunt(hunt) {
  if (!hunt) return null;
  const pv = publicHuntView(hunt); // masks anonymous equity, strips secrets (no viewer = unprivileged)
  const bonuses = (hunt.bonuses || []).map(b => ({
    slot: b.slot || null,
    bet: b.bet ?? null,
    win: b.win ?? null,
    multiplier: (Number(b.bet) > 0 && b.win != null) ? +(b.win / b.bet).toFixed(2) : null,
  }));
  // Call queue. Whitelisted like everything else here — `user` comes from `pv`, so anonymous
  // members are already masked by maskCallerEntry; `callerId` is a raw Discord id and must
  // never appear. `at` mirrors the got-in serializer's epoch-ms naming.
  const calls = (pv.calls || []).map(c => ({
    slot: c.slot || null,
    user: c.user || null,
    status: c.status || null,
    at: c.ts ?? null,
  }));
  return {
    id: hunt.huntId || null,
    status: huntStatus(hunt),
    // The PUBLIC label, derived — NOT the internal behaviour key. An affiliate hunt is stored
    // as huntType 'vip' and the streamer's mod hunt as 'solo'; see huntCategoryOf.
    huntType: huntCategoryOf(hunt) || 'community',
    currency: hunt.currency || null,
    createdAt: hunt.createdAt || hunt.startedAt || null,
    startedAt: hunt.startedAt || null,
    endedAt: hunt.archivedAt || null,
    bonusCount: bonuses.length,
    totalWon: round2(bonuses.reduce((s, b) => s + (b.win || 0), 0) + sumVault(hunt)),
    bonuses,
    calls,
    equity: (pv.equity || []).map(e => ({ name: e.name, amount: e.amount ?? null })),
  };
}

// getHuntStats(tenantId) → { currencies, byCurrency:{code:{summary,topGotIn,topCalled,topHunters,biggestHits,hours,weekdays,weeks}}, tz }
// Drop topHunters + biggestHits (carry member names — anonymity risk); keep numeric/slot aggregates.
function publicStats(raw) {
  if (!raw) return null;
  const byCurrency = {};
  for (const [code, s] of Object.entries(raw.byCurrency || {})) {
    byCurrency[code] = {
      summary: roundFields(s.summary, SUMMARY_ROUND_FIELDS),
      topGotIn: (s.topGotIn || []).map(e => roundFields(e, TOP_GOT_IN_ROUND_FIELDS)),
      topCalled: s.topCalled || [],
      hours: s.hours || [], weekdays: s.weekdays || [], weeks: s.weeks || [],
    };
  }
  return { currencies: raw.currencies || [], byCurrency, tz: raw.tz || null };
}

function publicGotIn(rows) {
  return (rows || []).map(r => ({ slot: r.slot, bet: r.bet, at: r.ts }));
}

function publicBanger(b) {
  // mult is already rounded in lib/bangers.js (+mult.toFixed(2)); bet/win are raw per-bonus
  // source values (not summed/accumulated there either) — nothing here needs round2.
  return { slot: b.slot, bet: b.bet, win: b.win, multiplier: b.mult, username: b.username, huntType: b.huntType, at: b.at };
}

module.exports = { _setPublicHuntView, publicHunt, publicStats, publicGotIn, publicBanger };
