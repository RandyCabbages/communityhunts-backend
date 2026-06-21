const express = require('express');

// Share-link routes: mint an opaque token for a hunt, and resolve a token to a
// public, read-only overview. The token lives on the hunt object, so archiveHunt
// (which stores a full copy) carries it into history automatically — a token keeps
// resolving after the hunt ends (frozen), via the archive fallback below.
module.exports = (deps) => {
  const { requireAuth, canEditHunt, hunts, archive, publicHuntView, uid, persistHunts } = deps;
  const router = express.Router();

  // Mint (or return existing) a share token for the caller's own hunt. Editor-gated.
  router.post('/api/hunts/:userId/share-token', requireAuth, (req, res) => {
    const { userId } = req.params;
    if (!canEditHunt(req, userId)) return res.status(403).json({ error: 'Forbidden' });
    const hunt = hunts[userId];
    if (!hunt) return res.status(404).json({ error: 'No hunt' });
    if (!hunt.shareToken) {
      hunt.shareToken = uid();
      persistHunts();
    }
    res.json({ token: hunt.shareToken });
  });

  // Public: resolve a token to a read-only overview. Live hunts come from `hunts`;
  // ended hunts from `archive` (frozen). No auth — anyone with the link can view.
  router.get('/api/share/:token', (req, res) => {
    const { token } = req.params;
    if (!token) return res.status(400).json({ error: 'Bad token' });
    let hunt = Object.values(hunts).find(h => h && h.shareToken === token);
    if (!hunt) hunt = archive.find(h => h && h.shareToken === token);
    if (!hunt) return res.status(404).json({ error: 'Not found' });
    res.json({ hunt: publicHuntView(hunt), frozen: !hunt.isLive, ownerId: hunt.user?.id || null });
  });

  return router;
};
