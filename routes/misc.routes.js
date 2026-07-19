// Misc leaf routes that don't belong to a larger concern:
//   GET  /api/bangers       → top recent big-multiplier wins (reads hunts + archive, read-only)
//   GET  /api/hall-of-fame      → all-time top replay-backed wins, top FAME_CAP (shape frozen: bare array)
//   GET  /api/hall-of-fame/all  → the same, paginated: ?limit=&offset=&currency=&sort=latest
//                                 → { items, total, offset, limit, currencies }
//   GET  /api/community-stats  → tenant-wide proof numbers for the homepage band (FX-normalized USD)
//   POST /api/tickets   → persist an inquiry/suggestion (lib/tickets) + best-effort Discord doorbell (per-IP rate limited)
//   GET  /api/health    → health check
// Thin router, mounted from the server.js composition root.
// hunts/archive are the persistence-owned singletons — injected by reference, read only.

const express = require('express');

const { collectHallOfFame, pageHallOfFame, FAME_CAP } = require('../lib/hallOfFame');
const { collectBangers } = require('../lib/bangers');
const { shouldMaskIdentity } = require('../lib/settings'); // anon host masking for the public rails

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
  const { hunts, archive, tickets, getPlatformBotToken, statsStore } = deps;
  const router = express.Router();

  // Selection (300x floor, dedupe, recency sort, 2-per-user cap, 24-window) lives in
  // lib/bangers.js — tested there; this stays a thin pass-through. Tenant isolation: only
  // THIS tenant's hunts (tenantOf defaults an untagged hunt to 'bean'). Without it every
  // community's banger rail showed Bean's wins. Now live with MULTI_TENANT on.
  router.get('/api/bangers', (req, res) => {
    res.json(collectBangers(hunts, archive, req.tenant?.id || 'bean', { isAnon: shouldMaskIdentity }));
  });

  // Homepage proof band ("Real numbers from real hunts"). Public + tenant-scoped, same guard
  // as /api/bangers. FX-NORMALIZED — see lib/communityStats.js for why a raw sum of totalWon
  // across currencies is wrong. Degrades to zeros (no DB, no rows, or a query error) and the
  // frontend hides the band entirely when `hunts` is 0, so a failure is invisible, not broken.
  router.get('/api/community-stats', async (req, res) => {
    const empty = { hunts: 0, bonuses: 0, usdWon: 0, approx: 0 };
    if (!statsStore) return res.json(empty);
    try {
      res.json(await statsStore.getCommunityStats(req.tenant?.id || 'bean'));
    } catch (e) {
      console.error('[community-stats]', e.message);
      res.json(empty);
    }
  });

  // Hall of Fame: all-time top-multiplier hits that carry a replay link.
  // Selection (300x floor, replay required, mult-desc) lives in lib/hallOfFame.js and
  // returns the FULL list; these routes own truncation. Same tenant guard as /api/bangers.
  //
  // SHAPE IS FROZEN: a bare array of <= FAME_CAP. The hub rails call .slice() on this
  // response directly, so returning an envelope here would throw in an older deployed
  // frontend during the backend-first deploy gap. Page via /api/hall-of-fame/all instead.
  router.get('/api/hall-of-fame', (req, res) => {
    const all = collectHallOfFame(hunts, archive, req.tenant?.id || 'bean', { isAnon: shouldMaskIdentity });
    res.json(all.slice(0, FAME_CAP));
  });

  // Paginated back catalogue for the /:slug/hall-of-fame page — the whole archive, not
  // just the hub's top 12. Envelope (not a bare array) because the client needs `total`
  // to render "N more" and to know when to stop, and `currencies` to render the tab bar.
  // `currency` filters the board; `sort=latest` feeds the Latest Hits carousel. All four
  // params are clamped/validated in pageHallOfFame — junk falls back, it never 400s.
  router.get('/api/hall-of-fame/all', (req, res) => {
    const all = collectHallOfFame(hunts, archive, req.tenant?.id || 'bean', { isAnon: shouldMaskIdentity });
    res.json(pageHallOfFame(all, {
      limit: req.query.limit, offset: req.query.offset,
      currency: req.query.currency, sort: req.query.sort,
    }));
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
