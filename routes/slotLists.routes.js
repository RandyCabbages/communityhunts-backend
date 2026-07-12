// Global curated slot lists. Public read; owner-only writes.
//   GET    /api/slot-lists      — public, newest-first (≤50)
//   POST   /api/slot-lists      — platform admin only
//   PUT    /api/slot-lists/:id  — platform admin only
//   DELETE /api/slot-lists/:id  — platform admin only

const express = require('express');

module.exports = function slotListsRoutes(deps) {
  const { requireAuth, requirePlatformAdmin, slotLists } = deps;
  const router = express.Router();

  router.get('/api/slot-lists', (req, res) => {
    res.json(slotLists.listSlotLists());
  });

  router.post('/api/slot-lists', requireAuth, requirePlatformAdmin, (req, res) => {
    const err = slotLists.validateInput(req.body);
    if (err) return res.status(400).json({ error: err });
    const l = slotLists.createSlotList(req.body, req.user.id);
    res.json(l);
  });

  router.put('/api/slot-lists/:id', requireAuth, requirePlatformAdmin, (req, res) => {
    const err = slotLists.validateInput(req.body);
    if (err) return res.status(400).json({ error: err });
    const l = slotLists.updateSlotList(String(req.params.id), req.body);
    if (!l) return res.status(404).json({ error: 'Slot list not found' });
    res.json(l);
  });

  router.delete('/api/slot-lists/:id', requireAuth, requirePlatformAdmin, (req, res) => {
    if (!slotLists.deleteSlotList(String(req.params.id))) {
      return res.status(404).json({ error: 'Slot list not found' });
    }
    res.json({ ok: true });
  });

  return router;
};
