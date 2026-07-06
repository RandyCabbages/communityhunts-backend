// Misc leaf routes that don't belong to a larger concern:
//   GET  /api/bangers   → top recent big-multiplier wins (reads hunts + archive, read-only)
//   POST /api/tickets   → post inquiries/suggestions into Discord via the CommunityHunts bot (per-IP rate limited)
//   GET  /api/health    → health check
// Thin router, mounted from the server.js composition root.
// hunts/archive are the persistence-owned singletons — injected by reference, read only.

const express = require('express');

// Bangers threshold: a "banger" is a win at >=300x bet.
const BANGER_MIN_MULT = 300;

// Ticket config is env-derived (config, not shared state) — read here so the router is self-sufficient.
// This is the CommunityHunts *business* Discord bot (App 1506278609445191800), distinct from the
// per-tenant DISCORD_BOT_TOKEN used for slot-call import / winner parsing in Bean's community server.
// Tickets split by type: "Feature Request" → suggestions channel; everything else → tickets channel.
const TICKETS_BOT_TOKEN = (process.env.DISCORD_TICKETS_BOT_TOKEN || '').trim();
const TICKETS_CHANNEL_ID = (process.env.DISCORD_TICKETS_CHANNEL_ID || '').trim();
const SUGGESTIONS_CHANNEL_ID = (process.env.DISCORD_SUGGESTIONS_CHANNEL_ID || '').trim();
const SUGGESTION_TYPES = new Set(['Feature Request']);

const ticketHits = new Map(); // per-IP ticket timestamps for rate limiting

module.exports = function miscRoutes(deps) {
  const { hunts, archive } = deps;
  const router = express.Router();

  router.get('/api/bangers', (req, res) => {
    const out = [], seen = new Set();
    const collect = (h, live) => {
      if (!h || !h.user || !Array.isArray(h.bonuses)) return;
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
    res.json(out.slice(0, 24));
  });

  router.post('/api/tickets', async (req, res) => {
    const { username, issue, type } = req.body;

    if (!TICKETS_BOT_TOKEN) return res.status(500).json({error:'Discord ticket bot not configured on the server'});

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
    if (!channelId) return res.status(500).json({error:`No Discord ${dest} channel configured on the server`});

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
        headers: { Authorization: `Bot ${TICKETS_BOT_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ embeds: [embed] }),
      });
      if (!r.ok) {
        const detail = await r.text().catch(()=>'');
        console.error('[ticket] Discord rejected:', r.status, detail);
        return res.status(500).json({error:`Discord returned ${r.status}`, detail});
      }
      console.log(`[ticket] posted to Discord ${dest} channel — type ${kind}`);
      res.json({ ok: true, via: 'discord', channel: dest });
    } catch (e) {
      console.error('[ticket] Discord delivery failed:', e.message);
      res.status(500).json({error:'Failed to post ticket to Discord', detail: e.message});
    }
  });

  router.get('/api/health', (req, res) => res.json({ok:true}));

  return router;
};
