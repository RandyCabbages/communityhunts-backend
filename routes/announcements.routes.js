// Platform-wide announcements ("patch notes"). Public read; owner-only writes.
//   GET    /api/announcements      — public, newest-first (≤20)
//   POST   /api/announcements      — platform admin only
//   PUT    /api/announcements/:id  — platform admin only
//   DELETE /api/announcements/:id  — platform admin only

const express = require('express');

module.exports = function announcementsRoutes(deps) {
  const { requireAuth, requirePlatformAdmin, announcements } = deps;
  const router = express.Router();

  router.get('/api/announcements', (req, res) => {
    res.json(announcements.listAnnouncements());
  });

  router.post('/api/announcements', requireAuth, requirePlatformAdmin, (req, res) => {
    const err = announcements.validateInput(req.body);
    if (err) return res.status(400).json({ error: err });
    res.json(announcements.createAnnouncement(req.body, req.user.id));
  });

  router.put('/api/announcements/:id', requireAuth, requirePlatformAdmin, (req, res) => {
    const err = announcements.validateInput(req.body);
    if (err) return res.status(400).json({ error: err });
    const a = announcements.updateAnnouncement(String(req.params.id), req.body);
    if (!a) return res.status(404).json({ error: 'Announcement not found' });
    res.json(a);
  });

  router.delete('/api/announcements/:id', requireAuth, requirePlatformAdmin, (req, res) => {
    if (!announcements.deleteAnnouncement(String(req.params.id))) {
      return res.status(404).json({ error: 'Announcement not found' });
    }
    res.json({ ok: true });
  });

  return router;
};
