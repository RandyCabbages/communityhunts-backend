// Runs the Rainbet new-slots check (scripts/check_new_slots.js) on a timer inside
// the live backend process, instead of relying on GitHub Actions' `schedule` trigger
// (which was observed firing every 1.5-5 hours instead of the configured 30 minutes —
// GitHub silently throttles/drops frequent cron schedules under load).
//
// On a change it writes rainbet_slots.json, hot-reloads it into lib/slots.js's
// in-memory search pool (no redeploy needed), then commits the file via GitHub's
// Contents API so the change survives the next deploy — same durability the GitHub
// Actions bot had. Uses the API (not local git commands) because Railway's Railpack
// build doesn't include a .git directory in the runtime image.
//
// Requires GITHUB_PAT (repo contents:write) to persist; without it, slots still get
// found and searchable immediately, but won't survive a redeploy. See CLAUDE.md.

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SLOTS_FILE = path.join(ROOT, 'rainbet_slots.json');
const INTERVAL_MS = 10 * 60 * 1000;

// Rainbet's Cloudflare Managed Challenge only clears for a HEADED browser (see
// scripts/check_new_slots.js). On Railway there's no display, so a headed Chromium
// has nothing to draw to — the sync could only ever fall back to the slot.report API
// and never scraped the new-releases page. Spawn our own Xvfb virtual framebuffer and
// point DISPLAY at it so patchright can launch headed. Doing this in-process (rather
// than wrapping the start command with xvfb-run) keeps it robust against however
// Railway actually launches node — a custom Start Command silently overrode the
// nixpacks [start] phase, which is why the env-var approach didn't take.
//
// check_new_slots.js reads SCRAPE_HEADLESS into a module-level const at require time,
// and rainbetSlotSync only require()s it lazily inside runOnce — so setting the env
// here, before the first runOnce, makes HEADLESS=false stick.
const XVFB_DISPLAY = ':99';
function ensureVirtualDisplay() {
  // Only relevant on Linux servers (Railway). Local dev on Windows/macOS keeps the
  // headless default; a manual headed run there uses SCRAPE_HEADLESS=false + the real
  // desktop display. Respect a DISPLAY that's already provided (e.g. xvfb-run in CI).
  if (process.platform !== 'linux' || process.env.DISPLAY) return false;

  try {
    const xvfb = spawn('Xvfb', [XVFB_DISPLAY, '-screen', '0', '1280x900x24', '-nolisten', 'tcp'], {
      detached: true, stdio: 'ignore',
    });
    xvfb.on('error', e => console.error('[rainbet-sync] Xvfb failed to start (scrape stays headless-only):', e.message));
    xvfb.unref();
    process.env.DISPLAY = XVFB_DISPLAY;
    process.env.SCRAPE_HEADLESS = 'false';
    console.log(`[rainbet-sync] started Xvfb on ${XVFB_DISPLAY} — slot scrape will run headed`);
    return true;
  } catch (e) {
    console.error('[rainbet-sync] could not spawn Xvfb (scrape stays headless-only):', e.message);
    return false;
  }
}

const GITHUB_PAT = process.env.GITHUB_PAT || '';
const GITHUB_REPO = process.env.GITHUB_REPO || 'RandyCabbages/communityhunts-backend';
const CONTENTS_URL = `https://api.github.com/repos/${GITHUB_REPO}/contents/rainbet_slots.json`;

let warnedNoPat = false;

async function githubApi(method, body) {
  const res = await fetch(CONTENTS_URL, {
    method,
    headers: {
      'Authorization': `Bearer ${GITHUB_PAT}`,
      'Accept': 'application/vnd.github+json',
      'User-Agent': 'communityhunts-backend',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`GitHub API ${method} ${res.status}: ${data.message || res.statusText}`);
  return data;
}

// ── Stale-base protection ─────────────────────────────────────────────────────
// The sha passed to PUT only guards the window between our own GET and PUT. It does NOT stop us
// pushing content whose BASE predates someone else's commit: the sha is fresh, so the PUT
// succeeds and silently reverts them. Kyle made five manual commits to this file in six days,
// including one collapsing 794 duplicate rows — a container still running its interval with the
// pre-fix copy would overwrite that, authored as "rainbet-slots-bot", with no alert.
//
// So: remember the sha this process is based on, and refuse to push if the remote has moved off
// it. Content comparison is not an option — the GitHub Contents API returns no `content` for
// files over 1MB and this one is ~1.27MB, which is also why the short-circuit that used to live
// here was already dead code.
//
// Refusal is STICKY on purpose. A human commit to this file lands on main, which auto-deploys, so
// this container is about to be replaced with one holding the correct base. Resuming pushes on
// our own would just re-revert them.
let baseSha = null;
let staleBase = false;

// Called once at startup, before any scrape can finish, so the base reflects the file this
// container actually booted with.
async function captureBaseSha({ api = githubApi } = {}) {
  if (!GITHUB_PAT && api === githubApi) return null;
  try {
    const current = await api('GET');
    baseSha = current.sha || null;
    staleBase = false;
    return baseSha;
  } catch (e) {
    console.error('[rainbet-sync] could not read the base sha:', e.message);
    return null;
  }
}

async function commitViaApi({ api = githubApi, readContent } = {}) {
  if (!GITHUB_PAT && api === githubApi) {
    if (!warnedNoPat) {
      console.warn('[rainbet-sync] GITHUB_PAT not set — new slots will NOT survive a redeploy until this is fixed');
      warnedNoPat = true;
    }
    return;
  }
  if (staleBase) return;   // already refused once this process; wait for the redeploy

  try {
    const content = readContent ? readContent() : fs.readFileSync(SLOTS_FILE, 'utf8');
    const current = await api('GET');

    if (baseSha && current.sha && current.sha !== baseSha) {
      staleBase = true;
      console.error(
        `[rainbet-sync] REFUSING to push: rainbet_slots.json on main moved from ${baseSha} to ${current.sha} ` +
        'since this process started, so our copy is based on an older version and pushing it would ' +
        'revert that commit. Skipping until this container is redeployed with the current file.'
      );
      return;
    }

    const put = await api('PUT', {
      message: `auto: rainbet new releases (${new Date().toISOString().slice(0, 10)})`,
      content: Buffer.from(content, 'utf8').toString('base64'),
      sha: current.sha,
      branch: 'main',
      committer: { name: 'rainbet-slots-bot', email: 'actions@users.noreply.github.com' },
    });
    // Our push IS the new base — otherwise the next tick would see its own commit as somebody
    // else's and refuse forever.
    baseSha = (put && put.content && put.content.sha) || baseSha;
    console.log('[rainbet-sync] committed rainbet_slots.json update to main via GitHub API');
  } catch (e) {
    console.error('[rainbet-sync] GitHub API commit failed (slots are still live in memory, just not persisted):', e.message);
  }
}

// Re-entrancy guard. Measured runs on 2026-07-27 took 7m20s and 5m26s against a 10-minute timer,
// and the worst case is far longer. Two overlapping runs both read the same base file, both mutate
// their own copy and both write it back — last writer wins and the other run's new slots vanish.
let running = false;

async function runOnce(slots, { runCheck, commit } = {}) {
  if (running) {
    console.warn('[rainbet-sync] previous run still going — skipping this tick');
    return;
  }
  running = true;
  try {
    let result;
    try {
      result = await (runCheck ? runCheck() : require('../scripts/check_new_slots').runCheck());
    } catch (e) {
      console.error('[rainbet-sync] check failed:', e.message);
      return;
    }

    if (!result || !result.changed) return;

    console.log(`[rainbet-sync] +${result.added} / -${result.removed} slots — reloading + persisting`);
    slots.reloadRainbetSlots();
    await (commit ? commit() : commitViaApi());
  } finally {
    running = false;   // must release on EVERY path, or one slow/failed run wedges the sync forever
  }
}

function startRainbetSlotSync(slots) {
  // Give Xvfb a moment to bind the display before the first headed browser launch;
  // without a display, patchright's launch would fail outright.
  const startedXvfb = ensureVirtualDisplay();
  const firstRunDelay = startedXvfb ? 3000 : 0;
  // Base the stale-check on the file this container booted with, before any scrape can finish.
  captureBaseSha().catch(() => {});
  // Self-scheduling rather than setInterval: the next tick is only queued once this one has
  // settled, so slow runs space themselves out instead of piling up.
  const tick = async () => {
    try { await runOnce(slots); }
    catch (e) { console.error('[rainbet-sync] run failed:', e.message); }
    finally { setTimeout(tick, INTERVAL_MS); }
  };
  setTimeout(tick, firstRunDelay);
}

module.exports = { startRainbetSlotSync, runOnce, commitViaApi, captureBaseSha };
