// Who may set which `huntType`, in ONE place.
//
// `huntType` is writable from three routes: POST /api/my-hunt/start, PUT /api/my-hunt (both
// routes/hunts.routes.js) and PUT /api/hunts/:userId (routes/calls.routes.js). The first two
// carried an inline `huntType === 'vip' && !reqIsMod(req)` check; the third did not, and just
// did `if (huntType !== undefined) hunt.huntType = huntType`.
//
// That third route is gated on canEditHunt, which passes for the hunt OWNER as well as invited
// co-editors — so a regular user could promote their own hunt to VIP by calling it against their
// own id instead of /api/my-hunt. Same user, same payload, different URL. VIP hunts are a
// mod-run surface; a regular user should never hold one.
//
// The rule lives here so a fourth write path cannot quietly reintroduce the gap: any route that
// accepts a client-supplied huntType calls this, and adding a privileged type is one edit.
const PRIVILEGED_HUNT_TYPES = new Set(['vip']);

// Returns an error message when the caller may NOT set this huntType, or null when it is allowed.
// `undefined` means the request did not touch huntType at all, which is always fine.
function huntTypeDenial(huntType, req, reqIsMod) {
  if (huntType === undefined) return null;
  if (!PRIVILEGED_HUNT_TYPES.has(huntType)) return null;
  if (typeof reqIsMod === 'function' && reqIsMod(req)) return null;
  return 'Not authorised for VIP hunt';
}

module.exports = { PRIVILEGED_HUNT_TYPES, huntTypeDenial };
