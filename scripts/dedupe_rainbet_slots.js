#!/usr/bin/env node
//
// One-shot: collapse duplicate rows in rainbet_slots.json onto the slug Rainbet
// actually serves. Crawls ONLY the providers that appear in collision groups, which
// keeps it well under the games API's aggressive rate limit (a full 56-provider
// crawl is scripts/reconcile_rainbet.js's job).
//
//   SCRAPE_HEADLESS=false node scripts/dedupe_rainbet_slots.js --dry-run
//   SCRAPE_HEADLESS=false node scripts/dedupe_rainbet_slots.js
//
// Headless hangs forever on Cloudflare — a headed browser clears it in ~5s.

const fs = require('fs');
const path = require('path');
const { planDedupe, nameKey } = require('../lib/slotDedupe');
const { splitSlug, PROVIDER_ALIASES } = require('../lib/slotSlugCanon');

const SLOTS_FILE = path.join(process.cwd(), 'rainbet_slots.json');
const PLAN_FILE = path.join(process.cwd(), 'dedupe_plan.json');
// The crawl is slow and rate-limited, so its result is cached to disk. --use-cache
// re-runs the resolution logic against it without hitting Rainbet again, which is
// what makes reviewing successive dry runs practical. Neither file is committed.
const LIVE_CACHE = path.join(process.cwd(), 'dedupe_live_cache.json');
const PROVIDERS_URL = 'https://services.rainbet.com/v1/public/providers/list?country=US';
const GAMES_URL = 'https://services.rainbet.com/v1/public/games/list';
const HEADLESS = process.env.SCRAPE_HEADLESS !== 'false';
const DELETION_CAP = 1671; // total rows currently sitting in collision groups

const sleep = ms => new Promise(r => setTimeout(r, ms));
const CF = ['just a moment', 'attention required', 'cloudflare', 'checking your browser'];
const isCfTitle = t => CF.some(m => (t || '').toLowerCase().includes(m));

const apiGet = (page, url) => page.evaluate(async (u) => {
  const r = await fetch(u, { headers: { accept: 'application/json' } });
  let body = null;
  try { body = await r.json(); } catch {}
  return { status: r.status, body };
}, url);

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const entries = JSON.parse(fs.readFileSync(SLOTS_FILE, 'utf8'));

  // Which providers own a collision group? Only those get crawled.
  const byName = new Map();
  for (const e of entries) {
    const k = nameKey(e.name);
    if (!byName.has(k)) byName.set(k, []);
    byName.get(k).push(e);
  }
  const collisionGroups = [...byName.values()].filter(v => v.length > 1);
  const needed = new Set();
  for (const rows of collisionGroups) {
    for (const r of rows) {
      const { providerToken } = splitSlug(r.rainbetSlug);
      needed.add(PROVIDER_ALIASES[providerToken] || providerToken);
    }
  }
  console.log(`[dedupe] ${collisionGroups.length} collision groups across ${needed.size} studios`);

  let liveByNameKey = new Map();

  if (process.argv.includes('--use-cache')) {
    if (!fs.existsSync(LIVE_CACHE)) throw new Error(`--use-cache but ${LIVE_CACHE} is missing`);
    liveByNameKey = new Map(JSON.parse(fs.readFileSync(LIVE_CACHE, 'utf8')));
    console.log(`[dedupe] using cached crawl: ${liveByNameKey.size} live names`);
    return finish(entries, liveByNameKey, dryRun);
  }

  const { chromium } = require('patchright');
  const browser = await chromium.launch({ headless: HEADLESS });
  try {
    const ctx = await browser.newContext({
      viewport: { width: 1280, height: 900 }, locale: 'en-US', timezoneId: 'America/Chicago',
    });
    const page = await ctx.newPage();
    await page.goto('https://rainbet.com/casino/slots', { waitUntil: 'domcontentloaded', timeout: 60000 });
    let cleared = false;
    for (let i = 0; i < 30; i++) {
      if (!isCfTitle(await page.title().catch(() => ''))) { cleared = true; break; }
      await sleep(2000);
    }
    if (!cleared) throw new Error('Cloudflare did not clear');

    let provRes = await apiGet(page, PROVIDERS_URL);
    // The providers call is the first thing to get rate-limited after a prior crawl.
    let pGuard = 0;
    while (provRes.status === 429 && pGuard++ < 5) {
      console.log('  providers 429 — backing off 90s');
      await sleep(90000);
      provRes = await apiGet(page, PROVIDERS_URL);
    }
    console.log(`[dedupe] providers/list → HTTP ${provRes.status}`);
    const all = ((provRes.body && (provRes.body.providers || provRes.body)) || []).map(p => p.url).filter(Boolean);
    const norm = s => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
    const targets = all.filter(p => [...needed].some(w => norm(p) === norm(w)
      || norm(p).startsWith(norm(w)) || norm(w).startsWith(norm(p))));
    console.log(`[dedupe] crawling ${targets.length}/${all.length} providers: ${targets.join(', ')}`);
    if (!targets.length) throw new Error('no providers matched — aborting');

    for (const prov of targets) {
      let cursor = null, count = 0;
      do {
        const url = `${GAMES_URL}?provider=${encodeURIComponent(prov)}&country=US&region=IA&limit=64`
          + (cursor ? `&cursor=${encodeURIComponent(cursor)}` : '');
        let res = await apiGet(page, url);
        let guard = 0;
        while (res.status === 429 && guard++ < 5) {
          console.log('  429 — backing off 90s');
          await sleep(90000);
          res = await apiGet(page, url);
        }
        if (res.status !== 200 || !res.body) break;
        for (const g of (res.body.games || [])) {
          const k = nameKey(g.name);
          if (!liveByNameKey.has(k)) liveByNameKey.set(k, []);
          liveByNameKey.get(k).push({ url: g.url, thumb: g.custom_banner || g.icon });
          count++;
        }
        cursor = res.body.next_cursor || null;
        await sleep(1800);
      } while (cursor);
      console.log(`  ${prov}: ${count} games`);
      // Gate: a silently empty provider would make all its rows look delisted and
      // collapse the wrong survivors. Abort rather than write a corrupt catalog.
      if (count === 0) throw new Error(`provider ${prov} returned 0 games — crawl unreliable, aborting`);
    }
  } finally {
    await browser.close().catch(() => {});
  }

  fs.writeFileSync(LIVE_CACHE, JSON.stringify([...liveByNameKey], null, 2));
  console.log(`[dedupe] crawl cached to ${LIVE_CACHE} (${liveByNameKey.size} live names)`);
  return finish(entries, liveByNameKey, dryRun);
}

function finish(entries, liveByNameKey, dryRun) {
  const r = planDedupe(entries, liveByNameKey);
  console.log(`[dedupe] keep=${r.keep.length} drop=${r.drop.length} kept-distinct=${r.distinctKept}`);

  const show = action => r.groups.filter(g => g.action === action);
  for (const g of show('kept-distinct')) console.log(`  distinct:      ${(g.kept || []).join('  |  ')}`);
  for (const g of show('cross-collapse')) console.log(`  cross-collapse: kept ${(g.kept || []).join(',')}  dropped ${(g.dropped || []).join(',')}`);
  for (const g of show('kept-unarbitrated')) console.log(`  unarbitrated:  ${(g.slugs || []).join('  |  ')}`);

  if (r.drop.length > DELETION_CAP) throw new Error(`deletion cap exceeded (${r.drop.length} > ${DELETION_CAP})`);

  if (dryRun) {
    fs.writeFileSync(PLAN_FILE, JSON.stringify(r.groups, null, 2));
    console.log(`[dedupe] --dry-run: no write. Plan written to ${PLAN_FILE}`);
    return;
  }
  fs.writeFileSync(SLOTS_FILE, JSON.stringify(r.keep, null, 2) + '\n');
  console.log(`[dedupe] wrote ${r.keep.length} entries`);
}

main().catch(e => { console.error('[dedupe]', e.message); process.exit(1); });
