const express = require('express');

// Share-link routes: a STABLE, per-streamer token resolves to that streamer's current
// (or most recent) hunt as a public, read-only overview. The token lives in an owner-keyed
// map (shareTokens), NOT on the hunt object, so it survives reset/start/end — the link is a
// durable handle for "this streamer's hunt" rather than one ephemeral hunt instance.
module.exports = (deps) => {
  const { requireAuth, canEditHunt, isEquityMember, hunts, archive, publicHuntView,
          shareTokens, shareLinks, equippedCardsFor, tenantForHunt } = deps;
  const router = express.Router();

  // Mint (or return the existing) stable share token for the caller's own hunt. Editor-gated.
  router.post('/api/hunts/:userId/share-token', requireAuth, (req, res) => {
    const { userId } = req.params;
    if (!canEditHunt(req, userId)) return res.status(403).json({ error: 'Forbidden' });

    // Minting lives in lib/shareLinks.js — the public API's shared-hunt open needs the same token.
    res.json({ token: shareLinks.ensureShareToken(userId) });
  });

  // Public: resolve a token to a read-only overview. No auth — anyone with the link can view.
  // Rule: owner's ACTIVE hunt (not yet ended) if one exists — even pre-live/empty, so the link
  // tracks the current hunt through setup; else their most recent ended hunt; else 404.
  // `frozen` means ENDED (archivedAt set), NOT merely "not live" — a hunt in setup is not frozen,
  // so the share page shows live stats + the suggestion box during setup, not a "FINAL RESULTS" view.
  router.get('/api/share/:token', async (req, res) => {
    const { token } = req.params;
    if (!token) return res.status(400).json({ error: 'Bad token' });

    let hunt = null;
    const ownerKey = shareTokens[token];
    if (ownerKey) {
      const cur = hunts[ownerKey];
      if (cur && !cur.archivedAt) {
        hunt = cur; // owner's active / in-setup hunt (even if empty or pre-live)
      } else {
        hunt = archive
          .filter(h => h && h.user?.id === ownerKey)
          .sort((a, b) => new Date(b.archivedAt || 0) - new Date(a.archivedAt || 0))[0]
          || cur || null; // most recent ended hunt, else the ended shell
      }
    }
    // Legacy fallback: tokens minted before the map existed lived on the hunt object.
    if (!hunt) hunt = Object.values(hunts).find(h => h && h.shareToken === token) || null;
    if (!hunt) hunt = archive.find(h => h && h.shareToken === token) || null;

    if (!hunt) return res.status(404).json({ error: 'Not found' });
    // Per-viewer submit right, computed from the SAME rule POST /api/hunts/:userId/calls enforces
    // (canEdit OR equity member) — identical to GET /api/hunts/:userId (routes/hunts.routes.js).
    // The share page can't infer this: publicHuntView strips equity discordIds and
    // callsPermissions, so a client-side check falls back to a spoofable name match. req.user is
    // present here for a logged-in viewer (bearerFallback runs globally); anonymous → false.
    const ownerId = hunt.user?.id || null;
    const canAddCalls = req.user && ownerId
      ? (canEditHunt(req, ownerId) || isEquityMember(req.user, ownerId))
      : false;

    // Each member's equipped cosmetic card, so the public page can render the real equity cards
    // (the tracker's own source, /api/settings/:userId, is requireAuth). Resolved off the RAW hunt
    // — the ids it needs are exactly what publicHuntView strips — then attached to the masked
    // rows. Anonymous members are excluded inside equippedCardsFor and stay excluded here: a card
    // is a name badge. Cosmetic, so a failure degrades to no cards rather than a broken page.
    let cards = {};
    if (equippedCardsFor) {
      try {
        cards = await equippedCardsFor(hunt, tenantForHunt ? tenantForHunt(hunt) : null) || {};
      } catch (e) { console.error('[share] equipped cards lookup failed -', e && e.message); }
    }
    const pv = publicHuntView(hunt);
    const equity = Array.isArray(pv.equity)
      ? pv.equity.map(e => (e && !e.anonymous) ? { ...e, cosmeticCard: cards[e.id] || null } : e)
      : pv.equity;

    res.json({ hunt: { ...pv, equity, canAddCalls }, frozen: !!hunt.archivedAt, ownerId });
  });

  return router;
};
