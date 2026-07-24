// External integrations: Twitch live status, beantwitch leaderboard proxy, Discord import/parse.
// These are the functions that become per-tenant in the multi-tenancy work — isolated here
// so that change edits one small module instead of the main server file.

// ── Twitch live check (per-tenant) ─────────────────────────────────
// Live status per tenant slug. Twitch app creds are platform-level (shared); the
// polled channel is per-tenant (tenant.twitchChannel).
const liveBySlug = new Map(); // slug -> { isLive, title, updatedAt }

async function checkTenantLive(io, tenant) {
  const cid = tenant.twitchClientId || process.env.TWITCH_CLIENT_ID;
  const sec = tenant.twitchClientSecret || process.env.TWITCH_CLIENT_SECRET;
  const channel = tenant.twitchChannel;
  if (!cid || !sec || !channel) return;
  try {
    const tr = await fetch('https://id.twitch.tv/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `client_id=${cid}&client_secret=${sec}&grant_type=client_credentials`
    });
    const td = await tr.json();
    const sr = await fetch(`https://api.twitch.tv/helix/streams?user_login=${encodeURIComponent(channel)}`, {
      headers: { 'Client-ID': cid, 'Authorization': `Bearer ${td.access_token}` }
    });
    const sd = await sr.json();
    const state = { isLive: !!(sd.data?.length), title: sd.data?.[0]?.title||'', updatedAt: new Date().toISOString() };
    liveBySlug.set(tenant.slug, state);
    io.to('hub:' + tenant.slug).emit('bean:live', state);
  } catch(e) { console.error(`Twitch check error [${tenant.slug}]:`, e.message); }
}
function getLiveStatus(slug) { return liveBySlug.get(slug) || { isLive: false, title: '', updatedAt: null }; }
function startTenantPolling(io, tenantList) {
  for (const tenant of tenantList) {
    if (!tenant.twitchChannel) continue;
    checkTenantLive(io, tenant);
    setInterval(() => checkTenantLive(io, tenant), 5 * 60 * 1000);
  }
}

// ── Twitch live check (per hunt creator) ───────────────────────────
// Each live hunt's creator can key their card off their OWN channel: settings.twitchName,
// with the community host falling back to tenant.twitchChannel. One batched Helix
// /streams call per cycle covers every creator (endpoint takes up to 100 user_logins).
// Mirrors the liveBySlug pattern above. Consumed by GET /api/hunts enrichment
// (getCreatorLive) and pushed to hubs as 'hunts:twitchlive'.
const liveByLogin = new Map(); // login (lowercase) -> { isLive, title, updatedAt }
const loginByUser = new Map(); // creator userId -> login (lowercase)

// Resolve creator userId -> login for every public live hunt, grouped per tenant.
async function resolveCreatorLogins({ getAllTenants, getPublicHunts, getSettings }) {
  const byUser = new Map();
  const byTenant = new Map(); // slug -> [userId,...]
  for (const tenant of getAllTenants()) {
    const userIds = [];
    for (const h of getPublicHunts(tenant.id)) {
      if (!h.userId) continue;
      let login = '';
      try { login = String((await getSettings(h.userId))?.twitchName || '').trim(); } catch {}
      if (!login && String(h.userId) === String(tenant.hostDiscordId || '')) {
        login = String(tenant.twitchChannel || '').trim();
      }
      if (!login) continue;
      byUser.set(h.userId, login.toLowerCase());
      userIds.push(h.userId);
    }
    if (userIds.length) byTenant.set(tenant.slug, userIds);
  }
  return { byUser, byTenant };
}

// Real Helix fetch: same app-token flow as checkTenantLive, batched 100 logins per call.
// Returns Map(login -> { title }) containing ONLY the logins that are live.
async function fetchLiveStreams(logins) {
  const cid = process.env.TWITCH_CLIENT_ID;
  const sec = process.env.TWITCH_CLIENT_SECRET;
  const live = new Map();
  if (!cid || !sec || !logins.length) return live;
  const tr = await fetch('https://id.twitch.tv/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `client_id=${cid}&client_secret=${sec}&grant_type=client_credentials`
  });
  const td = await tr.json();
  for (let i = 0; i < logins.length; i += 100) {
    const qs = logins.slice(i, i + 100).map(l => `user_login=${encodeURIComponent(l)}`).join('&');
    const sr = await fetch(`https://api.twitch.tv/helix/streams?${qs}`, {
      headers: { 'Client-ID': cid, 'Authorization': `Bearer ${td.access_token}` }
    });
    const sd = await sr.json();
    for (const s of (sd.data || [])) live.set(String(s.user_login).toLowerCase(), { title: s.title || '' });
  }
  return live;
}

// One poll cycle. deps: { getAllTenants, getPublicHunts, getSettings, fetchStreams? }
// (fetchStreams injectable for tests; defaults to the real Helix call above).
async function checkCreatorsLive(io, deps) {
  try {
    const { byUser, byTenant } = await resolveCreatorLogins(deps);
    const logins = [...new Set(byUser.values())];
    const live = await (deps.fetchStreams || fetchLiveStreams)(logins);
    const now = new Date().toISOString();
    loginByUser.clear();
    for (const [userId, login] of byUser) loginByUser.set(userId, login);
    liveByLogin.clear();
    for (const login of logins) {
      const hit = live.get(login);
      liveByLogin.set(login, { isLive: !!hit, title: hit ? hit.title : '', updatedAt: now });
    }
    for (const [slug, userIds] of byTenant) {
      const payload = {};
      for (const userId of userIds) {
        const login = byUser.get(userId);
        payload[userId] = { isLive: !!(liveByLogin.get(login) || {}).isLive, login };
      }
      io.to('hub:' + slug).emit('hunts:twitchlive', payload);
    }
  } catch (e) { console.error('Twitch creator check error:', e.message); }
}

// Sync cache lookup for the GET /api/hunts wire enrichment.
function getCreatorLive(userId) {
  const login = loginByUser.get(userId);
  if (!login) return { isLive: false, login: null };
  return { isLive: !!(liveByLogin.get(login) || {}).isLive, login };
}

function startCreatorPolling(io, deps) {
  checkCreatorsLive(io, deps);
  setInterval(() => checkCreatorsLive(io, deps), 5 * 60 * 1000);
}

// ── Leaderboard proxy (per-tenant URL) ─────────────────────────────
// Proxied server-side (upstream CORS-allowlists only its own origin). Cached per tenant.
// A tenant with no leaderboardUrl returns null (frontend hides the panel).
const lbCacheBySlug = new Map(); // slug -> { data, fetchedAt }

async function getLeaderboard(tenant) {
  if (!tenant || !tenant.leaderboardUrl) return null;
  const slug = tenant.slug;
  const base = tenant.leaderboardUrl;
  const CACHE_MS = 90 * 1000;
  const cached = lbCacheBySlug.get(slug);
  if (cached && Date.now() - cached.fetchedAt < CACHE_MS) return cached.data;

  const headers = { 'User-Agent': 'Mozilla/5.0 Chrome/120', 'Origin': 'https://beantwitch.com', 'Accept': 'application/json' };
  const [lbRes, cfgRes] = await Promise.all([
    fetch(`${base}/api/leaderboard`, { headers }),
    fetch(`${base}/api/config`,      { headers }),
  ]);
  if (!lbRes.ok)  throw new Error(`leaderboard upstream ${lbRes.status}`);
  if (!cfgRes.ok) throw new Error(`config upstream ${cfgRes.status}`);
  const lbJson  = await lbRes.json();
  const cfgJson = await cfgRes.json();
  // api-v2 wraps config in a {success, data} envelope (v1 was flat); it also returns
  // rank/wager as strings — coerce so the frontend's numeric checks (rank === 1) hold.
  const cfg = cfgJson?.data ?? cfgJson;

  const prizes = Array.isArray(cfg.leaderboard_prizes) ? cfg.leaderboard_prizes : [];
  const rows   = (lbJson?.data?.leaderboard || []).map(r => ({
    rank:    Number(r.rank),
    player:  r.username,
    wagered: Number(r.wager),
    prize:   prizes[Number(r.rank) - 1] ?? null,
  }));

  const data = {
    prizePool:   cfg.leaderboard_prize_pool ?? null,
    currency:    cfg.currency || 'USD',
    startDay:    cfg.leaderboard_start_day || null,
    endDay:      cfg.leaderboard_end_day   || null,
    syncedAt:    lbJson?.data?.cache_updated_at || null,
    fetchedAt:   new Date().toISOString(),
    standings:   rows,
    fullUrl:     (tenant.branding && tenant.branding.leaderboardFullUrl) || 'https://beantwitch.com/leaderboard',
  };
  lbCacheBySlug.set(slug, { data, fetchedAt: Date.now() });
  return data;
}
function getLeaderboardCache(slug) { return lbCacheBySlug.get(slug)?.data || null; }

// ── Discord Import (per-tenant bot + channels) ─────────────────────
async function fetchDiscordMessages(botToken, channelId, limit = 100) {
  if (!botToken || !channelId) throw new Error('Discord bot not configured');
  // Never log any slice of the bot token (CWE-532, security audit 2026-07-18 #5) — boolean only.
  console.log(`[discord] fetchMessages: hasToken=${!!botToken} channel=${channelId}`);
  const res = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages?limit=${limit}`, {
    headers: { Authorization: `Bot ${botToken}`, 'Content-Type': 'application/json' }
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    console.error(`[discord] API ${res.status}: ${body}`);
    throw new Error(`Discord API error: ${res.status}`);
  }
  return res.json();
}

// Parse winners from Discord — finds latest results message and extracts names.
// `type` selects which channel to scrape: 'vip' (default) or 'affiliate'.
async function parseWinners(tenant, type) {
  const channelId = type === 'affiliate'
    ? tenant.discordAffiliateWinnersChannelId
    : tenant.discordVipWinnersChannelId;
  const messages = await fetchDiscordMessages(tenant.discordBotToken, channelId, 50);

  // Extract text from message content + embeds (bots often post results in embeds)
  const getText = m => {
    let t = m.content || '';
    if (m.embeds?.length) t += '\n' + m.embeds.map(e => [e.title, e.description, ...(e.fields||[]).map(f => `${f.name}\n${f.value}`)].filter(Boolean).join('\n')).join('\n');
    return t;
  };

  // Collect all text from embeds (descriptions + field values) and message content
  const getAllText = m => {
    const parts = [m.content || ''];
    for (const e of (m.embeds || [])) {
      if (e.description) parts.push(e.description);
      for (const f of (e.fields || [])) {
        if (f.value) parts.push(f.value);
      }
    }
    return parts.join('\n');
  };

  // Find message with the results board (embed field "Top Rolls" or similar table data)
  const resultsMsg = messages.find(m =>
    (m.embeds || []).some(e =>
      (e.fields || []).some(f => /Top Rolls|Roll.*Luck/i.test(f.name + '\n' + (f.value || '')))
      || /^#?\s*\d+\s+\S+\s+\d+\.\d+\s+[+-]?\d+/m.test(e.description || '')
    )
  ) || messages.find(m => {
    const t = getAllText(m);
    return t.includes('#1') && (t.includes('Checked-In') || t.includes('Winner') || t.includes('Check-In'));
  });

  if (!resultsMsg) {
    console.log(`[discord] No results board found. Total messages: ${messages.length}`);
    return { winners: [], count: 0, raw: 'No results message found in last 50 messages' };
  }

  const fullText = getAllText(resultsMsg);
  const winners = [];
  for (const line of fullText.split('\n')) {
    // Match: "1 DodO129 139.9845012 +50 In" or "#1 fullofwind 160.068 +65 Yes"
    const match = line.match(/^#?(\d+)\s+(.+?)\s+(\d+\.\d+)\s+([+-]?\d+)\s+(\S+)/);
    if (match && match[1] !== '0') {
      const status = match[5];
      // Skip header rows and non-checked-in entries
      if (/^(Check|Name|Luck|Roll|Winner|Pl)/i.test(match[2])) continue;
      if (/^(In|Yes|Checked-In|✅)$/i.test(status)) {
        winners.push({ place: parseInt(match[1]), name: match[2].trim(), roll: parseFloat(match[3]), luck: parseInt(match[4]) });
      }
    }
  }

  console.log(`[discord] Parsed ${winners.length} winners from results board${winners.length ? ', first: ' + winners[0].name : ''}`);

  return { winners, count: winners.length };
}

module.exports = {
  getLiveStatus, startTenantPolling, checkTenantLive,
  checkCreatorsLive, getCreatorLive, startCreatorPolling,
  getLeaderboard, getLeaderboardCache,
  fetchDiscordMessages, parseWinners,
};
