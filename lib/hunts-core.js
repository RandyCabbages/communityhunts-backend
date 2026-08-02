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

const crypto = require('crypto');   // uid() — ids double as public share tokens, see below

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

// Fixed hunt keys for the shared tenant / affiliate / vip hunts (not per-user).
// NB: the symbol is still MOD_HUNT_ID (its many importers + the /api/mod-hunt route path are kept
// for wire compat), but its VALUE was rebranded '__mod_hunt__' → '__tenant_hunt__' so the OBS
// overlay URL reads /:slug/overlay/__tenant_hunt__ instead of /__mod_hunt__. Existing live state
// and saved overlay styling are moved to the new key on startup by lib/migrateSharedHuntKeys.js;
// archived hunt_history rows keep the old key forever (ledgerQuery.MOD_HUNT_KEYS lists both).
const MOD_HUNT_ID = '__tenant_hunt__';
const AFFILIATE_HUNT_ID = '__affiliate_hunt__';
const VIP_HUNT_ID = '__vip_hunt__';

// The currency vocabulary. MUST match the frontend's CURRENCIES in src/hunt/huntMath.js —
// the two lists drifted once (backend only knew USD/CAD/ARS) and GBP/AUD hunts were
// rejected with 400 "Invalid currency" while the picker happily offered them.
const CURRENCIES = ['USD', 'GBP', 'AUD', 'CAD', 'ARS'];

// Resolve the correct hunt key for a tenant. The 'bean' tenant ALWAYS gets the bare key; the OBS
// browser-source overlay URL contains that literal string (src/pages/Overlay.js in the frontend
// repo is fully generic, keyed only by whatever :userId appears in the URL). tenantId === 'bean'
// (or falsy, back-compat) resolves to the bare MOD_HUNT_ID/AFFILIATE_HUNT_ID/VIP_HUNT_ID string;
// any OTHER tenant gets a namespaced key so communities' shared hunts don't collide on one global
// object. (Bean's bare key changed __mod_hunt__ → __tenant_hunt__ in the rebrand — see the note at
// MOD_HUNT_ID; migrateSharedHuntKeys.js carries the old state forward so no link/config is lost.)
function modHuntKey(tenantId) {
  return (tenantId === 'bean' || !tenantId) ? MOD_HUNT_ID : `${MOD_HUNT_ID}:${tenantId}`;
}
function affiliateHuntKey(tenantId) {
  return (tenantId === 'bean' || !tenantId) ? AFFILIATE_HUNT_ID : `${AFFILIATE_HUNT_ID}:${tenantId}`;
}
function vipHuntKey(tenantId) {
  return (tenantId === 'bean' || !tenantId) ? VIP_HUNT_ID : `${VIP_HUNT_ID}:${tenantId}`;
}

// Vault (base-game wins): counts toward WINNINGS/P&L, never toward a multiplier. Optional field.
const sumVault = h => (h && Array.isArray(h.vault) ? h.vault.reduce((s, v) => s + (+v.amount || 0), 0) : 0);

// Who is actually RUNNING a shared hunt.
//
// VIP and Affiliate hunts are owned by the COMMUNITY, so `user.displayName` is the tenant's host
// name (hostNameFor → "Bean") no matter who opened them. Once these started appearing on the hub
// that read as flatly wrong: a VIP hunt run by Mcflurry showed Bean's name and avatar letter.
//
// The runner is the `creator_auto` equity row — seeded with the display name of the mod who opens
// the hunt page (frontend EMPTY_VIP_HUNT / EMPTY_AFFILIATE_HUNT). This is DISPLAY ONLY: `userId`
// stays the shared key, so watch links, socket rooms and OBS URLs are untouched.
//
// Deliberately limited to the two community-facing shared hunts. A personal hunt's owner name is
// already correct, and letting a renamed creator_auto row override it would be a spoofing vector;
// the tenant/mod hunt really is the host's own, so "Bean" is right there.
//
// `isAnon` overrides the module-level masking predicate for callers that inject their own
// (lib/bangers.js, lib/hallOfFame.js — the public rails take it as an option and bangers
// deliberately defaults it FAIL-CLOSED, which the module-level default is not).
// Returns { name, avatar } or null.
function huntRunnerOf(h, isAnon) {
  const mask = isAnon || shouldMaskIdentity;
  const cat = huntCategoryOf(h);
  if (cat !== 'vip' && cat !== 'affiliate') return null;

  // Preferred: `h.runner`, stamped SERVER-SIDE from the session of the mod who opened the hunt
  // (routes/mod-hunt.routes.js). Not client-writable — the shared PUT whitelists fields and
  // `runner` is not among them — so it cannot be spoofed by editing a hunt payload.
  const r = h.runner;
  if (r && typeof r.name === 'string' && r.name.trim()) {
    const name = r.name.trim();
    return mask({ discordId: r.id, name })
      ? null
      : { name, avatar: r.avatar || null };
  }

  // Fallback for hunts that were already running when stamping shipped: the `creator_auto` equity
  // row carries the opener's display name (seeded client-side). Name only — no avatar, since the
  // row has never held one.
  const row = (h.equity || []).find(e => e && e.id === 'creator_auto');
  const name = row && typeof row.name === 'string' ? row.name.trim() : '';
  if (!name) return null;
  // Same masking the rest of this file applies — a runner who hunts anonymously stays anonymous
  // rather than being outed by the hub card.
  return mask({ discordId: row.discordId, name }) ? null : { name, avatar: null };
}

function huntSummary(h) {
  const runner = huntRunnerOf(h);
  return {
    userId: h.user?.id, username: runner?.name || h.user?.displayName,
    avatar: runner?.avatar || h.user?.avatar,
    // DERIVED public category ('vip' | 'affiliate' | 'streamer' | 'community' | 'solo'), which is
    // NOT the same thing as the raw `huntType` below: emptyAffiliateHunt carries huntType 'vip',
    // so huntType alone cannot tell an Affiliate hunt from a VIP one. The hub needs that
    // distinction to pull both into the featured row, so send the resolved category explicitly
    // rather than making every caller re-derive it from the key.
    category: huntCategoryOf(h),
    huntType: h.huntType, isLive: h.isLive, startedAt: h.startedAt, archivedAt: h.archivedAt||null,
    // null = legacy hunt logged before currency tracking (stats count it as USD) — the admin
    // UI surfaces these so they can be retagged via POST /api/admin/hunts/retag-currency.
    currency: h.currency || null,
    bonusCount: (h.bonuses||[]).length,
    totalWon: (h.bonuses||[]).reduce((s,b)=>s+(b.win||0),0) + sumVault(h),
    pot: (h.equity||[]).reduce((s,e)=>s+(e.amount||0),0),
    // Same "is there anything here?" test the hub uses to hide empty born-live hunts — lets the
    // admin match the hub so an opened-but-empty hunt reads as "Created", not "Live".
    hasContent: huntHasContent(h),
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

// PUBLIC product label for a hunt — what the Developer API and any customer-facing surface
// should say. Deliberately NOT the same thing as `huntType`, which is an internal BEHAVIOUR
// key: it drives equity injection, call-limit defaults and theming, which is why the Affiliate
// Hunt is huntType 'vip' and the streamer's own Mod Hunt is 'solo'. What distinguishes those
// two is the synthetic user.id key, not the type.
//
// Derived rather than stored: `huntType` has ~46 hard equality checks across the two repos, so
// promoting 'affiliate' to a real huntType value would make every `=== 'vip'` check silently
// stop firing for affiliate hunts — no error, they'd just lose equity injection and styling.
// Deriving also applies retroactively to the whole archive with no migration.
//
// ORDER MATTERS: a shared hunt matches both its key branch and the huntType branch, so the
// shared-key checks must come first.
//
// All THREE per-tenant shared hunts are identified by their key. The VIP Hunt used to be missing
// here and fell through to the huntType branch, which made it indistinguishable from any hunt
// carrying huntType 'vip' — the only one of the three shared hunts with no label of its own. The
// existing test even asserted that ("categorizes as plain 'vip', unlike affiliate which needs its
// key"), so a green suite pinned it in place.
//
// 'vip' now means THE VIP HUNT and nothing else. huntType 'vip' stays an internal BEHAVIOUR flag
// (equity injection, call-limit defaults, theming) that a mod may set on a regular hunt, but that
// is a community hunt which happens to be VIP-shaped underneath — not a VIP hunt. Dropping 'vip'
// from the storable set also means the label cannot be reached by writing the field: until
// 2026-07-29 three routes wrote huntType and only two checked reqIsMod, so a regular user could
// set 'vip' on their own hunt and have this report it as one.
const HUNT_CATEGORIES = ['community', 'solo'];
// Every label huntCategoryOf can RETURN — a superset of the storable set above, because the three
// shared runs are derived from the hunt key rather than written into the field. This is the public
// `huntType` vocabulary: the `?huntType=` filter validates against it and /stats counts by it, so
// both stay in step with the serializer by construction.
//
// ADDING A VALUE HERE IS A PUBLISHED API CHANGE. This list went 3 → 5 once already with no notice,
// and a consumer strict-parsing the field — the responsible default — starts throwing on live data
// the moment it grows. The published contract is now "new values are additive and may appear at any
// time; tolerate unknown ones", which only holds up if the additions are announced. So when you add
// one, also:
//   1. add a dated entry to the frontend's API changelog (src/docs/apiChangelog.js), and
//   2. add a label for it to DEFAULT_HUNT_TYPE_LABELS (lib/apiIdentity.js), which /me serves and
//      which must stay total over this list.
// Note the deliberate asymmetry with the filter: an unknown `huntType` VALUE in a query is a 400
// (a typo must never quietly return the wrong board), while an unknown value in a RESPONSE must be
// tolerated. That is not an inconsistency — don't "fix" it.
const PUBLIC_HUNT_CATEGORIES = ['community', 'solo', 'vip', 'affiliate', 'streamer'];
function huntCategoryOf(h) {
  if (!h) return null;
  const tid = tenantOf(h);
  const ownerId = h.user && h.user.id;
  if (ownerId && ownerId === affiliateHuntKey(tid)) return 'affiliate';
  if (ownerId && ownerId === modHuntKey(tid)) return 'streamer';
  if (ownerId && ownerId === vipHuntKey(tid)) return 'vip';
  return HUNT_CATEGORIES.includes(h.huntType) ? h.huntType : 'community';
}
function inTenant(h, tenantId) { return tenantOf(h) === (tenantId || 'bean'); }
// Hub "live now" filter. A COMPLETED hunt (every bonus opened) STAYS here while it's still isLive:
// after the last win the hunt keeps a 10-minute editable grace window (host does final tweaks), and
// it should remain visible on the hub for that window. It drops off naturally when the janitor's
// completed-reap flips isLive=false (→ Archived tab) after ~10m of inactivity — see cleanupStaleHunts.
// SHARED-HUNT VISIBILITY (changed 2026-08-01). All three shared hunts used to be excluded here, so
// a live VIP or Affiliate hunt appeared NOWHERE on the hub — the only surface was StaffHuntsSection,
// which is isCommunityMod-gated, meaning a Discord-VIP who was not also a mod could not find the VIP
// hunt at all. VIP and Affiliate are community-facing events and now list like any other live hunt;
// the card links to /:slug/hunt/:key (WatchHunt), which is generic and read-only for non-editors.
// Nothing new is exposed: GET /api/hunts/:userId already served these to any viewer through
// publicHuntView (Discord ids stripped, anonymous names redacted), and getArchivedHunts has never
// excluded them — so an ENDED VIP hunt was already public in the Archived tab while the live one
// was hidden.
//
// The tenant/mod hunt (modHuntKey) stays excluded — it is the community's PRIVATE staff hunt
// ("Never on the hub or in archive lists", lib/sharedHunts.js). Do not fold it in with the others.
function getPublicHunts(tenantId)   { return Object.values(hunts).filter(h=>h.isLive && huntHasContent(h) && inTenant(h,tenantId) && h.user?.id !== modHuntKey(tenantId)).map(huntSummary); }
// Public Archived tab: only completed hunts (every bonus opened). Incomplete ended hunts are
// hidden here — admins still see them in the All tab, and the janitor eventually reaps them.
function getArchivedHunts(tenantId) { return archive.filter(h=>inTenant(h,tenantId) && huntCompleted(h)).map(huntSummary); }
// Admin All tab: every hunt — created, live, and archived. Union of the current hunts (created/
// live/ended) with archived snapshots whose hunt is no longer current, deduped by huntId.
function getAllHunts(tenantId) {
  const current = Object.values(hunts).filter(h=>inTenant(h,tenantId) && h.user?.id !== modHuntKey(tenantId) && h.user?.id !== affiliateHuntKey(tenantId) && h.user?.id !== vipHuntKey(tenantId));
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
  const current = Object.values(hunts).filter(h=>inTenant(h,tenantId) && h.user?.id !== modHuntKey(tenantId) && h.user?.id !== affiliateHuntKey(tenantId) && h.user?.id !== vipHuntKey(tenantId));
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
  const current = Object.values(hunts).filter(h=>inTenant(h,tenantId) && h.user?.id !== modHuntKey(tenantId) && h.user?.id !== affiliateHuntKey(tenantId) && h.user?.id !== vipHuntKey(tenantId));
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
  const current = Object.values(hunts).filter(h=>inTenant(h,tenantId) && h.user?.id !== modHuntKey(tenantId) && h.user?.id !== affiliateHuntKey(tenantId) && h.user?.id !== vipHuntKey(tenantId));
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

  // Keyed by the PUBLIC category (huntCategoryOf), not the internal `huntType` behaviour flag.
  // Those are two different vocabularies and this counter used the wrong one: `types.vip` counted
  // any hunt a mod had set huntType 'vip' on, while /api/public/v1/hunts[].huntType reserves 'vip'
  // for THE shared VIP Hunt — so the same word meant two things across two endpoints, and the
  // affiliate + streamer runs were quietly folded into `community`. A consumer reported it as
  // "'vip' is declared in stats but zero vip hunts exist", which is exactly the symptom.
  const types = { community: 0, solo: 0, vip: 0, affiliate: 0, streamer: 0 };
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
    const cat = huntCategoryOf(h);
    types[cat] !== undefined ? types[cat]++ : types.community++;
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
// The injected anonymous-mode predicate, as a plain call. Exported because publicSerializers has
// to mask the hunt OWNER's name and `shouldMaskIdentity` is a rebindable module-level `let` —
// exporting the binding itself would capture the privacy-safe default at require time and then
// never see initHuntsCore's real one, silently un-masking every owner.
function isIdentityMasked(discordId, name) { return shouldMaskIdentity({ discordId, name }); }
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

// Seed equity when a hunt is created/reset: VIP starts with the tenant host, solo with just the
// runner, community with the runner (host) so they're present even without a starting balance.
//
// EVERY seeded row carries a discordId. This row is the one equity row the server writes itself,
// from an AUTHENTICATED creator (or the tenant's configured host) rather than from a typed name —
// so stamping it is not the display-name guessing that lib/identityLink.js is paranoid about, it's
// the opposite: the fact that makes hunt-local linking possible at all. Leaving it blank (the
// pre-2026-07-22 behavior for solo/community) put the host's own name into the Tier 2 identity
// review queue the moment they started a hunt, AND starved Tier 1 of the only seed it had to
// resolve that hunt's typed caller names against, so nothing in the hunt ever auto-linked.
//
// `id` stays 'creator_auto'/'bean_auto'/'host_auto:<slug>' — those are ROW ids the frontend's crown
// and HOST-pill logic key off, never identities (isRealDiscordId rejects them).
function initialEquity(huntType, user, tenant, balance) {
  const userName = user?.displayName || user?.username || '';
  // Omit rather than write the string "undefined" — a junk id is worse than a blank one.
  const withId = (row, id) => (id ? { ...row, discordId: String(id) } : row);
  if (huntType === 'vip') {
    const b = (tenant && tenant.branding) || {};
    const hostName = b.hostName || 'Bean';
    const hostId   = (tenant && tenant.hostDiscordId) || null;
    // Interim id: keep 'bean_auto' for the Bean tenant so the live frontend's crown logic
    // is unaffected until the frontend keys the crown off discordId/crownDiscordId.
    const id = (tenant && tenant.slug && tenant.slug !== 'bean') ? `host_auto:${tenant.slug}` : 'bean_auto';
    return [withId({ id, name: hostName, amount: balance != null ? balance : 1000, isRollWinner: false }, hostId)];
  }
  // solo and community are seeded identically — one row for the creator. Also covers reset, which
  // calls initialEquity('community', …) with no balance.
  return [withId({ id: 'creator_auto', name: userName, amount: balance != null ? balance : 0, isRollWinner: false }, user?.id)];
}

// Keep an identity the server already knows when a client save omits it.
//
// WHY THIS EXISTS: every save path replaces WHOLE arrays with the client's copy, and the copy the
// client holds has been through publicHuntView -> maskEquityMember, which deliberately STRIPS
// `discordId`/`callerId` (internal linkage, never public — it only sends `linked: true`). So a
// completely normal round trip deleted the identity the server itself established:
//
//   POST /start seeds equity WITH discordId
//     -> emitHuntUpdate sends the MASKED rows to the room, the owner included
//     -> MyHunt's socket handler adopts them once the save flag clears (`{...prev, ...data}`)
//     -> the next PUT writes those blank rows back, and the assignment overwrites the good ones
//
// Net effect: a host was un-linked from their own hunt within one save cycle, their name went
// straight back into the /admin/identity queue, and the same round trip erased anything Tier 2
// had just linked on a still-live hunt. That is why the queue kept refilling.
//
// The rule: a client may ADD an identity or CHANGE one, but an ABSENT field never clears a known
// one. Rows are matched on `id`, which is stable and survives masking. Deliberate unlinking goes
// through the admin routes, which mutate server-side and are unaffected by this.
function preserveRowIdentity(prev, next, field) {
  if (!Array.isArray(next) || !Array.isArray(prev) || !prev.length) return next;
  const known = new Map();
  for (const r of prev) if (r && r.id != null && r[field]) known.set(String(r.id), r[field]);
  if (!known.size) return next;
  return next.map(r => {
    if (!r || r.id == null || r[field]) return r;   // absent only — never overwrite what was sent
    const was = known.get(String(r.id));
    return was ? { ...r, [field]: was } : r;
  });
}

// Stamp `ts` on calls that are NEW in this request.
//
// `calls[].at` in the public API is this field, and it was null on almost every row: only
// lib/huntCalls.js stamped it, which covers the public call-submission board and the Discord bot.
// Every call the HOST adds in the tracker is built client-side without a timestamp and arrives as
// part of the whole-array hunt update, so the majority of calls had no time at all — and the docs
// wrongly explained the nulls as "calls made before mid-2026". Reported by an integrator who
// observed it null on every row they had ever seen.
//
// Stamped SERVER-side rather than trusting a client clock: the field means "when the server first
// saw this call", the same thing huntCalls.js records, and a client's clock is neither trustworthy
// nor synchronised.
//
// Two rows are deliberately left alone:
//   • one that already carries a ts — re-stamping on every save would turn `at` into "time of last
//     edit to this hunt", which is a different and useless fact.
//   • one that was ALREADY in the hunt and has no ts — a genuinely old call. Stamping it now would
//     put today's date on a call made months ago, which is worse than admitting we don't know.
// So this only ever adds a time to a row appearing for the first time.
//
// Apply this wherever a client-supplied `calls` array is accepted (it sits next to
// preserveRowIdentity at every such site today). A new write path that skips it silently
// reintroduces the null.
function stampNewCalls(prev, next, now) {
  if (!Array.isArray(next)) return next;
  const existing = new Set();
  if (Array.isArray(prev)) for (const r of prev) if (r && r.id != null) existing.add(String(r.id));
  const at = typeof now === 'number' ? now : Date.now();
  return next.map(r => {
    if (!r || typeof r.ts === 'number') return r;
    if (r.id != null && existing.has(String(r.id))) return r;
    return { ...r, ts: at };
  });
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
  // undoLog is stripped, not masked. It stores PREVIOUS copies of rows, so it carries the very
  // callerId/discordId that maskCallerEntry and maskEquityMember remove from the live arrays below
  // — shipping it would hand every viewer the identities the masking exists to hide, and re-send up
  // to 30 entries on every broadcast. Only the count goes out, which is all a client needs to know
  // whether its Undo button is live; the owner/editor reads the real log via the REST hunt fetch.
  const { publicCallsPin, invitedEditors, callsPermissions, undoLog, ...rest } = h;
  const privileged = viewerId ? isPrivilegedViewer(viewerId, h) : false;
  return {
    ...rest,
    undoCount: Array.isArray(undoLog) ? undoLog.length : 0,
    requiresPin: !!publicCallsPin,
    equity: Array.isArray(h.equity) ? h.equity.map(e => maskEquityMember(e, viewerId, privileged)) : h.equity,
    calls: Array.isArray(h.calls) ? h.calls.map(c => maskCallerEntry(c, 'user', viewerId, privileged)) : h.calls,
    bonuses: Array.isArray(h.bonuses) ? h.bonuses.map(b => maskCallerEntry(b, 'caller', viewerId, privileged)) : h.bonuses,
  };
}
// Deliver one payload into `hunt:<userId>`, gated per socket. This is the ONLY sanctioned way to
// write into a hunt room — `io.to(room).emit(...)` cannot filter recipients, and room membership
// is not proof of anything: `watch:hunt` can only compare a hunt that already EXISTS, so a socket
// asking to watch a Discord id with no hunt yet joins unchecked and stays joined (2026-07-18 audit
// #4 / BE #110 / BE #115, all the same leak through different windows).
//
// `tenantSlug` is passed in rather than read from `hunts[userId]` because the callers that need
// this most are announcing a hunt that is already GONE from the map (the janitor's sweep) — they
// capture tenantOf(h) before deleting. `accept` is an optional second filter for payloads that are
// not for every viewer in the tenant, e.g. an owner's pending call-request list.
async function emitToHuntRoom(userId, tenantSlug, event, payload, accept) {
  const slug = tenantSlug || 'bean';
  try {
    const sockets = await io.in(`hunt:${userId}`).fetchSockets();
    for (const s of sockets) {
      if (((s.data && s.data.tenantSlug) || 'bean') !== slug) continue;
      if (accept && !accept(s)) continue;
      s.emit(event, payload);
    }
  } catch (e) {
    // Emit nothing on failure, for the same reason emitHuntUpdate does: the only fallback available
    // is a room-wide broadcast, which is the vulnerability itself.
    console.error('[hunt] emitToHuntRoom fanout failed for', userId, event, '-', e && e.message);
  }
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
  const slug = tenantOf(h);
  const anon = huntHasAnon(h);
  try {
    const sockets = await io.in(room).fetchSockets();
    // Serialize ONCE when nobody is anonymous (the old room-broadcast fast path); per socket only
    // when a member is anonymous, so the runner/mods keep real names while everyone else sees
    // 'Anonymous'. Per-socket viewer identity is socket.data.userId, set from the VERIFIED
    // handshake token in sockets/index.js.
    const shared = anon ? null : publicHuntView(h);
    for (const s of sockets) {
      // TENANT GATE. Room membership alone does NOT prove the viewer belongs to this hunt's
      // tenant: `watch:hunt` can only compare a hunt that already exists, so a socket that asks
      // to watch a Discord id with no hunt yet joins `hunt:<id>` unchecked — and socket.io room
      // membership persists, so it would receive every update once the hunt is created in
      // ANOTHER tenant. Same leak as 2026-07-18 audit #4 / BE #110, reached through a timing
      // window. Delivery is the authoritative point, so the guard lives here.
      if (((s.data && s.data.tenantSlug) || 'bean') !== slug) continue;
      s.emit('hunt:update', anon ? publicHuntView(h, s.data && s.data.userId) : shared);
    }
  } catch (e) {
    // Deliberately emit NOTHING here. The old fallback was a room-wide broadcast, which cannot
    // filter by tenant and would reinstate the leak above on an error path. Dropping one update is
    // safe and self-healing — emitHuntUpdate fires on every hunt change (~every 500ms in a live
    // hunt), so the next one repaints. Logged so a persistently broken adapter is visible.
    console.error('[hunt] emitHuntUpdate fanout failed for', userId, '-', e && e.message);
  }
}

// 80 bits from the CSPRNG, as 20 lowercase hex chars. This mints three different things and the
// old `Math.random().toString(36).slice(2, 8)` was wrong for all of them:
//
//   1. hunt.huntId — statsStore.huntKey() returns it verbatim as the hunt_history TEXT PRIMARY
//      KEY, which is GLOBAL rather than per-tenant. Six base-36 chars is a 2.18e9 space, so the
//      birthday bound gives ~2.3% collision odds at 10k hunts and 44% at 50k; a collision makes
//      ON CONFLICT DO UPDATE overwrite a different (possibly other-tenant) hunt's snapshot.
//   2. Share tokens (routes/share.routes.js) — GET /api/share/:token is PUBLIC, so six characters
//      is brute-forceable.
//   3. Equity-row and call ids, which are returned in ordinary API responses.
//
// (2) and (3) are the sharper pair: V8's Math.random is xorshift128+, and its internal state is
// recoverable from a handful of outputs — so ids harvested from public responses let an attacker
// PREDICT future share tokens instead of guessing them. Hence randomBytes, not a bigger slice.
//
// Existing short ids keep working: every consumer compares with === and nothing parses the format.
function uid() { return crypto.randomBytes(10).toString('hex'); }
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
  MOD_HUNT_ID, AFFILIATE_HUNT_ID, VIP_HUNT_ID, CURRENCIES, modHuntKey, affiliateHuntKey, vipHuntKey,
  huntSummary, huntCompleted, huntHasContent, tenantOf, inTenant, sumVault, huntCategoryOf,
  huntRunnerOf,
  PUBLIC_HUNT_CATEGORIES,
  getPublicHunts, getArchivedHunts, getAllHunts, getSlotCallCounts, getGotInLog, getHuntsFullExport, getHuntStats, aggregateHuntStats,
  emitHubUpdate, publicHuntView, emitHuntUpdate, emitToHuntRoom, huntHasAnon, isIdentityMasked,
  bindEquityIdentityByName, linkEquityMember, initialEquity, preserveRowIdentity, stampNewCalls,
  uid, touch, sanitizeBonusReplayUrls,
};
