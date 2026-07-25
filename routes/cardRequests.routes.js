// Custom card commission requests ("Shop Requests").
//   POST   /api/card-requests            — any signed-in user submits an idea (rate-limited)
//   GET    /api/admin/card-requests      — platform admin: full list, newest first
//   PUT    /api/admin/card-requests/:id  — platform admin: status / adminNotes only
//   DELETE /api/admin/card-requests/:id  — platform admin
// On submit, a best-effort Discord embed goes to the business server (the doorbell);
// the request is already saved — a Discord failure never fails the request.

const express = require('express');
const { ASSIGNEES } = require('../lib/cardRequests');
const { ITEM_TIERS } = require('./cosmetics.routes'); // the item allowlist — validates itemId links

const MAX_OPEN_PER_USER = 2;
const MAX_DM = 2000; // DM message cap — mirrors lib/cardRequests MAX_IDEA / MAX_NOTES

// The two id-verification failures are deliberately worded apart: a 404 means the id is WRONG, a
// transport failure means we DON'T KNOW. Same outcome (blocked, nothing written), but conflating
// them in the copy sends the admin hunting a typo in a good id while Discord is simply down.
const NO_SUCH_USER = 'No Discord user with that ID — double-check the id';
const CANT_VERIFY = "Couldn't verify the Discord ID right now — Discord may be down. Try again in a moment.";

// Discord-owner-id → label, for the embed's "Assigned to" field. Mirrors the admin panel.
const ASSIGNEE_LABEL = Object.fromEntries(ASSIGNEES.map(a => [a.id, a.label]));

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
  if (r.createdBy) fields.push({ name: 'Filed by', value: `${r.createdBy.name} (on their behalf)`.slice(0, 1024), inline: true });
  if (r.assignee) fields.push({ name: 'Assigned to', value: ASSIGNEE_LABEL[r.assignee] || r.assignee, inline: true });
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
  const { requireAuth, requirePlatformAdmin, cardRequests, getPlatformBotToken, channelId, getKnownUser, recordKnownUser } = deps;
  const router = express.Router();
  const ipHits = new Map(); // per-IP submit timestamps (same throttle pattern as /api/tickets)

  // Post the request's embed to the shop-requests channel and store the message + channel ids, so a
  // later status change can PATCH that same message. Best-effort by contract: the request is already
  // saved, so a Discord failure is only logged. Shared by the public submit and the admin
  // on-behalf create — the embed is the queue's tracking artifact, so BOTH must post it.
  // Returns 'posted' | 'failed' | 'skipped'.
  async function postDoorbell(r) {
    const botToken = getPlatformBotToken();
    if (!botToken || !channelId) return 'skipped';
    try {
      const resp = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
        method: 'POST',
        headers: { Authorization: `Bot ${botToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ embeds: [buildRequestEmbed(r)] }),
      });
      if (!resp.ok) throw new Error(`Discord returned ${resp.status}`);
      const msg = await resp.json().catch(() => null);
      if (msg && msg.id) cardRequests.setDiscordMessage(r.id, { messageId: String(msg.id), channelId: String(channelId) });
      console.log(`[cardreq] request ${r.id} posted to Discord`);
      return 'posted';
    } catch (e) {
      console.error('[cardreq] Discord notify failed:', e.message);
      return 'failed';
    }
  }

  // Resolve the requester behind an admin on-behalf create. The id must be PROVEN to exist before
  // anything is written: validateAdminCreate checks shape, not existence, so a typo'd snowflake
  // would otherwise file silently against a real-looking record and surface only when the DM
  // bounced or the card wouldn't equip — long after the context is gone. There is deliberately no
  // placeholder path. Throws { code, message } for the route to turn into a status.
  async function resolveRequester(userId) {
    // A directory hit is proof on its own (they signed in with that id) — skip the Discord call.
    try {
      const known = getKnownUser ? await getKnownUser(userId) : null;
      if (known && known.id) return known;
    } catch (e) {
      console.error('[cardreq] known_users lookup failed:', e.message);
      // Fall through to Discord — a directory outage is not evidence the id is bad.
    }

    const botToken = getPlatformBotToken();
    if (!botToken) throw { code: 503, message: CANT_VERIFY };

    let resp;
    try {
      resp = await fetch(`https://discord.com/api/v10/users/${userId}`, { headers: { Authorization: `Bot ${botToken}` } });
    } catch (e) {
      console.error('[cardreq] Discord id lookup failed:', e.message);
      throw { code: 503, message: CANT_VERIFY };
    }
    if (resp.status === 404) throw { code: 400, message: NO_SUCH_USER };
    if (!resp.ok) {
      console.error(`[cardreq] Discord id lookup → ${resp.status}`);
      throw { code: 503, message: CANT_VERIFY };
    }
    const u = await resp.json().catch(() => null);
    if (!u || !u.id) throw { code: 503, message: CANT_VERIFY };

    const resolved = {
      id: String(u.id),
      displayName: u.global_name || u.username || `User ${userId}`,
      username: u.username || null,
      avatar: u.avatar ? `https://cdn.discordapp.com/avatars/${u.id}/${u.avatar}.png` : null,
    };
    // Backfill the directory so the admin picker finds them next time (best-effort).
    if (recordKnownUser) {
      try { recordKnownUser(resolved); } catch (e) { console.error('[cardreq] recordKnownUser failed:', e.message); }
    }
    return resolved;
  }

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
    const discord = await postDoorbell(r);
    res.json({ ok: true, discord });
  });

  // Admin files a request on behalf of someone who asked over DM/Discord, so they never have to be
  // told "go to the site". Produces the SAME record a public submit does — status 'new', same
  // doorbell — plus createdBy provenance. No IP throttle and no open-request cap: both exist to stop
  // strangers spamming the public form, and requirePlatformAdmin is the gate here.
  router.post('/api/admin/card-requests', requireAuth, requirePlatformAdmin, async (req, res) => {
    const err = cardRequests.validateAdminCreate(req.body);
    if (err) return res.status(400).json({ error: err });

    let requester;
    try {
      requester = await resolveRequester(String(req.body.userId));
    } catch (e) {
      if (e && e.code) return res.status(e.code).json({ error: e.message });
      console.error('[cardreq] resolve error:', e && e.message);
      return res.status(503).json({ error: CANT_VERIFY });
    }

    const createdBy = { id: String(req.user.id), name: req.user.displayName || req.user.username || 'admin' };
    const r = cardRequests.createRequest(req.body, requester, { createdBy });
    // Awaited (unlike the PUT's fire-after-respond) so the returned row carries the Discord message
    // ids — setDiscordMessage mutates this same object — and the board's new tile is complete.
    await postDoorbell(r);
    console.log(`[cardreq] ${createdBy.name} filed ${r.id} on behalf of ${requester.id}`);
    res.json(r);
  });

  router.get('/api/admin/card-requests', requireAuth, requirePlatformAdmin, async (req, res) => {
    res.json({ requests: cardRequests.listRequests() });
  });

  router.put('/api/admin/card-requests/:id', requireAuth, requirePlatformAdmin, async (req, res) => {
    const err = cardRequests.validateUpdate(req.body);
    if (err) return res.status(400).json({ error: err });
    // The lib type-checks itemId; membership lives here, where the item allowlist is known.
    if (req.body.itemId !== undefined && req.body.itemId !== null && !(req.body.itemId in ITEM_TIERS)) {
      return res.status(400).json({ error: 'Invalid item' });
    }
    const r = cardRequests.updateRequest(String(req.params.id), req.body);
    if (!r) return res.status(404).json({ error: 'Request not found' });
    res.json(r);

    // Best-effort: reflect the new phase (emoji + color) on the request's Discord message.
    // Fire after responding — the admin action never blocks on Discord. Skips silently when the
    // request has no stored message id (post failed/skipped, or it predates this feature).
    const botToken = getPlatformBotToken();
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

  // Manual, best-effort DM to the requester (a canned/edited message composed on the frontend).
  // Two Discord calls: open the DM channel with the requester, then post the message. A Discord
  // failure never errors the request — it returns { ok:false } and records the attempt in dmLog.
  router.post('/api/admin/card-requests/:id/dm', requireAuth, requirePlatformAdmin, async (req, res) => {
    const message = typeof (req.body && req.body.message) === 'string' ? req.body.message.trim() : '';
    if (!message) return res.status(400).json({ error: 'Message required' });
    if (message.length > MAX_DM) return res.status(400).json({ error: `Message too long (max ${MAX_DM} characters)` });

    const r = cardRequests.getRequest(String(req.params.id));
    if (!r) return res.status(404).json({ error: 'Request not found' });

    const template = (req.body && req.body.template) || '';
    const by = req.user ? { id: String(req.user.id), name: req.user.displayName || req.user.username || 'admin' } : undefined;
    const botToken = getPlatformBotToken();
    if (!botToken) return res.json({ ok: false, error: 'Discord bot not configured', request: r });

    const CANT_DM = "Couldn't DM — they may have DMs disabled or left the server";
    try {
      // 1) Open (or reuse) the DM channel with the requester.
      const dmResp = await fetch('https://discord.com/api/v10/users/@me/channels', {
        method: 'POST',
        headers: { Authorization: `Bot ${botToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ recipient_id: r.userId }),
      });
      if (!dmResp.ok) throw new Error(`open DM channel → ${dmResp.status}`);
      const dm = await dmResp.json().catch(() => null);
      if (!dm || !dm.id) throw new Error('no DM channel id');

      // 2) Post the message as plain text.
      const msgResp = await fetch(`https://discord.com/api/v10/channels/${dm.id}/messages`, {
        method: 'POST',
        headers: { Authorization: `Bot ${botToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: message }),
      });
      if (!msgResp.ok) {
        const error = msgResp.status === 403 ? CANT_DM : 'Discord error — try again';
        const updated = cardRequests.recordDm(r.id, { template, ok: false, error, message, by });
        console.error(`[cardreq] DM to ${r.userId} failed: ${msgResp.status}`);
        return res.json({ ok: false, error, request: updated || r });
      }

      const sent = await msgResp.json().catch(() => null);
      const sentId = sent && sent.id ? String(sent.id) : null;

      // Persist the DM channel so lib/dmPoller.js can read replies off it. The watermark is
      // seeded from this send ONLY when unset — advancing it on every send would skip a reply
      // that arrived between the last poll and this send. After the first send the poller owns it.
      const seedWatermark = !r.dmWatermark && sentId ? sentId : undefined;
      cardRequests.setDmChannel(r.id, { channelId: String(dm.id), watermark: seedWatermark });

      const updated = cardRequests.recordDm(r.id, { template, ok: true, message, by, messageId: sentId });
      console.log(`[cardreq] DM sent to ${r.userId} for request ${r.id}`);
      return res.json({ ok: true, request: updated || r });
    } catch (e) {
      console.error('[cardreq] DM error:', e.message);
      const updated = cardRequests.recordDm(r.id, { template, ok: false, error: CANT_DM, message, by });
      return res.json({ ok: false, error: CANT_DM, request: updated || r });
    }
  });

  return router;
};
