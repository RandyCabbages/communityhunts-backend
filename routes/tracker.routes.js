// Standalone tracker routes — persistent solo hunt for paying users outside any community.
// Mirrors the /api/my-hunt pattern but scoped to /api/tracker/* with no tenant context.
// Hunts stored in the same hunts singleton with a 'tracker:' prefixed key.

const express = require('express');
const { sanitizeBonusReplayUrls } = require('../lib/hunts-core');
const { sanitizePayouts } = require('../lib/payouts');

module.exports = function trackerRoutes(deps) {
  const {
    requireAuth, subscriptions,
    hunts, persistHunts, rejectBadHuntInput,
    uid,
  } = deps;
  function touch(h) { h.updatedAt = new Date().toISOString(); }
  const router = express.Router();

  function trackerKey(userId) { return `tracker:${userId}`; }

  function requireSubscription(req, res, next) {
    subscriptions.getSubscription(req.user.id).then(sub => {
      if (!sub || sub.tier === 'free') {
        return res.status(403).json({ error: 'Active subscription required' });
      }
      if (sub.expiresAt && new Date(sub.expiresAt) < new Date()) {
        return res.status(403).json({ error: 'Subscription expired' });
      }
      req.subscription = sub;
      next();
    }).catch(e => res.status(500).json({ error: e.message }));
  }

  router.get('/api/tracker/my-hunt', requireAuth, requireSubscription, (req, res) => {
    const hunt = hunts[trackerKey(req.user.id)];
    if (!hunt) return res.json(null);
    res.json(hunt);
  });

  router.post('/api/tracker/start', requireAuth, requireSubscription, (req, res) => {
    const key = trackerKey(req.user.id);
    if (hunts[key] && hunts[key].huntType) {
      return res.status(409).json({ error: 'Hunt already exists — end or delete it first' });
    }
    const huntType = 'solo';
    hunts[key] = {
      user: { id: req.user.id, username: req.user.username, displayName: req.user.displayName, avatar: req.user.avatar },
      huntId: uid(),
      isLive: true,
      startedAt: new Date().toISOString(),
      huntType,
      bonuses: [],
      calls: [],
      invitedEditors: [],
      equity: [{ id: 'creator_auto', name: req.user.displayName || '', amount: 0, isRollWinner: false }],
      callLimit: 0,
      roundRobin: false,
      currency: req.body.currency || 'USD',
      huntMode: 'creating',
      tenantId: '_tracker',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    persistHunts();
    res.json(hunts[key]);
  });

  router.put('/api/tracker/my-hunt', requireAuth, requireSubscription, (req, res) => {
    if (rejectBadHuntInput(req, res)) return;
    const key = trackerKey(req.user.id);
    const hunt = hunts[key];
    if (!hunt) return res.status(404).json({ error: 'No active hunt' });

    const allowed = ['bonuses', 'equity', 'gifts', 'payouts', 'vault', 'calls', 'callLimit', 'huntMode', 'lockTop4',
      'roundRobin', 'currentSlot', 'manualOrder', 'huntType', 'currency'];
    for (const f of allowed) {
      if (req.body[f] === undefined) continue;
      let v = req.body[f];
      if (f === 'bonuses') v = sanitizeBonusReplayUrls(v);
      else if (f === 'payouts') v = sanitizePayouts(v);
      hunt[f] = v;
    }
    touch(hunt);
    persistHunts();
    res.json({ ok: true });
  });

  router.post('/api/tracker/my-hunt/end', requireAuth, (req, res) => {
    const key = trackerKey(req.user.id);
    const hunt = hunts[key];
    if (!hunt) return res.status(404).json({ error: 'No active hunt' });
    hunt.isLive = false;
    hunt.archivedAt = new Date().toISOString();
    touch(hunt);
    persistHunts();
    res.json({ ok: true });
  });

  router.delete('/api/tracker/my-hunt', requireAuth, (req, res) => {
    const key = trackerKey(req.user.id);
    if (!hunts[key]) return res.status(404).json({ error: 'No active hunt' });
    delete hunts[key];
    persistHunts();
    res.json({ ok: true });
  });

  return router;
};
