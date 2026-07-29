// Building a community's shared hunts — the tenant, affiliate and VIP runs.
//
// Extracted from routes/mod-hunt.routes.js because a second router now needs to open the same
// runs: the Discord bot's public API opens the affiliate or VIP hunt when a giveaway is created.
// Two copies of "what a fresh affiliate hunt looks like" would drift, and the copy that drifted
// would be the one writing a hunt with the wrong starting equity or the wrong call limit.
//
// A factory over its deps rather than a plain module, because the host name and id come from
// tenant config and `uid` is injected everywhere else in this codebase.

const { defaultHuntTitle, sanitizeTitle } = require('./huntTitle');
const { modHuntKey, affiliateHuntKey, vipHuntKey } = require('./hunts-core');

module.exports = function sharedHunts({ tenants, uid }) {
  // Resolve the display name shown in the tenant/affiliate hunt's equity from the tenant's own
  // branding instead of hardcoding 'Bean'. Bean's tenant has branding.hostName === 'Bean', so
  // this resolves to the same value for Bean — zero behavior change for the existing tenant.
  function hostNameFor(tenantId) {
    const t = tenants.getTenantBySlug(tenantId) || tenants.getTenantBySlug('bean');
    return t?.branding?.hostName || t?.displayName || 'Bean';
  }

  // The host equity row is written by the server from tenant config, not typed by anyone, so it
  // carries the tenant's configured host id. Without it the host's display name shows up in the
  // /admin/identity review queue as if it were an unidentified participant, and Tier 1 has no
  // seed to link this hunt's typed caller names against. Null for a tenant with no hostDiscordId
  // — the row then seeds without the field rather than with a junk one.
  function hostIdFor(tenantId) {
    const t = tenants.getTenantBySlug(tenantId) || tenants.getTenantBySlug('bean');
    return t?.hostDiscordId || null;
  }

  const hostEquityRow = (tenantId, amount) => {
    const row = { id: 'bean_auto', name: hostNameFor(tenantId), amount, isRollWinner: false };
    const id = hostIdFor(tenantId);
    return id ? { ...row, discordId: String(id) } : row;
  };

  // The three shared runs differ only in their key, title kind, hunt type and call limit — but
  // they are written out in full rather than folded into one parameterised builder, because the
  // differences are the interesting part and a shared builder hides which field belongs to which.
  const base = (tenantId, title, kind) => ({
    huntId: uid(),
    isLive: true,
    startedAt: new Date().toISOString(),
    archivedAt: null,
    tenantId: tenantId || 'bean',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    title: sanitizeTitle(title) || defaultHuntTitle(hostNameFor(tenantId), kind, Date.now()),
    bonuses: [],
    calls: [],
    invitedEditors: [],
    huntMode: 'hunting',
    lockTop4: false,
    currency: 'USD',
    publicCalls: false,
    publicCallsPin: null,
  });

  /** Private solo hunt run jointly by a community's mods. Never on the hub or in archive lists. */
  function emptyModHunt(tenantId, title) {
    return {
      ...base(tenantId, title, 'mod'),
      user: { id: modHuntKey(tenantId), displayName: hostNameFor(tenantId), avatar: null },
      huntType: 'solo',
      equity: [hostEquityRow(tenantId, 0)],
      callLimit: 0,
      roundRobin: false,
    };
  }

  function emptyAffiliateHunt(tenantId, title) {
    return {
      ...base(tenantId, title, 'affiliate'),
      user: { id: affiliateHuntKey(tenantId), displayName: hostNameFor(tenantId), avatar: null },
      huntType: 'vip',
      equity: [hostEquityRow(tenantId, 1000)],
      callLimit: 10,
      roundRobin: true,
    };
  }

  function emptyVipHunt(tenantId, title) {
    return {
      ...base(tenantId, title, 'vip'),
      user: { id: vipHuntKey(tenantId), displayName: hostNameFor(tenantId), avatar: null },
      huntType: 'vip',
      equity: [hostEquityRow(tenantId, 1000)],
      callLimit: 10,
      roundRobin: true,
    };
  }

  return {
    hostNameFor, hostIdFor, hostEquityRow,
    emptyModHunt, emptyAffiliateHunt, emptyVipHunt,
  };
};
