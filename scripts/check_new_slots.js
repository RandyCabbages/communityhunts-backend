#!/usr/bin/env node
//
// Scrapes Rainbet's "new releases" page using a stealthed Chromium and merges
// any newly-discovered slots into rainbet_slots.json. Idempotent — re-running
// makes no changes if everything is already present.
//
// Designed to run inside GitHub Actions (see .github/workflows/check-rainbet-slots.yml).
// Locally: `node scripts/check_new_slots.js` from the backend repo root.
//
// Why a real browser? Rainbet sits behind Cloudflare which challenges plain HTTP
// (cf-mitigated: challenge → 403). Playwright + stealth solves the challenge by
// being an actual Chrome, then we yank slot data out of the page's __NEXT_DATA__.

const fs = require('fs');
const path = require('path');
const { addExtra } = require('playwright-extra');
const { chromium } = require('playwright');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');

const stealthChromium = addExtra(chromium);
stealthChromium.use(StealthPlugin());

const URL_NEW_RELEASES = 'https://rainbet.com/new-releases';
const SLOTS_FILE = path.join(process.cwd(), 'rainbet_slots.json');
const MAX_VERIFY_PARALLEL = 6;

async function scrape() {
  const browser = await stealthChromium.launch({
    headless: true,
    args: ['--disable-blink-features=AutomationControlled'],
  });
  const ctx = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 800 },
    locale: 'en-US',
  });
  const page = await ctx.newPage();

  console.log(`[check] navigating to ${URL_NEW_RELEASES}`);
  await page.goto(URL_NEW_RELEASES, { waitUntil: 'domcontentloaded', timeout: 60_000 });

  // Wait either for __NEXT_DATA__ (page rendered) or the Cloudflare challenge to clear.
  await page.waitForSelector('script#__NEXT_DATA__', { timeout: 45_000 }).catch(() => {});

  const games = await page.evaluate(() => {
    const el = document.getElementById('__NEXT_DATA__');
    if (!el) return null;
    try {
      const data = JSON.parse(el.textContent);
      return data?.props?.pageProps?.initialData?.games || null;
    } catch { return null; }
  });

  await browser.close();
  return games;
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
    const results = await Promise.all(batch.map(e => verifyThumb(e.thumb)));
    batch.forEach((e, idx) => { if (results[idx]) out.push(e); else console.log(`  ! skipping (thumb unreachable): ${e.name}`); });
  }
  return out;
}

(async () => {
  const games = await scrape();
  if (!Array.isArray(games)) {
    console.error('[check] failed to extract games from page. Cloudflare may have blocked us.');
    process.exit(1);
  }
  console.log(`[check] found ${games.length} slots on the new-releases page`);

  if (!fs.existsSync(SLOTS_FILE)) {
    console.error(`[check] ${SLOTS_FILE} not found — run from backend repo root`);
    process.exit(1);
  }
  const existing = JSON.parse(fs.readFileSync(SLOTS_FILE, 'utf8'));
  const seenSlugs = new Set(existing.map(s => (s.rainbetSlug || '').toLowerCase()));
  const seenNames = new Set(existing.map(s => (s.name || '').toLowerCase()));

  // Build candidate entries, skipping anything we already have.
  const candidates = [];
  for (const g of games) {
    if (!g?.name || !g?.url) continue;
    const rainbetSlug = String(g.url).toLowerCase();
    if (seenSlugs.has(rainbetSlug)) continue;
    if (seenNames.has(String(g.name).toLowerCase())) continue;

    // Prefer custom_banner; fall back to icon if missing.
    let thumb = g.custom_banner || g.icon || null;
    if (!thumb) continue;

    // The original URL may have spaces / special chars in the filename. Re-encode
    // the path portion. server.js does this again at load time too, so this is
    // belt + suspenders.
    try {
      const u = new URL(thumb);
      u.pathname = u.pathname.split('/').map(seg => encodeURIComponent(decodeURIComponent(seg))).join('/');
      thumb = u.toString();
    } catch { /* leave as-is if URL parse fails */ }

    candidates.push({ name: g.name, rainbetSlug: g.url, thumb });
  }

  if (candidates.length === 0) {
    console.log('[check] no new slots — DB already up to date');
    return;
  }
  console.log(`[check] ${candidates.length} candidate(s) not in DB; verifying thumbnails…`);

  const verified = await verifyAll(candidates);
  if (verified.length === 0) {
    console.log('[check] no candidates passed thumbnail verification');
    return;
  }

  for (const v of verified) {
    existing.push(v);
    console.log(`  + ${v.name}  [${v.rainbetSlug}]`);
  }

  fs.writeFileSync(SLOTS_FILE, JSON.stringify(existing, null, 2) + '\n');
  console.log(`[check] added ${verified.length} entry/entries; file now has ${existing.length} total`);
})().catch(err => {
  console.error('[check] error:', err);
  process.exit(1);
});
