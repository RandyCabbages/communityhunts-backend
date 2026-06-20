// Misc leaf routes that don't belong to a larger concern:
//   GET  /api/bangers   → top recent big-multiplier wins (reads hunts + archive, read-only)
//   POST /api/tickets   → bug-report email via Resend (per-IP rate limited)
//   GET  /api/health    → health check
// Thin router, mounted from the server.js composition root.
// hunts/archive are the persistence-owned singletons — injected by reference, read only.

const express = require('express');

// Bangers threshold: a "banger" is a win at >=300x bet.
const BANGER_MIN_MULT = 300;

// Ticket config is env-derived (config, not shared state) — read here so the router is self-sufficient.
const TICKET_EMAILS = (process.env.TICKET_EMAILS || 'nesgoomba@gmail.com,luimeneghim@gmail.com').split(',').map(s=>s.trim()).filter(Boolean);
const RESEND_API_KEY = (process.env.RESEND_API_KEY || '').trim();
const TICKET_FROM = (process.env.TICKET_FROM || 'CommunityHunts Tickets <onboarding@resend.dev>').trim();

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

    if (!RESEND_API_KEY) return res.status(500).json({error:'RESEND_API_KEY not configured on the server'});
    if (TICKET_EMAILS.length === 0) return res.status(500).json({error:'No ticket recipients configured'});

    // Length caps + per-IP throttle to prevent inbox / Resend-quota spam.
    if (String(issue||'').length > 5000 || String(username||'').length > 120 || String(type||'').length > 40)
      return res.status(400).json({error:'Ticket content too long'});
    const tip = req.ip || 'unknown';
    const tnow = Date.now();
    const recentTickets = (ticketHits.get(tip) || []).filter(t => tnow - t < 10*60*1000);
    if (recentTickets.length >= 5) return res.status(429).json({error:'Too many tickets — please try again in a few minutes'});
    recentTickets.push(tnow); ticketHits.set(tip, recentTickets);

    const safe = s => String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    const from = safe(username || 'Anonymous');
    const kind = safe(type || 'General');
    const body = safe(issue || '(no message)').replace(/\n/g,'<br>');

    const html = `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 560px; margin: 0 auto; padding: 24px; background: #0e0e10; color: #efeff1; border-radius: 8px;">
        <div style="border-left: 3px solid #9146ff; padding-left: 14px; margin-bottom: 20px;">
          <div style="font-size: 11px; color: #adadb8; letter-spacing: 0.12em; text-transform: uppercase;">New CommunityHunts ticket</div>
          <div style="font-size: 20px; font-weight: 700; margin-top: 4px;">${kind}</div>
        </div>
        <div style="background: #18181b; border-radius: 6px; padding: 16px 18px; margin-bottom: 16px;">
          <div style="font-size: 12px; color: #adadb8; text-transform: uppercase; letter-spacing: 0.08em; margin-bottom: 6px;">From</div>
          <div style="font-size: 15px; font-weight: 600;">${from}</div>
        </div>
        <div style="background: #18181b; border-radius: 6px; padding: 16px 18px;">
          <div style="font-size: 12px; color: #adadb8; text-transform: uppercase; letter-spacing: 0.08em; margin-bottom: 8px;">Message</div>
          <div style="font-size: 14px; line-height: 1.6; color: #efeff1;">${body}</div>
        </div>
        <div style="font-size: 11px; color: #7c7c84; margin-top: 18px; text-align: center;">
          ${new Date().toISOString()}
        </div>
      </div>
    `;

    try {
      const r = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${RESEND_API_KEY}` },
        body: JSON.stringify({
          from: TICKET_FROM,
          to: TICKET_EMAILS,
          subject: `🎫 CommunityHunts Ticket — ${type||'General'} (from ${username||'Anonymous'})`,
          reply_to: username && username.includes('@') ? username : undefined,
          html
        })
      });
      if (!r.ok) {
        const detail = await r.text().catch(()=>'');
        console.error('[ticket] Resend rejected:', r.status, detail);
        return res.status(500).json({error:`Resend returned ${r.status}`, detail});
      }
      const data = await r.json().catch(()=>({}));
      console.log(`[ticket] emailed to ${TICKET_EMAILS.join(', ')} — id ${data.id || '(no id)'}`);
      res.json({ ok: true, via: 'email', recipients: TICKET_EMAILS.length });
    } catch (e) {
      console.error('[ticket] email delivery failed:', e.message);
      res.status(500).json({error:'Failed to send ticket email', detail: e.message});
    }
  });

  router.get('/api/health', (req, res) => res.json({ok:true}));

  return router;
};
