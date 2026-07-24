// Validation + construction for POST /api/public/v1/hunts. Pure: no pgPool, no fs, no Date.now()
// (the caller injects `now`), so every rule here is unit-testable.
//
// The controlling constraint is that archiveHunt UPSERTS by hunt identity. A write reusing an
// existing huntId replaces that snapshot in place, and the archive feeds Hall of Fame, the
// ProofBand, caller leaderboards and payout attribution. So this module's job is to make a bad or
// hostile payload unable to reach archiveHunt at all.

const crypto = require('crypto');
const { modHuntKey, affiliateHuntKey, CURRENCIES, uid } = require('./hunts-core');

// A hunt older than this is refused. Backfilling history is deliberately NOT this endpoint's job
// — that is the owner-gated admin importer, where a human confirms a diff first. Without this
// guard a leaked key could inject or overwrite arbitrary history, which no revert undoes.
const MAX_AGE_MS = 48 * 60 * 60 * 1000;

// The five PUBLIC categories (see huntCategoryOf in hunts-core). `affiliate` and `streamer` are
// NOT storable hunt types — they map to the tenant's shared-hunt keys, with the behaviour type
// underneath. Storing "affiliate" as a huntType would produce a hunt no existing filter matches.
const CATEGORY_TO_INTERNAL = {
  vip: 'vip', community: 'community', solo: 'solo',
  affiliate: 'vip',    // the Affiliate Hunt is VIP-shaped
  streamer: 'solo',    // the streamer's own Mod Hunt is solo-shaped
};

// Deterministic id: the same externalId from the same tenant always produces the same huntId, so
// archiveHunt's existing sameHuntInstance upsert dedupes a retry with no new index or table.
// tenantId is inside the hash so one community's externalId can never collide with another's.
function importedHuntId(tenantId, externalId) {
  const h = crypto.createHash('sha256').update(`${tenantId}|${externalId}`).digest('hex');
  return `ext_${h.slice(0, 12)}`;
}

const err = (code, message) => ({ ok: false, code, message });
const num = v => { const n = Number(v); return Number.isFinite(n) ? n : null; };
const str = v => (typeof v === 'string' ? v : '');

function validateImport(body, { now }) {
  const b = body && typeof body === 'object' ? body : {};

  const externalId = b.externalId;
  if (typeof externalId !== 'string' || !externalId.trim() || externalId.length > 200) {
    return err('invalid_external_id', 'externalId is required, must be a non-empty string, max 200 chars');
  }

  const category = str(b.huntType) || 'community';
  if (!CATEGORY_TO_INTERNAL[category]) {
    return err('invalid_hunt_type', `huntType must be one of: ${Object.keys(CATEGORY_TO_INTERNAL).join(', ')}`);
  }

  // CURRENCIES is an ARRAY of codes (["USD","GBP","AUD","CAD","ARS"]) — verified, not assumed.
  // Indexing it like a map would reject every currency, including USD.
  const currency = str(b.currency) || 'USD';
  if (!CURRENCIES.includes(currency)) return err('invalid_currency', `Unknown currency "${currency}"`);

  const startedAt = Date.parse(b.startedAt);
  const endedAt = Date.parse(b.endedAt);
  if (!Number.isFinite(startedAt) || !Number.isFinite(endedAt) || endedAt < startedAt || endedAt > now) {
    return err('invalid_dates', 'startedAt and endedAt must be ISO timestamps, with startedAt <= endedAt <= now');
  }
  if (now - endedAt > MAX_AGE_MS) {
    return err('too_old', 'This endpoint accepts hunts finished within the last 48 hours. Use the admin importer for older history.');
  }

  if (!Array.isArray(b.bonuses) || b.bonuses.length === 0) {
    return err('no_bonuses', 'bonuses must be a non-empty array — a hunt with no bonuses is not archived');
  }
  const bonuses = [];
  for (const raw of b.bonuses) {
    const row = raw && typeof raw === 'object' ? raw : {};
    const slot = str(row.slot).trim();
    if (!slot) return err('invalid_bonus', 'every bonus needs a slot name');
    // win null means "not opened"; 0 means "opened for nothing". They are different, and the
    // distinction survives into the public serializer — do not collapse them.
    bonuses.push({ slot, bet: num(row.bet) ?? 0, win: row.win == null ? null : num(row.win) });
  }

  const equity = Array.isArray(b.equity) ? b.equity : [];

  return { ok: true, value: { externalId: externalId.trim(), huntType: category, currency, startedAt, endedAt, bonuses, equity } };
}

// Turn a validated payload into an object archiveHunt accepts. `hostDiscordId` is the tenant's
// configured host — a regular imported hunt is attributed to them, since an API key is not a user.
function buildImportedHunt(value, { tenantId, hostDiscordId }) {
  const shared = value.huntType === 'affiliate' ? affiliateHuntKey(tenantId)
               : value.huntType === 'streamer' ? modHuntKey(tenantId)
               : null;
  const ownerId = shared || (hostDiscordId ? String(hostDiscordId) : `manual:${tenantId}`);
  const endedIso = new Date(value.endedAt).toISOString();
  const startedIso = new Date(value.startedAt).toISOString();

  return {
    user: { id: ownerId, displayName: '', avatar: null },
    huntId: importedHuntId(tenantId, value.externalId),
    externalId: value.externalId,
    tenantId,
    isLive: false,
    huntType: CATEGORY_TO_INTERNAL[value.huntType],
    currency: value.currency,
    startedAt: startedIso,
    createdAt: startedIso,
    updatedAt: endedIso,
    archivedAt: endedIso,
    bonuses: value.bonuses,
    equity: (value.equity || []).map(raw => {
      const e = raw && typeof raw === 'object' ? raw : {};
      const row = { id: uid(), name: str(e.name), amount: num(e.amount) ?? 0, isRollWinner: false };
      // discordId is CLIENT-ASSERTED and is vetted by the route before storage — never trusted here.
      return e.discordId == null ? row : { ...row, discordId: String(e.discordId) };
    }),
    calls: [], invitedEditors: [], callLimit: 0, huntMode: 'hunting',
    roundRobin: false, lockTop4: false, publicCalls: false, publicCallsPin: null,
    // FX is latest-only, so an imported hunt must never claim a rate it does not have.
    // scripts/backfill-hunt-history.js set this precedent; statsStore.recordHunt reads it.
    _approxRate: true,
  };
}

module.exports = { importedHuntId, validateImport, buildImportedHunt, MAX_AGE_MS, CATEGORY_TO_INTERNAL };
