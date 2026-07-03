// OverDrop routes — mod/admin remote control of the community's stream overlay.
// All mutations are requireMod-gated (per-tenant, resolves via req.tenant — see lib/auth.js);
// state + broadcasts live in lib/overdrop.js. The OBS source page consumes state read-only
// over the `overdrop:<slug>` socket room (joined via watch:overdrop in sockets/index.js).
//
//   GET    /api/overdrop            — current state (control panel initial load)
//   POST   /api/overdrop/items      — add an item (image/text/video)
//   PUT    /api/overdrop/items/:id  — partial update (drag/resize/rotate/edit)
//   DELETE /api/overdrop/items/:id  — remove one item
//   POST   /api/overdrop/clear      — panic: clear all items + audio
//   POST   /api/overdrop/audio      — play a sound/music URL
//   PUT    /api/overdrop/audio      — live-update volume/loop
//   DELETE /api/overdrop/audio      — stop audio
//   PUT    /api/overdrop/enabled    — master switch: OFF = stage only, ON = live on stream
//   POST   /api/overdrop/upload     — raw-body file upload (image/gif/video/audio, ≤30 MB)
//   GET    /api/overdrop/media/:name — serve an uploaded file (PUBLIC — OBS/source loads these)

const express = require('express');

module.exports = function overdropRoutes(deps) {
  const { requireMod, overdrop } = deps;
  const router = express.Router();
  const slugOf = (req) => req.tenant.slug;

  router.get('/api/overdrop', requireMod, (req, res) => {
    res.json(overdrop.getState(slugOf(req)));
  });

  router.post('/api/overdrop/items', requireMod, (req, res) => {
    const item = overdrop.addItem(slugOf(req), req.body || {});
    if (!item) return res.status(400).json({ error: 'Invalid URL or item limit reached' });
    res.json(item);
  });

  router.put('/api/overdrop/items/:id', requireMod, (req, res) => {
    const item = overdrop.updateItem(slugOf(req), String(req.params.id), req.body || {});
    if (!item) return res.status(404).json({ error: 'No such item' });
    res.json(item);
  });

  router.delete('/api/overdrop/items/:id', requireMod, (req, res) => {
    overdrop.removeItem(slugOf(req), String(req.params.id));
    res.json({ ok: true });
  });

  router.post('/api/overdrop/clear', requireMod, (req, res) => {
    overdrop.clearAll(slugOf(req));
    res.json({ ok: true });
  });

  router.post('/api/overdrop/audio', requireMod, (req, res) => {
    const audio = overdrop.playAudio(slugOf(req), req.body || {});
    if (!audio) return res.status(400).json({ error: 'Valid http(s) audio URL required' });
    res.json(audio);
  });

  router.put('/api/overdrop/audio', requireMod, (req, res) => {
    const audio = overdrop.updateAudio(slugOf(req), req.body || {});
    if (!audio) return res.status(404).json({ error: 'Nothing playing' });
    res.json(audio);
  });

  router.delete('/api/overdrop/audio', requireMod, (req, res) => {
    overdrop.stopAudio(slugOf(req));
    res.json({ ok: true });
  });

  router.put('/api/overdrop/enabled', requireMod, (req, res) => {
    res.json({ enabled: overdrop.setEnabled(slugOf(req), !!(req.body || {}).enabled) });
  });

  // Raw-body upload (no multipart dep): the browser POSTs the File directly, so the
  // Content-Type header IS the file's mime type. Type/size validation in saveUpload.
  router.post('/api/overdrop/upload', requireMod,
    express.raw({ type: () => true, limit: '30mb' }),
    (req, res) => {
      const mime = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
      const saved = overdrop.saveUpload(slugOf(req), mime, req.body);
      if (!saved) return res.status(400).json({ error: 'Unsupported file type or file too large (max 30 MB)' });
      res.json({ path: `/api/overdrop/media/${saved.name}`, kind: saved.kind });
    });

  // PUBLIC: <img>/<video>/<audio> tags on the OBS source page load these with no session.
  // mediaPath enforces a strict generated-name pattern (no traversal); sendFile handles
  // Content-Type by extension and Range requests for video scrubbing.
  router.get('/api/overdrop/media/:name', (req, res) => {
    const p = overdrop.mediaPath(String(req.params.name));
    if (!p) return res.status(404).end();
    res.set('Cache-Control', 'public, max-age=86400, immutable');
    res.sendFile(p);
  });

  return router;
};
