// Reads requester replies to Shop Request DMs and folds them into the request's dmLog thread.
//
// The backend holds no Discord gateway connection — DMs are SENT over plain REST from
// routes/cardRequests.routes.js, so replies land in the bot's inbox where nothing observes them.
// This module polls each open request's DM channel instead. Reading DM history over REST needs
// no gateway intent: intents govern gateway events, and we subscribe to none.
//
// DI: startDmPolling({ cardRequests, getPlatformBotToken, channelId }).

const API = 'https://discord.com/api/v10';
const DEFAULT_INTERVAL_MS = 120000; // 2 min — a commission queue, not a chat client
const PAGE = 50;                    // messages read per request per tick

// Discord snowflakes are numeric strings too long for Number. Longer string = larger id, and
// equal-length ids compare correctly lexicographically. Avoids BigInt throwing on a malformed id.
function cmpSnowflake(a, b) {
  if (a.length !== b.length) return a.length - b.length;
  return a < b ? -1 : a > b ? 1 : 0;
}

// Announce a reply in the shop-requests channel. Best-effort by contract: the replies are already
// recorded on the request, so a failure here costs only the ping.
async function notify(botToken, channelId, r, replies) {
  if (!channelId) return;
  const body = replies.map(m => m.content).filter(Boolean).join('\n\n').slice(0, 3900);
  const fields = [{ name: 'Request', value: r.id, inline: true }];
  if (r.cardName) fields.push({ name: 'Card', value: r.cardName.slice(0, 1024), inline: true });
  try {
    const resp = await fetch(`${API}/channels/${channelId}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bot ${botToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        embeds: [{
          title: `💬 Reply from ${r.displayName}`,
          description: body || '(no text — attachment only)',
          color: 0xa78bfa,
          fields,
          footer: { text: 'CommunityHunts — Shop Requests' },
        }],
      }),
    });
    if (!resp.ok) throw new Error(`Discord returned ${resp.status}`);
  } catch (e) {
    console.error(`[dmpoll] notify failed for ${r.id}: ${e.message}`);
  }
}

// Poll one request's DM channel. THROWS on a Discord failure so the caller skips this request
// without advancing its watermark — the same window is then retried on the next tick.
async function pollOne({ cardRequests, botToken, channelId }, r) {
  let dmChannelId = r.dmChannelId;

  // A request DM'd before this shipped has no stored channel. Opening one is idempotent —
  // Discord returns the existing DM channel for the same recipient.
  if (!dmChannelId) {
    const resp = await fetch(`${API}/users/@me/channels`, {
      method: 'POST',
      headers: { Authorization: `Bot ${botToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ recipient_id: r.userId }),
    });
    if (!resp.ok) throw new Error(`open DM channel → ${resp.status}`);
    const dm = await resp.json().catch(() => null);
    if (!dm || !dm.id) throw new Error('no DM channel id');
    dmChannelId = String(dm.id);
    cardRequests.setDmChannel(r.id, { channelId: dmChannelId });
  }

  const qs = r.dmWatermark ? `?limit=${PAGE}&after=${r.dmWatermark}` : `?limit=${PAGE}`;
  const resp = await fetch(`${API}/channels/${dmChannelId}/messages${qs}`, {
    headers: { Authorization: `Bot ${botToken}` },
  });
  if (!resp.ok) throw new Error(`read DM channel → ${resp.status}`);
  const msgs = await resp.json().catch(() => null);
  if (!Array.isArray(msgs) || !msgs.length) return 0;

  // Discord returns newest-first. Sort ascending so the thread reads in order and the cursor
  // lands on the true newest id.
  const asc = msgs.slice().sort((a, b) => cmpSnowflake(String(a.id), String(b.id)));
  const newest = String(asc[asc.length - 1].id);

  // Only the requester's own messages are replies. This one filter drops our bot's sends with
  // no bot-user-id lookup.
  let inbound = asc.filter(m => m.author && String(m.author.id) === String(r.userId));

  // Bootstrap (no cursor yet): the window is the channel's whole recent history, so keep only
  // what arrived after our last DM. Date.parse both sides — Discord stamps look like
  // "…+00:00" and lastDmAt like "…Z", which do NOT compare correctly as raw strings.
  if (!r.dmWatermark) {
    inbound = r.lastDmAt
      ? inbound.filter(m => m.timestamp && Date.parse(m.timestamp) > Date.parse(r.lastDmAt))
      : []; // a row with a dmLog always has lastDmAt; if it somehow doesn't, ingest nothing
  }

  for (const m of inbound) {
    cardRequests.recordReply(r.id, { messageId: String(m.id), content: m.content || '', at: m.timestamp });
  }

  // Advance even when everything was filtered out — otherwise the same window refetches forever.
  cardRequests.setDmChannel(r.id, { watermark: newest });

  // One ping per request per tick, not one per message.
  if (inbound.length) await notify(botToken, channelId, cardRequests.getRequest(r.id) || r, inbound);
  return inbound.length;
}

function startDmPolling({ cardRequests, getPlatformBotToken, channelId, intervalMs = DEFAULT_INTERVAL_MS }) {
  let running = false;

  async function tick() {
    if (running) return; // never stack ticks behind a slow Discord call
    const botToken = getPlatformBotToken && getPlatformBotToken();
    if (!botToken) return;
    running = true;
    try {
      // Closed requests are done conversations; a request never DM'd has no channel to read.
      const open = cardRequests.listRequests().filter(
        r => cardRequests.OPEN_STATUSES.has(r.status) && Array.isArray(r.dmLog) && r.dmLog.length
      );
      for (const r of open) {
        try {
          await pollOne({ cardRequests, botToken, channelId }, r);
        } catch (e) {
          console.error(`[dmpoll] ${r.id}: ${e.message}`);
        }
      }
    } finally {
      running = false;
    }
  }

  const timer = setInterval(tick, intervalMs);
  if (timer.unref) timer.unref(); // never hold a test run or a maintenance script open
  console.log(`[dmpoll] Shop Request DM reply polling every ${Math.round(intervalMs / 1000)}s`);
  return { tick, stop: () => clearInterval(timer) };
}

module.exports = { startDmPolling };
