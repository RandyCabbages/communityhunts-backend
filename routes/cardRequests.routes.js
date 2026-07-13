// Custom card commission requests ("Shop Requests").
//   POST   /api/card-requests            — any signed-in user submits an idea (rate-limited)
//   GET    /api/admin/card-requests      — platform admin: full list, newest first
//   PUT    /api/admin/card-requests/:id  — platform admin: status / adminNotes only
//   DELETE /api/admin/card-requests/:id  — platform admin
// On submit, a best-effort Discord embed goes to the business server (the doorbell);
// the request is already saved — a Discord failure never fails the request.

const express = require('express');

const MAX_OPEN_PER_USER = 2;
const EMBED_COLOR = 0xa78bfa; // community accent (violet)

// Discord embed caps mirror routes/misc.routes.js: title ≤256, description ≤4096
// (3900 for margin), field value ≤1024.
function buildRequestEmbed(r) {
  const fields = [
    { name: 'From', value: `${r.displayName} (${r.userId})`.slice(0, 1024), inline: false },
  ];
  if (r.cardName) fields.push({ name: 'Card name', value: r.cardName.slice(0, 1024), inline: true });
  if (r.rainbetUsername) fields.push({ name: 'Rainbet', value: r.rainbetUsername.slice(0, 1024), inline: true });
  if (r.refLinks.length) fields.push({ name: 'References', value: r.refLinks.join('\n').slice(0, 1024), inline: false });
  return {
    title: '🎨 Custom Card Request',
    description: r.idea.slice(0, 3900),
    color: EMBED_COLOR,
    fields,
    timestamp: r.createdAt,
    footer: { text: 'CommunityHunts — Shop Requests' },
  };
}

module.exports = function cardRequestsRoutes(deps) {
  const { requireAuth, requirePlatformAdmin, cardRequests, ticketsBotToken, channelId } = deps;
  const router = express.Router();
  const ipHits = new Map(); // per-IP submit timestamps (same throttle pattern as /api/tickets)

  router.post('/api/card-requests', requireAuth, async (req, res) => {
    // Per-IP throttle: 5 submits per 10 minutes.
    const ip = req.ip || 'unknown';
    const now = Date.now();
    const recent = (ipHits.get(ip) || []).filter(t => now - t < 10 * 60 * 1000);
    if (recent.length >= 5) return res.status(429).json({ error: 'Too many requests — please try again in a few minutes' });

    // Per-user cap on open requests (new / awaiting_tip / in_progress).
    if (cardRequests.openCountFor(req.user.id) >= MAX_OPEN_PER_USER)
      return res.status(429).json({ error: "You already have open card requests — we'll DM you about those first" });

    const err = cardRequests.validateInput(req.body);
    if (err) return res.status(400).json({ error: err });

    recent.push(now);
    ipHits.set(ip, recent);
    const r = cardRequests.createRequest(req.body, req.user);

    // Best-effort Discord doorbell (announcements pattern: saved first, failure only logged).
    let discord = 'skipped';
    if (ticketsBotToken && channelId) {
      try {
        const resp = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
          method: 'POST',
          headers: { Authorization: `Bot ${ticketsBotToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ embeds: [buildRequestEmbed(r)] }),
        });
        if (!resp.ok) throw new Error(`Discord returned ${resp.status}`);
        discord = 'posted';
        console.log(`[cardreq] request ${r.id} posted to Discord`);
      } catch (e) {
        discord = 'failed';
        console.error('[cardreq] Discord notify failed:', e.message);
      }
    }
    res.json({ ok: true, discord });
  });

  router.get('/api/admin/card-requests', requireAuth, requirePlatformAdmin, (req, res) => {
    res.json({ requests: cardRequests.listRequests() });
  });

  router.put('/api/admin/card-requests/:id', requireAuth, requirePlatformAdmin, (req, res) => {
    const err = cardRequests.validateUpdate(req.body);
    if (err) return res.status(400).json({ error: err });
    const r = cardRequests.updateRequest(String(req.params.id), req.body);
    if (!r) return res.status(404).json({ error: 'Request not found' });
    res.json(r);
  });

  router.delete('/api/admin/card-requests/:id', requireAuth, requirePlatformAdmin, (req, res) => {
    if (!cardRequests.deleteRequest(String(req.params.id))) return res.status(404).json({ error: 'Request not found' });
    res.json({ ok: true });
  });

  return router;
};
