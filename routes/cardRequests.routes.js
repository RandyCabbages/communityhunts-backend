// Custom card commission requests ("Shop Requests").
//   POST   /api/card-requests            — any signed-in user submits an idea (rate-limited)
//   GET    /api/admin/card-requests      — platform admin: full list, newest first
//   PUT    /api/admin/card-requests/:id  — platform admin: status / adminNotes only
//   DELETE /api/admin/card-requests/:id  — platform admin
// On submit, a best-effort Discord embed goes to the business server (the doorbell);
// the request is already saved — a Discord failure never fails the request.

const express = require('express');

const MAX_OPEN_PER_USER = 2;

// Phase → title emoji + embed color. Colors mirror the frontend admin STATUS_META so the Discord
// message and the Shop Requests panel read the same. Unknown status falls back to 'new'.
const PHASE_META = {
  new:          { emoji: '🆕', color: 0xa78bfa },
  awaiting_tip: { emoji: '💰', color: 0xfbbf24 },
  in_progress:  { emoji: '🔨', color: 0x22d3ee },
  done:         { emoji: '✅', color: 0x4ade80 },
  declined:     { emoji: '❌', color: 0xff6b6b },
};

// Discord embed caps mirror routes/misc.routes.js: title ≤256, description ≤4096
// (3900 for margin), field value ≤1024. Rebuilt from the request each call, so an edit reflects
// current data + phase.
function buildRequestEmbed(r) {
  const phase = PHASE_META[r.status] || PHASE_META.new;
  const fields = [
    { name: 'From', value: `${r.displayName} (${r.userId})`.slice(0, 1024), inline: false },
  ];
  if (r.cardName) fields.push({ name: 'Card name', value: r.cardName.slice(0, 1024), inline: true });
  if (r.rainbetUsername) fields.push({ name: 'Rainbet', value: r.rainbetUsername.slice(0, 1024), inline: true });
  if (r.refLinks.length) fields.push({ name: 'References', value: r.refLinks.join('\n').slice(0, 1024), inline: false });
  return {
    title: `${phase.emoji} Custom Card Request`,
    description: r.idea.slice(0, 3900),
    color: phase.color,
    fields,
    timestamp: r.createdAt,
    footer: { text: 'CommunityHunts — Shop Requests' },
  };
}

module.exports = function cardRequestsRoutes(deps) {
  const { requireAuth, requirePlatformAdmin, cardRequests, envBotToken, channelId } = deps;
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
    // Token resolves per-request: tenant override, else the shared community bot.
    const botToken = (req.tenant && req.tenant.discordBotToken) || envBotToken;
    let discord = 'skipped';
    if (botToken && channelId) {
      try {
        const resp = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
          method: 'POST',
          headers: { Authorization: `Bot ${botToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ embeds: [buildRequestEmbed(r)] }),
        });
        if (!resp.ok) throw new Error(`Discord returned ${resp.status}`);
        // Store the message + channel ids so a later status change can PATCH this same message.
        const msg = await resp.json().catch(() => null);
        if (msg && msg.id) cardRequests.setDiscordMessage(r.id, { messageId: String(msg.id), channelId: String(channelId) });
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

  router.put('/api/admin/card-requests/:id', requireAuth, requirePlatformAdmin, async (req, res) => {
    const err = cardRequests.validateUpdate(req.body);
    if (err) return res.status(400).json({ error: err });
    const r = cardRequests.updateRequest(String(req.params.id), req.body);
    if (!r) return res.status(404).json({ error: 'Request not found' });
    res.json(r);

    // Best-effort: reflect the new phase (emoji + color) on the request's Discord message.
    // Fire after responding — the admin action never blocks on Discord. Skips silently when the
    // request has no stored message id (post failed/skipped, or it predates this feature).
    const botToken = (req.tenant && req.tenant.discordBotToken) || envBotToken;
    if (r.discordMessageId && r.discordChannelId && botToken) {
      try {
        const resp = await fetch(`https://discord.com/api/v10/channels/${r.discordChannelId}/messages/${r.discordMessageId}`, {
          method: 'PATCH',
          headers: { Authorization: `Bot ${botToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ embeds: [buildRequestEmbed(r)] }),
        });
        if (!resp.ok) throw new Error(`Discord returned ${resp.status}`);
        console.log(`[cardreq] request ${r.id} embed updated → ${r.status}`);
      } catch (e) {
        console.error('[cardreq] Discord embed update failed:', e.message);
      }
    }
  });

  router.delete('/api/admin/card-requests/:id', requireAuth, requirePlatformAdmin, (req, res) => {
    if (!cardRequests.deleteRequest(String(req.params.id))) return res.status(404).json({ error: 'Request not found' });
    res.json({ ok: true });
  });

  return router;
};
