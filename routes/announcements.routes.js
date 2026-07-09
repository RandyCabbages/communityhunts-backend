// Platform-wide announcements ("patch notes"). Public read; owner-only writes.
//   GET    /api/announcements      — public, newest-first (≤20)
//   POST   /api/announcements      — platform admin only (optional Discord cross-post)
//   PUT    /api/announcements/:id  — platform admin only
//   DELETE /api/announcements/:id  — platform admin only

const express = require('express');

const EMBED_COLOR = 0x7c3aed; // community accent (violet) — matches the live site palette
const SITE_URL = 'https://communityhunts.gg';

// Build a Discord embed from an announcement. Caps mirror routes/misc.routes.js:
// title ≤ 256, field value ≤ 1024, ≤ 25 fields. '​' is a zero-width space —
// Discord rejects empty field name/value strings.
function buildAnnouncementEmbed(a) {
  return {
    title: `🔔 ${a.title}`.slice(0, 256),
    description: `[communityhunts.gg](${SITE_URL})`,
    color: EMBED_COLOR,
    fields: (a.sections || []).slice(0, 25).map(s => ({
      name: String(s.heading || '​').slice(0, 256),
      value: ((s.items || []).map(i => `• ${i}`).join('\n') || '​').slice(0, 1024),
      inline: false,
    })),
    timestamp: new Date(a.date || Date.now()).toISOString(),
    footer: { text: 'CommunityHunts' },
  };
}

// Best-effort POST to Discord. Throws on non-2xx so the caller can flag 'failed'.
async function postAnnouncementToDiscord(a, botToken, channelId) {
  const r = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bot ${botToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ embeds: [buildAnnouncementEmbed(a)] }),
  });
  if (!r.ok) {
    const detail = await r.text().catch(() => '');
    throw new Error(`Discord returned ${r.status}: ${detail.slice(0, 200)}`);
  }
}

module.exports = function announcementsRoutes(deps) {
  const { requireAuth, requirePlatformAdmin, announcements, botToken, announcementsChannelId } = deps;
  const router = express.Router();

  router.get('/api/announcements', (req, res) => {
    res.json(announcements.listAnnouncements());
  });

  router.post('/api/announcements', requireAuth, requirePlatformAdmin, async (req, res) => {
    const err = announcements.validateInput(req.body);
    if (err) return res.status(400).json({ error: err });
    const a = announcements.createAnnouncement(req.body, req.user.id);

    // Optional Discord cross-post. The announcement is already saved — a Discord
    // failure only flips the status field, it never fails the request.
    let discord = 'skipped';
    if (req.body.postToDiscord && botToken && announcementsChannelId) {
      try {
        await postAnnouncementToDiscord(a, botToken, announcementsChannelId);
        discord = 'posted';
        console.log(`[announce] cross-posted announcement ${a.id} to Discord`);
      } catch (e) {
        discord = 'failed';
        console.error('[announce] Discord cross-post failed:', e.message);
      }
    }
    res.json({ ...a, discord });
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
