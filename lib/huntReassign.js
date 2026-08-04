// Move a whole hunt from one owner to another.
//
// This exists for the "ran it under the wrong account" case: someone opens a hunt on their own
// login while actually running it for another member. Every surface that credits a hunt reads the
// SAME field — `h.user` — so the wrong name then shows up on the Hall of Fame ticket
// (lib/hallOfFame.js), the hub's Archived tab, `/:slug/hunt/:userId`, and the durable stats
// rollups, with no per-surface override anywhere to correct it.
//
// The owner lives in exactly one place per record, but ONE hunt can exist as several records: the
// current entry in `hunts` (which is keyed BY the owner id) plus every archived snapshot of it.
// Moving one and not the others is worse than not moving it at all — `archiveHunt()` rewrites the
// snapshot from the current hunt whenever the hunt is re-ended, so a half-move silently reverts to
// the old owner later. planReassign therefore always resolves the FULL hunt instance from either
// entry point, using the same identity rule persistence uses to decide what to upsert.
//
// Pure by design: it takes the hunts map + archive array and returns a plan. Persistence, the
// socket broadcasts, the durable-stats handoff and the audit entry all belong to the caller.

const { inTenant } = require('./hunts-core');
const { MOD_HUNT_KEYS } = require('./ledgerQuery');
const { sameHuntInstance } = require('./persistence');
const { isRealDiscordId } = require('./userIds');

// The three per-tenant shared hunts are keyed by their ROLE, not by a person, and that key is a
// contract: huntCategoryOf, the hub filters, the staff-hunt panels and lib/sharedHunts.js all
// branch on it. Handing one to a member would not move a hunt, it would delete a fixture and mint
// a personal hunt in its place.
//
// Keyed off MOD_HUNT_KEYS rather than the MOD_HUNT_ID/AFFILIATE_HUNT_ID/VIP_HUNT_ID constants
// because that set also carries the PRE-REBRAND '__mod_hunt__' — the constant is '__tenant_hunt__'
// now, but already-archived tenant hunts keep the old string forever (see the note at MOD_HUNT_ID
// in hunts-core.js). Checking only the constants would leave exactly those archived fixtures
// reassignable. Prefix match, not set membership: a non-Bean tenant namespaces its key
// (`__vip_hunt__:someslug`).
const isSharedHuntKey = (id) =>
  typeof id === 'string' && [...MOD_HUNT_KEYS].some(k => id.startsWith(k));

// Resolve the hunt to move and check the move is legal. Targeting mirrors retag-currency, the
// other admin "fix a stored hunt" action, so the frontend can pass the same row identifiers:
//   { userId }              — the user's current hunt
//   { userId, archivedAt }  — one specific archived snapshot
// Either way the returned plan covers the whole instance.
//
// Returns { error, status } on rejection, or the plan on success. Never mutates.
function planReassign({ hunts = {}, archive = [], tenantId = 'bean', userId, archivedAt, newOwnerId } = {}) {
  const fromId = String(userId ?? '');
  const toId = String(newOwnerId ?? '');
  if (!fromId) return { error: 'userId is required', status: 400 };
  // A hunt's owner id is also its key in `hunts` and its host_user_id in the stats store, so it
  // has to be a real login. A synthetic `manual:<name>` row would key a hunt to an account nobody
  // can sign in to, stranding it.
  if (!isRealDiscordId(toId)) return { error: 'New owner must be a linked Discord account', status: 400 };
  if (isSharedHuntKey(fromId)) return { error: 'Shared community hunts cannot be reassigned', status: 400 };

  // Tenant-scope every lookup: a tenant admin must not be able to reach another community's hunt
  // by guessing an id (same rule GET /api/hunts/:userId and retag-currency enforce).
  const atKey = hunts[fromId] && inTenant(hunts[fromId], tenantId) ? hunts[fromId] : null;
  const anchor = archivedAt
    ? archive.find(h => h && h.user?.id === fromId && h.archivedAt === archivedAt && inTenant(h, tenantId))
    : atKey;
  if (!anchor) return { error: 'Hunt not found', status: 404 };

  // Re-running a reassign that already landed is ALLOWED, deliberately. The records and the
  // durable stats are two separate stores and cannot be one transaction, so a Postgres blip can
  // leave the hunt renamed everywhere while the rollups still credit the old owner. Refusing the
  // repeat as a no-op would make exactly that state unrepairable from the admin UI — the retry is
  // the repair. Nothing is written twice: the flush compares content, so re-stamping an identical
  // owner never reaches Postgres.
  const resync = String(anchor.user?.id ?? '') === toId;

  // `atKey` is whatever currently sits at the old owner's key, which is NOT necessarily this hunt:
  // targeting an old archived snapshot by archivedAt can find a hunt whose owner has since opened
  // a brand new one. Only move the current record when it really is the same instance.
  const current = atKey && sameHuntInstance(atKey, anchor) ? atKey : null;
  const snapshots = archive.filter(h => h && inTenant(h, tenantId) && sameHuntInstance(h, anchor));

  // `hunts` holds at most one hunt per user, so an occupied destination key would be overwritten —
  // silently destroying the new owner's own hunt. Refuse; the admin can end that one first. On a
  // resync the destination key IS this hunt, which is not a collision.
  if (current && hunts[toId] && hunts[toId] !== current) {
    return { error: 'That user already has a current hunt. End it first, then reassign.', status: 409 };
  }

  return {
    fromId,
    toId,
    current,
    snapshots,
    resync,
    // The durable stats store keys a hunt by `huntId`, falling back to `user.id|startedAt`
    // (lib/statsStore.js huntKey). Every record here is the same instance, so they share one key —
    // captured BEFORE the move, because the fallback form contains the owner id we are about to
    // change and would otherwise be unrecoverable.
    statsKey: anchor.huntId ? String(anchor.huntId) : `${anchor.user?.id}|${anchor.startedAt}`,
    fromName: anchor.user?.displayName || fromId,
  };
}

// Stamp the new owner onto every record in the plan. Mutates the hunt objects in place (they are
// the persistence-owned singletons) and re-keys the current hunt, which is what makes the DELETE
// of the old `hunts_rows` row happen on the next flush.
//
// Equity is deliberately untouched: those rows are who got PAID, and the person who ran the hunt
// under their own name may well still be owed a cut. Ownership and equity are separate questions.
function applyReassign({ hunts, plan, owner }) {
  const stamped = {
    id: String(owner.id),
    displayName: owner.displayName || String(owner.id),
    avatar: owner.avatar ?? null,
  };
  // Spread over the existing user object rather than replacing it, so any field a snapshot carries
  // that we don't know about survives the move.
  for (const snap of plan.snapshots) snap.user = { ...(snap.user || {}), ...stamped };
  if (plan.current) {
    plan.current.user = { ...(plan.current.user || {}), ...stamped };
    // Re-keying is what makes the flush DELETE the old hunts_rows row. Skipped on a resync, where
    // the key is already the destination and the delete/re-add would be a pointless round trip.
    if (plan.fromId !== stamped.id) {
      delete hunts[plan.fromId];
      hunts[stamped.id] = plan.current;
    }
  }
  // A resync moved nothing — it exists to re-run the caller's durable-stats handoff — so report
  // zeroes rather than counting records that were already where they belong.
  if (plan.resync) return { movedCurrent: false, movedArchived: 0, resync: true };
  return { movedCurrent: !!plan.current, movedArchived: plan.snapshots.length, resync: false };
}

module.exports = { planReassign, applyReassign, isSharedHuntKey };
