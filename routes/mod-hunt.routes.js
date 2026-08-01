// Tenant hunt + Affiliate hunt routes. Two shared hunts per community (not per-user), keyed by
// modHuntKey(tenantId)/affiliateHuntKey(tenantId):
//   __tenant_hunt__       — Bean's tenant only (bare fixed key; the string in Bean's OBS overlay URL)
//   __tenant_hunt__:<id>  — every other tenant, namespaced so communities' tenant hunts don't collide
// (same pattern for __affiliate_hunt__). The route PATH stays /api/mod-hunt for wire compat; only
// the storage key was rebranded from __mod_hunt__ (see lib/hunts-core.js MOD_HUNT_ID + the startup
// migration in lib/migrateSharedHuntKeys.js). All gated by requireMod. Thin router; mounted from
// the server.js composition root.
//
// hunts/archive are persistence-owned singletons (by reference, never reassigned — only mutated).
// Behavior unchanged from the inline routes; every hunt:update goes through publicHuntView.

const express = require('express');
const { sanitizeBonusReplayUrls, preserveRowIdentity, stampNewCalls, tenantOf } = require('../lib/hunts-core');
const huntRevert = require('../lib/huntRevert');
const { sanitizePayouts } = require('../lib/payouts');
const { sanitizeChases } = require('../lib/chases');
const { sanitizeTitle } = require('../lib/huntTitle');
const makeSharedHunts = require('../lib/sharedHunts');
const { sanitizeHuntMeta } = require('../lib/huntKinds');

// Audit summaries name the hunt, not its key: these are SHARED hunts, so `targetId` is the fixed
// key (`__tenant_hunt__:<tenant>`) rather than a user id, and a raw key reads as gibberish in the log.
const MOD_HUNT_LABEL = "the Tenant Hunt"; // audit-log label (route/key names stay mod-hunt for wire compat)
const AFFILIATE_HUNT_LABEL = "the Affiliate Hunt";
const VIP_HUNT_LABEL = "the VIP Hunt";

module.exports = function modHuntRoutes(deps) {
  const {
    hunts, archive, io, persistHunts, archiveHunt, unarchiveHunt,
    requireMod, requireBoardEditor, modHuntKey, affiliateHuntKey, vipHuntKey, tenants,
    uid, touch, publicHuntView, emitHuntUpdate, emitToHuntRoom, rejectBadHuntInput,
    auditLog, getSettings, saveSettings, persistOverlayConfig,
  } = deps;
  const router = express.Router();

  // ── Board-editor gates (affiliate + VIP only) ──────────────────────
  // The BOARD routes of these two admit the mod crew plus anyone a mod has invited to co-run
  // this specific hunt (lib/auth.js requireBoardEditor, reading `boardEditors` off the hunt).
  // Everything destructive or historical below stays on plain requireMod — see the editors
  // routes at the bottom of this file for the full split and why.
  //
  // Bean's tenant hunt (modHuntKey) is deliberately NOT in this list: it has no co-edit yet.
  const affiliateBoard = requireBoardEditor(affiliateHuntKey);
  const vipBoard       = requireBoardEditor(vipHuntKey);

  // ── Delete a shared hunt ───────────────────────────────────────────
  // Removes the singleton key OUTRIGHT. These three keys were previously un-removable: /reset
  // replaces the key with a fresh BORN-LIVE hunt (and the affiliate/VIP seeds carry a 1000
  // starting pot, so a "deleted" hunt came straight back reading as live), and /end archives in
  // place, leaving the spent hunt as the active singleton with no way to clear it.
  //
  // Deliberately does NOT archive — /end is the save path, so "save it first" composes as
  // /end then DELETE, and a plain DELETE stays a true discard.
  //
  // Watchers are the subtle part: emitHuntUpdate early-returns on a missing hunt, so calling it
  // after the delete emits NOTHING and a second mod's tab (or the OBS source) keeps rendering a
  // hunt that is gone. Capture tenantOf(h) BEFORE the delete and fan a distinct `hunt:deleted`
  // through emitToHuntRoom, which applies the same per-socket tenant gate as every other hunt
  // emit (a room broadcast here would reopen the cross-tenant leak from the 2026-07-18 audit).
  const deleteRoute = (keyFor, label) => (req, res) => {
    const key = keyFor(req.tenant.id);
    const h = hunts[key];
    if (!h) return res.status(404).json({ error: 'No hunt' });
    const slug = tenantOf(h);
    auditLog.recordFromReq(req, {
      category: 'hunt', action: 'hunt.delete', targetId: key,
      summary: `${(req.user && req.user.displayName) || 'a mod'} deleted ${label}${h.title ? ` "${h.title}"` : ''}`,
      detail: {
        title: h.title || null,
        before: { bonuses: h.bonuses || [], equity: h.equity || [], calls: h.calls || [], vault: h.vault || [] },
      },
    });
    delete hunts[key];
    persistHunts(); // a missed persist deletes in memory only — the hunt resurrects on next boot
    emitToHuntRoom(key, slug, 'hunt:deleted', { id: key });
    res.json({ ok: true });
  };
  router.delete('/api/mod-hunt', requireMod, deleteRoute(modHuntKey, MOD_HUNT_LABEL));
  router.delete('/api/affiliate-hunt', requireMod, deleteRoute(affiliateHuntKey, AFFILIATE_HUNT_LABEL));
  router.delete('/api/vip-hunt', requireMod, deleteRoute(vipHuntKey, VIP_HUNT_LABEL));

  // Shared-overlay styling. The mod/affiliate hunts are shared, so their OBS overlay config lives
  // under the hunt KEY (modHuntKey/affiliateHuntKey), read publicly via GET /api/overlay-config/:id.
  // These requireMod writes let a mod restyle that shared overlay; the emit live-restyles the open
  // OBS source (its browser source joined room hunt:<key> via watch:hunt), mirroring the personal
  // overlay path in settings.routes.js. The link never changes — only the stored style does.
  const overlayConfigRoute = (keyFor) => async (req, res) => {
    const key = keyFor(req.tenant.id);
    const cfg = await persistOverlayConfig(getSettings, saveSettings, key, req.body.overlayConfig);
    if (io) io.to(`hunt:${key}`).emit('overlay-config:update', cfg);
    res.json({ ok: true });
  };
  router.put('/api/mod-hunt/overlay-config', requireMod, overlayConfigRoute(modHuntKey));
  router.put('/api/affiliate-hunt/overlay-config', requireMod, overlayConfigRoute(affiliateHuntKey));
  router.put('/api/vip-hunt/overlay-config', requireMod, overlayConfigRoute(vipHuntKey));

  // ── Activity panel: per-hunt audit view + revert (see docs/.../shared-hunt-activity-revert) ──
  // Tenant-safe view of an audit row for the mod-facing panel: strip `ip` (mods must never see it —
  // the owner /admin/audit endpoint is the only place that exposes it). Keep `detail` (the panel
  // reads detail.removed / detail.members to describe + revert the change).
  const activityRow = ({ ip, ...rest }) => rest;

  // Recent hunt-activity for ONE shared hunt. Key is derived from req.tenant server-side, so a mod
  // only ever sees their own tenant's hunt (no client-supplied target).
  const activityRoute = (keyFor) => async (req, res) => {
    try {
      const key = keyFor(req.tenant.id);
      const out = await auditLog.query({
        targetId: key, category: 'hunt',
        limit: req.query.limit || 50, cursor: req.query.cursor || null,
      });
      res.json({ rows: (out.rows || []).map(activityRow), nextCursor: out.nextCursor || null });
    } catch (e) {
      console.error('[hunt-activity] query failed:', e.message);
      res.status(500).json({ error: 'Activity query failed' });
    }
  };
  router.get('/api/mod-hunt/activity', requireMod, activityRoute(modHuntKey));
  router.get('/api/affiliate-hunt/activity', affiliateBoard, activityRoute(affiliateHuntKey));
  router.get('/api/vip-hunt/activity', vipBoard, activityRoute(vipHuntKey));

  // Who is RUNNING this shared hunt. VIP and Affiliate hunts are owned by the COMMUNITY, so
  // `user.displayName` is the tenant's host name ("Bean") no matter who opened them — which reads
  // as flatly wrong on the hub. Stamping the opener's session here gives the card their real name
  // AND their Discord avatar.
  //
  // Server-side on purpose: `runner` is not in the PUT's field whitelist, so a client cannot set
  // or change it by editing a hunt payload.
  //
  // `wasNew` is the honest case — the hunt is being created, so the caller IS the opener. For a
  // hunt that predates this (already live when it shipped) we backfill ONLY when the saver matches
  // the `creator_auto` equity row, which carries the opener's display name. Without that guard a
  // backfill would stamp whichever mod happened to save next, which on a shared hunt is often not
  // the person running it.
  function stampRunner(h, req, wasNew) {
    if (!h || !req.user || (h.runner && h.runner.id)) return;
    const name = String(req.user.displayName || req.user.username || '').trim();
    if (!name) return;
    const me = { id: String(req.user.id), name, avatar: req.user.avatar || null };
    if (wasNew) { h.runner = me; return; }
    const row = (h.equity || []).find(e => e && e.id === 'creator_auto');
    const seeded = row && typeof row.name === 'string' ? row.name.trim().toLowerCase() : '';
    if (seeded && seeded === name.toLowerCase()) h.runner = me;
  }

  // Apply a { bonuses?, equity?, calls? } patch to the shared hunt through the SAME write path a
  // normal PUT uses, then audit it (so the revert is itself a reversible row). Label per hunt kind.
  function applyRevert(req, key, patch, label) {
    const h = hunts[key];
    if (!h) return false;
    const before = { bonuses: [...(h.bonuses || [])], equity: [...(h.equity || [])], calls: [...(h.calls || [])] };
    if (patch.bonuses !== undefined) h.bonuses = preserveRowIdentity(before.bonuses, sanitizeBonusReplayUrls(patch.bonuses), 'callerId');
    if (patch.equity  !== undefined) h.equity  = preserveRowIdentity(before.equity, patch.equity, 'discordId');
    if (patch.calls   !== undefined) h.calls   = stampNewCalls(before.calls, preserveRowIdentity(before.calls, patch.calls, 'callerId'));
    touch(key);
    persistHunts();
    emitHuntUpdate(key);
    auditLog.recordHuntChange(req, before,
      { bonuses: h.bonuses, equity: h.equity, calls: h.calls },
      { targetId: key, huntLabel: label });
    return true;
  }

  const undoRoute = (keyFor, label) => async (req, res) => {
    const key = keyFor(req.tenant.id);
    const row = await auditLog.getById(req.params.id);
    if (!huntRevert.isRevertableRow(row, key)) return res.status(404).json({ error: 'Activity not found' });
    let patch;
    try { patch = huntRevert.scopedUndoPatch(hunts[key] || {}, row); }
    catch { return res.status(400).json({ error: 'Nothing to undo for this action' }); }
    if (!applyRevert(req, key, patch, label)) return res.status(404).json({ error: 'No hunt' });
    res.json({ ok: true });
  };

  const restoreRoute = (keyFor, label) => async (req, res) => {
    const key = keyFor(req.tenant.id);
    const row = await auditLog.getById(req.params.id);
    if (!huntRevert.isRevertableRow(row, key)) return res.status(404).json({ error: 'Activity not found' });
    let patch;
    try { patch = huntRevert.fullRestorePatch(row); }
    catch { return res.status(400).json({ error: 'No snapshot to restore' }); }
    if (!applyRevert(req, key, patch, label)) return res.status(404).json({ error: 'No hunt' });
    res.json({ ok: true });
  };

  router.post('/api/mod-hunt/activity/:id/undo', requireMod, undoRoute(modHuntKey, MOD_HUNT_LABEL));
  router.post('/api/affiliate-hunt/activity/:id/undo', affiliateBoard, undoRoute(affiliateHuntKey, AFFILIATE_HUNT_LABEL));
  router.post('/api/vip-hunt/activity/:id/undo', vipBoard, undoRoute(vipHuntKey, VIP_HUNT_LABEL));
  router.post('/api/mod-hunt/activity/:id/restore', requireMod, restoreRoute(modHuntKey, MOD_HUNT_LABEL));
  router.post('/api/affiliate-hunt/activity/:id/restore', affiliateBoard, restoreRoute(affiliateHuntKey, AFFILIATE_HUNT_LABEL));
  router.post('/api/vip-hunt/activity/:id/restore', vipBoard, restoreRoute(vipHuntKey, VIP_HUNT_LABEL));

  // Shared with routes/public.routes.js, which opens the same affiliate/VIP runs for the Discord
  // bot. Two copies of "what a fresh affiliate hunt looks like" would drift, and the drifted one
  // would be writing a real hunt with the wrong starting equity.
  const { hostNameFor, hostEquityRow, emptyModHunt, emptyAffiliateHunt, emptyVipHunt } =
    makeSharedHunts({ tenants, uid });

  // ── Mod hunt — private solo hunt run jointly by a community's Mods ────
  // Stored under modHuntKey(tenantId) so Bean's OBS overlay link never changes.
  // Never appears on Hub or archive listings.

  router.get('/api/mod-hunt', requireMod, (req, res) => {
    const key = modHuntKey(req.tenant.id);
    res.json(hunts[key] || null);
  });

  router.put('/api/mod-hunt', requireMod, (req, res) => {
    if (rejectBadHuntInput(req, res)) return;
    const key = modHuntKey(req.tenant.id);
    // Snapshot BEFORE any mutation. This is a SHARED hunt (any mod can edit), so "who removed
    // this?" has no obvious owner to ask — attribution matters more here than on a personal hunt.
    const _h = hunts[key];
    const _before = _h
      ? { bonuses: [...(_h.bonuses || [])], equity: [...(_h.equity || [])], calls: [...(_h.calls || [])], vault: [...(_h.vault || [])] }
      : { bonuses: [], equity: [], calls: [], vault: [] };
    if (!hunts[key]) hunts[key] = emptyModHunt(req.tenant.id);
    const { bonuses, equity, gifts, chases, payouts, vault, calls, callLimit, huntMode, roundRobin, lockTop4, currency, currentSlot, manualOrder, title, endingBalance } = req.body;
    // See routes/hunts.routes.js — masked client copies must not clear known identities.
    if (bonuses    !== undefined) hunts[key].bonuses    = preserveRowIdentity(_before.bonuses, sanitizeBonusReplayUrls(bonuses), 'callerId');
    if (equity     !== undefined) hunts[key].equity     = preserveRowIdentity(_before.equity, equity, 'discordId');
    if (gifts      !== undefined) hunts[key].gifts      = gifts;
    if (payouts    !== undefined) hunts[key].payouts    = sanitizePayouts(payouts);
    if (chases     !== undefined) hunts[key].chases     = sanitizeChases(chases);
    if (vault      !== undefined) hunts[key].vault      = vault;
    if (calls      !== undefined) hunts[key].calls      = stampNewCalls(_before.calls, preserveRowIdentity(_before.calls, calls, 'callerId'));
    if (callLimit  !== undefined) hunts[key].callLimit  = callLimit;
    if (huntMode   !== undefined) hunts[key].huntMode   = huntMode;
    if (roundRobin !== undefined) hunts[key].roundRobin = roundRobin;
    if (lockTop4   !== undefined) hunts[key].lockTop4   = lockTop4;
    if (currency   !== undefined) hunts[key].currency   = currency;
    if (currentSlot !== undefined) hunts[key].currentSlot = currentSlot;
    if (manualOrder !== undefined) hunts[key].manualOrder = manualOrder;
    if (title      !== undefined) hunts[key].title      = sanitizeTitle(title);
    // Ending Balance (tenant hunt page only): once set, the frontend uses it as the authoritative
    // total winnings. null clears it back to the summed-bonus-wins behavior.
    if (endingBalance !== undefined) hunts[key].endingBalance = endingBalance;
    // Hunt metadata (kind, tournament, plan, pull list). sanitizeHuntMeta returns ONLY the keys
    // present in the body, so a partial save cannot blank a field the caller never mentioned —
    // the same contract as every `!== undefined` guard above.
    Object.assign(hunts[key], sanitizeHuntMeta(req.body));
    hunts[key].huntType = 'solo';
    touch(key);
    persistHunts();
    emitHuntUpdate(key);
    auditLog.recordHuntChange(req, _before,
      { bonuses: hunts[key].bonuses, equity: hunts[key].equity, calls: hunts[key].calls, vault: hunts[key].vault },
      { targetId: key, huntLabel: MOD_HUNT_LABEL });
    res.json({ ok: true });
  });

  router.post('/api/mod-hunt/golive', requireMod, (req, res) => {
    const key = modHuntKey(req.tenant.id);
    if (!hunts[key]) hunts[key] = emptyModHunt(req.tenant.id);
    hunts[key].isLive     = true;
    hunts[key].startedAt  = new Date().toISOString();
    hunts[key].updatedAt  = new Date().toISOString();
    hunts[key].archivedAt = null;
    persistHunts();
    emitHuntUpdate(key);
    res.json({ ok: true });
  });

  // Stop broadcasting without ending/archiving — host can go live again. (See /end for the lock path.)
  router.post('/api/mod-hunt/offline', requireMod, (req, res) => {
    const key = modHuntKey(req.tenant.id);
    const h = hunts[key];
    if (h) {
      h.isLive = false;
      h.updatedAt = new Date().toISOString();
      persistHunts();
      emitHuntUpdate(key);
    }
    res.json({ ok: true });
  });

  router.post('/api/mod-hunt/end', requireMod, (req, res) => {
    const key = modHuntKey(req.tenant.id);
    const h = hunts[key];
    if (h) {
      h.isLive = false;
      h.updatedAt = new Date().toISOString();
      if (!h.archivedAt) h.archivedAt = new Date().toISOString();
      archiveHunt(h); // log it to /history now (idempotent by huntId; no-op if 0 bonuses)
      persistHunts();
      emitHuntUpdate(key);
    }
    res.json({ ok: true });
  });

  router.post('/api/mod-hunt/reopen', requireMod, (req, res) => {
    const key = modHuntKey(req.tenant.id);
    const h = hunts[key];
    if (!h) return res.status(404).json({ error: 'No mod hunt' });
    h.isLive = true;
    h.updatedAt = new Date().toISOString();
    h.archivedAt = null;
    if (!h.startedAt) h.startedAt = new Date().toISOString();
    unarchiveHunt(h); // live again → must not also sit in /history
    persistHunts();
    emitHuntUpdate(key);
    res.json({ ok: true });
  });

  // Reopen a SPECIFIC past hunt from history: swap it into the active slot and make it live.
  // Whatever is currently active is archived first (idempotent; empty skipped) so nothing is lost,
  // then the selected snapshot is removed from history (unarchive) and becomes the active hunt.
  router.post('/api/mod-hunt/reopen-archived', requireMod, (req, res) => {
    const key = modHuntKey(req.tenant.id);
    const huntId = req.body && req.body.huntId;
    if (!huntId) return res.status(400).json({ error: 'huntId required' });
    const snap = archive.find(h => h && h.user?.id === key && h.huntId === huntId);
    if (!snap) return res.status(404).json({ error: 'Archived hunt not found' });

    const cur = hunts[key];
    if (cur && Array.isArray(cur.bonuses) && cur.bonuses.length > 0) {
      if (!cur.archivedAt) cur.archivedAt = new Date().toISOString();
      archiveHunt(cur); // save the currently-active hunt to history first
    }
    unarchiveHunt(snap); // remove the chosen one from history…
    hunts[key] = { ...snap, isLive: true, archivedAt: null, updatedAt: new Date().toISOString() }; // …and make it active+live
    persistHunts();
    emitHuntUpdate(key);
    auditLog.recordFromReq(req, {
      category: 'hunt', action: 'hunt.reopen_archived', targetId: key,
      summary: `${(req.user && req.user.displayName) || 'a mod'} reopened ${MOD_HUNT_LABEL} "${snap.title || snap.huntId}"`,
      detail: { huntId: snap.huntId, title: snap.title || null },
    });
    res.json({ ok: true });
  });

  router.post('/api/mod-hunt/reset', requireMod, (req, res) => {
    const key = modHuntKey(req.tenant.id);
    const old = hunts[key];
    if (old && Array.isArray(old.bonuses) && old.bonuses.length > 0) {
      if (!old.archivedAt) old.archivedAt = new Date().toISOString();
      archiveHunt(old);
    }
    auditLog.recordFromReq(req, {
      category: 'hunt', action: 'hunt.reset', targetId: key,
      summary: `${(req.user && req.user.displayName) || 'a mod'} reset ${MOD_HUNT_LABEL}`,
      detail: old ? { before: { bonuses: old.bonuses || [], equity: old.equity || [], calls: old.calls || [] } } : null,
    });
    hunts[key] = emptyModHunt(req.tenant.id, req.body && req.body.title);
    persistHunts();
    emitHuntUpdate(key);
    res.json({ ok: true });
  });

  router.get('/api/mod-hunt/history', requireMod, (req, res) => {
    const key = modHuntKey(req.tenant.id);
    const modArchived = archive.filter(h => h.user?.id === key);
    res.json(modArchived.map(h => ({
      huntId: h.huntId,
      title: h.title || null,
      archivedAt: h.archivedAt,
      bonuses: h.bonuses || [],
      equity: h.equity || [],
      huntMode: h.huntMode,
      lockTop4: h.lockTop4 ?? false,
      startedAt: h.startedAt,
      createdAt: h.createdAt,
      totalWon: (h.bonuses || []).reduce((s, b) => s + (b.win || 0), 0),
      totalBet: (h.bonuses || []).reduce((s, b) => s + (b.bet || 0), 0),
      bonusCount: (h.bonuses || []).length,
    })));
  });

  // ── Affiliate hunt — VIP-style hunt run jointly by a community's Mods ──

  router.get('/api/affiliate-hunt', affiliateBoard, (req, res) => {
    const key = affiliateHuntKey(req.tenant.id);
    res.json(hunts[key] || null);
  });

  router.put('/api/affiliate-hunt', affiliateBoard, (req, res) => {
    if (rejectBadHuntInput(req, res)) return;
    const key = affiliateHuntKey(req.tenant.id);
    // Snapshot BEFORE any mutation — shared hunt, many mod editors (see the mod-hunt PUT above).
    const _h = hunts[key];
    const _before = _h
      ? { bonuses: [...(_h.bonuses || [])], equity: [...(_h.equity || [])], calls: [...(_h.calls || [])], vault: [...(_h.vault || [])] }
      : { bonuses: [], equity: [], calls: [], vault: [] };
    const _wasNew = !hunts[key];
    if (!hunts[key]) hunts[key] = emptyAffiliateHunt(req.tenant.id);
    stampRunner(hunts[key], req, _wasNew);
    const { bonuses, equity, gifts, chases, payouts, vault, calls, callLimit, huntMode, roundRobin, lockTop4, currency, currentSlot, manualOrder, title } = req.body;
    // See routes/hunts.routes.js — masked client copies must not clear known identities.
    if (bonuses    !== undefined) hunts[key].bonuses    = preserveRowIdentity(_before.bonuses, sanitizeBonusReplayUrls(bonuses), 'callerId');
    if (equity     !== undefined) hunts[key].equity     = preserveRowIdentity(_before.equity, equity, 'discordId');
    if (gifts      !== undefined) hunts[key].gifts      = gifts;
    if (payouts    !== undefined) hunts[key].payouts    = sanitizePayouts(payouts);
    if (chases     !== undefined) hunts[key].chases     = sanitizeChases(chases);
    if (vault      !== undefined) hunts[key].vault      = vault;
    if (calls      !== undefined) hunts[key].calls      = stampNewCalls(_before.calls, preserveRowIdentity(_before.calls, calls, 'callerId'));
    if (callLimit  !== undefined) hunts[key].callLimit  = callLimit;
    if (huntMode   !== undefined) hunts[key].huntMode   = huntMode;
    if (roundRobin !== undefined) hunts[key].roundRobin = roundRobin;
    if (lockTop4   !== undefined) hunts[key].lockTop4   = lockTop4;
    if (currency   !== undefined) hunts[key].currency   = currency;
    if (currentSlot !== undefined) hunts[key].currentSlot = currentSlot;
    if (manualOrder !== undefined) hunts[key].manualOrder = manualOrder;
    if (title      !== undefined) hunts[key].title      = sanitizeTitle(title);
    hunts[key].huntType = 'vip';
    touch(key);
    persistHunts();
    emitHuntUpdate(key);
    auditLog.recordHuntChange(req, _before,
      { bonuses: hunts[key].bonuses, equity: hunts[key].equity, calls: hunts[key].calls, vault: hunts[key].vault },
      { targetId: key, huntLabel: AFFILIATE_HUNT_LABEL });
    res.json({ ok: true });
  });

  router.post('/api/affiliate-hunt/golive', requireMod, (req, res) => {
    const key = affiliateHuntKey(req.tenant.id);
    const _wasNew = !hunts[key];
    if (!hunts[key]) hunts[key] = emptyAffiliateHunt(req.tenant.id);
    stampRunner(hunts[key], req, _wasNew);
    hunts[key].isLive     = true;
    hunts[key].startedAt  = new Date().toISOString();
    hunts[key].updatedAt  = new Date().toISOString();
    hunts[key].archivedAt = null;
    persistHunts();
    emitHuntUpdate(key);
    res.json({ ok: true });
  });

  // Stop broadcasting without ending/archiving — host can go live again. (See /end for the lock path.)
  router.post('/api/affiliate-hunt/offline', requireMod, (req, res) => {
    const key = affiliateHuntKey(req.tenant.id);
    const h = hunts[key];
    if (h) {
      h.isLive = false;
      h.updatedAt = new Date().toISOString();
      persistHunts();
      emitHuntUpdate(key);
    }
    res.json({ ok: true });
  });

  router.post('/api/affiliate-hunt/end', requireMod, (req, res) => {
    const key = affiliateHuntKey(req.tenant.id);
    const h = hunts[key];
    if (h) {
      h.isLive = false;
      h.updatedAt = new Date().toISOString();
      if (!h.archivedAt) h.archivedAt = new Date().toISOString();
      archiveHunt(h); // log it to /history now (idempotent by huntId; no-op if 0 bonuses)
      persistHunts();
      emitHuntUpdate(key);
    }
    res.json({ ok: true });
  });

  router.post('/api/affiliate-hunt/reopen', requireMod, (req, res) => {
    const key = affiliateHuntKey(req.tenant.id);
    const h = hunts[key];
    if (!h) return res.status(404).json({ error: 'No affiliate hunt' });
    h.isLive = true;
    h.updatedAt = new Date().toISOString();
    h.archivedAt = null;
    if (!h.startedAt) h.startedAt = new Date().toISOString();
    unarchiveHunt(h); // live again → must not also sit in /history
    persistHunts();
    emitHuntUpdate(key);
    res.json({ ok: true });
  });

  // Reopen a specific past affiliate hunt from history (see the mod-hunt twin above for the shape).
  router.post('/api/affiliate-hunt/reopen-archived', requireMod, (req, res) => {
    const key = affiliateHuntKey(req.tenant.id);
    const huntId = req.body && req.body.huntId;
    if (!huntId) return res.status(400).json({ error: 'huntId required' });
    const snap = archive.find(h => h && h.user?.id === key && h.huntId === huntId);
    if (!snap) return res.status(404).json({ error: 'Archived hunt not found' });

    const cur = hunts[key];
    if (cur && Array.isArray(cur.bonuses) && cur.bonuses.length > 0) {
      if (!cur.archivedAt) cur.archivedAt = new Date().toISOString();
      archiveHunt(cur);
    }
    unarchiveHunt(snap);
    hunts[key] = { ...snap, isLive: true, archivedAt: null, updatedAt: new Date().toISOString() };
    persistHunts();
    emitHuntUpdate(key);
    auditLog.recordFromReq(req, {
      category: 'hunt', action: 'hunt.reopen_archived', targetId: key,
      summary: `${(req.user && req.user.displayName) || 'a mod'} reopened ${AFFILIATE_HUNT_LABEL} "${snap.title || snap.huntId}"`,
      detail: { huntId: snap.huntId, title: snap.title || null },
    });
    res.json({ ok: true });
  });

  router.post('/api/affiliate-hunt/reset', requireMod, (req, res) => {
    const key = affiliateHuntKey(req.tenant.id);
    const old = hunts[key];
    if (old && Array.isArray(old.bonuses) && old.bonuses.length > 0) {
      if (!old.archivedAt) old.archivedAt = new Date().toISOString();
      archiveHunt(old);
    }
    auditLog.recordFromReq(req, {
      category: 'hunt', action: 'hunt.reset', targetId: key,
      summary: `${(req.user && req.user.displayName) || 'a mod'} reset ${AFFILIATE_HUNT_LABEL}`,
      detail: old ? { before: { bonuses: old.bonuses || [], equity: old.equity || [], calls: old.calls || [] } } : null,
    });
    hunts[key] = emptyAffiliateHunt(req.tenant.id, req.body && req.body.title);
    persistHunts();
    emitHuntUpdate(key);
    res.json({ ok: true });
  });

  router.get('/api/affiliate-hunt/history', requireMod, (req, res) => {
    const key = affiliateHuntKey(req.tenant.id);
    const affArchived = archive.filter(h => h.user?.id === key);
    res.json(affArchived.map(h => ({
      huntId: h.huntId,
      title: h.title || null,
      archivedAt: h.archivedAt,
      bonuses: h.bonuses || [],
      equity: h.equity || [],
      huntMode: h.huntMode,
      lockTop4: h.lockTop4 ?? false,
      startedAt: h.startedAt,
      createdAt: h.createdAt,
      totalWon: (h.bonuses || []).reduce((s, b) => s + (b.win || 0), 0),
      totalBet: (h.bonuses || []).reduce((s, b) => s + (b.bet || 0), 0),
      bonusCount: (h.bonuses || []).length,
    })));
  });

  // ── VIP hunt — VIP-style hunt run jointly by a community's Mods ──

  router.get('/api/vip-hunt', vipBoard, (req, res) => {
    const key = vipHuntKey(req.tenant.id);
    res.json(hunts[key] || null);
  });

  router.put('/api/vip-hunt', vipBoard, (req, res) => {
    if (rejectBadHuntInput(req, res)) return;
    const key = vipHuntKey(req.tenant.id);
    // Snapshot BEFORE any mutation — shared hunt, many mod editors (see the mod-hunt PUT above).
    const _h = hunts[key];
    const _before = _h
      ? { bonuses: [...(_h.bonuses || [])], equity: [...(_h.equity || [])], calls: [...(_h.calls || [])], vault: [...(_h.vault || [])] }
      : { bonuses: [], equity: [], calls: [], vault: [] };
    const _wasNew = !hunts[key];
    if (!hunts[key]) hunts[key] = emptyVipHunt(req.tenant.id);
    stampRunner(hunts[key], req, _wasNew);
    const { bonuses, equity, gifts, chases, payouts, vault, calls, callLimit, huntMode, roundRobin, lockTop4, currency, currentSlot, manualOrder, title } = req.body;
    // See routes/hunts.routes.js — masked client copies must not clear known identities.
    if (bonuses    !== undefined) hunts[key].bonuses    = preserveRowIdentity(_before.bonuses, sanitizeBonusReplayUrls(bonuses), 'callerId');
    if (equity     !== undefined) hunts[key].equity     = preserveRowIdentity(_before.equity, equity, 'discordId');
    if (gifts      !== undefined) hunts[key].gifts      = gifts;
    if (payouts    !== undefined) hunts[key].payouts    = sanitizePayouts(payouts);
    if (chases     !== undefined) hunts[key].chases     = sanitizeChases(chases);
    if (vault      !== undefined) hunts[key].vault      = vault;
    if (calls      !== undefined) hunts[key].calls      = stampNewCalls(_before.calls, preserveRowIdentity(_before.calls, calls, 'callerId'));
    if (callLimit  !== undefined) hunts[key].callLimit  = callLimit;
    if (huntMode   !== undefined) hunts[key].huntMode   = huntMode;
    if (roundRobin !== undefined) hunts[key].roundRobin = roundRobin;
    if (lockTop4   !== undefined) hunts[key].lockTop4   = lockTop4;
    if (currency   !== undefined) hunts[key].currency   = currency;
    if (currentSlot !== undefined) hunts[key].currentSlot = currentSlot;
    if (manualOrder !== undefined) hunts[key].manualOrder = manualOrder;
    if (title      !== undefined) hunts[key].title      = sanitizeTitle(title);
    hunts[key].huntType = 'vip';
    touch(key);
    persistHunts();
    emitHuntUpdate(key);
    auditLog.recordHuntChange(req, _before,
      { bonuses: hunts[key].bonuses, equity: hunts[key].equity, calls: hunts[key].calls, vault: hunts[key].vault },
      { targetId: key, huntLabel: VIP_HUNT_LABEL });
    res.json({ ok: true });
  });

  router.post('/api/vip-hunt/golive', requireMod, (req, res) => {
    const key = vipHuntKey(req.tenant.id);
    const _wasNew = !hunts[key];
    if (!hunts[key]) hunts[key] = emptyVipHunt(req.tenant.id);
    stampRunner(hunts[key], req, _wasNew);
    hunts[key].isLive     = true;
    hunts[key].startedAt  = new Date().toISOString();
    hunts[key].updatedAt  = new Date().toISOString();
    hunts[key].archivedAt = null;
    persistHunts();
    emitHuntUpdate(key);
    res.json({ ok: true });
  });

  // Stop broadcasting without ending/archiving — host can go live again. (See /end for the lock path.)
  router.post('/api/vip-hunt/offline', requireMod, (req, res) => {
    const key = vipHuntKey(req.tenant.id);
    const h = hunts[key];
    if (h) {
      h.isLive = false;
      h.updatedAt = new Date().toISOString();
      persistHunts();
      emitHuntUpdate(key);
    }
    res.json({ ok: true });
  });

  router.post('/api/vip-hunt/end', requireMod, (req, res) => {
    const key = vipHuntKey(req.tenant.id);
    const h = hunts[key];
    if (h) {
      h.isLive = false;
      h.updatedAt = new Date().toISOString();
      if (!h.archivedAt) h.archivedAt = new Date().toISOString();
      archiveHunt(h); // log it to /history now (idempotent by huntId; no-op if 0 bonuses)
      persistHunts();
      emitHuntUpdate(key);
    }
    res.json({ ok: true });
  });

  router.post('/api/vip-hunt/reopen', requireMod, (req, res) => {
    const key = vipHuntKey(req.tenant.id);
    const h = hunts[key];
    if (!h) return res.status(404).json({ error: 'No vip hunt' });
    h.isLive = true;
    h.updatedAt = new Date().toISOString();
    h.archivedAt = null;
    if (!h.startedAt) h.startedAt = new Date().toISOString();
    unarchiveHunt(h); // live again → must not also sit in /history
    persistHunts();
    emitHuntUpdate(key);
    res.json({ ok: true });
  });

  // Reopen a specific past vip hunt from history (see the mod-hunt twin above for the shape).
  router.post('/api/vip-hunt/reopen-archived', requireMod, (req, res) => {
    const key = vipHuntKey(req.tenant.id);
    const huntId = req.body && req.body.huntId;
    if (!huntId) return res.status(400).json({ error: 'huntId required' });
    const snap = archive.find(h => h && h.user?.id === key && h.huntId === huntId);
    if (!snap) return res.status(404).json({ error: 'Archived hunt not found' });

    const cur = hunts[key];
    if (cur && Array.isArray(cur.bonuses) && cur.bonuses.length > 0) {
      if (!cur.archivedAt) cur.archivedAt = new Date().toISOString();
      archiveHunt(cur);
    }
    unarchiveHunt(snap);
    hunts[key] = { ...snap, isLive: true, archivedAt: null, updatedAt: new Date().toISOString() };
    persistHunts();
    emitHuntUpdate(key);
    auditLog.recordFromReq(req, {
      category: 'hunt', action: 'hunt.reopen_archived', targetId: key,
      summary: `${(req.user && req.user.displayName) || 'a mod'} reopened ${VIP_HUNT_LABEL} "${snap.title || snap.huntId}"`,
      detail: { huntId: snap.huntId, title: snap.title || null },
    });
    res.json({ ok: true });
  });

  router.post('/api/vip-hunt/reset', requireMod, (req, res) => {
    const key = vipHuntKey(req.tenant.id);
    const old = hunts[key];
    if (old && Array.isArray(old.bonuses) && old.bonuses.length > 0) {
      if (!old.archivedAt) old.archivedAt = new Date().toISOString();
      archiveHunt(old);
    }
    auditLog.recordFromReq(req, {
      category: 'hunt', action: 'hunt.reset', targetId: key,
      summary: `${(req.user && req.user.displayName) || 'a mod'} reset ${VIP_HUNT_LABEL}`,
      detail: old ? { before: { bonuses: old.bonuses || [], equity: old.equity || [], calls: old.calls || [] } } : null,
    });
    hunts[key] = emptyVipHunt(req.tenant.id, req.body && req.body.title);
    persistHunts();
    emitHuntUpdate(key);
    res.json({ ok: true });
  });

  router.get('/api/vip-hunt/history', requireMod, (req, res) => {
    const key = vipHuntKey(req.tenant.id);
    const vipArchived = archive.filter(h => h.user?.id === key);
    res.json(vipArchived.map(h => ({
      huntId: h.huntId,
      title: h.title || null,
      archivedAt: h.archivedAt,
      bonuses: h.bonuses || [],
      equity: h.equity || [],
      huntMode: h.huntMode,
      lockTop4: h.lockTop4 ?? false,
      startedAt: h.startedAt,
      createdAt: h.createdAt,
      totalWon: (h.bonuses || []).reduce((s, b) => s + (b.win || 0), 0),
      totalBet: (h.bonuses || []).reduce((s, b) => s + (b.bet || 0), 0),
      bonusCount: (h.bonuses || []).length,
    })));
  });

  // ── Board editors: co-edit on the affiliate + VIP hunts ────────────
  // These two hunts are owned by the COMMUNITY, not a Discord id, so canEditHunt has nothing to
  // resolve against and every route here was requireMod — "the mod crew, or nobody". A mod can
  // now invite a named helper to co-run one hunt without granting them the mod role.
  //
  // The split: GET / PUT / activity / undo / restore take the board gate above; delete, reset,
  // end, reopen, reopen-archived, golive, offline, history and overlay-config stay requireMod,
  // as do these two routes — an invited editor must not be able to invite anyone else.
  //
  // Editors are stored in `boardEditors`, deliberately NOT `invitedEditors`: canEditHunt reads
  // that field and gates the generic /api/hunts/:userId/* family, which would have handed a
  // board-only helper an unsanitised whole-hunt write plus invite/uninvite and share tokens.
  //
  // The list lives ON the hunt, so /reset clearing the slot clears it too — invites last for one
  // hunt by design. An empty slot therefore has nothing to attach an editor to, hence the 404.
  const editorsRoute = (keyFor, label) => (req, res) => {
    const key = keyFor(req.tenant.id);
    const hunt = hunts[key];
    if (!hunt) return res.status(404).json({ error: 'No hunt' });
    // Body on POST, query string on DELETE — fetch/XHR DELETEs routinely carry no body.
    const raw = req.method === 'DELETE'
      ? (req.query.id ?? (req.body && req.body.id))
      : (req.body && (req.body.userId ?? req.body.id));
    const id = raw == null ? '' : String(raw).trim();
    if (!id) return res.status(400).json({ error: 'Missing user id' });

    const before = (hunt.boardEditors || []).map(String);
    // Store as strings: a Discord snowflake exceeds JS's safe integer range, so a numeric id
    // would silently lose precision and never match its owner again.
    hunt.boardEditors = req.method === 'DELETE'
      ? before.filter(e => e !== id)
      : (before.includes(id) ? before : [...before, id]);   // idempotent — re-inviting is a no-op

    if (hunt.boardEditors.length !== before.length) {
      touch(key);
      persistHunts();
      // Tell open tabs: a revoked editor's board should stop being editable without a reload.
      emitHuntUpdate(key);
      auditLog.recordFromReq(req, {
        category: 'hunt',
        action: req.method === 'DELETE' ? 'hunt.editor.remove' : 'hunt.editor.add',
        targetId: key,
        summary: `${(req.user && req.user.displayName) || 'a mod'} ${req.method === 'DELETE' ? 'removed' : 'added'} a co-editor on ${label}`,
        detail: { editorId: id },
      });
    }
    res.json({ ok: true, boardEditors: hunt.boardEditors });
  };
  router.post('/api/affiliate-hunt/editors', requireMod, editorsRoute(affiliateHuntKey, AFFILIATE_HUNT_LABEL));
  router.delete('/api/affiliate-hunt/editors', requireMod, editorsRoute(affiliateHuntKey, AFFILIATE_HUNT_LABEL));
  router.post('/api/vip-hunt/editors', requireMod, editorsRoute(vipHuntKey, VIP_HUNT_LABEL));
  router.delete('/api/vip-hunt/editors', requireMod, editorsRoute(vipHuntKey, VIP_HUNT_LABEL));

  return router;
};
