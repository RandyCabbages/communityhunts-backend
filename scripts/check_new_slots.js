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

const SLOTS_URL = 'https://rainbet.com/casino/slots';
const SLOTS_FILE = path.join(process.cwd(), 'rainbet_slots.json');
const MAX_VERIFY_PARALLEL = 6;
const MAX_RETRIES = 3;

// ── Strategy 1: Direct API fetch ────────────────────────────────────
// Rainbet's Next.js frontend loads slot data from internal API routes.
// If we can hit those directly, we skip the browser entirely.
async function tryApiFetch() {
  const endpoints = [
    'https://rainbet.com/api/casino/games?category=slots&limit=10000',
    'https://rainbet.com/api/games?type=slots&limit=10000',
    'https://rainbet.com/api/casino/slots?limit=10000',
  ];

  for (const url of endpoints) {
    try {
      console.log(`[api] trying ${url}`);
      const res = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36',
          'Accept': 'application/json',
          'Referer': 'https://rainbet.com/casino/slots',
        },
      });
      if (!res.ok) { console.log(`  → ${res.status}`); continue; }
      const data = await res.json();
      const games = Array.isArray(data) ? data : (data.games || data.results || data.data || []);
      if (games.length > 100) {
        console.log(`[api] got ${games.length} slots from ${url}`);
        return games.map(g => ({
          rainbetSlug: g.slug || g.id || '',
          name: g.name || g.title || '',
          thumb: g.thumbnail || g.image || g.thumb || null,
        })).filter(g => g.rainbetSlug && g.name);
      }
    } catch (e) {
      console.log(`  → failed: ${e.message}`);
    }
  }
  return null;
}

// ── Strategy 2: Headless browser scrape ─────────────────────────────
async function scrapeBrowser() {
  const { addExtra } = require('playwright-extra');
  const { chromium } = require('playwright');
  const StealthPlugin = require('puppeteer-extra-plugin-stealth');

  const stealthChromium = addExtra(chromium);
  stealthChromium.use(StealthPlugin());

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    console.log(`[scrape] attempt ${attempt}/${MAX_RETRIES}`);
    let browser;
    try {
      browser = await stealthChromium.launch({
        headless: true,
        args: [
          '--disable-blink-features=AutomationControlled',
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
        ],
      });

      const ctx = await browser.newContext({
        userAgent:
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
          '(KHTML, like Gecko) Chrome/137.0.6934.79 Safari/537.36',
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

      const isCfChallenge = title.toLowerCase().includes('just a moment')
        || title.toLowerCase().includes('attention required')
        || title.toLowerCase().includes('cloudflare');

      if (isCfChallenge) {
        console.log('[scrape] Cloudflare challenge detected — waiting for it to clear…');
        // Wait for the page title to change (CF redirects after challenge solves)
        try {
          await page.waitForFunction(
            () => !document.title.toLowerCase().includes('just a moment')
               && !document.title.toLowerCase().includes('attention')
               && !document.title.toLowerCase().includes('cloudflare'),
            { timeout: 30_000 }
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

// HEAD-check a thumb URL to make sure CDN hosts it before we commit the entry.
async function verifyThumb(url) {
  try {
    const r = await fetch(url, { method: 'HEAD', redirect: 'follow' });
    return r.ok;
  } catch { return false; }
}

async function verifyAll(entries) {
  const out = [];
  for (let i = 0; i < entries.length; i += MAX_VERIFY_PARALLEL) {
    const batch = entries.slice(i, i + MAX_VERIFY_PARALLEL);
    const results = await Promise.all(batch.map(e =>
      e.thumb ? verifyThumb(e.thumb) : Promise.resolve(false)
    ));
    batch.forEach((e, idx) => {
      if (results[idx]) out.push(e);
      else console.log(`  ! skipping (thumb unreachable): ${e.name}`);
    });
  }
  return out;
}

(async () => {
  // Try direct API first (fast, no CF issues)
  let games = await tryApiFetch();

  // Fall back to browser scrape if API didn't work
  if (!games || games.length === 0) {
    console.log('[check] API fetch returned nothing — falling back to browser scrape');
    games = await scrapeBrowser();
  }

  if (!Array.isArray(games) || games.length === 0) {
    console.error('[check] all strategies failed — no slots extracted. Cloudflare may have blocked us.');
    process.exit(1);
  }
  console.log(`[check] got ${games.length} slots total`);

  if (!fs.existsSync(SLOTS_FILE)) {
    console.error(`[check] ${SLOTS_FILE} not found — run from backend repo root`);
    process.exit(1);
  }
  const existing = JSON.parse(fs.readFileSync(SLOTS_FILE, 'utf8'));
  const seenSlugs = new Set(existing.map(s => (s.rainbetSlug || '').toLowerCase()));

  // Detect slots removed from Rainbet
  const liveSlugs = new Set(games.map(g => g.rainbetSlug.toLowerCase()));
  const removed = existing.filter(s => !liveSlugs.has((s.rainbetSlug || '').toLowerCase()));
  if (removed.length > 0 && removed.length < existing.length * 0.5) {
    console.log(`[check] ${removed.length} slot(s) no longer on Rainbet — removing`);
    for (const r of removed.slice(0, 20)) console.log(`  - ${r.name}`);
    if (removed.length > 20) console.log(`  … and ${removed.length - 20} more`);
  }

  // Build new file: keep existing entries that are still live (preserves manual edits),
  // then append genuinely new slots.
  const kept = removed.length < existing.length * 0.5
    ? existing.filter(s => liveSlugs.has((s.rainbetSlug || '').toLowerCase()))
    : existing;

  const candidates = [];
  for (const g of games) {
    if (seenSlugs.has(g.rainbetSlug.toLowerCase())) continue;
    if (!g.thumb) continue;

    // Re-encode the path portion for safety
    try {
      const u = new URL(g.thumb);
      u.pathname = u.pathname.split('/').map(seg =>
        encodeURIComponent(decodeURIComponent(seg))
      ).join('/');
      g.thumb = u.toString();
    } catch { /* leave as-is */ }

    candidates.push(g);
  }

  if (candidates.length === 0 && removed.length === 0) {
    console.log('[check] no new slots and nothing removed — DB already up to date');
    return;
  }

  if (candidates.length > 0) {
    console.log(`[check] ${candidates.length} candidate(s) not in DB; verifying thumbnails…`);
    const verified = await verifyAll(candidates);
    console.log(`[check] ${verified.length} passed thumbnail verification`);

    for (const v of verified) {
      kept.push(v);
      console.log(`  + ${v.name}  [${v.rainbetSlug}]`);
    }
  }

  fs.writeFileSync(SLOTS_FILE, JSON.stringify(kept, null, 2) + '\n');
  console.log(`[check] done — file now has ${kept.length} slots (was ${existing.length})`);
})().catch(err => {
  console.error('[check] error:', err);
  process.exit(1);
});
