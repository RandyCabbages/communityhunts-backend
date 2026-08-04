// Stable public shapes for the Developer API. Whitelist-only: a new internal field can NEVER
// auto-leak. Anonymous-member masking + secret stripping is inherited from publicHuntView.
const { sumVault, huntCategoryOf, tenantOf, isIdentityMasked } = require('./hunts-core');
const { publicOwnerId } = require('./publicIds');
const { thumbForSlotNames } = require('./slots');

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

// The hunt's cost — the break-even line. Summed from the RAW equity, not the masked view:
// maskEquityMember rewrites `name`/`avatar` and drops `discordId`, and never reads `amount`, so
// the totals are identical and this avoids paying per-row masking work on a 100-row listing.
const potOf = hunt => round2((hunt.equity || []).reduce((s, e) => s + (Number(e.amount) || 0), 0));

// Mean multiple over bonuses that have BOTH a stake and a result. `bet: 0` is a collected-but-
// unbought bonus and `win: null` is one not yet opened; scoring either as 0x would drag the
// average down by however many bonuses are still to come. `win: 0` IS counted — a bonus that
// opened and paid nothing is a result. Null rather than 0 when nothing qualifies, because 0
// would read as "everything paid nothing".
const averageMultipleOf = (hunt) => {
  const rows = (hunt.bonuses || []).filter(b => Number(b.bet) > 0 && b.win != null);
  if (!rows.length) return null;
  return round2(rows.reduce((s, b) => s + (b.win / b.bet), 0) / rows.length);
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

// Last-changed stamp, so a consumer can poll the LIST endpoint once and re-fetch only the hunts
// whose timestamp moved, instead of fetching every hunt on a timer.
//
// The MAX of the lifecycle stamps, not `updatedAt` alone: archiveHunt() snapshots the hunt and
// then stamps `archivedAt` on the copy, so a hunt that just ended would otherwise report a
// timestamp EARLIER than the moment its `status` flipped to 'archived' — the one transition a
// consumer most needs to notice. All four are `new Date().toISOString()`, which is always UTC
// with a `Z`, so lexicographic max is chronological max.
function lastChangedAt(h) {
  let best = null;
  for (const v of [h.updatedAt, h.archivedAt, h.startedAt, h.createdAt]) {
    if (typeof v === 'string' && v && (best === null || v > best)) best = v;
  }
  return best;
}

// Who a hunt belongs to. Until this existed the ONLY handle on a hunt was `equity[0].name`, which
// happens to be the owner on a solo hunt and is a BACKER on a community hunt — so every consumer
// showing one streamer's hunts was string-matching a display name and breaking on a rename.
//
// `id` is opaque (see lib/publicIds.js) because the raw value is a Discord id, which this API
// never returns. `name` respects anonymous mode exactly as equity and calls do — a host who opted
// out of being named does not get named here either, but keeps a stable id so their hunts still
// group correctly.
//
// Shared hunts (the tenant/affiliate/VIP runs) own themselves: `user.id` is a synthetic key rather
// than a person. That is still a stable owner, and `huntType` already tells a consumer which one.
function publicOwner(hunt) {
  const u = hunt && hunt.user;
  if (!u || u.id == null || u.id === '') return null;
  const name = u.displayName || u.username || null;
  return {
    id: publicOwnerId(tenantOf(hunt), u.id),
    name: isIdentityMasked(u.id, name) ? 'Anonymous' : name,
  };
}

// The index shape: everything a card grid, history table or hunt picker needs, and none of the
// nested arrays. Sweeping 322 hunts cost ~1.9 MB in full form to surface a list; this is a few KB.
// Deliberately does NOT call publicHuntView — the only masked field it carries is the owner name,
// which publicOwner handles itself, so a summary page never pays to mask equity/calls/bonuses it
// is about to throw away.
function publicHuntSummary(hunt) {
  if (!hunt) return null;
  const bonuses = hunt.bonuses || [];
  return {
    id: hunt.huntId || null,
    owner: publicOwner(hunt),
    status: huntStatus(hunt),
    huntType: huntCategoryOf(hunt) || 'community',
    // The hunt KIND — orthogonal to huntType. Null when never set: a hunt whose kind nobody
    // chose must not be published as though someone had.
    huntKind: hunt.huntKind || null,
    isTournament: !!hunt.isTournament,
    currency: hunt.currency || null,
    createdAt: hunt.createdAt || hunt.startedAt || null,
    startedAt: hunt.startedAt || null,
    endedAt: hunt.archivedAt || null,
    updatedAt: lastChangedAt(hunt),
    bonusCount: bonuses.length,
    totalWon: round2(bonuses.reduce((s, b) => s + (b.win || 0), 0) + sumVault(hunt)),
    pot: potOf(hunt),
    averageMultiple: averageMultipleOf(hunt),
  };
}

function publicHunt(hunt) {
  if (!hunt) return null;
  const pv = publicHuntView(hunt); // masks anonymous equity, strips secrets (no viewer = unprivileged)
  // One pool pass for the whole hunt, not one per bonus — see thumbForSlotNames. `thumb` is null
  // for a slot the catalogue has not reviewed and for a row with no slot name; both are normal
  // and a consumer renders a fallback tile.
  const rawBonuses = hunt.bonuses || [];
  const thumbs = thumbForSlotNames(rawBonuses.map(b => b.slot));
  const bonuses = rawBonuses.map(b => ({
    slot: b.slot || null,
    bet: b.bet ?? null,
    win: b.win ?? null,
    multiplier: (Number(b.bet) > 0 && b.win != null) ? +(b.win / b.bet).toFixed(2) : null,
    thumb: (typeof b.slot === 'string' && thumbs.get(b.slot)) || null,
  }));
  // Call queue. Whitelisted like everything else here — `user` comes from `pv`, so anonymous
  // members are already masked by maskCallerEntry; `callerId` is a raw Discord id and must
  // never appear. `at` mirrors the got-in serializer's epoch-ms naming.
  // Coerce VALUES, not just keys. rejectBadHuntInput only checks that `calls` is an array of
  // ≤1000 items — nothing validates element shape — so a stored object in `user` would be
  // serialized out whole, and the anonymity check upstream would miss it (normAnonName
  // stringifies an object to "[object Object]", which is in no anon set). Within-tenant only
  // today since writing that row needs editor rights, but the write endpoint will accept these
  // shapes from a machine caller, so pin it at the boundary.
  const str = v => (typeof v === 'string' ? v : null);
  // Stable identity for the rows that HAVE one.
  //
  // Read from the RAW hunt, not from `pv`: maskEquityMember and maskCallerEntry strip
  // `discordId`/`callerId` off every row by design, so the masked copy cannot supply this. Pairing
  // by index is sound because both are 1:1 `.map`s over the source arrays — same length, same
  // order (pinned by a test). Same contract as publicOwner: an anonymous member loses their NAME
  // and keeps a stable id, so a masked identity stays consistent across periods.
  //
  // `null` is the COMMON case and it is not a bug: a call is free text typed by whoever entered
  // it, and an equity row only carries an identity once someone has actually been linked to it.
  // A consumer must treat null as "unlinked row", never as a failed lookup — the docs say so.
  const rawEquity = Array.isArray(hunt.equity) ? hunt.equity : [];
  const rawCalls = Array.isArray(hunt.calls) ? hunt.calls : [];
  const idOf = raw => (raw == null || raw === '') ? null : publicOwnerId(tenantOf(hunt), raw);
  const calls = (pv.calls || []).map((c, i) => ({
    slot: str(c.slot),
    user: str(c.user),
    userId: idOf(rawCalls[i] && rawCalls[i].callerId),
    status: str(c.status),
    at: typeof c.ts === 'number' ? c.ts : null,
  }));
  return {
    id: hunt.huntId || null,
    owner: publicOwner(hunt),
    status: huntStatus(hunt),
    // The PUBLIC label, derived — NOT the internal behaviour key. An affiliate hunt is stored
    // as huntType 'vip' and the streamer's mod hunt as 'solo'; see huntCategoryOf.
    huntType: huntCategoryOf(hunt) || 'community',
    // Same null-not-default rule as the summary shape — see the comment there.
    huntKind: hunt.huntKind || null,
    isTournament: !!hunt.isTournament,
    tournamentProvider: hunt.tournamentProvider || null,
    tournamentRound: hunt.tournamentRound || null,
    targetBonuses: typeof hunt.targetBonuses === 'number' ? hunt.targetBonuses : null,
    currency: hunt.currency || null,
    createdAt: hunt.createdAt || hunt.startedAt || null,
    startedAt: hunt.startedAt || null,
    endedAt: hunt.archivedAt || null,
    updatedAt: lastChangedAt(hunt),
    bonusCount: bonuses.length,
    totalWon: round2(bonuses.reduce((s, b) => s + (b.win || 0), 0) + sumVault(hunt)),
    pot: potOf(hunt),
    averageMultiple: averageMultipleOf(hunt),
    bonuses,
    calls,
    // `userId` is ADDED alongside `name`, not folded into a nested `user` object. Turning
    // `calls[].user` from a string into an object would be a silent type change on a live field —
    // a consumer rendering it would print "[object Object]" on stream with no error anywhere — and
    // the published policy this API just adopted is that changes are additive.
    equity: (pv.equity || []).map((e, i) => ({
      name: e.name,
      userId: idOf(rawEquity[i] && rawEquity[i].discordId),
      amount: e.amount ?? null,
    })),
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

module.exports = {
  _setPublicHuntView, publicHunt, publicHuntSummary, publicOwner, publicStats, publicGotIn,
  publicBanger, lastChangedAt,
};
