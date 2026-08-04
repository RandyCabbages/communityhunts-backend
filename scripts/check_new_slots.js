#!/usr/bin/env node
//
// Scrapes Rainbet's full slot catalog and merges any newly-discovered slots
// into rainbet_slots.json. Idempotent — re-running makes no changes if
// everything is already present.
//
// Designed to run inside GitHub Actions (see .github/workflows/check-rainbet-slots.yml).
// Locally: `node scripts/check_new_slots.js` from the backend repo root.
//
// Rainbet is a Next.js SPA behind Cloudflare. This script:
//   1. Tries a direct API fetch first (fastest, no browser needed)
//   2. Falls back to headless Chromium with stealth if the API is unavailable
// Both paths merge results into rainbet_slots.json.

const fs = require('fs');
const path = require('path');
const { canonKey, splitSlug } = require('../lib/slotSlugCanon');
const { removalAllowed } = require('../lib/rainbetReconcile');

const SLOTS_URL = 'https://rainbet.com/casino/slots';
const SLOTS_FILE = path.join(process.cwd(), 'rainbet_slots.json');
const MAX_RETRIES = 3;

// Default storage: the committed file. runCheck() takes overrides — see its header.
function readSlotsFile() {
  if (!fs.existsSync(SLOTS_FILE)) {
    throw new Error(`${SLOTS_FILE} not found — run from backend repo root`);
  }
  return JSON.parse(fs.readFileSync(SLOTS_FILE, 'utf8'));
}

function writeSlotsFile(entries) {
  fs.writeFileSync(SLOTS_FILE, JSON.stringify(entries, null, 2) + '\n');
}

// Ghost guard (2026-07-22): confirm a candidate's thumbnail actually resolves before
// writing it to the file. This stops dead SoftSwiss *guesses* (and thumbless rows) for
// games Rainbet doesn't carry from entering the catalog — those rendered as missing-thumb
// "ghost" tiles in the slot picker. Real Rainbet games (Strategy 1/3 carry live CDN
// thumbs; Strategy 2 reviewed thumbs) pass; a guess that happens to be live also passes
// and is kept. Rainbet's own CDN 401s to a bare request but renders in-app, so a 401 is
// trusted rather than dropped.
async function thumbResolves(url) {
  if (!url || !url.trim()) return false;
  try {
    const res = await fetch(url, { headers: { Referer: 'https://communityhunts.gg', 'User-Agent': 'Mozilla/5.0' } });
    if (res.status === 401) return true;
    if (!res.ok) return false;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 800) return false;
    // slot.report's generic placeholder (1000x563, ~7790 bytes) is not a real thumb
    if (/slot\.report\/images\/slots\//.test(url) && buf.length === 7790) return false;
    return true;
  } catch { return false; }
}

// Cloudflare's Managed Challenge on rainbet.com no longer clears for headless
// Chromium (even patched via patchright) — it hangs on "Checking your browser…"
// → "Just a moment…" forever. A HEADED browser clears it in ~5s. Default stays
// headless (preserves the in-process Railway sync, which runs without a display);
// set SCRAPE_HEADLESS=false + run under a virtual display (xvfb-run) to actually
// get past Cloudflare — that's what the GitHub Actions backup workflow does.
const HEADLESS = process.env.SCRAPE_HEADLESS !== 'false';

// Titles Cloudflare shows while a challenge is in-flight. "checking your browser"
// was missing before, so the old heuristic thought the challenge had already
// cleared and bailed straight into the (doomed) card wait.
const CF_TITLE_MARKERS = ['just a moment', 'attention required', 'cloudflare', 'checking your browser'];
const isCfTitle = t => { const s = (t || '').toLowerCase(); return CF_TITLE_MARKERS.some(m => s.includes(m)); };

// slot.report provider_slug → Rainbet URL prefix
const SLOT_REPORT_TO_RAINBET = {
  'playngo':'play-n-go','hacksaw-gaming':'hacksaw','nolimit-city':'nolimit',
  'blueprint-gaming':'blueprint','relax-gaming':'relax','iron-dog-studio':'iron-dog',
  'backseat-gaming':'backseat-gaming','bullshark-games':'bullshark-games',
  'print-studios':'print-studios','nownow-gaming':'nownow-gaming',
  'trusty-gaming':'trusty-gaming','kitsune-studios':'kitsune-studios',
  'foxhound-games':'foxhound-games','jinx-gaming':'jinx-gaming',
  'pineapple-play':'pineapple-play',
};

// slot.report provider_slug → SoftSwiss CDN provider segment (real thumbnails for
// slots slot.report hasn't reviewed). Mirrors lib/slots.js + frontend slotThumb.js.
const SOFTSWISS_PROVIDER = {
  'pragmatic-play':'pragmatic','playngo':'playngo','hacksaw-gaming':'hacksaw',
  'nolimit-city':'nolimitcity','elk-studios':'elk','red-tiger':'redtiger',
  'relax-gaming':'relax','bgaming':'bgaming','thunderkick':'thunderkick',
  'yggdrasil':'yggdrasil','push-gaming':'pushgaming','netent':'netent',
  'quickspin':'quickspin','blueprint-gaming':'blueprint','big-time-gaming':'bigtimegaming',
  'spinomenal':'spinomenal','isoftbet':'isoftbet','wazdan':'wazdan',
  'iron-dog-studio':'irondog','gameart':'gameart','gamomat':'gamomat',
};
const toPascal = slug => slug.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join('');

// Constructed slugs that don't match Rainbet's real URL (verified in a browser —
// a wrong slug 404s). slot.report says "chaos-crew-2"; Rainbet serves …-chaos-crew-ii.
const SLUG_FIXES = {
  'hacksaw-chaos-crew-2': 'hacksaw-chaos-crew-ii',
  // slot.report says "phoenix-duel-reels"; Rainbet serves the slug as one word,
  // hacksaw-phoenix-duelreels (the hyphenated form 404s). Verified on rainbet.com.
  'hacksaw-phoenix-duel-reels': 'hacksaw-phoenix-duelreels',
  // slot.report constructs "…bonanza-keeping-it-reel"; Rainbet serves the game at
  // pragmatic-play-big-bass-keeping-it-reel (the bonanza form 404s). Verified on rainbet.com.
  'pragmatic-play-big-bass-bonanza-keeping-it-reel': 'pragmatic-play-big-bass-keeping-it-reel',
  // slot.report has two rows for this game; its "mr-null-s-wicked-wares" slug has no real
  // thumb (falls back to slot.report's generic placeholder). Collapse onto the reviewed
  // "mr-nulls-wicked-wares" row, which carries a real Rainbet-CDN thumb. Verified on rainbet.com.
  'pragmatic-play-mr-null-s-wicked-wares': 'pragmatic-play-mr-nulls-wicked-wares',
  // slot.report constructs "six-six-six"; Rainbet serves this Hacksaw game as one word,
  // hacksaw-sixsixsix (its CDN thumb is SixSixSix.png). The dashed row only had a slot.report
  // thumb; collapse onto the reviewed "sixsixsix" row (real Rainbet-CDN thumb). Verified on rainbet.com.
  'hacksaw-six-six-six': 'hacksaw-sixsixsix',
  // slot.report renders an apostrophe as its own "-s-" segment; Rainbet keeps the clean
  // form. Each dashed slug was a duplicate row pointing at the (now dead) DigitalOcean
  // Spaces CDN. Collapse onto the real Rainbet slug. Verified via the games API.
  'pragmatic-play-magician-s-secrets': 'pragmatic-play-magicians-secrets',
  'pragmatic-play-caishen-s-gold': 'pragmatic-play-caishens-gold',
  'pragmatic-play-lobster-bob-s-crazy-crab-shack': 'pragmatic-play-lobster-bobs-crazy-crab-shack',
  // slot.report appends the full subtitle; Rainbet serves these shorter. Verified via the games API.
  'pragmatic-play-little-gem-hold-and-spin': 'pragmatic-play-little-gem',
  'pragmatic-play-the-dragon-tiger': 'pragmatic-play-dragon-tiger',
};

const RELEVANT_PROVIDERS = new Set([
  'pragmatic-play','playngo','hacksaw-gaming','elk-studios','red-tiger',
  'relax-gaming','quickspin','blueprint-gaming','nolimit-city','bgaming',
  'thunderkick','yggdrasil','push-gaming','netent','isoftbet','gameart',
  'wazdan','big-time-gaming','iron-dog-studio','spinomenal',
  'bullshark-games','backseat-gaming','print-studios','nownow-gaming',
  'trusty-gaming','kitsune-studios','ace-roll','foxhound-games',
  'jinx-gaming','pineapple-play',
  'habanero','endorphina','betsoft','1spin4win','pgsoft','mascot',
  'peter-and-sons','3-oaks','belatra','platipus','avatarux',
  'truelab','slotmill','fantasma','popiplay','gamomat','onetouch',
  'massive-studios','clutch-gaming','shady-lady',
  'playnetic','amigo-gaming','penguin-king','mascot-gaming','aceroll',
]);

// ── Strategy 1: slot.report API (no Cloudflare, always works) ───────
// Fetches the full slot catalog from slot.report, filters to Rainbet-
// available providers, constructs Rainbet slugs, and finds thumbnails.
async function trySlotReport() {
  console.log('[slot.report] fetching slot catalog + thumbnails…');
  // slot.report's nginx now 403s requests without a same-origin Referer.
  // Send browser-like headers so the API + thumbnail endpoints respond.
  const slotReportHeaders = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
      + '(KHTML, like Gecko) Chrome/137.0.6934.79 Safari/537.36',
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'en-US,en;q=0.9',
    'Referer': 'https://slot.report/',
  };
  const [gamesRes, thumbRes] = await Promise.all([
    fetch('https://slot.report/api/v1/slots.json', { headers: slotReportHeaders }),
    fetch('https://slot.report/data/slots-cards.js', { headers: slotReportHeaders }),
  ]);
  if (!gamesRes.ok) { console.log(`[slot.report] slots.json → ${gamesRes.status}`); return null; }

  const gamesData = await gamesRes.json();
  const allGames = (gamesData.results || []).filter(s => s.name);
  console.log(`[slot.report] ${allGames.length} total slots from API`);

  // Build thumbnail map from reviewed slots
  const thumbMap = {};
  const thumbText = await thumbRes.text();
  const thumbMatch = thumbText.match(/var SLOT_DATA=([\s\S]*?]);/);
  if (thumbMatch) {
    try {
      const reviewed = JSON.parse(thumbMatch[1]);
      reviewed.forEach(s => {
        if (s.slug && s.thumbnail) {
          thumbMap[s.slug] = `https://slot.report${s.thumbnail.split('?')[0]}`;
        }
      });
      console.log(`[slot.report] ${Object.keys(thumbMap).length} reviewed thumbnails`);
    } catch (e) { console.error('[slot.report] failed to parse slots-cards.js:', e.message); }
  }

  // Filter to providers available on Rainbet
  const relevant = allGames.filter(g => RELEVANT_PROVIDERS.has(g.provider_slug));
  console.log(`[slot.report] ${relevant.length} slots from Rainbet-available providers`);

  // Construct Rainbet slugs and find thumbnails.
  // Thumb source priority: slot.report reviewed thumb (real) → SoftSwiss CDN guess
  // (verified later by HEAD) → none. The old cdn.rainbet.com/{name}.png pattern was
  // dropped — Rainbet appends opaque filename suffixes (" cvf", " PR Original") so a
  // bare-name URL 404s for every slot, and slot.report's /images/slots/{slug}-thumb.webp
  // returns a generic placeholder for unreviewed slugs. SoftSwiss URLs that 404 are
  // filtered out by verifyAll, so only real thumbnails ever get committed.
  const results = [];
  let reviewedThumbs = 0, softswissGuess = 0;
  for (const g of relevant) {
    const rbProvider = SLOT_REPORT_TO_RAINBET[g.provider_slug] || g.provider_slug;
    // slot.report suffixes some Pragmatic entries "… Slot by Pragmatic Play"; Rainbet's
    // real slug/name never carries it (CULT. lives at pragmatic-play-cult), so a
    // constructed slug keeping the suffix 404s AND duplicates the clean row.
    const slug = g.slug.replace(/-slot-by-pragmatic-play.*$/, '');
    const name = g.name.replace(/\s+slot by pragmatic play.*$/i, '');
    const built = `${rbProvider}-${slug}`;
    const rainbetSlug = SLUG_FIXES[built] || built;
    let thumb = thumbMap[g.slug] || null;
    if (thumb) {
      reviewedThumbs++;
    } else {
      const ss = SOFTSWISS_PROVIDER[g.provider_slug];
      if (ss) { thumb = `https://cdn.softswiss.net/i/s4/${ss}/${toPascal(g.slug)}.webp`; softswissGuess++; }
    }

    results.push({ rainbetSlug, name, thumb });
  }

  console.log(`[slot.report] ${results.length} slots ready (${reviewedThumbs} reviewed thumbs, ${softswissGuess} SoftSwiss guesses to verify, ${results.length - reviewedThumbs - softswissGuess} without a thumb source)`);
  return results.length > 100 ? results : null;
}

// ── Rainbet New Releases scrape ─────────────────────────────────────
// Small page, no infinite scroll — grabs the ~20-50 newest slots directly.
//
// Rainbet's Cloudflare sits behind a Managed Challenge that blocked vanilla
// Playwright+stealth-plugin even with headless:false from a residential IP
// (confirmed via cf-mitigated:challenge header — it fingerprints the Chrome
// DevTools Protocol connection itself, not just headless-mode signals or IP
// reputation). patchright is a patched Playwright fork that strips those CDP
// artifacts; it replaces playwright-extra + puppeteer-extra-plugin-stealth
// entirely — don't layer those back on top of it.
async function scrapeNewReleases() {
  let chromium;
  try {
    chromium = require('patchright').chromium;
  } catch (e) {
    console.log('[new-releases] patchright not installed — skipping');
    return [];
  }

  for (let attempt = 1; attempt <= 2; attempt++) {
    console.log(`[new-releases] attempt ${attempt}/2`);
    let browser;
    try {
      browser = await chromium.launch({ headless: HEADLESS });
      const ctx = await browser.newContext({
        viewport: { width: 1280, height: 900 }, locale: 'en-US', timezoneId: 'America/Chicago',
      });
      const page = await ctx.newPage();

      console.log(`[new-releases] navigating to https://rainbet.com/new-releases (headless=${HEADLESS})`);
      await page.goto('https://rainbet.com/new-releases', { waitUntil: 'domcontentloaded', timeout: 60_000 });

      // Cloudflare challenge
      const title = await page.title();
      if (isCfTitle(title)) {
        console.log(`[new-releases] Cloudflare challenge ("${title}") — waiting…`);
        try {
          await page.waitForFunction(
            markers => !markers.some(m => document.title.toLowerCase().includes(m)),
            CF_TITLE_MARKERS, { timeout: 30_000 }
          );
        } catch {
          console.log('[new-releases] challenge did NOT clear');
          await browser.close();
          if (attempt < 2) { await new Promise(r => setTimeout(r, 15_000)); continue; }
          return [];
        }
        await page.waitForTimeout(3000);
      }

      // Wait for slot cards
      try {
        await page.waitForSelector('a[href*="/casino/slots/"]', { timeout: 30_000 });
      } catch {
        console.log('[new-releases] no slot cards found');
        await browser.close();
        if (attempt < 2) { await new Promise(r => setTimeout(r, 15_000)); continue; }
        return [];
      }

      await page.waitForTimeout(2000);

      // Click "Load more" a few times in case they paginate new releases
      for (let i = 0; i < 10; i++) {
        const loadMore = await page.$('button:has-text("Load more"), button:has-text("load more")');
        if (!loadMore || !(await loadMore.isVisible().catch(() => false))) break;
        await loadMore.scrollIntoViewIfNeeded().catch(() => {});
        await loadMore.click().catch(() => {});
        await page.waitForTimeout(500);
      }

      const games = await page.$$eval('a[href*="/casino/slots/"]', els => {
        const seen = new Set();
        const results = [];
        for (const a of els) {
          const href = a.getAttribute('href') || '';
          const slug = href.replace('/casino/slots/', '');
          if (!slug || slug.length < 2 || slug.includes('?') || seen.has(slug)) continue;
          seen.add(slug);
          const img = a.querySelector('img');
          let thumb = null;
          if (img) {
            const src = img.getAttribute('src') || '';
            try {
              const u = new URL(src, 'https://rainbet.com');
              const original = u.searchParams.get('url');
              thumb = original ? decodeURIComponent(original) : src;
            } catch { thumb = src; }
          }
          const name = img?.alt || slug.replace(/^[a-z]+-[a-z]+-/, '').replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
          results.push({ rainbetSlug: slug, name, thumb });
        }
        return results;
      });

      await browser.close();
      console.log(`[new-releases] found ${games.length} slots`);
      return games;
    } catch (e) {
      console.error(`[new-releases] attempt ${attempt} error:`, e.message);
      if (browser) await browser.close().catch(() => {});
      if (attempt < 2) await new Promise(r => setTimeout(r, 15_000));
    }
  }
  return [];
}

// ── Full catalog browser scrape ─────────────────────────────────────
// See the patchright note above scrapeNewReleases — same Cloudflare Managed
// Challenge applies to this page too, so this uses patchright too.
async function scrapeBrowser() {
  const { chromium } = require('patchright');

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    console.log(`[scrape] attempt ${attempt}/${MAX_RETRIES}`);
    let browser;
    try {
      browser = await chromium.launch({ headless: HEADLESS });

      const ctx = await browser.newContext({
        viewport: { width: 1280, height: 900 },
        locale: 'en-US',
        timezoneId: 'America/Chicago',
      });

      const page = await ctx.newPage();

      // Log API-like requests so we can discover endpoints for Strategy 1
      const apiHits = [];
      page.on('response', resp => {
        const url = resp.url();
        const ct = resp.headers()['content-type'] || '';
        if ((url.includes('/api/') || url.includes('graphql') || url.includes('/_next/data/'))
            && ct.includes('json')) {
          apiHits.push({ url, status: resp.status() });
        }
      });

      console.log(`[scrape] navigating to ${SLOTS_URL}`);
      await page.goto(SLOTS_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });

      // ── Cloudflare challenge detection + waiting ──
      const title = await page.title();
      console.log(`[scrape] page title: "${title}"`);

      const isCfChallenge = isCfTitle(title);

      if (isCfChallenge) {
        console.log('[scrape] Cloudflare challenge detected — waiting for it to clear…');
        // Wait for the page title to change (CF redirects after challenge solves)
        try {
          await page.waitForFunction(
            markers => !markers.some(m => document.title.toLowerCase().includes(m)),
            CF_TITLE_MARKERS, { timeout: 30_000 }
          );
          console.log('[scrape] challenge cleared');
        } catch {
          console.log('[scrape] challenge did NOT clear within 30s');
          await browser.close();
          if (attempt < MAX_RETRIES) {
            const delay = attempt * 15_000;
            console.log(`[scrape] waiting ${delay / 1000}s before retry…`);
            await new Promise(r => setTimeout(r, delay));
          }
          continue;
        }
        // Extra settle time after challenge
        await page.waitForTimeout(3000);
      }

      // Wait for actual slot cards to appear
      console.log('[scrape] waiting for slot cards…');
      try {
        await page.waitForSelector('a[href*="/casino/slots/"]', { timeout: 45_000 });
      } catch {
        console.log('[scrape] no slot cards found — page may still be blocked');
        const bodyText = await page.textContent('body').catch(() => '');
        console.log(`[scrape] body preview: "${bodyText.slice(0, 300)}"`);
        await browser.close();
        if (attempt < MAX_RETRIES) {
          const delay = attempt * 15_000;
          console.log(`[scrape] waiting ${delay / 1000}s before retry…`);
          await new Promise(r => setTimeout(r, delay));
        }
        continue;
      }

      await page.waitForTimeout(2000);

      // Click "Load more" until it disappears to reveal the full catalog
      let clicks = 0;
      const maxClicks = 500;
      while (clicks < maxClicks) {
        const loadMore = await page.$('button:has-text("Load more"), button:has-text("load more")');
        if (!loadMore) break;

        const visible = await loadMore.isVisible().catch(() => false);
        if (!visible) break;

        await loadMore.scrollIntoViewIfNeeded().catch(() => {});
        await loadMore.click().catch(() => {});
        clicks++;
        await page.waitForTimeout(400);

        if (clicks % 20 === 0) {
          const count = await page.$$eval('a[href*="/casino/slots/"]', els => {
            const slugs = new Set();
            for (const a of els) {
              const s = a.getAttribute('href')?.replace('/casino/slots/', '');
              if (s && s.length > 1 && !s.includes('?')) slugs.add(s);
            }
            return slugs.size;
          });
          console.log(`  … ${clicks} clicks, ${count} slots loaded`);
        }
      }
      console.log(`[scrape] finished loading (${clicks} "Load more" clicks)`);

      // Extract all slot data from the DOM
      const games = await page.$$eval('a[href*="/casino/slots/"]', els => {
        const seen = new Set();
        const results = [];
        for (const a of els) {
          const href = a.getAttribute('href') || '';
          const slug = href.replace('/casino/slots/', '');
          if (!slug || slug.length < 2 || slug.includes('?') || seen.has(slug)) continue;
          seen.add(slug);

          const img = a.querySelector('img');
          let thumb = null;
          if (img) {
            const src = img.getAttribute('src') || '';
            try {
              const u = new URL(src, 'https://rainbet.com');
              const original = u.searchParams.get('url');
              thumb = original ? decodeURIComponent(original) : src;
            } catch {
              thumb = src;
            }
          }

          const name = img?.alt || slug.replace(/^[a-z]+-[a-z]+-/, '').replace(/-/g, ' ')
            .replace(/\b\w/g, c => c.toUpperCase());

          results.push({ rainbetSlug: slug, name, thumb });
        }
        return results;
      });

      // Log discovered API endpoints for future reference
      if (apiHits.length) {
        console.log(`[scrape] discovered ${apiHits.length} API-like response(s):`);
        for (const h of apiHits.slice(0, 15)) console.log(`  ${h.status} ${h.url}`);
      }

      await browser.close();

      if (games.length > 0) {
        console.log(`[scrape] extracted ${games.length} slots`);
        return games;
      }

      console.log('[scrape] extracted 0 slots from DOM');
      if (attempt < MAX_RETRIES) {
        const delay = attempt * 15_000;
        console.log(`[scrape] waiting ${delay / 1000}s before retry…`);
        await new Promise(r => setTimeout(r, delay));
      }
    } catch (e) {
      console.error(`[scrape] attempt ${attempt} error:`, e.message);
      if (browser) await browser.close().catch(() => {});
      if (attempt < MAX_RETRIES) {
        const delay = attempt * 15_000;
        console.log(`[scrape] waiting ${delay / 1000}s before retry…`);
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }

  return [];
}

// Runs the full scrape + merge + write pipeline once. Returns a summary instead
// of exiting the process, so it's safe to call from a long-running server.
//
// Storage is INJECTED. Both hooks default to rainbet_slots.json, which is what the CLI and the
// GitHub Actions run want; the in-process sync on Railway passes Postgres-backed ones instead
// (lib/rainbetSlotSync.js), because a file the deploy resets could not keep the catalogue alive.
//
// They must be passed as a PAIR. Reading the file while writing the database would compute `kept`
// from a stale base, and since the write replaces the whole catalogue that would delete every row
// the file has not caught up with yet.
async function runCheck({ readExisting, writeResult } = {}) {
  // Strategy 1: Rainbet new releases page (targeted, fast)
  const newReleases = await scrapeNewReleases().catch(e => {
    console.error('[new-releases] failed:', e.message);
    return [];
  });

  // Strategy 2: slot.report API (bulk catalog, reliable)
  let games = await trySlotReport().catch(e => {
    console.error('[slot.report] failed:', e.message);
    return null;
  });

  // slot.report only reconstructs slugs for a curated provider list (RELEVANT_PROVIDERS)
  // — it's not a full enumeration of everything actually live on Rainbet. Only a real
  // DOM crawl of rainbet.com (Strategy 3) is trustworthy enough to say a slot was removed.
  let isFullCatalog = false;

  // Strategy 3: full browser scrape (fallback if slot.report fails)
  if (!games || games.length === 0) {
    console.log('[check] slot.report returned nothing — falling back to full browser scrape');
    games = await scrapeBrowser();
    isFullCatalog = games.length > 0;
  }

  // Merge new releases into the games list (new releases take priority —
  // they have exact Rainbet slugs and CDN thumbs straight from the site)
  if (newReleases.length > 0) {
    // Key by canonKey, NOT the literal slug. Rainbet serves some titles as playn-go-… and
    // others as play-n-go-… with no derivable rule, so a literal comparison treats the two
    // spellings of one game as different rows. That is exactly what happened: this merge
    // re-added a duplicate for every Play'n GO title already in the catalog — 294 of them in
    // one run — which is why the catalog kept needing scripts/dedupe_rainbet_slots.js.
    // The slot.report merge below already keys on canonKey; this path was the one that didn't,
    // despite lib/slotSlugCanon.js existing for precisely this ("so the slot.report merge
    // can't re-add a variant of a row the catalog already has").
    const gameSlugs = new Set((games || []).map(g => canonKey(g.rainbetSlug || '')));
    let merged = 0;
    for (const nr of newReleases) {
      const k = canonKey(nr.rainbetSlug || '');
      if (!gameSlugs.has(k)) {
        (games || (games = [])).push(nr);
        gameSlugs.add(k);
        merged++;
      }
    }
    console.log(`[check] merged ${merged} new-release slots not in slot.report`);
  }

  if (!Array.isArray(games) || games.length === 0) {
    throw new Error('all strategies failed — no slots extracted. Cloudflare may have blocked us.');
  }
  console.log(`[check] got ${games.length} slots total`);

  const existing = readExisting ? await readExisting() : readSlotsFile();
  if (!Array.isArray(existing)) {
    throw new Error('could not read the existing slot catalogue — refusing to rebuild it from scratch');
  }

  // Entries with a real thumb are done. Null-thumb entries stay eligible to be
  // reconsidered each cycle — the frontend already renders a branded fallback tile
  // for a missing/broken thumb (src/slotThumb.js), so there's no UX cost to adding a
  // slot before a real image is available, and no HEAD-check gate is needed either:
  // a guessed thumb that turns out dead just degrades to that same fallback tile.
  const existingBySlug = new Map(existing.map(s => [(s.rainbetSlug || '').toLowerCase(), s]));
  // canonKey, not the literal slug — otherwise slot.report's provider-alias,
  // apostrophe and word-join variants each re-enter the file as a duplicate row.
  const seenSlugs = new Set(existing.filter(s => s.thumb).map(s => canonKey(s.rainbetSlug || '')));

  // Detect slots removed from Rainbet — only trust this when Strategy 3 actually ran
  // (see isFullCatalog above); slot.report's curated-provider reconstruction alone
  // would otherwise flag thousands of still-live slots as "removed".
  // Compare by canonKey, NOT the literal slug — the same rule the add path already uses. Rainbet
  // serves some titles as playn-go-… and others as play-n-go-… (461 vs 9 rows in the catalog
  // today), so a literal match flags whichever spelling the DOM did not serve as "removed" even
  // though the game is canonically present.
  const liveKeys = new Set(games.map(g => canonKey(g.rainbetSlug)));
  const removed = isFullCatalog
    ? existing.filter(s => !liveKeys.has(canonKey(s.rainbetSlug || '')))
    : [];

  // This script runs unattended every 10 minutes and AUTO-COMMITS to main, so removal goes through
  // the same class of gates the human-run reconcile script uses (lib/rainbetReconcile.removalAllowed):
  // provider count and catalog floor catch a partial/blocked crawl, and an absolute cap stops one
  // bad run deleting a large slice of the catalog. Set RAINBET_ALLOW_MASS_REMOVAL=1 for a genuine
  // mass delisting — that lifts the size cap only, never the crawl-health gates.
  const providerCount = new Set(
    games.map(g => splitSlug(g.rainbetSlug).providerToken).filter(Boolean)
  ).size;
  const gate = removalAllowed({
    isFullCatalog,
    removedCount: removed.length,
    existingCount: existing.length,
    providerCount,
    liveCount: liveKeys.size,
    override: process.env.RAINBET_ALLOW_MASS_REMOVAL === '1',
  });
  if (removed.length > 0 && !gate.ok) {
    console.error(`[check] REFUSING to remove ${removed.length} slot(s) — ${gate.reason}`);
    console.error('[check] keeping the catalog as-is; nothing will be deleted or committed this run');
  }
  if (gate.ok) {
    console.log(`[check] ${removed.length} slot(s) no longer on Rainbet — removing`);
    for (const r of removed.slice(0, 20)) console.log(`  - ${r.name}`);
    if (removed.length > 20) console.log(`  … and ${removed.length - 20} more`);
  }

  // Build new file: keep existing entries that are still live (preserves manual edits),
  // then append genuinely new slots.
  const kept = gate.ok
    ? existing.filter(s => liveKeys.has(canonKey(s.rainbetSlug || '')))
    : existing;

  const candidates = [];
  for (const g of games) {
    if (seenSlugs.has(canonKey(g.rainbetSlug))) continue;

    // Re-encode the path portion for safety
    if (g.thumb) {
      try {
        const u = new URL(g.thumb);
        u.pathname = u.pathname.split('/').map(seg =>
          encodeURIComponent(decodeURIComponent(seg))
        ).join('/');
        g.thumb = u.toString();
      } catch { /* leave as-is */ }
    }

    candidates.push(g);
  }

  // Log only the first few of each kind — a big batch (e.g. after a long outage)
  // can mean thousands of these in one run, which trips Railway's per-second log
  // rate limit and drops messages (including the summary line below).
  const LOG_SAMPLE = 20;
  let addedCount = 0, upgradedCount = 0;

  // Ghost guard (2026-07-22): pre-verify every candidate thumbnail that could be written
  // (a new slot, or a thumb upgrade of an existing null-thumb row). Only slots whose thumb
  // actually resolves are added/upgraded — dead SoftSwiss guesses / thumbless slot.report
  // rows for games Rainbet doesn't carry are skipped, so the picker stops showing
  // missing-thumb "ghost" tiles. Bounded to candidates (usually few per cycle).
  const toVerify = new Set();
  for (const g of candidates) {
    const ex = existingBySlug.get(g.rainbetSlug.toLowerCase());
    if (ex) { if (g.thumb && !ex.thumb) toVerify.add(g.thumb); }
    else if (g.thumb) toVerify.add(g.thumb);
  }
  const thumbOk = new Map();
  if (toVerify.size) {
    const urls = [...toVerify]; let vi = 0;
    await Promise.all(Array.from({ length: 20 }, async () => {
      while (vi < urls.length) { const u = urls[vi++]; thumbOk.set(u, await thumbResolves(u)); }
    }));
    const live = [...thumbOk.values()].filter(Boolean).length;
    console.log(`[check] verified ${urls.length} candidate thumbnail(s) — ${live} live, ${urls.length - live} dead/skipped`);
  }
  const thumbLive = t => !!t && thumbOk.get(t) === true;

  for (const g of candidates) {
    const key = g.rainbetSlug.toLowerCase();
    const existingEntry = existingBySlug.get(key);
    if (existingEntry) {
      // Was a null-thumb placeholder — upgrade it in place now that a verified thumb exists.
      if (g.thumb && !existingEntry.thumb && thumbLive(g.thumb)) {
        existingEntry.thumb = g.thumb;
        upgradedCount++;
        if (upgradedCount <= LOG_SAMPLE) console.log(`  ↑ upgraded thumbnail: ${g.name}  [${g.rainbetSlug}]`);
      }
    } else {
      // Only add a genuinely-new slot if its thumbnail resolves (no ghost rows).
      if (!thumbLive(g.thumb)) continue;
      kept.push(g);
      existingBySlug.set(key, g);
      addedCount++;
      if (addedCount <= LOG_SAMPLE) console.log(`  + ${g.name}  [${g.rainbetSlug}]`);
    }
  }
  if (addedCount > LOG_SAMPLE) console.log(`  … and ${addedCount - LOG_SAMPLE} more added`);
  if (upgradedCount > LOG_SAMPLE) console.log(`  … and ${upgradedCount - LOG_SAMPLE} more upgraded`);

  const changed = addedCount > 0 || upgradedCount > 0 || removed.length > 0;
  if (changed) {
    if (writeResult) await writeResult(kept);
    else writeSlotsFile(kept);
  } else {
    console.log('[check] no new slots, upgrades, or removals — catalogue already up to date');
  }
  console.log(`[check] done — catalogue now has ${kept.length} slots (was ${existing.length})`);
  // `entries` rides along so a caller that persists elsewhere doesn't have to re-read what it
  // just wrote to refresh its own in-memory copy.
  return { changed, added: addedCount, upgraded: upgradedCount, removed: removed.length,
    total: kept.length, entries: kept };
}

module.exports = { runCheck, readSlotsFile, writeSlotsFile };

if (require.main === module) {
  runCheck().catch(err => {
    console.error('[check] error:', err);
    process.exit(1);
  });
}
