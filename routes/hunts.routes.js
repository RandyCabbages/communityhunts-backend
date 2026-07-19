// Public-hunt + my-hunt routes. Thin router; mounted from the server.js composition root.
//   GET    /api/hunts                              — live public hunts (tenant)
//   GET    /api/hunts/archived                     — completed archived hunts (tenant)
//   GET    /api/hunts/:userId/archived/:archivedAt — one archived snapshot (readonly)
//   GET    /api/hunts/:userId                      — one hunt (permission-aware, auto-links viewer)
//   GET    /api/my-hunt                            — caller's own hunt
//   POST   /api/my-hunt/start|golive|offline|end|reopen|reset
//   PUT    /api/my-hunt          DELETE /api/my-hunt  — caller deletes their own hunt (removes it)
//   POST   /api/my-hunt/invite   DELETE /api/my-hunt/invite
//
// ROUTE ORDER IS LOAD-BEARING: /api/hunts/archived and /api/hunts/:userId/archived/:archivedAt
// MUST be declared before /api/hunts/:userId, or the :userId param swallows them. Preserved below.
// hunts/archive are persistence-owned singletons (by reference). hunt:update via publicHuntView.

const express = require('express');
const { CURRENCIES, sanitizeBonusReplayUrls, huntHasContent, inTenant, linkEquityMember } = require('../lib/hunts-core');

module.exports = function huntsRoutes(deps) {
  const {
    requireAuth, canEditHunt, isEquityMember, reqIsMod,
    hunts, archive, getPublicHunts, getArchivedHunts,
    emitHubUpdate, emitHuntUpdate, publicHuntView, uid, touch,
    persistHunts, archiveHunt, unarchiveHunt, io, rejectBadHuntInput,
    resolveUserIdByName, getCreatorLive, refreshCreatorsLive, getKnownUser, auditLog,
  } = deps;
  const router = express.Router();

  // ── Invited-editor helper ──────────────────────────────────────────
  // invitedEditors holds Discord ID strings (matched by id in canEditHunt — never by name).
  // Resolve an invite request to a real Discord ID: new clients send { userId }; legacy clients
  // send { username } (resolved via known settings, best-effort). Returns null when no real user
  // can be identified — they must have signed in at least once. IDs (not objects) so the current
  // frontend, which renders each entry as a React child, keeps working through the deploy.
  async function resolveInviteeId({ userId, username }) {
    const id = String(userId || '').trim();
    if (/^\d{5,}$/.test(id)) return id;
    if (resolveUserIdByName && username) {
      const resolved = await resolveUserIdByName(username);
      if (resolved) return String(resolved);
    }
    return null;
  }

  // ── Public hunt endpoints ──────────────────────────────────────────
  // Each summary is enriched (route layer — huntSummary is contract-frozen) with the
  // creator's Twitch live state so hub cards can show "LIVE ON TWITCH".
  router.get('/api/hunts', (req, res) => res.json(
    getPublicHunts(req.tenant.id).map(h => {
      const t = getCreatorLive(h.userId);
      return { ...h, twitchLive: t.isLive, twitchLogin: t.login };
    })
  ));
  router.get('/api/hunts/archived', (req, res) => res.json(getArchivedHunts(req.tenant.id)));

  // Fetch a specific archived hunt snapshot. One user can have many archived hunts so the
  // archivedAt timestamp is the tiebreaker. Always returned as readonly (canEdit/canAddCalls=false).
  router.get('/api/hunts/:userId/archived/:archivedAt', (req, res) => {
    const { userId, archivedAt } = req.params;
    const found = archive.find(h => h.user?.id === userId && h.archivedAt === archivedAt);
    // Tenant-scoped + stripped: this is a PUBLIC route (WatchHunt), so serve the same
    // publicHuntView the live sibling does — never the raw snapshot (equity discordIds,
    // editor list). inTenant keeps one tenant's archive from being read via another's slug.
    if (!found || !inTenant(found, req.tenant?.id)) return res.status(404).json({error:'Archived hunt not found'});
    res.json({ ...publicHuntView(found, req.user?.id), canEdit: false, canAddCalls: false });
  });

  router.get('/api/hunts/:userId', (req, res) => {
    const hunt = hunts[req.params.userId];
    if (!hunt) return res.status(404).json({error:'Hunt not found'});
    const canEdit  = req.user ? canEditHunt(req, req.params.userId) : false;

    // NOTE: a display-name → discordId auto-link write used to live here. Removed in the
    // 2026-07-18 security audit (#2): a side-effecting GET let any logged-in user claim an
    // equity row by renaming to its name. Equity rows now get an ID only via the
    // owner-approved request-calls flow (see routes/calls.routes.js).
    const canCalls = req.user ? (canEdit || isEquityMember(req.user, req.params.userId)) : false;
    if (canEdit) {
      res.json({ ...hunt, canEdit, canAddCalls: canCalls });
    } else {
      // Viewers don't need internal linkage/permission data — publicHuntView strips Discord IDs,
      // the editor list, and call-permission IDs, AND redacts anonymous members' names for anyone
      // who isn't the runner/mod/admin (caller identity passed so mods still see real names).
      res.json({
        ...publicHuntView(hunt, req.user?.id),
        canEdit, canAddCalls: canCalls,
      });
    }
  });

  // ── My hunt ────────────────────────────────────────────────────────
  router.get('/api/my-hunt', requireAuth, (req, res) => res.json(hunts[req.user.id] || null));

  // Seed equity when a hunt is created/reset: VIP starts with Bean, solo with
  // just the runner, community empty.
  function initialEquity(huntType, user, tenant, balance) {
    const userName = user?.displayName || user?.username || '';
    if (huntType === 'vip') {
      const b = (tenant && tenant.branding) || {};
      const hostName = b.hostName || 'Bean';
      const hostId   = (tenant && tenant.hostDiscordId) || null;
      // Interim id: keep 'bean_auto' for the Bean tenant so the live frontend's crown logic
      // is unaffected until the frontend keys the crown off discordId/crownDiscordId.
      const id = (tenant && tenant.slug && tenant.slug !== 'bean') ? `host_auto:${tenant.slug}` : 'bean_auto';
      return [{ id, discordId: hostId, name: hostName, amount: balance != null ? balance : 1000, isRollWinner: false }];
    }
    if (huntType === 'solo') return [{ id:'creator_auto', name: userName, amount: balance != null ? balance : 0, isRollWinner: false }];
    // community: always seed the host (creator) so the runner is present even without a
    // starting balance (amount = the balance if given, else 0). Also covers reset, which
    // calls initialEquity('community', …) with no balance.
    return [{ id:'creator_auto', name: userName, amount: balance != null ? balance : 0, isRollWinner: false }];
  }

  router.post('/api/my-hunt/start', requireAuth, (req, res) => {
    const { huntType = 'community', startingBalance, currency, pullPreferredSlots } = req.body;
    if (huntType === 'vip' && !reqIsMod(req))
      return res.status(403).json({error:'Not authorised for VIP hunts'});
    if (currency !== undefined && !CURRENCIES.includes(currency))
      return res.status(400).json({ error: 'Invalid currency' });
    const bal = (Number.isFinite(+startingBalance) && +startingBalance >= 0) ? +startingBalance : undefined;
    // One active hunt per user: block a new hunt while the current one still has content
    // (bonuses / real equity / non-solo calls). Since hunts are born live, an empty shell
    // or an ended hunt (archivedAt set) can always be replaced.
    const current = hunts[req.user.id];
    if (current && !current.archivedAt && huntHasContent(current)) {
      return res.status(409).json({ error: 'You already have an active hunt. End or reset it before starting a new one.' });
    }
    // Archive previous hunt if it had any bonuses
    if (hunts[req.user.id] && hunts[req.user.id].bonuses?.length > 0) {
      if (!hunts[req.user.id].archivedAt) hunts[req.user.id].archivedAt = new Date().toISOString();
      archiveHunt(hunts[req.user.id]);
    }
    hunts[req.user.id] = {
      user: req.user, huntId: uid(), isLive: true, startedAt: new Date().toISOString(), archivedAt: null, tenantId: req.tenant.id,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      huntType, bonuses: [], equity: initialEquity(huntType, req.user, req.tenant, bal), calls: [], invitedEditors: [], callLimit: huntType === 'solo' ? 0 : huntType === 'community' ? 20 : 10, huntMode: 'hunting', roundRobin: true, lockTop4: false, currency: currency || 'USD', publicCalls: false, publicCallsPin: null, pullPreferredSlots: pullPreferredSlots !== false
    };
    persistHunts();
    // Fire-and-forget: pick up the new hunt's creator without waiting a poll cycle.
    refreshCreatorsLive();
    res.json({ok:true});
  });

  router.post('/api/my-hunt/golive', requireAuth, (req, res) => {
    if (!hunts[req.user.id]) return res.status(404).json({error:'No hunt'});
    hunts[req.user.id].isLive    = true;
    hunts[req.user.id].startedAt = new Date().toISOString();
    hunts[req.user.id].updatedAt = new Date().toISOString();
    hunts[req.user.id].archivedAt= null;
    emitHubUpdate(req.tenant.id); // emitHubUpdate calls persistHunts
    emitHuntUpdate(req.user.id);
    res.json({ok:true});
  });

  // Stop broadcasting WITHOUT ending: flip isLive off but leave the hunt unarchived and
  // fully editable, so the host can go live again. (Distinct from /end, which archives + locks.)
  router.post('/api/my-hunt/offline', requireAuth, (req, res) => {
    const h = hunts[req.user.id];
    if (h) {
      h.isLive = false;
      h.updatedAt = new Date().toISOString();
      emitHubUpdate(req.tenant.id); // drop it from the hub's live list; also persists
      emitHuntUpdate(req.user.id);
    }
    res.json({ok:true});
  });

  router.post('/api/my-hunt/end', requireAuth, (req, res) => {
    const h = hunts[req.user.id];
    if (h) {
      h.isLive = false;
      h.updatedAt = new Date().toISOString();
      if (!h.huntId) h.huntId = uid();                       // backfill legacy hunts so the archive can dedupe
      if (!h.archivedAt) h.archivedAt = new Date().toISOString(); // stamp once — re-ending won't move it
      archiveHunt(h);                                         // upsert: refreshes the snapshot, never duplicates
      emitHubUpdate(req.tenant.id);
      emitHuntUpdate(req.user.id);
    }
    res.json({ok:true});
  });

  // Reopen a hunt ended by mistake: flip it back to live and pull its snapshot out of the
  // archive, so history never keeps a copy of a hunt that's running again.
  router.post('/api/my-hunt/reopen', requireAuth, (req, res) => {
    const h = hunts[req.user.id];
    if (!h) return res.status(404).json({error:'No hunt'});
    unarchiveHunt(h);
    h.isLive = true;
    h.updatedAt = new Date().toISOString();
    h.archivedAt = null;
    if (!h.startedAt) h.startedAt = new Date().toISOString();
    emitHubUpdate(req.tenant.id);
    emitHuntUpdate(req.user.id);
    res.json({ok:true});
  });

  router.post('/api/my-hunt/reset', requireAuth, (req, res) => {
    const prev = hunts[req.user.id];
    // Archive the hunt before wiping it — run 1 keeps its own snapshot under its huntId
    // (archiveHunt upserts by huntId; the new run below gets a fresh huntId, so history
    // never collapses the two runs together).
    if (prev && prev.bonuses?.length > 0) {
      if (!prev.archivedAt) prev.archivedAt = new Date().toISOString();
      archiveHunt(prev);
    }
    // Preserve the hunt type across a reset — resetting a VIP hunt should stay
    // VIP (re-seeded with Bean), not silently demote to community.
    const keepType = ['vip','solo'].includes(prev?.huntType) ? prev.huntType : 'community';

    // Restart Hunt (next run) carry-over: the client sends the equity members to keep
    // (checked rows, with possibly-edited amounts) and the un-opened calls to continue with.
    // Absent → blank reset (legacy behavior). Guard to arrays; coerce equity amounts to numbers.
    const carryEquity = Array.isArray(req.body?.equity)
      ? req.body.equity.map(e => ({ ...e, amount: Number.isFinite(+e.amount) ? +e.amount : 0 }))
      : null;
    const carryCalls = Array.isArray(req.body?.calls) ? req.body.calls : null;

    // Continue the session's settings on a restart rather than snapping back to type defaults.
    const keepCallLimit = Number.isFinite(+prev?.callLimit) ? +prev.callLimit
      : (keepType === 'solo' ? 0 : keepType === 'community' ? 20 : 10);

    hunts[req.user.id] = { user: req.user, huntId: uid(), isLive: true, startedAt: new Date().toISOString(), archivedAt: null, tenantId: req.tenant.id,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      huntType: keepType, bonuses: [],
      equity: carryEquity != null ? carryEquity : initialEquity(keepType, req.user, req.tenant),
      calls: carryCalls != null ? carryCalls : [],
      invitedEditors: prev?.invitedEditors || [],
      callLimit: keepCallLimit, huntMode: 'hunting', roundRobin: prev?.roundRobin !== false, lockTop4: false,
      currency: prev?.currency || 'USD', publicCalls: !!prev?.publicCalls, publicCallsPin: prev?.publicCallsPin ?? null };
    persistHunts();
    emitHubUpdate(req.tenant.id);
    emitHuntUpdate(req.user.id);
    auditLog.recordFromReq(req, {
      category: 'hunt', action: 'hunt.reset', targetId: req.user.id,
      summary: `${req.user.displayName || 'someone'} reset their hunt`,
      detail: prev ? { before: { bonuses: prev.bonuses || [], equity: prev.equity || [], calls: prev.calls || [] } } : null,
    });
    res.json({ ok: true, hunt: hunts[req.user.id] });
  });

  // Delete the caller's own hunt entirely — removes it from the hub. Distinct from /reset (which
  // blanks it but leaves an empty hunt still showing in the hub) and /end (which archives + keeps it
  // as history). To keep results, the client calls /end first (archives a copy), then this.
  router.delete('/api/my-hunt', requireAuth, (req, res) => {
    const h = hunts[req.user.id];
    if (h) {
      // Snapshot before the delete — this is the row an owner restores from.
      auditLog.recordFromReq(req, {
        category: 'hunt', action: 'hunt.delete', targetId: req.user.id,
        summary: `${req.user.displayName || 'someone'} deleted their hunt`,
        detail: { before: { bonuses: h.bonuses || [], equity: h.equity || [], calls: h.calls || [] } },
      });
      delete hunts[req.user.id];
      emitHubUpdate(req.tenant.id); // drops it from the hub list; also persists
    }
    res.json({ok:true});
  });

  router.put('/api/my-hunt', requireAuth, (req, res) => {
    if (rejectBadHuntInput(req, res)) return;
    // Snapshot BEFORE any mutation — the client replaces whole arrays, so a bonus deletion is
    // only visible as a diff (see lib/auditLog.recordHuntChange).
    const _h = hunts[req.user.id];
    const _before = _h
      ? { bonuses: [...(_h.bonuses || [])], equity: [...(_h.equity || [])], calls: [...(_h.calls || [])] }
      : { bonuses: [], equity: [], calls: [] };
    if (!hunts[req.user.id]) hunts[req.user.id] = {
      user: req.user, huntId: uid(), isLive: false, startedAt: null, archivedAt: null, tenantId: req.tenant.id,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      huntType: 'community', bonuses: [], equity: [], calls: [], invitedEditors: [], callLimit: 20, currency: 'USD', publicCalls: false, publicCallsPin: null
    };
    const { bonuses, equity, gifts, vault, calls, huntType, callLimit, huntMode, roundRobin, lockTop4, currency, publicCalls, publicCallsPin, currentSlot, manualOrder } = req.body;
    if (bonuses    !== undefined) hunts[req.user.id].bonuses    = sanitizeBonusReplayUrls(bonuses);
    if (equity     !== undefined) hunts[req.user.id].equity     = equity;
    if (gifts      !== undefined) hunts[req.user.id].gifts      = gifts;
    if (vault      !== undefined) hunts[req.user.id].vault      = vault;
    if (calls      !== undefined) hunts[req.user.id].calls      = calls;
    if (huntType   !== undefined) {
      if (huntType === 'vip' && !reqIsMod(req))
        return res.status(403).json({error:'Not authorised for VIP hunt'});
      hunts[req.user.id].huntType = huntType;
    }
    if (callLimit  !== undefined) hunts[req.user.id].callLimit  = callLimit;
    if (huntMode   !== undefined) hunts[req.user.id].huntMode   = huntMode;
    if (roundRobin !== undefined) hunts[req.user.id].roundRobin = roundRobin;
    if (lockTop4   !== undefined) hunts[req.user.id].lockTop4   = lockTop4;
    if (currency   !== undefined) hunts[req.user.id].currency   = currency;
    if (publicCalls    !== undefined) hunts[req.user.id].publicCalls    = publicCalls;
    if (publicCallsPin !== undefined) hunts[req.user.id].publicCallsPin = publicCallsPin;
    if (currentSlot !== undefined) hunts[req.user.id].currentSlot = currentSlot;
    if (manualOrder !== undefined) hunts[req.user.id].manualOrder = manualOrder;
    touch(req.user.id);
    persistHunts();
    emitHuntUpdate(req.user.id);
    emitHubUpdate(req.tenant.id);
    auditLog.recordHuntChange(req,
      _before,
      { bonuses: hunts[req.user.id].bonuses, equity: hunts[req.user.id].equity, calls: hunts[req.user.id].calls },
      { targetId: req.user.id, targetName: req.user.displayName });
    res.json({ok:true});
  });

  // ── Invite editor ──────────────────────────────────────────────────
  // Body: { userId } (new) or { username } (legacy → resolved to an id). Stored as a Discord
  // ID and matched by id in canEditHunt — never by display name.
  router.post('/api/my-hunt/invite', requireAuth, async (req, res) => {
    const hunt = hunts[req.user.id];
    if (!hunt) return res.status(404).json({error:'No hunt'});
    const id = await resolveInviteeId(req.body || {});
    if (!id) return res.status(400).json({error:'Pick a user who has signed in at least once'});
    if (!hunt.invitedEditors) hunt.invitedEditors = [];
    if (!hunt.invitedEditors.includes(id)) hunt.invitedEditors.push(id);
    persistHunts();
    io.to(`hunt:${req.user.id}`).emit('hunt:reinvite', { huntUserId: req.user.id });
    auditLog.recordFromReq(req, { category: 'admin', action: 'editor.invite', targetId: req.user.id,
      summary: `${req.user.displayName || 'someone'} invited editor ${id} to their hunt` });
    res.json({ok:true, invitedEditors: hunt.invitedEditors});
  });

  router.delete('/api/my-hunt/invite', requireAuth, (req, res) => {
    const hunt = hunts[req.user.id];
    if (!hunt) return res.status(404).json({error:'No hunt'});
    const target = String(req.body?.id ?? req.body?.userId ?? req.body?.username ?? '').trim().toLowerCase();
    hunt.invitedEditors = (hunt.invitedEditors || []).filter(u => String(u).toLowerCase() !== target);
    persistHunts();
    io.to(`hunt:${req.user.id}`).emit('hunt:reinvite', { huntUserId: req.user.id });
    auditLog.recordFromReq(req, { category: 'admin', action: 'editor.remove', targetId: req.user.id,
      summary: `${req.user.displayName || 'someone'} removed editor ${target} from their hunt` });
    res.json({ok:true, invitedEditors: hunt.invitedEditors});
  });

  // ── Invite editor on another user's hunt (admin/editor) ────────────
  router.post('/api/hunts/:userId/invite', requireAuth, async (req, res) => {
    const { userId } = req.params;
    if (!canEditHunt(req, userId)) return res.status(403).json({error:'Not authorised'});
    const hunt = hunts[userId];
    if (!hunt) return res.status(404).json({error:'Hunt not found'});
    const id = await resolveInviteeId(req.body || {});
    if (!id) return res.status(400).json({error:'Pick a user who has signed in at least once'});
    if (!hunt.invitedEditors) hunt.invitedEditors = [];
    if (!hunt.invitedEditors.includes(id)) hunt.invitedEditors.push(id);
    persistHunts();
    io.to(`hunt:${userId}`).emit('hunt:reinvite', { huntUserId: userId });
    auditLog.recordFromReq(req, { category: 'admin', action: 'editor.invite', targetId: userId,
      summary: `${req.user.displayName || 'someone'} invited editor ${id} to ${userId}'s hunt` });
    res.json({ok:true, invitedEditors: hunt.invitedEditors});
  });

  router.delete('/api/hunts/:userId/invite', requireAuth, (req, res) => {
    const { userId } = req.params;
    if (!canEditHunt(req, userId)) return res.status(403).json({error:'Not authorised'});
    const hunt = hunts[userId];
    if (!hunt) return res.status(404).json({error:'Hunt not found'});
    const target = String(req.body?.id ?? req.body?.userId ?? req.body?.username ?? '').trim().toLowerCase();
    hunt.invitedEditors = (hunt.invitedEditors || []).filter(u => String(u).toLowerCase() !== target);
    persistHunts();
    io.to(`hunt:${userId}`).emit('hunt:reinvite', { huntUserId: userId });
    auditLog.recordFromReq(req, { category: 'admin', action: 'editor.remove', targetId: userId,
      summary: `${req.user.displayName || 'someone'} removed editor ${target} from ${userId}'s hunt` });
    res.json({ok:true, invitedEditors: hunt.invitedEditors});
  });

  // Admin/owner: bind a Discord user to an equity row (rename-proof identity for masking + payouts).
  router.post('/api/hunts/:userId/equity/:memberId/link', requireAuth, async (req, res) => {
    if (!canEditHunt(req, req.params.userId)) return res.status(403).json({ error: 'Not authorised' });
    const hunt = hunts[req.params.userId];
    if (!hunt) return res.status(404).json({ error: 'Hunt not found' });
    const discordId = String(req.body?.discordId || '').trim();
    if (!/^\d{5,}$/.test(discordId)) return res.status(400).json({ error: 'Valid discordId required' });
    const known = getKnownUser ? await getKnownUser(discordId) : null;
    if (!known) return res.status(404).json({ error: 'No known user for that Discord ID' });
    const _before = { equity: [...(hunt.equity || [])] };
    if (!linkEquityMember(hunt, req.params.memberId, discordId))
      return res.status(404).json({ error: 'Equity member not found' });
    hunt.updatedAt = new Date().toISOString();
    emitHuntUpdate(req.params.userId);
    auditLog.recordHuntChange(req, _before, { equity: hunt.equity },
      { targetId: req.params.userId, targetName: hunt.user && hunt.user.displayName });
    res.json({ ok: true, linked: { memberId: req.params.memberId, discordId, displayName: known.displayName } });
  });

  return router;
};
