// Supporter applications ("Support Us" apply flow).
//   POST   /api/supporter-applications            — any signed-in user applies with a donation amount
//   GET    /api/admin/supporter-applications      — platform admin: full list, newest first
//   PUT    /api/admin/supporter-applications/:id  — platform admin: status / adminNotes (granting adds the supporter)
//   DELETE /api/admin/supporter-applications/:id  — platform admin
// On submit, a best-effort Discord embed goes to the shop-requests channel (the doorbell). The
// application is saved first — a Discord failure never fails the request (announcements pattern).

const express = require('express');

const MAX_OPEN_PER_USER = 2;

const PHASE_META = {
  new:      { emoji: '💜', color: 0xa78bfa },
  paid:     { emoji: '💰', color: 0xfbbf24 },
  granted:  { emoji: '✅', color: 0x4ade80 },
  declined: { emoji: '❌', color: 0xff6b6b },
};

function buildEmbed(a) {
  const phase = PHASE_META[a.status] || PHASE_META.new;
  const fields = [
    { name: 'From', value: `${a.displayName} (${a.userId})`.slice(0, 1024), inline: false },
    { name: 'Amount', value: String(a.amount || '—').slice(0, 1024), inline: true },
  ];
  return {
    title: `${phase.emoji} Supporter Application`,
    description: (a.message || '(no message)').slice(0, 3900),
    color: phase.color,
    fields,
    timestamp: a.createdAt,
    footer: { text: 'CommunityHunts — Supporter Applications' },
  };
}

module.exports = function supporterApplicationsRoutes(deps) {
  const { requireAuth, requirePlatformAdmin, supporterApplications, getPlatformBotToken, channelId, supporters } = deps;
  const router = express.Router();
  const ipHits = new Map();

  async function postDoorbell(a) {
    const botToken = getPlatformBotToken();
    if (!botToken || !channelId) return 'skipped';
    try {
      const resp = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
        method: 'POST',
        headers: { Authorization: `Bot ${botToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ embeds: [buildEmbed(a)] }),
      });
      if (!resp.ok) throw new Error(`Discord returned ${resp.status}`);
      const msg = await resp.json().catch(() => null);
      if (msg && msg.id) supporterApplications.setDiscordMessage(a.id, { messageId: String(msg.id), channelId: String(channelId) });
      return 'posted';
    } catch (e) { console.error('[supapp] Discord notify failed:', e.message); return 'failed'; }
  }

  async function patchDoorbell(a) {
    const botToken = getPlatformBotToken();
    if (!a.discordMessageId || !a.discordChannelId || !botToken) return;
    try {
      const resp = await fetch(`https://discord.com/api/v10/channels/${a.discordChannelId}/messages/${a.discordMessageId}`, {
        method: 'PATCH',
        headers: { Authorization: `Bot ${botToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ embeds: [buildEmbed(a)] }),
      });
      if (!resp.ok) throw new Error(`Discord returned ${resp.status}`);
    } catch (e) { console.error('[supapp] Discord embed update failed:', e.message); }
  }

  router.post('/api/supporter-applications', requireAuth, async (req, res) => {
    const ip = req.ip || 'unknown';
    const now = Date.now();
    const recent = (ipHits.get(ip) || []).filter(t => now - t < 10 * 60 * 1000);
    if (recent.length >= 5) return res.status(429).json({ error: 'Too many requests — please try again in a few minutes' });
    if (supporterApplications.openCountFor(req.user.id) >= MAX_OPEN_PER_USER)
      return res.status(429).json({ error: "You already have open applications — we'll be in touch about those first" });

    const err = supporterApplications.validateInput(req.body);
    if (err) return res.status(400).json({ error: err });

    recent.push(now); ipHits.set(ip, recent);
    const a = supporterApplications.createApplication(req.body, req.user);
    const discord = await postDoorbell(a);
    res.json({ ok: true, discord });
  });

  router.get('/api/admin/supporter-applications', requireAuth, requirePlatformAdmin, (req, res) => {
    res.json({ applications: supporterApplications.listApplications() });
  });

  router.put('/api/admin/supporter-applications/:id', requireAuth, requirePlatformAdmin, async (req, res) => {
    const err = supporterApplications.validateUpdate(req.body);
    if (err) return res.status(400).json({ error: err });
    const a = supporterApplications.updateApplication(String(req.params.id), req.body);
    if (!a) return res.status(404).json({ error: 'Application not found' });

    // Granting flips the supporters table so the flair + all perks turn on. Best-effort; a DB hiccup
    // is logged, not surfaced as a failed status change (the admin can re-grant).
    if (req.body.status === 'granted' && supporters) {
      try { await supporters.addSupporter(a.userId, req.user.id); }
      catch (e) { console.error('[supapp] addSupporter on grant failed:', e.message); }
    }
    res.json(a);
    patchDoorbell(a); // fire after responding
  });

  router.delete('/api/admin/supporter-applications/:id', requireAuth, requirePlatformAdmin, (req, res) => {
    if (!supporterApplications.deleteApplication(String(req.params.id))) return res.status(404).json({ error: 'Application not found' });
    res.json({ ok: true });
  });

  return router;
};
