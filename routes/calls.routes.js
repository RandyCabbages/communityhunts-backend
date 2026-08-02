// Slot-call + call-permission routes:
//   POST /api/hunts/:userId/calls                      — equity member adds a call
//   POST /api/hunts/:userId/public-calls               — public link adds a call (optional PIN)
//   PUT  /api/hunts/:userId                            — edit any hunt (admin/editor)
//   POST /api/hunts/:userId/request-calls              — request call permission
//   GET  /api/hunts/:userId/call-requests              — pending requests (owner/admin)
//   POST /api/hunts/:userId/call-requests/:requestId   — grant/deny a request
// Thin router; mounted from the server.js composition root. hunts is the persistence-owned
// singleton (by reference). Every hunt:update broadcast goes through publicHuntView.
// huntCallRequests is process-local pending-request state, owned here.

const express = require('express');
const { sanitizeBonusReplayUrls, bindEquityIdentityByName, preserveRowIdentity, stampNewCalls, tenantOf } = require('../lib/hunts-core');
const { sanitizePayouts } = require('../lib/payouts');
const { sanitizeChases } = require('../lib/chases');
const { linkWithinHunt, linkFromConfirmed } = require('../lib/identityLink');
const confirmedAliases = require('../lib/confirmedAliases');
const huntUndo = require('../lib/huntUndo');
const { vetEquityIdentity, vetCallerIdentity } = require('../lib/identityWrites');
const { huntTypeDenial } = require('../lib/huntTypeGate');

module.exports = function callsRoutes(deps) {
  const {
    hunts, io, persistHunts,
    requireAuth, canEditHunt, isEquityMember, reqCanAdminHunt, isPrivileged, isPrivilegedViewer, reqIsMod,
    normalizeSlot, nameOf, publicHuntView, emitHubUpdate, emitHuntUpdate, emitToHuntRoom, uid, rejectBadHuntInput,
    auditLog, activityFeed, getKnownUser,
  } = deps;
  const router = express.Router();

  // The pending-request list is owner-only data: `GET /api/hunts/:userId/call-requests` 403s
  // everyone else. It used to be pushed with io.to(`hunt:${userId}`).emit(...), and that room holds
  // every viewer of a live hunt — so each request's Discord id, display name and avatar went to the
  // whole audience, including for requests the owner goes on to DENY. Same REST-gated /
  // socket-ungated shape as the 2026-07-18 audit #4 miss.
  //
  // Delivery matches who the frontend actually shows the panel to (HuntTracker gates it on
  // `canEdit`): host, admin/mod with authority over this hunt, invited co-editor. That is slightly
  // wider than the REST gate, which omits co-editors — narrowing to REST's exact set would blank
  // the panel for people who legitimately co-run the hunt, and these events are its ONLY source.
  //
  // BOTH editor lists, because the two shared surfaces use the other one. On the affiliate and VIP
  // hunts co-editors live in `boardEditors` and deliberately not in `invitedEditors` (lib/auth.js
  // requireBoardEditor — that list gates a wider set of routes), and nobody is ever the "owner" of
  // a shared hunt: `hunt.user.id` is the singleton key, which no Discord id equals. So a non-mod
  // helper invited to run that board matched none of the branches and got an empty panel, which is
  // the whole feature for the only people it was built for.
  const seesRequests = (hunt, ownerId) => (s) => {
    const viewerId = s.data && s.data.userId;          // verified handshake token, never client-set
    if (!viewerId) return false;                       // anonymous socket: never
    if (String(viewerId) === String(ownerId)) return true;
    // ID-only and String()-normalised on both sides, per the repo rule: a display name must never
    // match, and legacy number-typed entries still compare equal to a real user.id.
    const editors = [...(hunt.invitedEditors || []), ...(hunt.boardEditors || [])];
    if (editors.some(e => String(e) === String(viewerId))) return true;
    return typeof isPrivilegedViewer === 'function' ? !!isPrivilegedViewer(viewerId, hunt) : false;
  };

  // See the twin in routes/hunts.routes.js — an editor's save is vetted the same way an owner's is.
  const isKnownAccount = getKnownUser ? (id) => getKnownUser(id) : null;

  // huntCallRequests[huntOwnerId] = [{id, userId, displayName, avatar, requestedAt}]
  const huntCallRequests = {};

  // The add-call rules live in lib/huntCalls.js so the Discord bot's public endpoint gets the same
  // duplicate check, rolling gate and per-person limit rather than a second copy of them.
  const { addCallToHunt } = require('../lib/huntCalls')({
    normalizeSlot, nameOf, emitHuntUpdate, activityFeed,
  });

  // ── Equity member: add slot call ────────────────────────────────────
  router.post('/api/hunts/:userId/calls', requireAuth, (req, res) => {
    const hunt = hunts[req.params.userId];
    if (!hunt) return res.status(404).json({error:'Hunt not found'});
    if (!canEditHunt(req, req.params.userId) && !isEquityMember(req.user, req.params.userId))
      return res.status(403).json({error:'Not an equity member'});

    const isEditor = canEditHunt(req, req.params.userId);
    const result = addCallToHunt(hunt, req.user, req.body.slot,
      { isEditor, limitExempt: isPrivileged(req) });
    if (result.error) return res.status(result.status).json({error: result.error});
    res.json({ok:true, call: result.call});
  });

  // ── Public link: add slot call (any logged-in user, optional PIN, no equity membership) ──
  router.post('/api/hunts/:userId/public-calls', requireAuth, (req, res) => {
    const hunt = hunts[req.params.userId];
    if (!hunt) return res.status(404).json({error:'Hunt not found'});
    if (!hunt.publicCalls) return res.status(403).json({error:'Call link is disabled'});
    if (hunt.publicCallsPin && req.body.pin !== hunt.publicCallsPin)
      return res.status(403).json({error:'Incorrect PIN'});

    // Owners/admins/editors keep their exemptions; everyone else is a limited submitter.
    const isEditor = canEditHunt(req, req.params.userId);
    const result = addCallToHunt(hunt, req.user, req.body.slot,
      { isEditor, source: 'public', limitExempt: isPrivileged(req) });
    if (result.error) return res.status(result.status).json({error: result.error});
    res.json({ok:true, call: result.call});
  });

  // ── Remove a slot call ─────────────────────────────────────────────
  // Editors/admins can remove any call. A regular caller can remove their OWN call, but
  // only while it's still pending and the hunt isn't rolling (mirrors the add-call rule,
  // so a caller can't yank a slot that may be up-next during Opening). Ownership is a
  // strict Discord-ID match — display-name-only (Discord-imported/legacy) calls stay host-only.
  router.delete('/api/hunts/:userId/calls/:callId', requireAuth, (req, res) => {
    const { userId, callId } = req.params;
    const hunt = hunts[userId];
    if (!hunt) return res.status(404).json({ error: 'Hunt not found' });

    const call = (hunt.calls || []).find(c => c.id === callId);
    if (!call) return res.status(404).json({ error: 'Call not found' });

    const isEditor = canEditHunt(req, userId);
    const ownsIt = call.callerId && String(call.callerId) === String(req.user.id);
    const canOwnerRemove = ownsIt && call.status === 'pending' && hunt.huntMode !== 'rolling';
    if (!isEditor && !canOwnerRemove) return res.status(403).json({ error: 'Not allowed' });

    hunt.calls = hunt.calls.filter(c => c.id !== callId);
    hunt.updatedAt = new Date().toISOString();
    emitHuntUpdate(userId); // per-socket (persists + redacts anonymous names)
    res.json({ ok: true });
  });

  // ── Edit any hunt (admin/editor) ───────────────────────────────────
  // Shared undo for a hunt someone else runs — the editor/mod twin of POST /api/my-hunt/undo.
  // Same single history, so an editor's Undo and the host's Undo mean the same thing.
  router.post('/api/hunts/:userId/undo', requireAuth, (req, res) => {
    if (!canEditHunt(req, req.params.userId)) return res.status(403).json({ error: 'Not authorised' });
    const hunt = hunts[req.params.userId];
    if (!hunt) return res.status(404).json({ error: 'Hunt not found' });
    if (hunt.archivedAt) return res.status(409).json({ error: 'Hunt has ended' });

    const popped = huntUndo.popUndo(hunt);
    if (!popped) return res.json({ ok: false, reason: 'nothing to undo', remaining: 0 });

    Object.assign(hunt, popped.patch);
    hunt.updatedAt = new Date().toISOString();
    emitHuntUpdate(req.params.userId);
    emitHubUpdate(req.tenant.id);
    auditLog.recordFromReq(req, {
      category: 'hunt', action: 'hunt.undo', targetId: req.params.userId,
      summary: 'Undid a change by ' + (popped.entry.actorName || 'someone') + (popped.entry.source ? ' (' + popped.entry.source + ')' : ''),
      detail: { at: popped.entry.at, fields: Object.keys(popped.patch) },
    });
    res.json({ ok: true, remaining: (hunt.undoLog || []).length });
  });
  router.put('/api/hunts/:userId', requireAuth, async (req, res) => {
    if (!canEditHunt(req, req.params.userId)) return res.status(403).json({error:'Not authorised'});
    const hunt = hunts[req.params.userId];
    if (!hunt) return res.status(404).json({error:'Hunt not found'});
    if (rejectBadHuntInput(req, res)) return;
    // Snapshot BEFORE any mutation — an editor deleting someone else's bonus is only visible
    // as a diff (the client replaces whole arrays). See lib/auditLog.recordHuntChange.
    const _before = { bonuses: [...(hunt.bonuses || [])], equity: [...(hunt.equity || [])], calls: [...(hunt.calls || [])], vault: [...(hunt.vault || [])] };
    // Shared undo history also needs the scalars — the audit log only ever read the arrays.
    for (const f of huntUndo.SCALAR_FIELDS) _before[f] = hunt[f];
    const { bonuses, equity, gifts, chases, payouts, vault, calls, huntType, callLimit, huntMode, roundRobin, lockTop4, currency, publicCalls, publicCallsPin, currentSlot, manualOrder } = req.body;
    // See routes/hunts.routes.js for the vet-then-preserve ordering and why equity goes first.
    const _idAudit = { accepted: [], rejected: [] };
    const _vetted = (v) => { _idAudit.accepted.push(...v.accepted); _idAudit.rejected.push(...v.rejected); return v.rows; };

    if (equity      !== undefined) hunt.equity      = preserveRowIdentity(_before.equity, _vetted(await vetEquityIdentity(_before.equity, equity, { isKnownAccount })), 'discordId');
    const _eq = hunt.equity;
    if (bonuses     !== undefined) hunt.bonuses     = preserveRowIdentity(_before.bonuses, _vetted(vetCallerIdentity(_before.bonuses, sanitizeBonusReplayUrls(bonuses), _eq)), 'callerId');
    if (gifts       !== undefined) hunt.gifts       = gifts;
    if (payouts     !== undefined) hunt.payouts     = sanitizePayouts(payouts);
    if (chases      !== undefined) hunt.chases      = sanitizeChases(chases);
    if (vault       !== undefined) hunt.vault       = vault;
    if (calls       !== undefined) hunt.calls       = stampNewCalls(_before.calls, preserveRowIdentity(_before.calls, _vetted(vetCallerIdentity(_before.calls, calls, _eq)), 'callerId'));
    // VIP is a mod-run surface. This route's gate (canEditHunt) passes for the owner and invited
    // co-editors, so without this a user could promote their own hunt by calling it here instead
    // of PUT /api/my-hunt. Rule is shared with that route — see lib/huntTypeGate.js.
    const _typeDenied = huntTypeDenial(huntType, req, reqIsMod);
    if (_typeDenied) return res.status(403).json({ error: _typeDenied });
    if (huntType    !== undefined) hunt.huntType    = huntType;
    if (callLimit   !== undefined) hunt.callLimit   = callLimit;
    if (huntMode    !== undefined) hunt.huntMode    = huntMode;
    if (roundRobin  !== undefined) hunt.roundRobin  = roundRobin;
    if (lockTop4    !== undefined) hunt.lockTop4    = lockTop4;
    if (currency    !== undefined) hunt.currency    = currency;
    if (publicCalls    !== undefined) hunt.publicCalls    = publicCalls;
    if (publicCallsPin !== undefined) hunt.publicCallsPin = publicCallsPin;
    if (currentSlot !== undefined) hunt.currentSlot = currentSlot;
    if (manualOrder !== undefined) hunt.manualOrder = manualOrder;
    // Tier 1.5 then Tier 1 — see the twin hook in routes/hunts.routes.js. BOTH save paths
    // replace the whole arrays, so hooking only one leaves a silent gap for editor/admin edits.
    const _confirmed = linkFromConfirmed(hunt, confirmedAliases.resolve);
    const _linked = linkWithinHunt(hunt);
    // Shared undo history — the twin of the hook in routes/hunts.routes.js. An editor's edit is a
    // change to this hunt like any other, so it has to be undoable from either client's button.
    if (!req.undoSkip) {
      const _undo = huntUndo.buildUndoEntry(_before, hunt, {
        actorId: req.user.id, actorName: req.user.displayName,
        source: req.get('X-Client') === 'extension' ? 'extension' : 'site',
      });
      if (_undo) huntUndo.pushUndoEntry(hunt, _undo);
    }
    hunt.updatedAt = new Date().toISOString();
    emitHuntUpdate(req.params.userId); // per-socket (persists + redacts anonymous names)
    emitHubUpdate(req.tenant.id);
    auditLog.recordHuntChange(req, _before,
      { bonuses: hunt.bonuses, equity: hunt.equity, calls: hunt.calls },
      { targetId: req.params.userId, targetName: hunt.user && hunt.user.displayName });
    const _autolinks = [..._confirmed.links, ..._linked.links];
    if (_autolinks.length) {
      auditLog.recordFromReq(req, {
        category: 'hunt', action: 'identity.autolink', targetId: req.params.userId,
        summary: `${_autolinks.length} row(s) auto-linked to a Discord id`,
        detail: { links: _autolinks, fromConfirmed: _confirmed.links.length },
      });
    }
    if (_idAudit.accepted.length || _idAudit.rejected.length) {
      auditLog.recordFromReq(req, {
        category: 'hunt', action: 'identity.set', targetId: req.params.userId,
        summary: `${_idAudit.accepted.length} identity write(s) accepted, ${_idAudit.rejected.length} rejected`,
        detail: _idAudit,
      });
    }
    res.json({ok:true});
  });

  // ── Call Permission Requests ─────────────────────────────────────
  // Request permission to add calls
  router.post('/api/hunts/:userId/request-calls', requireAuth, (req, res) => {
    const { userId } = req.params;
    const hunt = hunts[userId];
    if (!hunt || !hunt.isLive) return res.status(404).json({ error: 'Hunt not found' });
    if (isEquityMember(req.user, userId)) return res.json({ status: 'already_member' });

    if (!huntCallRequests[userId]) huntCallRequests[userId] = [];
    const existing = huntCallRequests[userId].find(r => r.userId === req.user.id);
    if (existing) return res.json({ status: 'pending' });

    const request = {
      id: uid(),
      userId: req.user.id,
      displayName: req.user.displayName || req.user.username,
      avatar: req.user.avatar ? `https://cdn.discordapp.com/avatars/${req.user.id}/${req.user.avatar}.png` : null,
      requestedAt: new Date().toISOString(),
    };
    huntCallRequests[userId].push(request);

    // Notify the hunt owner — and ONLY the hunt owner (see seesRequests above).
    emitToHuntRoom(userId, tenantOf(hunt), 'calls:request:new',
      { requests: huntCallRequests[userId] }, seesRequests(hunt, userId));
    res.json({ status: 'requested' });
  });

  // Get pending requests (hunt owner only)
  router.get('/api/hunts/:userId/call-requests', requireAuth, (req, res) => {
    if (req.user.id !== req.params.userId && !reqCanAdminHunt(req, req.params.userId)) return res.status(403).json({ error: 'Forbidden' });
    res.json(huntCallRequests[req.params.userId] || []);
  });

  // Grant or deny a request
  router.post('/api/hunts/:userId/call-requests/:requestId', requireAuth, (req, res) => {
    const { userId, requestId } = req.params;
    const { action } = req.body; // 'grant' or 'deny'
    if (req.user.id !== userId && !reqCanAdminHunt(req, userId)) return res.status(403).json({ error: 'Forbidden' });

    const requests = huntCallRequests[userId] || [];
    const reqItem = requests.find(r => r.id === requestId);
    if (!reqItem) return res.status(404).json({ error: 'Request not found' });

    // Remove from pending
    huntCallRequests[userId] = requests.filter(r => r.id !== requestId);

    if (action === 'grant') {
      if (!hunts[userId].callsPermissions) hunts[userId].callsPermissions = [];
      if (!hunts[userId].callsPermissions.includes(reqItem.userId)) {
        hunts[userId].callsPermissions.push(reqItem.userId);
      }
      // Attach the verified, owner-approved identity to the member's equity row if unambiguous.
      // Display name for matching comes from the pending request (reqItem.displayName).
      bindEquityIdentityByName(hunts[userId], { userId: reqItem.userId, name: reqItem.displayName });
      persistHunts();
      // Notify the requester
      io.to(`hunt:${userId}`).emit('calls:granted', { userId: reqItem.userId });
    } else {
      io.to(`hunt:${userId}`).emit('calls:denied', { userId: reqItem.userId });
    }

    // Update owner's notification count — same gate; a DENIED request must not be announced to the
    // room either (it names someone the owner just turned down).
    emitToHuntRoom(userId, tenantOf(hunts[userId] || {}), 'calls:request:update',
      { requests: huntCallRequests[userId] }, seesRequests(hunts[userId] || {}, userId));
    res.json({ ok: true });
  });

  return router;
};
