// Bug-ticket / feature-suggestion triage ("Tickets" in the admin hub).
//   GET    /api/admin/tickets      — platform admin: full list, newest first
//   PUT    /api/admin/tickets/:id  — platform admin: status / adminNotes only
//   DELETE /api/admin/tickets/:id  — platform admin
// On a status change, best-effort PATCH the ticket's Discord message so the phase (emoji + color)
// stays in sync — same machinery as routes/cardRequests.routes.js. Tickets are PLATFORM-level:
// the embed is posted/edited with the platform bot (getPlatformBotToken), NEVER req.tenant.

const express = require('express');

// Phase → title emoji + embed color. Mirrors the frontend admin STATUS_META so the Discord
// message and the Tickets panel read the same. Unknown status falls back to 'new'.
const PHASE_META = {
  new:         { emoji: '🆕', color: 0xa78bfa },
  in_progress: { emoji: '🔨', color: 0x22d3ee },
  resolved:    { emoji: '✅', color: 0x4ade80 },
  closed:      { emoji: '🚫', color: 0xff6b6b },
};

// Feature Requests read as suggestions (💡); bugs / everything else as tickets (🎫).
function typeIcon(type) { return type === 'Feature Request' ? '💡' : '🎫'; }

// Discord embed caps mirror routes/misc.routes.js: title ≤256, description ≤4096 (3900 for
// margin), field value ≤1024. Rebuilt from the ticket each call, so an edit reflects current
// data + phase.
function buildTicketEmbed(t) {
  const phase = PHASE_META[t.status] || PHASE_META.new;
  const from = t.userId ? `${t.displayName || t.username} (${t.userId})` : (t.username || 'Anonymous');
  return {
    title: `${phase.emoji} ${typeIcon(t.type)} ${t.type || 'Ticket'}`.slice(0, 256),
    description: String(t.issue || '(no message)').slice(0, 3900),
    color: phase.color,
    fields: [{ name: 'From', value: String(from).slice(0, 1024), inline: false }],
    timestamp: t.createdAt,
    footer: { text: 'CommunityHunts — Tickets' },
  };
}

module.exports = function adminTicketsRoutes(deps) {
  const { requireAuth, requirePlatformAdmin, tickets, getPlatformBotToken, auditLog } = deps;
  const router = express.Router();

  router.get('/api/admin/tickets', requireAuth, requirePlatformAdmin, (req, res) => {
    res.json({ tickets: tickets.listTickets() });
  });

  router.put('/api/admin/tickets/:id', requireAuth, requirePlatformAdmin, async (req, res) => {
    const err = tickets.validateUpdate(req.body);
    if (err) return res.status(400).json({ error: err });
    const t = tickets.updateTicket(String(req.params.id), req.body);
    if (!t) return res.status(404).json({ error: 'Ticket not found' });
    auditLog.recordFromReq(req, { category: 'admin', action: 'ticket.triage', targetId: String(req.params.id),
      summary: `${req.user.displayName || 'admin'} set ticket ${req.params.id} → ${t.status}` });
    res.json(t);

    // Best-effort: reflect the new phase (emoji + color) on the ticket's Discord message.
    // Fire after responding — the admin action never blocks on Discord. Skips silently when the
    // ticket has no stored message id (post failed/skipped, or it predates this feature).
    const botToken = getPlatformBotToken();
    if (t.discordMessageId && t.discordChannelId && botToken) {
      try {
        const resp = await fetch(`https://discord.com/api/v10/channels/${t.discordChannelId}/messages/${t.discordMessageId}`, {
          method: 'PATCH',
          headers: { Authorization: `Bot ${botToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ embeds: [buildTicketEmbed(t)] }),
        });
        if (!resp.ok) throw new Error(`Discord returned ${resp.status}`);
        console.log(`[tickets] ticket ${t.id} embed updated → ${t.status}`);
      } catch (e) {
        console.error('[tickets] Discord embed update failed:', e.message);
      }
    }
  });

  router.delete('/api/admin/tickets/:id', requireAuth, requirePlatformAdmin, (req, res) => {
    if (!tickets.deleteTicket(String(req.params.id))) return res.status(404).json({ error: 'Ticket not found' });
    res.json({ ok: true });
  });

  return router;
};
