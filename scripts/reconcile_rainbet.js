#!/usr/bin/env node
//
// Daily reconciliation: authoritatively enumerate Rainbet's live catalog via the
// games API (per-provider, region-inclusive) and mark-then-sweep stale entries from
// rainbet_slots.json, plus emit rainbet_live_names.json (gates the slot.report merge
// in lib/slots.js). Runs headed under xvfb in GitHub Actions — a bare fetch/curl 403s
// (Cloudflare), so the API is called from a CF-cleared patchright page via page.evaluate.
//
// Local dry-run (Windows desktop, real display):
//   SCRAPE_HEADLESS=false node scripts/reconcile_rainbet.js --dry-run

const fs = require('fs');
const path = require('path');
const { reconcile, nameKey, providersGateOk, catalogFloorOk } = require('../lib/rainbetReconcile');

const ROOT = process.cwd();
const SLOTS_FILE = path.join(ROOT, 'rainbet_slots.json');
const LIVE_NAMES_FILE = path.join(ROOT, 'rainbet_live_names.json');

const PROVIDERS_URL = 'https://services.rainbet.com/v1/public/providers/list?country=US';
const GAMES_URL = 'https://services.rainbet.com/v1/public/games/list';

const HEADLESS = process.env.SCRAPE_HEADLESS !== 'false';
const CF_TITLE_MARKERS = ['just a moment', 'attention required', 'cloudflare', 'checking your browser'];
const isCfTitle = t => { const s = (t || '').toLowerCase(); return CF_TITLE_MARKERS.some(m => s.includes(m)); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

// One API GET from inside the CF-cleared page (inherits Cloudflare cookies).
function apiGet(page, url) {
  return page.evaluate(async (u) => {
    const r = await fetch(u, { headers: { accept: 'application/json' } });
    let body = null;
    try { body = await r.json(); } catch {}
    return { status: r.status, body };
  }, url);
}

async function clearCloudflare(page) {
  await page.goto('https://rainbet.com/casino/slots', { waitUntil: 'domcontentloaded', timeout: 60000 });
  for (let i = 0; i < 30; i++) {
    const title = await page.title().catch(() => '');
    if (!isCfTitle(title)) return true;
    await sleep(2000);
  }
  return false;
}

async function enumerateLiveNames(page) {
  const provRes = await apiGet(page, PROVIDERS_URL);
  const providers = ((provRes.body && (provRes.body.providers || provRes.body)) || [])
    .map(p => p.url).filter(Boolean);

  const liveNames = new Set();
  let gameCount = 0;

  for (const prov of providers) {
    let cursor = null;
    do {
      const url = `${GAMES_URL}?provider=${encodeURIComponent(prov)}&country=US&region=IA&limit=64`
        + (cursor ? `&cursor=${encodeURIComponent(cursor)}` : '');
      let res = await apiGet(page, url);
      // Aggressive rate limit: back off 90s and retry the same page.
      let guard = 0;
      while (res.status === 429 && guard++ < 5) { await sleep(90000); res = await apiGet(page, url); }
      if (res.status !== 200 || !res.body) break;
      for (const g of (res.body.games || [])) { liveNames.add(nameKey(g.name)); gameCount++; }
      cursor = res.body.next_cursor || null;
      await sleep(1800); // throttle
    } while (cursor);
  }

  return { liveNames, providerCount: providers.length, gameCount };
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const { chromium } = require('patchright');

  const browser = await chromium.launch({ headless: HEADLESS });
  let liveNames, providerCount, gameCount, cfCleared = true;
  try {
    const ctx = await browser.newContext({ userAgent: 'Mozilla/5.0' });
    const page = await ctx.newPage();
    if (!(await clearCloudflare(page))) {
      cfCleared = false;
    } else {
      ({ liveNames, providerCount, gameCount } = await enumerateLiveNames(page));
    }
  } finally {
    // Close the browser on every path. Do NOT process.exit inside the try —
    // that skips this finally and leaks the headed Chromium; abort after close.
    await browser.close().catch(() => {});
  }
  if (!cfCleared) {
    console.error('[reconcile] Cloudflare did not clear — aborting, no write');
    process.exit(1);
  }

  const entries = JSON.parse(fs.readFileSync(SLOTS_FILE, 'utf8'));

  // Safety gates — a broken/rate-limited crawl must never sweep the catalog.
  if (!providersGateOk(providerCount)) {
    console.error(`[reconcile] provider gate failed (got ${providerCount}, need >= 20) — no write`);
    process.exit(1);
  }
  if (!catalogFloorOk(liveNames.size, entries.length)) {
    console.error(`[reconcile] catalog-floor gate failed (live ${liveNames.size} vs catalog ${entries.length}) — no write`);
    process.exit(1);
  }

  const r = reconcile(entries, liveNames, { graceDays: 3 });
  console.log(`[reconcile] providers=${providerCount} games=${gameCount} live=${liveNames.size} | marked=${r.marked} cleared=${r.cleared} swept=${r.swept}`);
  if (r.markedNames.length) console.log(`[reconcile] newly marked: ${r.markedNames.slice(0, 30).join(', ')}${r.markedNames.length > 30 ? ' …' : ''}`);
  if (r.sweptNames.length) console.log(`[reconcile] swept: ${r.sweptNames.slice(0, 30).join(', ')}${r.sweptNames.length > 30 ? ' …' : ''}`);

  if (dryRun) {
    console.log('[reconcile] --dry-run: no files written');
    return;
  }

  fs.writeFileSync(SLOTS_FILE, JSON.stringify(r.entries, null, 2) + '\n');
  fs.writeFileSync(LIVE_NAMES_FILE, JSON.stringify({ generatedAt: new Date().toISOString(), names: [...liveNames].sort() }) + '\n');
  console.log(`[reconcile] wrote ${SLOTS_FILE} (${r.entries.length} entries) + ${LIVE_NAMES_FILE} (${liveNames.size} names)`);
}

main().catch(e => { console.error('[reconcile] fatal:', e); process.exit(1); });
