#!/usr/bin/env node
//
// Daily reconciliation: authoritatively enumerate Rainbet's live catalog via the
// games API (per-provider, region-inclusive) and mark-then-sweep stale entries from
// rainbet_slots.json, plus emit rainbet_live_names.json (gates the slot.report merge
// in lib/slots.js). Runs headed under xvfb in GitHub Actions — a bare fetch/curl 403s
// (Cloudflare), so the API is called from a CF-cleared patchright page via page.evaluate.
//
// STORAGE (since the catalogue moved into Postgres — lib/rainbetSlotStore.js). Production reads
// the catalogue from the database, not from rainbet_slots.json, so this job needs DATABASE_URL and
// writes there; the files it also writes are the repo snapshot. Three rules hold it together:
//
//   1. It FAILS CLOSED without a database. A file-only run would compute a perfectly good sweep,
//      commit it, report success, and change nothing anybody sees — the exact silence this job is
//      most likely to fail with. Pass --file-only to opt into that deliberately.
//   2. It reads from whatever it will write to, never one and then the other (the same pairing
//      rule check_new_slots documents), or the sweep is computed against a stale base.
//   3. It applies TARGETED deletes and marks, not a whole-catalogue replace. This crawl takes
//      ~20 minutes and the in-process 10-minute sync keeps adding new releases throughout; a
//      replace built from our read would delete every one of them.
//
// Two stages, because appearing in the catalogue is not the same as being playable:
//
//   1. LISTING. Enumerate every provider and match catalogue rows by SLUG. A provider whose
//      pagination did not complete is recorded as unreachable and its rows are held back
//      from the sweep entirely (see enumerateLive).
//   2. PLAYABILITY. Load the game pages of this run's sweep candidates, plus a rolling
//      slice of rows the listing still carries, and check the player actually starts
//      (see lib/rainbetPlayability.js). This is the only stage that can catch a game which
//      the API happily lists and which nonetheless never boots — avatarux-majestic-meow was
//      exactly that on 2026-08-01.
//
// Budget: RAINBET_PROBE_LIMIT (default 250) page loads at ~10s each.
//
// Local dry-run (Windows desktop, real display):
//   SCRAPE_HEADLESS=false node scripts/reconcile_rainbet.js --dry-run
//   SCRAPE_HEADLESS=false RAINBET_PROBE_LIMIT=10 node scripts/reconcile_rainbet.js --dry-run

const fs = require('fs');
const path = require('path');
// providerOf comes from rainbetReconcile rather than being rebuilt here: reachability is
// matched against exactly the token reconcile() derives for a catalogue row, and two copies
// of that rule would drift apart silently.
const { reconcile, nameKey, providerOf, providersGateOk, catalogFloorOk } = require('../lib/rainbetReconcile');
const { canonKey } = require('../lib/slotSlugCanon');
const { classify, selectProbeTargets, mergeHistory } = require('../lib/rainbetPlayability');
const slotStore = require('../lib/rainbetSlotStore');

const ROOT = process.cwd();
const SLOTS_FILE = path.join(ROOT, 'rainbet_slots.json');
const LIVE_NAMES_FILE = path.join(ROOT, 'rainbet_live_names.json');
const PLAYABILITY_FILE = path.join(ROOT, 'rainbet_playability.json');

// How many game pages to load per run. Each costs ~10s, and the job has a 30-minute budget.
const PROBE_LIMIT = Number(process.env.RAINBET_PROBE_LIMIT || 250);

const PROVIDERS_BASE = 'https://services.rainbet.com/v1/public/providers/list';
const GAMES_URL = 'https://services.rainbet.com/v1/public/games/list';

// ── Where we crawl FROM ──────────────────────────────────────────────────────
// The games API validates its country/region against the caller's actual geo: from an
// Iowa IP, `country=US&region=IA` is the ONLY combination that answers — NJ, bare US, CA,
// GB and no-params all return HTTP 400. So the old hardcoded IA was never a choice, it was
// a description of one developer's location, and it would 400 from anywhere else
// (including a GitHub Actions runner, which is why arming the schedule was risky).
//
// Iowa is also the WORST vantage to reconcile a global catalogue from. rainbet_slots.json
// is one shared list serving every tenant's users across many regions, and IA is the most
// restrictive jurisdiction available: it reports region_blocked for 4,301 of 7,596 entries,
// all of which are then undecidable. Region-blocking is a per-user display concern, not a
// question of whether a game belongs in the catalogue — so crawl from the most PERMISSIVE
// vantage available and let the catalogue be inclusive.
//
// Rather than guess the right parameters for whatever exit point we are on, watch the ones
// Rainbet's own frontend uses on the page we just loaded, and reuse those verbatim.
// RAINBET_API_PARAMS overrides (e.g. "country=CA"); the IA default is the last resort.
const DEFAULT_API_PARAMS = process.env.RAINBET_API_PARAMS || 'country=US&region=IA';

// The listener must be attached before the first navigation, but the frontend issues its
// games/list call some time AFTER the Cloudflare title clears — reading `seen` immediately
// raced it and silently fell back to the Iowa default (which then 400s from anywhere else).
// So this returns a waiter, not a getter.
function watchApiParams(page) {
  const seen = [];
  page.on('request', req => {
    const u = req.url();
    if (!u.startsWith(GAMES_URL)) return;
    try {
      const q = new URL(u).searchParams;
      const country = q.get('country');
      if (!country) return;
      const region = q.get('region');
      const params = region ? `country=${country}&region=${region}` : `country=${country}`;
      if (!seen.includes(params)) seen.push(params);
    } catch { /* not a URL we can read — ignore */ }
  });
  return async ({ timeoutMs = 20000, pollMs = 500 } = {}) => {
    const deadline = Date.now() + timeoutMs;
    while (!seen.length && Date.now() < deadline) await sleep(pollMs);
    return seen;
  };
}

// The providers endpoint takes a country and rejects a region, so it cannot reuse the games
// parameter string verbatim.
const countryOf = params => {
  const m = /(?:^|&)country=([^&]*)/.exec(params || '');
  return m ? m[1] : 'US';
};

// A system-wide VPN (the NordVPN desktop app) needs nothing here — it moves every socket,
// including this Chromium's. The proxy path exists for CI, where there is no desktop app.
// Credentials come from the environment and are never read or logged by this script.
function launchOptions() {
  const server = process.env.RAINBET_PROXY_SERVER;
  if (!server) return { headless: HEADLESS };
  return {
    headless: HEADLESS,
    proxy: {
      server,
      ...(process.env.RAINBET_PROXY_USERNAME ? { username: process.env.RAINBET_PROXY_USERNAME } : {}),
      ...(process.env.RAINBET_PROXY_PASSWORD ? { password: process.env.RAINBET_PROXY_PASSWORD } : {}),
    },
  };
}

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

// Enumerate the live catalogue, tracking WHICH PROVIDERS WE ACTUALLY GOT AN ANSWER FOR.
//
// This used to `break` out of the pagination on any non-200 and move on, so a provider that
// errored contributed zero live names — indistinguishable from "every game from that
// provider was delisted". The games query for `voltent` returns HTTP 400 under every
// parameter combination the API accepts, and Wazdan ships only under voltent, so the live
// set contained no Wazdan games at all. 900 catalogue entries across 13 provider tokens sat
// in that hole on 2026-08-01; sweeping on that basis would have deleted all of them.
//
// A provider counts as reachable ONLY if its pagination ran to completion. A partial answer
// (rate-limited out, cursor abandoned mid-way) is treated exactly like no answer, because a
// half-enumerated provider looks like a half-delisted one.
async function enumerateLive(page, apiParams = DEFAULT_API_PARAMS) {
  const provRes = await apiGet(page, `${PROVIDERS_BASE}?country=${encodeURIComponent(countryOf(apiParams))}`);
  const providers = ((provRes.body && (provRes.body.providers || provRes.body)) || [])
    .map(p => p.url).filter(Boolean);

  const liveNames = new Set();
  const liveSlugs = new Set();
  const regionBlocked = new Set();
  const reachableProviders = new Set();
  const failedProviders = [];
  let gameCount = 0;

  for (const prov of providers) {
    let cursor = null, complete = true;
    const batch = [];
    do {
      const url = `${GAMES_URL}?provider=${encodeURIComponent(prov)}&${apiParams}&limit=64`
        + (cursor ? `&cursor=${encodeURIComponent(cursor)}` : '');
      let res = await apiGet(page, url);
      // Aggressive rate limit: back off 90s and retry the same page.
      let guard = 0;
      while (res.status === 429 && guard++ < 5) { await sleep(90000); res = await apiGet(page, url); }
      if (res.status !== 200 || !res.body) { complete = false; break; }
      for (const g of (res.body.games || [])) batch.push(g);
      cursor = res.body.next_cursor || null;
      await sleep(1800); // throttle
    } while (cursor);

    if (!complete) {
      failedProviders.push(prov);
      console.error(`[reconcile] provider "${prov}" did not enumerate cleanly — its catalogue entries are NOT sweep-eligible this run`);
      continue;
    }

    for (const g of batch) {
      liveNames.add(nameKey(g.name));
      gameCount++;
      if (!g.url) continue;
      const k = canonKey(g.url);
      liveSlugs.add(k);
      if (g.region_blocked) regionBlocked.add(k);
      // Key reachability off the slug's provider token, the same way reconcile() derives it
      // for a catalogue row — Rainbet's provider id and its slug prefix are not always the
      // same string (provider "voltent" serves voltent-wazdan-… which canonicalises to wazdan).
      reachableProviders.add(providerOf(g.url));
    }
  }

  return {
    liveNames, liveSlugs, regionBlocked, reachableProviders, failedProviders,
    providerCount: providers.length, gameCount,
  };
}

// Load one game page and record whether the player actually booted. Read-only: no login,
// no wagering — it is the same page any visitor gets.
//
// Retried once, because a nav timeout is indistinguishable from a real answer at the
// classify() layer and both degrade to 'unknown'. A first pass immediately after the ~13
// minute API crawl returned 9 'unknown' out of 12; replaying the identical 12 slugs on a
// fresh browser returned 12 'dead' with a "404 – Rainbet" title. The verdicts were never
// wrong — 'unknown' is inert by design — but they were needlessly uninformative.
async function probeSlug(page, slug) {
  let lastErr = '';
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      await page.goto(`https://rainbet.com/casino/slots/${slug}`, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await sleep(9000); // the launcher iframe gets its src well after domcontentloaded
      return {
        title: await page.title().catch(() => ''),
        iframeSrcs: await page.evaluate(() =>
          [...document.querySelectorAll('iframe')].map(f => f.getAttribute('src') || '')),
      };
    } catch (e) {
      lastErr = e.message;
      if (attempt < 2) await sleep(4000);
    }
  }
  return { navError: lastErr };
}

// Connect to the catalogue's real home. The pool is kept at module scope so it can be closed on
// EVERY exit path — this is a script, and an open pool keeps the process (and therefore the
// Actions job) alive long after the work is done.
let pgPoolRef = null;
async function openStore() {
  if (!process.env.DATABASE_URL) return null;
  const { Pool } = require('pg');
  const { makePoolConfig } = require('../lib/pgConfig');
  pgPoolRef = new Pool(makePoolConfig(process.env.DATABASE_URL));
  pgPoolRef.on('error', e => console.error('[reconcile] pg pool error:', e.message));
  await slotStore.initRainbetSlotStore({ pgPool: pgPoolRef });
  return pgPoolRef;
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  // Escape hatch for working on the committed snapshot alone (local experiments, regenerating the
  // repo copy). Never what a scheduled run wants — see the fail-closed check below.
  const fileOnly = process.argv.includes('--file-only');
  const { chromium } = require('patchright');

  // FAIL CLOSED. Production reads the catalogue from Postgres, not from this file, so a run
  // without a database would compute a perfectly good sweep, write it to the repo, report success
  // — and change nothing that anybody sees. That silence is the exact failure mode this job was
  // rewritten to avoid, so refuse rather than mislead.
  const pool = fileOnly ? null : await openStore();
  if (!pool && !fileOnly) {
    console.error('[reconcile] DATABASE_URL is not set. The live catalogue lives in Postgres, so a');
    console.error('[reconcile] file-only run would prune the repo snapshot and leave production');
    console.error('[reconcile] untouched. Set DATABASE_URL, or pass --file-only if that is really');
    console.error('[reconcile] what you want.');
    process.exit(1);
  }

  // Read from wherever we are going to write. Reading the file while writing the database would
  // compute the sweep against a stale base — the same pairing rule check_new_slots documents.
  const stored = pool ? await slotStore.loadAll() : null;
  const entries = (stored && stored.length) ? stored : JSON.parse(fs.readFileSync(SLOTS_FILE, 'utf8'));
  console.log(`[reconcile] catalogue source: ${(stored && stored.length) ? `Postgres (${entries.length} entries)` : `${SLOTS_FILE} (${entries.length} entries)`}`);
  let history = {};
  try {
    if (fs.existsSync(PLAYABILITY_FILE)) history = JSON.parse(fs.readFileSync(PLAYABILITY_FILE, 'utf8')).slugs || {};
  } catch (e) { console.error('[reconcile] could not read playability history:', e.message); }

  const browser = await chromium.launch(launchOptions());
  let live, cfCleared = true;
  const verdicts = new Map();
  try {
    // Mirror scripts/check_new_slots.js exactly — patchright's stealth relies on a
    // coherent fingerprint; overriding the userAgent with a bare string re-trips
    // Cloudflare's Managed Challenge and the crawl never clears.
    const ctx = await browser.newContext({
      viewport: { width: 1280, height: 900 }, locale: 'en-US', timezoneId: 'America/Chicago',
    });
    const page = await ctx.newPage();
    const awaitObservedParams = watchApiParams(page);   // attach before the first load
    if (!(await clearCloudflare(page))) {
      cfCleared = false;
    } else {
      const observed = await awaitObservedParams();
      const apiParams = observed[0] || DEFAULT_API_PARAMS;
      console.log(observed.length
        ? `[reconcile] crawling as "${apiParams}" (observed from Rainbet's own requests${observed.length > 1 ? `; also saw ${observed.slice(1).join(', ')}` : ''})`
        : `[reconcile] crawling as "${apiParams}" (no frontend request observed — falling back)`);
      live = await enumerateLive(page, apiParams);

      // Stage 2 — playability. Only meaningful once the listing crawl is healthy, so it
      // runs behind the same gates the sweep does.
      if (providersGateOk(live.providerCount) && catalogFloorOk(live.liveSlugs.size, entries.length)) {
        const eligible = entries.filter(e => live.reachableProviders.has(providerOf(e.rainbetSlug)));
        const candidates = eligible
          .filter(e => !live.liveSlugs.has(canonKey(e.rainbetSlug || '')))
          .map(e => e.rainbetSlug);
        // Only region-unblocked entries are decidable; probing the rest just burns budget
        // on a guaranteed 'unknown'.
        const present = eligible
          .filter(e => {
            const k = canonKey(e.rainbetSlug || '');
            return live.liveSlugs.has(k) && !live.regionBlocked.has(k);
          })
          .map(e => e.rainbetSlug);

        const targets = selectProbeTargets({ candidates, present, history, limit: PROBE_LIMIT });
        const candidateSet = new Set(candidates);
        const probedCandidates = targets.filter(t => candidateSet.has(t)).length;
        console.log(`[reconcile] probing ${targets.length} game page(s) — ${probedCandidates} of ${candidates.length} sweep candidate(s) + ${targets.length - probedCandidates} rolling audit`);
        if (probedCandidates < candidates.length)
          console.warn(`[reconcile] probe budget (${PROBE_LIMIT}) is smaller than the candidate list — the unprobed ones can still be swept on listing evidence alone; raise RAINBET_PROBE_LIMIT to confirm every removal`);

        for (const slug of targets) {
          const obs = await probeSlug(page, slug);
          obs.regionBlocked = live.regionBlocked.has(canonKey(slug));
          const v = classify(obs);
          verdicts.set(slug, v);
          if (v === 'dead') console.log(`[reconcile]   DEAD (no session): ${slug}`);
          // Say WHY an undecidable one was undecidable; "unknown" alone gives an operator
          // nothing to act on, and a run full of nav errors should look different from a
          // run full of legitimately region-blocked games.
          else if (v === 'unknown' && !obs.regionBlocked)
            console.log(`[reconcile]   undecidable: ${slug} — ${obs.navError ? `nav error: ${obs.navError}` : `title: ${JSON.stringify(obs.title)}`}`);
          await sleep(1500);
        }
      }
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

  // Safety gates — a broken/rate-limited crawl must never sweep the catalog.
  if (!providersGateOk(live.providerCount)) {
    console.error(`[reconcile] provider gate failed (got ${live.providerCount}, need >= 20) — no write`);
    process.exit(1);
  }
  if (!catalogFloorOk(live.liveSlugs.size, entries.length)) {
    console.error(`[reconcile] catalog-floor gate failed (live ${live.liveSlugs.size} vs catalog ${entries.length}) — no write`);
    process.exit(1);
  }

  const r = reconcile(entries, {
    slugs: live.liveSlugs,
    names: live.liveNames,
    reachableProviders: live.reachableProviders,
  }, { graceDays: 3, playability: verdicts });

  const deadCount = [...verdicts.values()].filter(v => v === 'dead').length;
  console.log(`[reconcile] providers=${live.providerCount} games=${live.gameCount} liveSlugs=${live.liveSlugs.size} | marked=${r.marked} cleared=${r.cleared} swept=${r.swept} skipped=${r.skipped}`);
  // The single number that decides how much of the catalogue the playability probe can even
  // adjudicate — a high count means we are crawling from a restrictive jurisdiction and most
  // verdicts will be 'unknown'. Iowa: 4,301 of 7,596. Comoros: near zero.
  console.log(`[reconcile] region_blocked=${live.regionBlocked.size} of ${live.liveSlugs.size} listed — these are undecidable by probe from this exit point`);
  console.log(`[reconcile] probed=${verdicts.size} dead=${deadCount} alive=${[...verdicts.values()].filter(v => v === 'alive').length} undecidable=${[...verdicts.values()].filter(v => v === 'unknown').length}`);
  // Listed but would not start a session. NOT removed — Rainbet's listing decides that — but
  // reported every run so a real rot problem is visible rather than silent.
  if (r.advisoryDead.length) {
    console.log(`[reconcile] ${r.advisoryDead.length} listed entr(ies) would not start a session — KEPT (listing wins), recorded in ${PLAYABILITY_FILE}:`);
    for (const s of r.advisoryDead.slice(0, 30)) console.log(`[reconcile]   ${s}`);
    if (r.advisoryDead.length > 30) console.log(`[reconcile]   … and ${r.advisoryDead.length - 30} more`);
  }
  if (live.failedProviders.length)
    console.log(`[reconcile] providers that did NOT enumerate: ${live.failedProviders.join(', ')}`);
  if (r.skipped)
    console.log(`[reconcile] ${r.skipped} entr(ies) held back as not sweep-eligible, from: ${r.skippedProviders.join(', ')}`);
  if (r.markedNames.length) console.log(`[reconcile] newly marked: ${r.markedNames.slice(0, 30).join(', ')}${r.markedNames.length > 30 ? ' …' : ''}`);
  if (r.sweptNames.length) console.log(`[reconcile] swept: ${r.sweptNames.slice(0, 30).join(', ')}${r.sweptNames.length > 30 ? ' …' : ''}`);

  if (dryRun) {
    const d = slotStore.diffReconcile(entries, r.entries);
    console.log(`[reconcile] --dry-run: nothing written (would remove ${d.removed.length}, `
      + `mark ${d.marked.length}, clear ${d.cleared.length})`);
    return;
  }

  // Postgres FIRST and awaited — it is the live catalogue; the files below are the repo snapshot.
  // Applied as targeted deletes/marks rather than a whole-catalogue replace, because this crawl
  // takes ~20 minutes and the in-process 10-minute sync keeps adding new releases the entire time.
  // A replace built from our read would delete every one of them. See lib/rainbetSlotStore.js.
  if (pool) {
    const diff = slotStore.diffReconcile(entries, r.entries);
    const applied = await slotStore.applyReconcile(diff);
    if (applied.skipped) {
      console.error(`[reconcile] REFUSED by the store (${applied.skipped}) — offered ${applied.offered} `
        + `removals against a catalogue of ${applied.total}. Nothing written, anywhere.`);
      process.exitCode = 1;
      return;   // no file mirror either: a sweep the store rejected must not reach the repo
    }
    console.log(`[reconcile] Postgres: removed ${applied.removed}, marked ${applied.marked}, cleared ${applied.cleared}`);
  }

  fs.writeFileSync(PLAYABILITY_FILE, JSON.stringify({
    generatedAt: new Date().toISOString(),
    slugs: mergeHistory(history, verdicts),
  }, null, 2) + '\n');
  fs.writeFileSync(SLOTS_FILE, JSON.stringify(r.entries, null, 2) + '\n');
  // `names` stays the first key and keeps its shape — lib/slots.js reads it for the
  // slot.report merge gate. `slugs` is additive.
  fs.writeFileSync(LIVE_NAMES_FILE, JSON.stringify({
    generatedAt: new Date().toISOString(),
    names: [...live.liveNames].sort(),
    slugs: [...live.liveSlugs].sort(),
  }) + '\n');
  console.log(`[reconcile] wrote ${SLOTS_FILE} (${r.entries.length} entries) + ${LIVE_NAMES_FILE} (${live.liveNames.size} names) + ${PLAYABILITY_FILE}`);
}

main()
  // exitCode rather than exit(): the pool still has to be drained, and process.exit() would cut
  // the finally below off mid-close, leaving the connection to time out server-side.
  .catch(e => { console.error('[reconcile] fatal:', e); process.exitCode = 1; })
  .finally(async () => { if (pgPoolRef) await pgPoolRef.end().catch(() => {}); });
