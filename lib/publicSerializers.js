// Stable public shapes for the Developer API. Whitelist-only: a new internal field can NEVER
// auto-leak. Anonymous-member masking + secret stripping is inherited from publicHuntView.

// Fail-closed default: if _setPublicHuntView is never called, mask all names rather than leak.
let publicHuntView = h => (h && Array.isArray(h.equity))
  ? { ...h, equity: h.equity.map(e => ({ ...e, name: 'Hidden', avatar: null })) }
  : h; // injected from server.js (lib/hunts-core.publicHuntView)
function _setPublicHuntView(fn) { publicHuntView = fn; }

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
  return {
    id: hunt.huntId || null,
    status: huntStatus(hunt),
    huntType: hunt.huntType || 'community',
    currency: hunt.currency || null,
    createdAt: hunt.createdAt || hunt.startedAt || null,
    startedAt: hunt.startedAt || null,
    endedAt: hunt.archivedAt || null,
    bonusCount: bonuses.length,
    totalWon: bonuses.reduce((s, b) => s + (b.win || 0), 0),
    bonuses,
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
      summary: s.summary,
      topGotIn: s.topGotIn || [],
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
  return { slot: b.slot, bet: b.bet, win: b.win, multiplier: b.mult, username: b.username, huntType: b.huntType, at: b.at };
}

module.exports = { _setPublicHuntView, publicHunt, publicStats, publicGotIn, publicBanger };
