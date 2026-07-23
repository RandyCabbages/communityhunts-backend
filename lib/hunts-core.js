// Hunt-domain read/broadcast core: shaping hunts for the wire (huntSummary), the
// completed/tenant predicates, the public/archived/all list builders, the hub/hunt
// Socket.IO emit helpers, and the secret-stripping publicHuntView. Also owns the
// mod/affiliate fixed-hunt-key constants and the uid/touch helpers.
// Extracted from server.js (de-slop refactor, 2026-06-20). BEHAVIOR UNCHANGED.
//
// CONTRACT-SENSITIVE: publicHuntView strips publicCallsPin -> requiresPin before any
// hunt:update broadcast to the shared watch room. huntSummary's field set is the
// /api/hunts wire shape. Do not alter either without updating docs/baseline-endpoints.txt.
//
// DI: initHuntsCore({ hunts, archive, viewers, io, persistHunts }) — hunts/archive are the
// persistence-owned singletons (by reference, never reassigned); viewers is the SAME live
// viewer-count map the sockets module mutates (shared by reference).

let hunts = {};
let archive = [];
let viewers = {};
let io = null;
let persistHunts = () => {};
// Anonymous-mode collaborators (injected). isAnonymousUser(discordId) — has the member opted into
// "Show me as anonymous"? isPrivilegedViewer(viewerId, hunt) — may this viewer see real names
// (hunt runner / mod / admin)? Both default to privacy-safe no-ops until wired in server.js.
let isAnonymousUser = () => false;
let isPrivilegedViewer = () => false;
let shouldMaskIdentity = ({ discordId }) => isAnonymousUser(discordId); // privacy-safe id-only default

function initHuntsCore(deps) {
  hunts        = deps.hunts;
  archive      = deps.archive;
  viewers      = deps.viewers;
  io           = deps.io;
  persistHunts = deps.persistHunts || (() => {});
  if (deps.isAnonymousUser)    isAnonymousUser    = deps.isAnonymousUser;
  if (deps.isPrivilegedViewer) isPrivilegedViewer = deps.isPrivilegedViewer;
  if (deps.shouldMaskIdentity) shouldMaskIdentity = deps.shouldMaskIdentity;
}

// Fixed hunt keys for the shared mod / affiliate hunts (not per-user).
const MOD_HUNT_ID = '__mod_hunt__';
const AFFILIATE_HUNT_ID = '__affiliate_hunt__';

// The currency vocabulary. MUST match the frontend's CURRENCIES in src/hunt/huntMath.js —
// the two lists drifted once (backend only knew USD/CAD/ARS) and GBP/AUD hunts were
// rejected with 400 "Invalid currency" while the picker happily offered them.
const CURRENCIES = ['USD', 'GBP', 'AUD', 'CAD', 'ARS'];

// Resolve the correct hunt key for a tenant. The 'bean' tenant ALWAYS gets the bare legacy
// key — this is load-bearing: Bean's OBS browser-source overlay is already live in production
// at a URL containing the literal string '__mod_hunt__' (src/pages/Overlay.js in the frontend
// repo is fully generic, keyed only by whatever :userId appears in the URL). That URL must
// never need to change, so tenantId === 'bean' (or falsy, back-compat) always resolves to the
// bare MOD_HUNT_ID/AFFILIATE_HUNT_ID string. Any OTHER tenant gets a namespaced key so multiple
// communities' mod hunts don't collide on one global object.
function modHuntKey(tenantId) {
  return (tenantId === 'bean' || !tenantId) ? MOD_HUNT_ID : `${MOD_HUNT_ID}:${tenantId}`;
}
function affiliateHuntKey(tenantId) {
  return (tenantId === 'bean' || !tenantId) ? AFFILIATE_HUNT_ID : `${AFFILIATE_HUNT_ID}:${tenantId}`;
}

// Vault (base-game wins): counts toward WINNINGS/P&L, never toward a multiplier. Optional field.
const sumVault = h => (h && Array.isArray(h.vault) ? h.vault.reduce((s, v) => s + (+v.amount || 0), 0) : 0);

function huntSummary(h) {
  return {
    userId: h.user?.id, username: h.user?.displayName, avatar: h.user?.avatar,
    huntType: h.huntType, isLive: h.isLive, startedAt: h.startedAt, archivedAt: h.archivedAt||null,
    // null = legacy hunt logged before currency tracking (stats count it as USD) — the admin
    // UI surfaces these so they can be retagged via POST /api/admin/hunts/retag-currency.
    currency: h.currency || null,
    bonusCount: (h.bonuses||[]).length,
    totalWon: (h.bonuses||[]).reduce((s,b)=>s+(b.win||0),0) + sumVault(h),
    pot: (h.equity||[]).reduce((s,e)=>s+(e.amount||0),0),
    // Include the equity list ONLY for archived hunts — needed for per-member all-time-payout
    // calculation on the equity cards. Live hunts omit it (bandwidth + don't expose equity publicly).
    equity: h.archivedAt
      ? (h.equity || []).map(e => ({
          id: e.id,
          // Archived summaries are public (hub Archived tab, share links) with no viewer context —
          // mask anonymous members' names here too so history can't de-anonymize them.
          name: shouldMaskIdentity({ discordId: e.discordId, name: e.name }) ? 'Anonymous' : e.name,
          amount: e.amount, isRollWinner: !!e.isRollWinner, isMod: !!e.isMod,
        }))
      : undefined,
    // Archived-only, same reason as `equity` above: the equity cards recompute gift-aware
    // all-time payouts client-side, so they need the ledger alongside the equity list.
    gifts: h.archivedAt ? (h.gifts || []) : undefined,
    chases: h.archivedAt ? (h.chases || []) : undefined,
    viewers: viewers[h.user?.id]||0,
    huntMode: h.huntMode||'creating',
    lockTop4: h.lockTop4 ?? false,
    rolledCount: (h.bonuses||[]).filter(b=>b.win!=null).length,
    // "Completed" == every bonus has been opened (a win recorded). Mirrors the frontend's
    // allBonusesOpened. Drives the public Archived tab (completed-only) + the janitor.
    completed: huntCompleted(h),
    createdAt: h.createdAt || null, updatedAt: h.updatedAt || null,
  };
}
// A hunt is "completed" when it has bonuses and all of them have been opened (win recorded).
function huntCompleted(h) {
  return Array.isArray(h.bonuses) && h.bonuses.length > 0 && h.bonuses.every(b => b.win != null);
}
// A hunt has "content" (is worth showing on the hub + spared by the 1h dead-reaper) when it
// has a bonus, a REAL equity member (amount>0 or a non-auto-seed id), or a non-solo call.
// Solo calls are excluded because solo hunts auto-inject the creator's preferred slots into
// the call queue on creation (frontend), which would otherwise fake liveness. Shared by
// getPublicHunts (hub filter) and cleanupStaleHunts (janitor) so the two can't drift.
function huntHasContent(h) {
  if (!h) return false;
  if (Array.isArray(h.bonuses) && h.bonuses.length > 0) return true;
  if (Array.isArray(h.equity) && h.equity.some(e =>
    (e && e.amount > 0) || (e && e.id !== 'creator_auto' && e.id !== 'bean_auto'))) return true;
  if (h.huntType !== 'solo' && Array.isArray(h.calls) && h.calls.length > 0) return true;
  return false;
}
function tenantOf(h) { return h.tenantId || 'bean'; } // untagged hunts belong to Bean (back-compat)
function inTenant(h, tenantId) { return tenantOf(h) === (tenantId || 'bean'); }
// Hub "live now" filter. A COMPLETED hunt (every bonus opened) STAYS here while it's still isLive:
// after the last win the hunt keeps a 10-minute editable grace window (host does final tweaks), and
// it should remain visible on the hub for that window. It drops off naturally when the janitor's
// completed-reap flips isLive=false (→ Archived tab) after ~10m of inactivity — see cleanupStaleHunts.
function getPublicHunts(tenantId)   { return Object.values(hunts).filter(h=>h.isLive && huntHasContent(h) && inTenant(h,tenantId) && h.user?.id !== modHuntKey(tenantId) && h.user?.id !== affiliateHuntKey(tenantId)).map(huntSummary); }
// Public Archived tab: only completed hunts (every bonus opened). Incomplete ended hunts are
// hidden here — admins still see them in the All tab, and the janitor eventually reaps them.
function getArchivedHunts(tenantId) { return archive.filter(h=>inTenant(h,tenantId) && huntCompleted(h)).map(huntSummary); }
// Admin All tab: every hunt — created, live, and archived. Union of the current hunts (created/
// live/ended) with archived snapshots whose hunt is no longer current, deduped by huntId.
function getAllHunts(tenantId) {
  const current = Object.values(hunts).filter(h=>inTenant(h,tenantId) && h.user?.id !== modHuntKey(tenantId) && h.user?.id !== affiliateHuntKey(tenantId));
  const seen = new Set(current.map(h=>h.huntId).filter(Boolean));
  const archivedOnly = archive.filter(h=>inTenant(h,tenantId) && (!h.huntId || !seen.has(h.huntId)));
  return [...current, ...archivedOnly].map(huntSummary);
}
// Slot popularity aggregation for "Add Random Slots". Counts how many hunts featured each
// slot — once per hunt (calls/bonuses are deduped per hunt by persistence), so the count is
// "appeared in N hunts". Two signals: calls[] (what people CALLED) and bonuses[] (what GOT IN
// / actually played). Tenant-scoped; mirrors getAllHunts' current+archived dedup so a live hunt
// that's also archived isn't double-counted. Returns top 250 of each, sorted desc.
function getSlotCallCounts(tenantId) {
  const current = Object.values(hunts).filter(h=>inTenant(h,tenantId) && h.user?.id !== modHuntKey(tenantId) && h.user?.id !== affiliateHuntKey(tenantId));
  const seen = new Set(current.map(h=>h.huntId).filter(Boolean));
  const archivedOnly = archive.filter(h=>inTenant(h,tenantId) && (!h.huntId || !seen.has(h.huntId)));
  const all = [...current, ...archivedOnly];
  const norm = s => (s||'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();
  const bump = (map, slot) => {
    const name = (slot||'').trim();
    const k = norm(name);
    if (!k) return;
    const e = map.get(k);
    if (e) e.count++; else map.set(k, { name, count: 1 });
  };
  const callMap = new Map(), bonusMap = new Map();
  for (const h of all) {
    if (Array.isArray(h.calls))   for (const c of h.calls)   bump(callMap, c.slot);
    if (Array.isArray(h.bonuses)) for (const b of h.bonuses) bump(bonusMap, b.slot);
  }
  const top = map => [...map.values()].sort((a,b)=>b.count-a.count).slice(0,250);
  return { calls: top(callMap), bonuses: top(bonusMap) };
}
// Got-In event log for the admin CSV export. Unlike getSlotCallCounts (which dedups to a
// per-hunt count), this returns EVERY individual got-in event — one row per bonus that carries
// a `ts` (stamped by the frontend when "Got In" is pressed). Tenant-scoped; mirrors the
// current+archived dedup so a live hunt that's also archived isn't emitted twice. Bonuses
// without a `ts` (pre-feature history) are skipped since they have no time. Sorted newest first.
function getGotInLog(tenantId) {
  const current = Object.values(hunts).filter(h=>inTenant(h,tenantId) && h.user?.id !== modHuntKey(tenantId) && h.user?.id !== affiliateHuntKey(tenantId));
  const seen = new Set(current.map(h=>h.huntId).filter(Boolean));
  const archivedOnly = archive.filter(h=>inTenant(h,tenantId) && (!h.huntId || !seen.has(h.huntId)));
  const all = [...current, ...archivedOnly];
  const rows = [];
  for (const h of all) {
    if (!Array.isArray(h.bonuses)) continue;
    for (const b of h.bonuses) {
      if (!b || !b.ts) continue;
      rows.push({ ts: b.ts, slot: (b.slot||'').trim(), bet: Number(b.bet)||0 });
    }
  }
  rows.sort((a,b)=>b.ts-a.ts);
  return rows;
}
// Flat per-bonus rows for the admin "Export CSV" button: one row per bonus across every
// current + archived hunt in the tenant, hunt metadata repeated on each row so the CSV is
// self-contained for spreadsheet pivoting. Newest got-in first (rows without a ts sink).
function getHuntsFullExport(tenantId) {
  const { all } = tenantHuntsUnion(tenantId);
  const rows = [];
  for (const h of all) {
    if (!Array.isArray(h.bonuses)) continue;
    const huntMeta = {
      huntId: h.huntId || null,
      hunter: h.user?.displayName || h.user?.id || 'unknown',
      huntType: h.huntType || 'community',
      huntMode: h.huntMode || 'creating',
      currency: h.currency || 'USD',
      pot: (h.equity||[]).reduce((s,e)=>s+(e.amount||0),0),
      equityCount: (h.equity||[]).length,
      totalSlots: h.bonuses.length,
      startedAt: h.startedAt || h.createdAt || null,
      archivedAt: h.archivedAt || null,
      completed: huntCompleted(h),
    };
    for (let i = 0; i < h.bonuses.length; i++) {
      const b = h.bonuses[i];
      if (!b) continue;
      const bet = Number(b.bet)||0, win = Number(b.win)||0;
      rows.push({
        ...huntMeta,
        slotIndex: i + 1,
        slot: (b.slot||'').trim(),
        provider: b.provider || null,
        bet,
        win,
        mult: bet > 0 && win > 0 ? +(win/bet).toFixed(2) : null,
        scat: b.scat || null,
        caller: b.caller || null,
        gotInAt: b.ts || null,
      });
    }
  }
  rows.sort((a,b) => (b.gotInAt||0) - (a.gotInAt||0));
  return rows;
}
// Union of current + archived hunts for a tenant (FULL hunt objects, not summaries) —
// the same dedup rule as getAllHunts. Used by the admin stats aggregation below; the
// three older builders above keep their own inline copies (contract-sensitive, untouched).
function tenantHuntsUnion(tenantId) {
  const current = Object.values(hunts).filter(h=>inTenant(h,tenantId) && h.user?.id !== modHuntKey(tenantId) && h.user?.id !== affiliateHuntKey(tenantId));
  const seen = new Set(current.map(h=>h.huntId).filter(Boolean));
  const archivedOnly = archive.filter(h=>inTenant(h,tenantId) && (!h.huntId || !seen.has(h.huntId)));
  return { current, all: [...current, ...archivedOnly] };
}

// Admin dashboard statistics. tz is an IANA zone used to bucket got-in timestamps into
// hour-of-day / weekday and hunt starts into weeks — the frontend sends the admin's browser
// zone so "8pm" means 8pm for whoever is looking. Falls back to America/Chicago (same
// default as the got-in xlsx export) if the zone is missing or invalid.
//
// Money never crosses currencies: hunts are grouped by hunt.currency (legacy untagged =
// USD, matching the frontend's `hunt.currency || 'USD'`) and EVERY section — counts,
// charts, and tables alike — is computed per group, so an ARS pot is never summed into a
// USD total (and multipliers aren't skewed by mixed-magnitude bets). Returns
// { currencies: [{code,hunts}…] desc by hunt count, byCurrency: { CODE: block }, tz }.
// Pure aggregation over a single list of hunts (one currency slice). Extracted out of
// getHuntStats (2026-07-19) so it's unit-testable without the module-scoped hunts/archive
// singletons: pass any list + a liveSet (hunts considered "live now") + an IANA tz.
// INVARIANT: overallMulti divides bonus wins by bonus bets ONLY — vault entries have no
// bet and must never enter that ratio. totalWon/pnl are winnings and DO include vault.
function aggregateHuntStats(list, liveSet, tz) {
  let zone = tz || 'America/Chicago';
  try { new Intl.DateTimeFormat('en-US', { timeZone: zone }); } catch { zone = 'America/Chicago'; }
  const hourFmt = new Intl.DateTimeFormat('en-US', { timeZone: zone, hour: 'numeric', hour12: false });
  const ymdFmt  = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' });
  const hourOf = ts => { const h = parseInt(hourFmt.format(new Date(ts)), 10); return (h === 24 ? 0 : h); };
  const ymdOf  = ts => ymdFmt.format(new Date(ts)); // YYYY-MM-DD in zone
  // Weekday + week-start derived from the zone-local Y-M-D (re-parsed as UTC so getUTCDay is stable).
  const dayIdx = ymd => (new Date(ymd + 'T00:00:00Z').getUTCDay() + 6) % 7; // 0=Mon .. 6=Sun
  const weekStartOf = ymd => {
    const d = new Date(ymd + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() - dayIdx(ymd));
    return d.toISOString().slice(0, 10);
  };

  const norm = s => (s||'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();

  const types = { community: 0, vip: 0, solo: 0 };
  const slotMap = new Map();    // norm -> per-slot aggregate
  const callMap = new Map();    // norm -> { name, called }
  const hunterMap = new Map();  // userId -> { name, avatar, hunts, totalWon }
  const hits = [];              // every opened bonus, for the biggest-hits top list
  const hours = new Array(24).fill(0);
  const weekdays = new Array(7).fill(0);
  const weekCounts = new Map(); // weekStart -> hunts started
  let totalBonuses = 0, openedBonuses = 0, totalBet = 0, openedBet = 0, openedWon = 0;
  let completedHunts = 0, potSum = 0, potHunts = 0, potWon = 0, untagged = 0;

  for (const h of list) {
    types[h.huntType] !== undefined ? types[h.huntType]++ : types.community++;
    if (huntCompleted(h)) completedHunts++;
    if (!h.currency) untagged++; // legacy hunt, bucketed as USD — surfaced for admin retagging
    const pot = (h.equity||[]).reduce((s,e)=>s+(e.amount||0),0);
    const huntWon = (h.bonuses||[]).reduce((s,b)=>s+(+b.win||0),0); // bonus-only, feeds overallMulti path
    // P/L (canonical: totalWon − pot, same as the tracker's profitLoss) is only computable
    // for hunts that recorded a starting pot — potless hunts are excluded, never counted as
    // pure profit. potWon pairs the wins to those same hunts so the subtraction is honest.
    // Vault has no bet, so it's added here (P&L) but never into the bonus win/bet ratio.
    if (pot > 0) { potSum += pot; potHunts++; potWon += huntWon + sumVault(h); }

    const startTs = Date.parse(h.startedAt || h.createdAt || '');
    if (!isNaN(startTs)) {
      const wk = weekStartOf(ymdOf(startTs));
      weekCounts.set(wk, (weekCounts.get(wk)||0) + 1);
    }

    if (h.user?.id) {
      const e = hunterMap.get(h.user.id) || { userId: h.user.id, name: '', avatar: null, hunts: 0, totalWon: 0, totalPot: 0, potWon: 0, pnlHunts: 0 };
      e.hunts++;
      // current hunts iterate first, so the first-seen name/avatar is the freshest
      if (!e.name) { e.name = h.user.displayName || h.user.id; e.avatar = h.user.avatar || null; }
      e.totalWon += huntWon + sumVault(h);
      // per-hunter P/L over the same pot-tracked subset as the summary P/L
      if (pot > 0) { e.totalPot += pot; e.potWon += huntWon + sumVault(h); e.pnlHunts++; }
      hunterMap.set(h.user.id, e);
    }

    if (Array.isArray(h.calls)) for (const c of h.calls) {
      const k = norm(c.slot); if (!k) continue;
      const e = callMap.get(k) || { name: (c.slot||'').trim(), called: 0 };
      e.called++; callMap.set(k, e);
    }

    if (!Array.isArray(h.bonuses)) continue;
    for (const b of h.bonuses) {
      if (!b) continue;
      const bet = Number(b.bet)||0, win = +b.win||0;
      totalBonuses++; totalBet += bet;
      if (b.ts) { const ymd = ymdOf(b.ts); hours[hourOf(b.ts)]++; weekdays[dayIdx(ymd)]++; }
      const k = norm(b.slot);
      if (k) {
        const e = slotMap.get(k) || { name: (b.slot||'').trim(), entries: 0, huntIds: new Set(), totalBet: 0, totalWin: 0, openedBet: 0, opened: 0, bestWin: 0, bestMulti: 0 };
        e.entries++; e.huntIds.add(h.huntId || h.user?.id || '?'); e.totalBet += bet;
        if (win > 0) {
          e.opened++; e.totalWin += win; e.openedBet += bet;
          if (win > e.bestWin) e.bestWin = win;
          if (bet > 0 && win/bet > e.bestMulti) e.bestMulti = win/bet;
        }
        slotMap.set(k, e);
      }
      if (win > 0) {
        openedBonuses++; openedBet += bet; openedWon += win;
        hits.push({ slot: (b.slot||'').trim(), bet, win, multi: bet > 0 ? win/bet : 0, hunter: h.user?.displayName || null, ts: b.ts || null });
      }
    }
  }

  // ── shape the result ──
  const topGotIn = [...slotMap.values()]
    .sort((a,b)=>b.entries-a.entries).slice(0, 15)
    .map(e => ({ name: e.name, entries: e.entries, hunts: e.huntIds.size, totalBet: e.totalBet, totalWin: e.totalWin,
                 avgMulti: e.openedBet > 0 ? e.totalWin/e.openedBet : null, bestMulti: e.bestMulti || null, bestWin: e.bestWin || null }));
  const topCalled = [...callMap.entries()]
    .sort((a,b)=>b[1].called-a[1].called).slice(0, 10)
    .map(([k, e]) => ({ name: e.name, called: e.called, gotIn: slotMap.get(k)?.entries || 0 }));
  const topHunters = [...hunterMap.values()].sort((a,b)=>b.hunts-a.hunts).slice(0, 10)
    .map(({ potWon, ...e }) => ({ ...e, pnl: e.pnlHunts ? potWon - e.totalPot : null }));
  const biggestHits = hits.sort((a,b)=>b.win-a.win).slice(0, 10);
  // Last 12 calendar weeks (Mon-start, zone-local), oldest first, zero-filled.
  const thisWeek = new Date(weekStartOf(ymdOf(Date.now())) + 'T00:00:00Z');
  const weeks = [];
  for (let i = 11; i >= 0; i--) {
    const d = new Date(thisWeek); d.setUTCDate(d.getUTCDate() - 7*i);
    const key = d.toISOString().slice(0, 10);
    weeks.push({ weekStart: key, count: weekCounts.get(key) || 0 });
  }

  const vaultTotal = list.reduce((s, h) => s + sumVault(h), 0);

  return {
    summary: {
      totalHunts: list.length, completedHunts,
      liveNow: list.filter(h => liveSet.has(h)).length,
      totalBonuses, openedBonuses, totalBet, totalWon: openedWon + vaultTotal,
      overallMulti: openedBet > 0 ? openedWon/openedBet : null, // bonus-only — vault excluded
      avgSlotsPerHunt: list.length ? totalBonuses/list.length : 0,
      avgPot: potHunts ? potSum/potHunts : 0,
      totalPot: potSum,
      pnl: potHunts ? potWon - potSum : null, // null = no hunt recorded a pot, P/L unknowable
      pnlHunts: potHunts,
      untagged,
      types,
    },
    topGotIn, topCalled, topHunters, biggestHits,
    hours, weekdays, weeks,
  };
}

function getHuntStats(tenantId, tz) {
  let zone = tz || 'America/Chicago';
  try { new Intl.DateTimeFormat('en-US', { timeZone: zone }); } catch { zone = 'America/Chicago'; }

  const { current, all } = tenantHuntsUnion(tenantId);
  const liveSet = new Set(current.filter(h => h.isLive && !h.archivedAt));

  const groups = new Map(); // currency code -> hunts
  for (const h of all) {
    const code = h.currency || 'USD';
    if (!groups.has(code)) groups.set(code, []);
    groups.get(code).push(h);
  }

  const currencies = [...groups.keys()].sort((a, b) => groups.get(b).length - groups.get(a).length);
  const byCurrency = {};
  for (const code of currencies) byCurrency[code] = aggregateHuntStats(groups.get(code), liveSet, zone);
  return {
    currencies: currencies.map(code => ({ code, hunts: groups.get(code).length })),
    byCurrency, tz: zone,
  };
}

function emitHubUpdate(tenantId)    { persistHunts(); io.to('hub:'+(tenantId||'bean')).emit('hub:update', getPublicHunts(tenantId)); }
// Strip owner-only secrets + internal linkage before any public exposure: the share link
// (GET /api/share/:token) and the hunt:<id> socket broadcast, which includes non-editor
// viewers. Mirrors the GET /api/hunts/:userId non-editor branch so the two public views can't
// drift: PIN -> requiresPin boolean, drop the editor list + call-permission IDs, and drop each
// equity member's discordId. (Editors get invitedEditors from the REST invite endpoint, not the
// socket; callsPermissions and equity.discordId are never read client-side.)
// Does this hunt have any equity member who opted into anonymous mode? Cheap O(members) check
// used to keep the common case (no anon members) on the original single-broadcast fast path.
function huntHasAnon(h) {
  const eq = Array.isArray(h.equity) && h.equity.some(e => shouldMaskIdentity({ discordId: e.discordId, name: e.name }));
  const ca = Array.isArray(h.calls) && h.calls.some(c => shouldMaskIdentity({ discordId: c.callerId, name: c.user }));
  const bo = Array.isArray(h.bonuses) && h.bonuses.some(b => shouldMaskIdentity({ discordId: b.callerId, name: b.caller }));
  return !!(eq || ca || bo);
}
// Mask one call/bonus caller entry. Strips callerId always; privileged/self keep the real name.
function maskCallerEntry(entry, nameField, viewerId, privileged) {
  const { callerId, ...e } = entry;
  if (!shouldMaskIdentity({ discordId: callerId, name: e[nameField] })) return e;
  const isSelf = viewerId && callerId && String(viewerId) === String(callerId);
  if (privileged || isSelf) return { ...e, anonymous: true };
  return { ...e, [nameField]: 'Anonymous', anonymous: true };
}
// Map one equity member for the wire, applying anonymous-mode redaction. `privileged` is whether
// the viewer may see real names at all; a member always sees their OWN real name. Non-privileged
// viewers get name → 'Anonymous' and no avatar. `discordId` is dropped either way (internal linkage).
// The `anonymous` flag is always surfaced so a privileged viewer's UI can badge the hidden member.
// Owner-authorized identity bind: attach a verified Discord id to the ONE unlinked equity row
// whose name matches. Ambiguous (2+) or no match → no-op (fall back to the manual link). Never
// overwrites an existing discordId. Matching is display-name only and is safe here because the
// caller (the call-grant handler) has just had the OWNER approve this specific person.
function bindEquityIdentityByName(hunt, { userId, name } = {}) {
  if (!hunt || !Array.isArray(hunt.equity) || !userId || !name) return { bound: false, memberId: null };
  const norm = s => (s || '').toString().toLowerCase().replace(/\s+/g, ' ').trim();
  const target = norm(name);
  if (!target) return { bound: false, memberId: null };
  const matches = hunt.equity.filter(e => !e.discordId && norm(e.name) === target);
  if (matches.length !== 1) return { bound: false, memberId: null };
  matches[0].discordId = String(userId);
  return { bound: true, memberId: matches[0].id };
}

// Admin-authorized identity link: bind a chosen discordId to a specific equity row by member id.
function linkEquityMember(hunt, memberId, discordId) {
  if (!hunt || !Array.isArray(hunt.equity) || !memberId || !discordId) return false;
  const row = hunt.equity.find(e => e.id === memberId);
  if (!row) return false;
  row.discordId = String(discordId);
  return true;
}

function maskEquityMember(member, viewerId, privileged) {
  const { discordId, callerId, ...e } = member; // drop internal linkage from every public payload
  const isSelf = viewerId && discordId && String(viewerId) === String(discordId);
  // Surface link STATE (a boolean, never the raw id) to privileged viewers / self so the manage
  // UI can show "Linked" vs "⚠ Not linked". Non-privileged viewers never learn linkage.
  if (discordId && (privileged || isSelf)) e.linked = true;
  if (!shouldMaskIdentity({ discordId, name: e.name })) return e;
  if (privileged || isSelf) return { ...e, anonymous: true };
  return { ...e, name: 'Anonymous', avatar: null, anonymous: true };
}
// Strip owner-only secrets + internal linkage before public exposure, and redact the names of
// anonymous members for viewers who aren't the hunt runner / a mod / an admin. `viewerId` is the
// Discord id of the recipient (per-socket) — omit it for the fully-masked, privacy-safe default
// (share links, unidentified sockets).
function publicHuntView(h, viewerId) {
  if (!h) return h;
  const { publicCallsPin, invitedEditors, callsPermissions, ...rest } = h;
  const privileged = viewerId ? isPrivilegedViewer(viewerId, h) : false;
  return {
    ...rest,
    requiresPin: !!publicCallsPin,
    equity: Array.isArray(h.equity) ? h.equity.map(e => maskEquityMember(e, viewerId, privileged)) : h.equity,
    calls: Array.isArray(h.calls) ? h.calls.map(c => maskCallerEntry(c, 'user', viewerId, privileged)) : h.calls,
    bonuses: Array.isArray(h.bonuses) ? h.bonuses.map(b => maskCallerEntry(b, 'caller', viewerId, privileged)) : h.bonuses,
  };
}
// Broadcast a hunt to its watch room. When no member is anonymous this is the original single
// room-broadcast (zero behavior change). When a member IS anonymous we serialize PER SOCKET so
// the runner/mods/admins keep real names while everyone else sees 'Anonymous' — a room-wide
// broadcast can't carry two different payloads. Per-socket viewer identity comes from
// socket.data.userId (set by the 'identify' handler in sockets/index.js).
async function emitHuntUpdate(userId) {
  const h = hunts[userId];
  if (!h) return;
  persistHunts();
  const room = `hunt:${userId}`;
  if (!huntHasAnon(h)) { io.to(room).emit('hunt:update', publicHuntView(h)); return; }
  try {
    const sockets = await io.in(room).fetchSockets();
    for (const s of sockets) s.emit('hunt:update', publicHuntView(h, s.data && s.data.userId));
  } catch (e) {
    // Fallback: never leak names if the per-socket path fails — send the fully-masked view.
    io.to(room).emit('hunt:update', publicHuntView(h));
  }
}

function uid() { return Math.random().toString(36).slice(2, 8); }
// Stamp a hunt's last-activity time so the stale-hunt janitor (cleanupStaleHunts) can measure idleness.
function touch(userId) { const h = hunts[userId]; if (h) h.updatedAt = new Date().toISOString(); }

// Defense-in-depth for user-supplied replay links: bonuses arrays are stored
// verbatim, so strip any replayUrl that isn't plain http(s) before it can
// reach public share pages. Leaves all other bonus fields untouched.
function sanitizeBonusReplayUrls(bonuses) {
  if (!Array.isArray(bonuses)) return bonuses;
  return bonuses.map(b => {
    if (!b || typeof b !== 'object' || b.replayUrl == null || b.replayUrl === '') return b;
    const u = String(b.replayUrl).trim();
    return /^https?:\/\//i.test(u) ? { ...b, replayUrl: u } : { ...b, replayUrl: '' };
  });
}

module.exports = {
  initHuntsCore,
  MOD_HUNT_ID, AFFILIATE_HUNT_ID, CURRENCIES, modHuntKey, affiliateHuntKey,
  huntSummary, huntCompleted, huntHasContent, tenantOf, inTenant, sumVault,
  getPublicHunts, getArchivedHunts, getAllHunts, getSlotCallCounts, getGotInLog, getHuntsFullExport, getHuntStats, aggregateHuntStats,
  emitHubUpdate, publicHuntView, emitHuntUpdate, huntHasAnon,
  bindEquityIdentityByName, linkEquityMember,
  uid, touch, sanitizeBonusReplayUrls,
};
