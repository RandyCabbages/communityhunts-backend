// Public share page: which cosmetic equity card is each member wearing?
//
// The hunt tracker learns this from GET /api/settings/:userId — requireAuth — and publicHuntView
// strips `discordId` off every equity row before it leaves the building. A share-link viewer is
// usually logged OUT, so it has no path to that data at all; the ids are resolved here instead and
// ride along on the share payload.
//
// Only the card ID goes out, never a settings row. Whether that id is actually LIVE stays a
// frontend decision (isCardLive over the public /api/cosmetics/releases + the catalog's `hidden`
// flag) — the backend has no catalog and must not grow one.

const { isRealDiscordId } = require('./userIds');

// Name → userId is a Postgres lookup per unresolved member. GET /api/share/:token is public and
// unauthenticated, and a 15-member hunt would fire one per member on EVERY view. Both legs are
// memoised: the values are cosmetic, so a stale minute costs nothing, and the cache is the
// difference between ~30 queries per view and ~0 on a hunt people are actively refreshing.
const NAME_TTL_MS = 5 * 60 * 1000;
const CARD_TTL_MS = 60 * 1000;
// Bounded — the name keys come off equity rows, which anyone who can edit a hunt can invent.
// Oldest-first eviction; insertion order is Map order.
const MAX_ENTRIES = 2000;

function makeCache(ttl) {
  const m = new Map();
  return {
    get(k) {
      const hit = m.get(k);
      if (!hit) return undefined;
      if (hit.exp < Date.now()) { m.delete(k); return undefined; }
      return hit.v;
    },
    set(k, v) {
      if (m.size >= MAX_ENTRIES) {
        for (const key of m.keys()) { m.delete(key); if (m.size < MAX_ENTRIES) break; }
      }
      m.set(k, { v, exp: Date.now() + ttl });
    },
  };
}

const norm = s => (s || '').toString().toLowerCase().trim();

// The tenant host's canonical Discord id — the same id the admin cosmetics panel equips an
// exclusive host card to. branding.crownDiscordId first, mirroring the frontend's crownDiscordId.
function hostIdOf(tenant) {
  const id = tenant?.branding?.crownDiscordId || tenant?.hostDiscordId || null;
  return isRealDiscordId(id) ? String(id) : null;
}

// A member row → the Discord id whose cosmetics it wears, when that's knowable without a lookup.
// `creator_auto` / `bean_auto` are shared placeholder ids reused across every hunt, so they must
// resolve through the hunt's owner / the tenant host rather than being treated as identities.
function directIdFor(e, ownerId, hostId) {
  if (isRealDiscordId(e.discordId)) return String(e.discordId);
  if (isRealDiscordId(e.id)) return String(e.id);
  if (e.id === 'creator_auto' && ownerId) return ownerId;
  if (e.id === 'bean_auto' && hostId) return hostId;
  return null;
}

// DI so the caches are per-instance and a test can drive the three settings lookups without a
// live Postgres. The default instance (exported below) is wired to lib/settings.
function createShareCards({ shouldMaskIdentity, resolveUserIdByName, cardsForUserIds }) {
  const nameCache = makeCache(NAME_TTL_MS);
  const cardCache = makeCache(CARD_TTL_MS);

  async function resolveByName(name) {
    const key = norm(name);
    if (!key) return null;
    const hit = nameCache.get(key);
    if (hit !== undefined) return hit;
    let id = null;
    try { id = await resolveUserIdByName(name); } catch (e) {
      console.error('[shareCards] name lookup failed for', key, '-', e && e.message);
      return null; // don't cache a transient failure as "no such user"
    }
    nameCache.set(key, id);
    return id;
  }

  // hunt + tenant → { [equityMemberId]: cardId }. Members wearing nothing are absent, so the
  // caller gets `null` for them naturally.
  async function equippedCardsFor(hunt, tenant) {
    const rows = Array.isArray(hunt?.equity) ? hunt.equity : [];
    if (!rows.length) return {};

    const ownerId = isRealDiscordId(hunt?.user?.id) ? String(hunt.user.id) : null;
    const hostId = hostIdOf(tenant);
    const hostName = norm(tenant?.branding?.hostName);

    const byMember = new Map();   // equity row id → Discord id
    const pending = [];           // rows needing the name lookup

    for (const e of rows) {
      if (!e || e.id == null) continue;
      // ANONYMOUS MEMBERS GET NO CARD. An exclusive card is a name badge — shipping card_x next
      // to "Anonymous" identifies the person the masking exists to hide. Same predicate the
      // masking itself uses (maskEquityMember → shouldMaskIdentity), so the two can't drift.
      if (shouldMaskIdentity({ discordId: e.discordId, name: e.name })) continue;

      const direct = directIdFor(e, ownerId, hostId);
      if (direct) { byMember.set(e.id, direct); continue; }
      // A host row carrying the host's NAME but no id — the same fragile case the tracker's
      // crownDiscordId path exists for (an admin equips a card to the host's id without stamping
      // a display name, so the by-name lookup finds nothing).
      if (hostId && hostName && norm(e.name) === hostName) { byMember.set(e.id, hostId); continue; }
      if (e.name) pending.push(e);
    }

    const resolved = await Promise.all(pending.map(e => resolveByName(e.name)));
    pending.forEach((e, i) => { if (resolved[i]) byMember.set(e.id, String(resolved[i])); });

    const wanted = [...new Set(byMember.values())];
    const cards = new Map();
    const missing = [];
    for (const id of wanted) {
      const hit = cardCache.get(id);
      if (hit !== undefined) { if (hit) cards.set(id, hit); } else missing.push(id);
    }
    if (missing.length) {
      let fetched = new Map();
      try { fetched = await cardsForUserIds(missing) || new Map(); } catch (e) {
        console.error('[shareCards] card lookup failed -', e && e.message);
      }
      for (const id of missing) {
        const card = fetched.get(id) || null;
        cardCache.set(id, card);     // cache the misses too — most members wear nothing
        if (card) cards.set(id, card);
      }
    }

    const out = {};
    for (const [memberId, userId] of byMember) {
      const card = cards.get(userId);
      if (card) out[memberId] = card;
    }
    return out;
  }

  return { equippedCardsFor };
}

const settings = require('./settings');
const defaultInstance = createShareCards({
  shouldMaskIdentity: settings.shouldMaskIdentity,
  resolveUserIdByName: settings.resolveUserIdByName,
  cardsForUserIds: settings.cardsForUserIds,
});

module.exports = { createShareCards, equippedCardsFor: defaultInstance.equippedCardsFor };
