// Misc leaf routes that don't belong to a larger concern:
//   GET  /api/bangers       → top recent big-multiplier wins (reads hunts + archive, read-only)
//   GET  /api/hall-of-fame  → all-time top replay-backed wins (reads hunts + archive, read-only)
//   POST /api/tickets   → persist an inquiry/suggestion (lib/tickets) + best-effort Discord doorbell (per-IP rate limited)
//   GET  /api/health    → health check
// Thin router, mounted from the server.js composition root.
// hunts/archive are the persistence-owned singletons — injected by reference, read only.

const express = require('express');

const { collectHallOfFame } = require('../lib/hallOfFame');

// Bangers threshold: a "banger" is a win at >=300x bet.
const BANGER_MIN_MULT = 300;

// Ticket config is env-derived (config, not shared state) — read here so the router is self-sufficient.
// Tickets are PLATFORM-level: they post to communityhunts.gg's OWN channels, so the bot token is
// the PLATFORM bot (deps.getPlatformBotToken), NOT req.tenant — a ticket from a streamer's hub sets
// req.tenant to that streamer, whose own bot can't post to our channels. Channels stay global env.
// Tickets split by type: "Feature Request" → suggestions channel; everything else → tickets channel.
const TICKETS_CHANNEL_ID = (process.env.DISCORD_TICKETS_CHANNEL_ID || '').trim();
const SUGGESTIONS_CHANNEL_ID = (process.env.DISCORD_SUGGESTIONS_CHANNEL_ID || '').trim();
const SUGGESTION_TYPES = new Set(['Feature Request']);

const ticketHits = new Map(); // per-IP ticket timestamps for rate limiting

module.exports = function miscRoutes(deps) {
  const { hunts, archive, tickets, getPlatformBotToken } = deps;
  const router = express.Router();

  router.get('/api/bangers', (req, res) => {
    const out = [], seen = new Set();
    // Tenant isolation: only THIS tenant's hunts. Without it every community's banger rail showed
    // Bean's wins (tenantOf defaults an untagged hunt to 'bean'). Now live with MULTI_TENANT on.
    const tid = req.tenant?.id || 'bean';
    const collect = (h, live) => {
      if (!h || !h.user || !Array.isArray(h.bonuses)) return;
      if ((h.tenantId || 'bean') !== tid) return;
      const at = h.archivedAt || h.startedAt || null;
      for (const b of h.bonuses) {
        const bet = +b.bet || 0, win = +b.win || 0;
        if (bet <= 0 || win <= 0) continue;
        const mult = win / bet;
        if (mult < BANGER_MIN_MULT) continue;
        const key = `${h.user.id}|${(b.slot||'').toLowerCase()}|${bet}|${win}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({
          slot: b.slot || 'Unknown', bet, win, mult: +mult.toFixed(2),
          userId: h.user.id, username: h.user.displayName, avatar: h.user.avatar,
          huntType: h.huntType || 'community', live: !!live,
          at, archivedAt: h.archivedAt || null,
        });
      }
    };
    // Live hunts first so their fresher copy wins the dedupe over an archived snapshot.
    Object.values(hunts).forEach(h => { if (h.isLive) collect(h, true); });
    archive.forEach(h => collect(h, false));
    out.sort((a, b) => {
      const ta = a.at ? new Date(a.at).getTime() : 0;
      const tb = b.at ? new Date(b.at).getTime() : 0;
      return tb - ta || b.mult - a.mult;
    });
    // Cap per user so one hot hunt doesn't dominate the rail.
    const MAX_PER_USER = 2;
    const userCount = new Map();
    const diverse = [];
    for (const b of out) {
      const c = userCount.get(b.userId) || 0;
      if (c >= MAX_PER_USER) continue;
      userCount.set(b.userId, c + 1);
      diverse.push(b);
      if (diverse.length >= 24) break;
    }
    res.json(diverse);
  });

  // Hall of Fame: all-time top-multiplier hits that carry a replay link.
  // Selection (300x floor, replay required, mult-desc, cap 12) lives in
  // lib/hallOfFame.js — tested there; this stays a thin pass-through with the
  // same tenant guard as /api/bangers.
  router.get('/api/hall-of-fame', (req, res) => {
    res.json(collectHallOfFame(hunts, archive, req.tenant?.id || 'bean'));
  });

  router.post('/api/tickets', async (req, res) => {
    const { username, issue, type } = req.body;

    // Length caps + per-IP throttle to prevent channel spam.
    if (String(issue||'').length > 5000 || String(username||'').length > 120 || String(type||'').length > 40)
      return res.status(400).json({error:'Ticket content too long'});
    const tip = req.ip || 'unknown';
    const tnow = Date.now();
    const recentTickets = (ticketHits.get(tip) || []).filter(t => tnow - t < 10*60*1000);
    if (recentTickets.length >= 5) return res.status(429).json({error:'Too many tickets — please try again in a few minutes'});
    recentTickets.push(tnow); ticketHits.set(tip, recentTickets);

    // Route by type: feature suggestions go to their own channel, everything else to the inquiries channel.
    const kind = (type || 'General').trim();
    const isSuggestion = SUGGESTION_TYPES.has(kind);
    const channelId = isSuggestion ? SUGGESTIONS_CHANNEL_ID : TICKETS_CHANNEL_ID;
    const dest = isSuggestion ? 'suggestions' : 'tickets';

    // Persist FIRST — the store is the source of truth for the admin queue. Identity is
    // snapshotted when the submitter is signed in; anonymous submits keep userId null.
    const t = tickets.createTicket({ type: kind, issue, username, discordChannel: dest }, req.user || null);

    // Best-effort Discord doorbell — a failure NEVER fails the submit (the ticket is already saved).
    // Token is the PLATFORM bot; channels are the global ticket/suggestion env ids.
    const botToken = getPlatformBotToken();
    let discord = 'skipped';
    if (botToken && channelId) {
      // Discord embed. description limit is 4096 and a field value 1024 — keep margins.
      const from = String(username || 'Anonymous').slice(0, 256);
      const desc = String(issue || '(no message)').slice(0, 3900);
      const color = isSuggestion ? 0x22c55e : (kind.toLowerCase() === 'bug' ? 0xef4444 : 0x7c3aed);
      const embed = {
        title: `${isSuggestion ? '💡' : '🎫'} ${kind}`.slice(0, 256),
        description: desc,
        color,
        fields: [{ name: 'From', value: from, inline: false }],
        timestamp: new Date().toISOString(),
        footer: { text: 'CommunityHunts' },
      };
      try {
        const r = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
          method: 'POST',
          headers: { Authorization: `Bot ${botToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ embeds: [embed] }),
        });
        if (!r.ok) throw new Error(`Discord returned ${r.status}`);
        // Store the posted message ids so an admin status change can PATCH this same embed.
        const msg = await r.json().catch(() => null);
        if (msg && msg.id) tickets.setDiscordMessage(t.id, { messageId: String(msg.id), channelId: String(channelId) });
        discord = 'posted';
        console.log(`[ticket] ${t.id} posted to Discord ${dest} channel — type ${kind}`);
      } catch (e) {
        discord = 'failed';
        console.error('[ticket] Discord delivery failed:', e.message);
      }
    } else {
      console.warn(`[ticket] ${t.id} stored but Discord skipped (token=${!!botToken}, channel=${!!channelId})`);
    }
    res.json({ ok: true, id: t.id, discord });
  });

  router.get('/api/health', (req, res) => res.json({ok:true}));

  return router;
};
