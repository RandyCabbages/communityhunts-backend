// Which full_extension grants the grandfather revocation may delete, and which it must not.
//
// Pure and in lib/ deliberately: the script that uses this issues a DELETE against live
// entitlements, and the one thing that must never be wrong is "is this row a paying customer?".
// Keeping the decision here puts it under npm test instead of inside a one-shot script nobody
// runs twice. See scripts/revoke-grandfather-full-extension.js.
//
// THE TRAP. The Stripe webhook grants with addGrant(userId,'full_extension','stripe-sub'), an
// INSERT that is ON CONFLICT (discord_id, feature_key) DO NOTHING. That pair is the primary key,
// so a user who was grandfathered and LATER SUBSCRIBED keeps granted_by='grandfather-by-…'. Their
// row is indistinguishable from a freeloader's, and deleting it cuts off a customer Stripe is
// still billing. Payment is therefore established from STRIPE, never from this table.

// grandfatherGrant() writes 'grandfather-by-<adminId>' from the route and defaults to a bare
// 'grandfather'. Match both and nothing else — a deliberate admin comp carries an admin's Discord
// id as granted_by and has to survive.
const isGrandfathered = (grantedBy) =>
  typeof grantedBy === 'string' && grantedBy.startsWith('grandfather');

const STRIPE_GRANT_BY = 'stripe-sub';

// rows: [{ discord_id, granted_by }] for feature_key='full_extension'
// payerIds: Set of Discord ids Stripe reports as active/trialing on the extension subscription
function partitionGrants(rows = [], payerIds = new Set()) {
  const has = (id) => payerIds.has(String(id));

  const grandfathered = rows.filter(r => isGrandfathered(r.granted_by));
  // NULL predates granted_by being recorded, so it could be an old comp OR an old grandfather.
  // There is no way to tell from the data, and guessing is the exact failure being avoided —
  // surface them and leave them alone.
  const ambiguous = rows.filter(r => r.granted_by == null);
  const stripeRows = rows.filter(r => r.granted_by === STRIPE_GRANT_BY);
  const comps = rows.filter(r =>
    r.granted_by != null && !isGrandfathered(r.granted_by) && r.granted_by !== STRIPE_GRANT_BY);

  return {
    grandfathered, ambiguous, stripeRows, comps,
    // Grandfathered rows that are really paying customers — re-stamp, never delete.
    atRisk:   grandfathered.filter(r => has(r.discord_id)),
    // What actually gets revoked: grandfathered AND not paying.
    toDelete: grandfathered.filter(r => !has(r.discord_id)),
  };
}

module.exports = { partitionGrants, isGrandfathered, STRIPE_GRANT_BY };
