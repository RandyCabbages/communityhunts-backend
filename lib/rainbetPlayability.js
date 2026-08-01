// Playability probing for the Rainbet catalogue: does a game page actually start a
// session, as opposed to merely appearing in the catalogue listing?
//
// Presence in the listing is NOT proof of playability. Measured 2026-08-01 against a live
// session: avatarux-majestic-meow is returned by the games API as type=slots with
// region_blocked=false, and its player iframe never receives a src — a permanent black box.
// It is the reason this module exists; no listing-based check can see that class of rot.
//
// The observable: load https://rainbet.com/casino/slots/<slug>, let the player boot, and
// look for an iframe that got a real http(s) src. Verified across two independent runs —
// a live game's launcher iframe carries e.g. https://cdn.launcher.a8r.games/index.html?…
// while the dead one renders its iframes with an empty src.
//
//   avatarux-majestic-meow                (dead)  -> no launcher src
//   popiplay-keys-to-the-sea              (live)  -> launcher src
//   elk-studios-rogue-rats-of-nitropolis  (live)  -> launcher src
//   4x bgaming controls                   (live)  -> launcher src
//
// The probe is BLIND to region_blocked games: hacksaw-le-zeus, 3-oaks-power-sun and
// nolimit-duck-hunters-happy-hour are all playable on a real session and all show no
// launcher src from the crawl's vantage, because Rainbet won't boot a demo for a region it
// blocks. That is 56.6% of the catalogue and it cannot be widened by asking about another
// region — country=US&region=IA is the only parameter combination the games API accepts
// (NJ, bare US, CA, GB and no-params all return HTTP 400). Those entries resolve to
// 'unknown' and are left to the extension's authenticated 'no-session' telemetry.
//
// Bias: false 'alive' merely keeps a row that is already in the file; false 'dead' deletes
// a real game. So every ambiguity resolves toward keeping, and any iframe with an http(s)
// src counts as a launch.

const CF_TITLE_MARKERS = ['just a moment', 'attention required', 'cloudflare', 'checking your browser'];

// Turn one page observation into a verdict. Pure, so the decision is testable without
// driving a browser.
function classify(obs = {}) {
  const { regionBlocked, iframeSrcs, title, navError } = obs;

  // Anything that stopped us seeing the page is not evidence of anything.
  if (navError) return 'unknown';
  const t = (title || '').toLowerCase();
  if (!t || CF_TITLE_MARKERS.some(m => t.includes(m))) return 'unknown';

  // Rainbet titles a slug it no longer serves "404 – Rainbet". That is an explicit answer
  // rather than an inference, so it outranks everything below — including regionBlocked,
  // which cannot even arise here (a 404 slug is not in the listing to be flagged).
  if (/^404\b/.test(t)) return 'dead';

  // Rainbet will not boot a demo session for a region it blocks, so a missing launcher
  // here says nothing about whether the game works for a player who can reach it.
  if (regionBlocked) return 'unknown';

  // The subtle case, and the one this module exists for: the page renders its own title
  // perfectly happily and the player still never starts (avatarux-majestic-meow).
  const launched = (iframeSrcs || []).some(s => /^https?:\/\//i.test(String(s || '')));
  return launched ? 'alive' : 'dead';
}

// Which slugs to spend the probe budget on this run.
//
// `candidates` (absent from the listing but in a reachable provider) always go first: they
// are the only entries a sweep can actually delete, and probing them is what turns a
// listing absence into a confirmed removal. Whatever budget is left goes to entries the
// listing still carries, least-recently-probed first — that rolling audit is the only thing
// that ever finds a Majestic Meow, since it looks perfectly healthy in the listing.
//
// `history` is { slug: { checkedAt, verdict } }. A slug never probed sorts oldest.
function selectProbeTargets({
  candidates = [], present = [], history = {}, limit = 250,
  now = new Date(), recheckDays = 30,
} = {}) {
  const seen = new Set();
  const targets = [];

  for (const slug of candidates) {
    if (targets.length >= limit) break;
    if (seen.has(slug)) continue;
    seen.add(slug);
    targets.push(slug);
  }

  const cutoff = now.getTime() - recheckDays * 24 * 60 * 60 * 1000;
  const staleness = slug => {
    const h = history[slug];
    const ms = h && h.checkedAt ? Date.parse(h.checkedAt) : NaN;
    return Number.isNaN(ms) ? -Infinity : ms;   // never probed => oldest
  };
  const due = present
    .filter(slug => !seen.has(slug) && staleness(slug) < cutoff)
    .sort((a, b) => staleness(a) - staleness(b));

  for (const slug of due) {
    if (targets.length >= limit) break;
    seen.add(slug);
    targets.push(slug);
  }
  return targets;
}

// Fold this run's verdicts into the stored history. 'unknown' is recorded so the rotation
// does not retry an undecidable (region-blocked) slug every single night, but it is never
// allowed to look like evidence.
function mergeHistory(history, verdicts, now = new Date()) {
  const out = { ...history };
  const checkedAt = now.toISOString();
  for (const [slug, verdict] of verdicts) out[slug] = { checkedAt, verdict };
  return out;
}

module.exports = { classify, selectProbeTargets, mergeHistory };
