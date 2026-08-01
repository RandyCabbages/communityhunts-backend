// communityhunts-backend/lib/userStatsHunt.js
// One user's view of ONE hunt, fully derived. Pure — no DB, no side effects.
//
// Extracted from userStats.js when the profile grew its All / Host / Joined split. The three
// slices and the four stat groups all read these same per-hunt numbers rather than each
// recomputing them: a second copy of this math is exactly how a host total and a combined total
// would drift apart while both looked plausible.
const { computePostHunt } = require('./chaseLedger');
const { sumVault } = require('./hunts-core');

// An equity row identifies a person by `discordId` (reliable — present on newer hunts and
// stamped onto older ones by statsStore's name match). The `id` field is a per-row UUID, NOT
// a user id, so it must never be used for attribution. Fall back to `id` only for legacy/test
// rows that carry no discordId (e.g. `{ id: 'u1' }` in unit tests).
const eqUserId = (e) =>
  (e && e.discordId != null && e.discordId !== '') ? String(e.discordId) : String(e?.id);

// Mirrors statsStore.isRealUserId. A per-row UUID or an auto-seed placeholder is not a person,
// so neither can be counted toward "how many different people hunt with this host".
const PLACEHOLDER_IDS = new Set(['creator_auto', 'bean_auto']);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isRealUserId = (x) => !!x && !PLACEHOLDER_IDS.has(x) && !UUID_RE.test(x);

function isoWeek(d) {
  const dt = new Date(d);
  const day = (dt.getUTCDay() + 6) % 7;
  dt.setUTCDate(dt.getUTCDate() - day + 3);
  const firstThu = new Date(Date.UTC(dt.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round(((dt - firstThu) / 86400000 - 3 + ((firstThu.getUTCDay() + 6) % 7)) / 7);
  return `${dt.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

function multBucket(m) {
  if (m < 1) return '<1x';
  if (m < 5) return '1–5x';
  if (m < 20) return '5–20x';
  if (m < 100) return '20–100x';
  return '100x+';
}

// Money-weighted avg X per named caller on this hunt; best/worst need ≥2 named callers to mean
// anything (with one caller "best" and "worst" are the same person).
function callerExtremes(opened) {
  const byName = new Map();
  for (const b of opened) {
    const name = String(b.caller || '').trim();
    if (!name) continue;
    const c = byName.get(name) || { name, bet: 0, win: 0 };
    c.bet += Number(b.bet) || 0;
    c.win += Number(b.win) || 0;
    byName.set(name, c);
  }
  const ranked = [...byName.values()]
    .filter(c => c.bet > 0)
    .map(c => ({ name: c.name, x: c.win / c.bet }))
    .sort((a, b) => b.x - a.x);
  if (ranked.length < 2) return { bestCaller: null, worstCaller: null };
  return {
    bestCaller: { name: ranked[0].name, x: ranked[0].x },
    worstCaller: { name: ranked[ranked.length - 1].name, x: ranked[ranked.length - 1].x },
  };
}

function perHunt(h, id) {
  const bonuses = h.bonuses || [];
  const opened = bonuses.filter(b => b.win != null && b.win !== '');
  const hw = bonuses.reduce((a, b) => a + (Number(b.bet) || 0), 0);   // Σ all bets (tiles only)
  const hn = bonuses.reduce((a, b) => a + (Number(b.win) || 0), 0);   // bonus-only won — feeds avgX (multiplier), vault MUST stay excluded here
  const hnWinnings = hn + sumVault(h);   // total won incl. vault = end balance — winnings/payout site, never a multiplier numerator
  const betOpened = opened.reduce((a, b) => a + (Number(b.bet) || 0), 0);
  const equity = h.equity || [];
  const pot = equity.reduce((a, e) => a + (Number(e.amount) || 0), 0); // start balance
  const isOwner = String(h.user?.id) === id;

  // Gift/chase-aware ledger, now computed for HOST hunts too. The joined branch has always needed
  // it for the member's own payout; the host branch needs it for `paidOutToMembers` (what everyone
  // else walked away with). One call means the host's view of a hunt's payouts and a member's view
  // of the same hunt can never disagree.
  const ledger = computePostHunt({ equity, gifts: h.gifts || [], chases: h.chases || [], totalWon: hnWinnings });
  const myRow = equity.find(e => eqUserId(e) === id);
  const me = (myRow && ledger.members[myRow.id]) || null;

  // Share-adjusted money: what THIS user put in and got back. Host is treated as owning the
  // whole hunt (share 1); a member gets their gift-aware stake in and payout out.
  let invested, returned, result;
  if (isOwner) {
    invested = pot; returned = hnWinnings;          // host owns the whole hunt (share 1); winnings incl. vault
    result = returned - invested;
  } else {
    // With no gifts this reduces exactly to the classic amount/pot × winnings.
    invested = me ? me.selfInvested : 0;
    returned = me ? me.finalPayout : 0;
    result = me ? me.plNet : (returned - invested);
  }

  const rate = (typeof h.usdRate === 'number' && isFinite(h.usdRate)) ? h.usdRate : null;
  const { bestCaller, worstCaller } = callerExtremes(opened);

  return {
    hunt: h, bonuses, opened, isOwner,
    hw, hn, hnWinnings, betOpened, pot,
    invested, returned, result,
    rate, code: h.currency || 'USD',
    reqX: pot > 0 && betOpened > 0 ? pot / betOpened : null,
    avgX: betOpened > 0 ? hn / betOpened : null,
    bestCaller, worstCaller,
    when: h.archivedAt || h.updatedAt || h.createdAt || h.startedAt,
    ledger, myRow, me,
    // Equity rows that represent an actual person, for the host-side people counts.
    memberIds: equity.map(eqUserId).filter(isRealUserId),
    people: equity.filter(e => String(e.name || '').trim()).length,
  };
}

module.exports = { perHunt, eqUserId, isRealUserId, isoWeek, multBucket };
