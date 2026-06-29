// Slot autocomplete + image proxy routes. Thin router over lib/slots.js.
// Mounted from the server.js composition root.
//   GET /api/img-proxy      → CORS-safe image proxy (allowlisted hosts, 24h cache)
//   GET /api/slots/search   → slot autocomplete from the Rainbet list
//   GET /api/slots/popular  → slot popularity (top calls / got-in / providers) for random fill

const express = require('express');

module.exports = function slotsRoutes(deps) {
  const { slots, getSlotCallCounts } = deps;
  const router = express.Router();

  router.get('/api/img-proxy', slots.imgProxyHandler);
  router.get('/api/slots/search', slots.slotsSearchHandler);
  router.get('/api/slots/popular', slots.makePopularHandler(getSlotCallCounts));

  return router;
};
