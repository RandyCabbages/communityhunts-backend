const express = require('express');

// Share-link routes: a STABLE, per-streamer token resolves to that streamer's current
// (or most recent) hunt as a public, read-only overview. The token lives in an owner-keyed
// map (shareTokens), NOT on the hunt object, so it survives reset/start/end — the link is a
// durable handle for "this streamer's hunt" rather than one ephemeral hunt instance.
module.exports = (deps) => {
  const { requireAuth, canEditHunt, hunts, archive, publicHuntView, uid,
          shareTokens, tokenForOwner, persistShareTokens } = deps;
  const router = express.Router();

  // Mint (or return the existing) stable share token for the caller's own hunt. Editor-gated.
  router.post('/api/hunts/:userId/share-token', requireAuth, (req, res) => {
    const { userId } = req.params;
    if (!canEditHunt(req, userId)) return res.status(403).json({ error: 'Forbidden' });

    let token = tokenForOwner(userId);          // 1) reuse a stable token if one exists
    if (!token) {
      const hunt = hunts[userId];
      token = (hunt && hunt.shareToken) || uid(); // 2) adopt a legacy per-hunt token, else mint fresh
      shareTokens[token] = userId;
      persistShareTokens();
    }
    res.json({ token });
  });

  // Public: resolve a token to a read-only overview. No auth — anyone with the link can view.
  // Rule: owner's ACTIVE hunt (not yet ended) if one exists — even pre-live/empty, so the link
  // tracks the current hunt through setup; else their most recent ended hunt; else 404.
  // `frozen` means ENDED (archivedAt set), NOT merely "not live" — a hunt in setup is not frozen,
  // so the share page shows live stats + the suggestion box during setup, not a "FINAL RESULTS" view.
  router.get('/api/share/:token', (req, res) => {
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
    res.json({ hunt: publicHuntView(hunt), frozen: !!hunt.archivedAt, ownerId: hunt.user?.id || null });
  });

  return router;
};
