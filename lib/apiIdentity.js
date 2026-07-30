// The `GET /api/public/v1/me` payload — every fact an integrator currently has to be TOLD.
//
// A key returns hundreds of hunts across dozens of owners and nothing in any response says which
// community that is, who the streamer is, or which of those owners is the tenant rather than a
// member. That gap is not a documentation problem: the answer is per-tenant, so prose cannot carry
// it and every new tenant repeats the same conversation. Serving it per key is what makes a
// consumer written for one community work unmodified for the next.
// See docs/developer-api-multitenant-readiness.md.
//
// Pure over an injected tenant, so it can be unit-tested without a router or a database.

const { PUBLIC_HUNT_CATEGORIES, modHuntKey, vipHuntKey, affiliateHuntKey } = require('./hunts-core');
const { publicOwnerId } = require('./publicIds');

// Which hunt types belong to the TENANT rather than to their members. Defaulted, not hardcoded:
// the three shared runs are derived from the hunt key (huntCategoryOf), so they are always the
// community's own — but a tenant may well run their house hunts as `community` and never open an
// affiliate run at all, which is why this is overridable per tenant.
const DEFAULT_HOUSE_HUNT_TYPES = ['streamer', 'vip', 'affiliate'];

// The API's own vocabulary. A community that calls a `streamer` hunt something else — Bean calls
// it a Mod hunt — overrides the label rather than making every consumer keep a private mapping
// file that drifts. Deliberately neutral here: this is the platform default, not Bean's.
const DEFAULT_HUNT_TYPE_LABELS = {
  community: 'Community',
  solo: 'Solo',
  streamer: 'Streamer',
  vip: 'VIP',
  affiliate: 'Affiliate',
};

// Per-tenant overrides live under `branding.api` — JSONB that already exists, so adding a
// community's vocabulary needs no migration and no deploy.
//
// Every override is validated and falls back to the default rather than being trusted: this
// object is admin-editable, and a typo'd hunt type here would otherwise be published as API
// truth and quietly break the consumer that filters on it.
function apiConfigOf(tenant) {
  const cfg = (tenant && tenant.branding && tenant.branding.api) || {};
  return cfg && typeof cfg === 'object' ? cfg : {};
}

function resolveHouseHuntTypes(tenant) {
  const raw = apiConfigOf(tenant).houseHuntTypes;
  if (!Array.isArray(raw)) return [...DEFAULT_HOUSE_HUNT_TYPES];
  const valid = raw.filter(t => PUBLIC_HUNT_CATEGORIES.includes(t));
  // An override that survives validation empty is a misconfiguration, not an instruction to
  // report that this community has no house hunts at all — fall back rather than publish it.
  return valid.length ? [...new Set(valid)] : [...DEFAULT_HOUSE_HUNT_TYPES];
}

function resolveHuntTypeLabels(tenant) {
  const raw = apiConfigOf(tenant).huntTypeLabels;
  const out = { ...DEFAULT_HUNT_TYPE_LABELS };
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const [type, label] of Object.entries(raw)) {
      // Unknown keys are dropped, not passed through: the label map must stay a total function
      // over the published `huntType` vocabulary and nothing else.
      if (!PUBLIC_HUNT_CATEGORIES.includes(type)) continue;
      if (typeof label !== 'string') continue;
      const trimmed = label.trim().slice(0, 40);
      if (trimmed) out[type] = trimmed;
    }
  }
  return out;
}

// The owners of the three shared runs.
//
// This is the correction that costs an integration its first wrong guess: `streamer.id` does NOT
// reach the house hunts. The shared Mod / VIP / Affiliate runs are owned by their own synthetic
// keys rather than by the host's user id, so `?ownerId=<streamer.id>` returns the host's PERSONAL
// solo and community hunts and nothing else. These ids are perfectly stable and perfectly usable
// as an `ownerId` filter — they just cannot be guessed, so we serve them.
//
// Minted through publicOwnerId, the same function that mints `owner.id` on a hunt, so the values
// compare equal to what the hunt endpoints return. Deriving them any other way is how the two
// silently stop matching.
function houseOwnerIds(tenantId) {
  return {
    streamer: publicOwnerId(tenantId, modHuntKey(tenantId)),
    vip: publicOwnerId(tenantId, vipHuntKey(tenantId)),
    affiliate: publicOwnerId(tenantId, affiliateHuntKey(tenantId)),
  };
}

/**
 * Build the /me body.
 *
 * `tier` and `scopes` come from requireApiKey (the KEY's plan and grants, not the tenant row's) so
 * the payload describes the credential actually in use.
 */
function buildApiMe({ tenant, tier, scopes, limits, writeLimits }) {
  const tenantId = tenant.id;
  const readLim = (limits && (limits[tier] || limits.pro)) || {};
  const writeLim = (writeLimits && (writeLimits[tier] || writeLimits.pro)) || {};
  // Same resolution order as every other host-name read in this codebase (lib/sharedHunts.js) —
  // the community's configured host name, falling back to the community's own display name.
  const streamerName = (tenant.branding && tenant.branding.hostName) || tenant.displayName || null;
  return {
    key: {
      tier: tier || null,
      scopes: Array.isArray(scopes) && scopes.length ? [...scopes] : ['read'],
      rateLimit: {
        readPerMin: readLim.perMin ?? null,
        readPerHour: readLim.perHour ?? null,
        writePerMin: writeLim.perMin ?? null,
        writePerHour: writeLim.perHour ?? null,
      },
    },
    community: { slug: tenant.slug, name: tenant.displayName || tenant.slug },
    // Null when the community has no host configured. The id is opaque and joins against
    // `owner.id`; it selects the host's PERSONAL hunts only — see houseOwnerIds above.
    streamer: tenant.hostDiscordId
      ? { id: publicOwnerId(tenantId, tenant.hostDiscordId), name: streamerName }
      : null,
    houseHuntTypes: resolveHouseHuntTypes(tenant),
    houseOwnerIds: houseOwnerIds(tenantId),
    // The full published vocabulary, served rather than documented, so a consumer can render a
    // filter UI without hardcoding a list that grows without notice.
    huntTypes: [...PUBLIC_HUNT_CATEGORIES],
    huntTypeLabels: resolveHuntTypeLabels(tenant),
  };
}

/**
 * Validate an admin-submitted vocabulary before it is stored.
 *
 * Deliberately paired with the resolvers above — the same module decides what is valid on the way
 * in and what is served on the way out, so a value that saves is a value that publishes.
 *
 * Entries equal to the platform default are DROPPED rather than stored. The editor presents the
 * defaults as placeholders, so "I left it alone" and "I typed the default" look identical at the
 * keyboard; storing the latter would silently pin this tenant to today's wording and shadow any
 * future change to DEFAULT_HUNT_TYPE_LABELS. An empty field means inherit, and inherit is a live
 * link, not a copy.
 *
 * Returns `{ ok, value, error }`. A malformed submission is rejected loudly here rather than
 * being quietly normalised, because the resolvers already fall back to defaults on read — so a
 * bad save would look like it worked and then serve something else.
 */
function sanitizeApiConfig(input) {
  const src = (input && typeof input === 'object' && !Array.isArray(input)) ? input : {};
  const out = {};

  if (src.houseHuntTypes !== undefined) {
    if (!Array.isArray(src.houseHuntTypes)) {
      return { ok: false, error: 'houseHuntTypes must be an array' };
    }
    const bad = src.houseHuntTypes.filter(t => !PUBLIC_HUNT_CATEGORIES.includes(t));
    if (bad.length) {
      return { ok: false, error: `Not a hunt type: ${bad.join(', ')}. Valid: ${PUBLIC_HUNT_CATEGORIES.join(', ')}` };
    }
    // Empty is a legitimate answer for a community that runs no house hunts at all, but it cannot
    // be STORED as one: resolveHouseHuntTypes reads an empty override as a misconfiguration and
    // falls back. Refuse rather than accept a save that will not take effect.
    if (!src.houseHuntTypes.length) {
      return { ok: false, error: 'Select at least one house hunt type' };
    }
    const unique = [...new Set(src.houseHuntTypes)];
    if (unique.join() !== [...DEFAULT_HOUSE_HUNT_TYPES].join()) out.houseHuntTypes = unique;
  }

  if (src.huntTypeLabels !== undefined) {
    const raw = src.huntTypeLabels;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return { ok: false, error: 'huntTypeLabels must be an object' };
    }
    const labels = {};
    for (const [type, label] of Object.entries(raw)) {
      if (!PUBLIC_HUNT_CATEGORIES.includes(type)) {
        return { ok: false, error: `Not a hunt type: ${type}` };
      }
      if (label === null || label === undefined || label === '') continue; // cleared → inherit
      if (typeof label !== 'string') return { ok: false, error: `Label for ${type} must be text` };
      const trimmed = label.trim().slice(0, 40);
      if (!trimmed) continue;
      if (trimmed !== DEFAULT_HUNT_TYPE_LABELS[type]) labels[type] = trimmed;
    }
    if (Object.keys(labels).length) out.huntTypeLabels = labels;
  }

  return { ok: true, value: out };
}

module.exports = {
  buildApiMe,
  houseOwnerIds,
  resolveHouseHuntTypes,
  resolveHuntTypeLabels,
  sanitizeApiConfig,
  DEFAULT_HOUSE_HUNT_TYPES,
  DEFAULT_HUNT_TYPE_LABELS,
};
