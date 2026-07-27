const fs = require('fs');
const path = require('path');

// Overridable via initPersistence({ dataDir }) so a test suite can own a private directory —
// `node --test` runs test FILES in parallel and two suites sharing these paths interfere.
let HUNTS_FILE   = path.join(__dirname, '..', 'hunts_data.json');
let ARCHIVE_FILE = path.join(__dirname, '..', 'hunts_archive.json');
let SHARETOKENS_FILE = path.join(__dirname, '..', 'share_tokens.json');

// Max hunts kept in the in-memory archive (newest first), PER COMMUNITY. The durable, uncapped
// source of truth is the Postgres hunt_history table (via statsStore); this cap only bounds the
// in-memory list backing the Hub's Archived tab, stats aggregation, bangers and the got-in log.
//
// This used to be a single GLOBAL cap over an array shared by every tenant, which meant a busy
// community evicted a quiet one's hunts from all of those views — Bean's Archived tab would
// visibly shrink because somebody else streamed a lot. Nothing was ever LOST (Postgres holds it),
// but the hub degraded, and it would have started the moment a second community got busy.
const ARCHIVE_CAP_PER_TENANT = 1000;
// Backstop so total memory stays bounded as communities are added — without it the ceiling is
// (tenants × 1000) on a single Railway instance. Trims oldest-overall; only reachable when many
// communities are each near their own cap.
const ARCHIVE_CAP_TOTAL = 5000;

// Mirrors tenantOf in lib/hunts-core.js — untagged hunts belong to Bean (back-compat). Inlined
// rather than imported to keep this module dependency-free; a divergence would only mis-bucket
// hunts that carry no tenantId at all.
const archiveTenantOf = h => (h && h.tenantId) || 'bean';

// Trim the archive IN PLACE: keep the newest `perTenant` hunts belonging to `tenantId`, then
// apply the global backstop. Pure over its array argument (no fs, no pgPool) so it is unit
// testable — see persistence.trim.test.js.
function trimArchive(list, tenantId, perTenant = ARCHIVE_CAP_PER_TENANT, total = ARCHIVE_CAP_TOTAL) {
  let kept = 0;
  for (let i = 0; i < list.length; i++) {
    if (archiveTenantOf(list[i]) !== tenantId) continue;
    if (++kept > perTenant) { list.splice(i, 1); i--; }
  }
  if (list.length > total) list.splice(total);
  return list;
}

// Shared mutable singletons — owned here, imported by reference elsewhere. Never reassign.
const hunts   = {};
const archive = []; // completed hunts, newest first
const shareTokens = {}; // { [token]: ownerKey } — stable per-streamer share links, survives hunt resets

let pgPool = null;
let normalizeSlot = s => (s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
let huntsTableReady = Promise.resolve();
let statsStore = null;

// ── Postgres clobber guard ────────────────────────────────────────────────────
// Postgres is the durable store; the JSON files are a local-dev fallback and, on Railway,
// sit on an EPHEMERAL disk that is empty after every redeploy.
//
// That combination made a transient PG error at boot catastrophic: loadPersistedState()
// caught the failed SELECT, left loadedFromPg false, fell back to a file that does not
// exist in production, and started with hunts = {}. The very next persistHunts() — one of
// 74 call sites, one of which fires on every hunt edit — then upserted that empty object
// straight over the row holding every live hunt. One PG hiccup during a redeploy silently
// destroyed all hunt state.
//
// So: if PG is configured and its read did not succeed, we do NOT write back to PG. A boot
// that starts blind stays read-only against the durable store until someone restarts with a
// healthy database. Losing writes made during a degraded boot is recoverable; overwriting
// every live hunt with {} is not.
let pgReadOk = false;
// Starts false only because there is no pool yet. The moment initPersistence receives one this
// flips to TRUE and stays blocked until the boot read SUCCEEDS — the guard fails CLOSED.
// It used to start permissive and only block after a read FAILED, which left the whole boot
// WINDOW open: server.js cannot await initPersistence (CommonJS top level), so server.listen()
// runs while `hunts` is still {}. A request landing in that gap upserted {} over the row holding
// every live hunt — the exact incident this guard exists to prevent, before the guard was armed.
// Measured on a real Railway boot: 2.63s between "[pg] Pool created" and "[persist] Loaded 34
// hunts", × ~11 deploys/day. Pinned by the boot-window test in persistence.clobber.test.js.
let pgWritesBlocked = false;
let blockedWriteLogged = false;

// Runtime reachability, separate from the boot read above. The clobber guard only ever answers
// "was in-memory state authoritative at startup", which is the right question for refusing to
// overwrite — but it made /api/health report "ok" indefinitely after Postgres died mid-flight,
// because nothing re-examined the connection. That is the misleading case: the durable store is
// gone and the health endpoint says fine. Every write already reports its own outcome, so use
// those as the liveness signal rather than adding a polling health check.
let pgLastWriteOk = null;   // null = nothing attempted yet this boot
let pgLastErrorAt = null;
let pgLastErrorMsg = '';

// ── Coalesced hunt writes ─────────────────────────────────────────────────────
// persistHunts() has 52 call sites, one of which is emitHubUpdate — i.e. every hub broadcast.
// It used to do all of this SYNCHRONOUSLY on each call: an O(hunts × calls) regex dedupe over
// every hunt (changed or not), JSON.stringify(hunts) for Postgres, a SECOND JSON.stringify for
// the file, then a blocking fs.writeFileSync + fs.renameSync.
//
// Everything except the Postgres round-trip blocked the single event loop that serves every
// request and every socket packet for EVERY tenant. Cost per call scales with the number of
// active hunts, and so does the call rate — so the load grows with the SQUARE of concurrency.
// Invisible at 3-4 concurrent hunts; roughly 50x that at the 20-30 the platform is heading for.
//
// So persistHunts() now marks state dirty and schedules one flush. A burst collapses into a
// single serialization + single write, and the blob written is always the newest state.
let huntsFlushMs = 250;
let huntsFlushTimer = null;
let huntsDirty = false;

// Every fire-and-forget Postgres write registers here so flushAll() (shutdown) can wait for it.
const inFlight = new Set();
function track(p) {
  inFlight.add(p);
  const done = () => inFlight.delete(p);
  p.then(done, done);
  return p;
}

function notePgWrite(what, err) {
  if (err) {
    pgLastWriteOk = false;
    pgLastErrorAt = Date.now();
    pgLastErrorMsg = `${what}: ${err.message}`;
  } else {
    pgLastWriteOk = true;
  }
}

function pgWritable(what) {
  if (!pgPool) return false;
  if (!pgWritesBlocked) return true;
  if (!blockedWriteLogged) {
    blockedWriteLogged = true;
    console.error(
      '[persist] PG WRITES BLOCKED — the initial load from Postgres failed, so in-memory state ' +
      'is NOT authoritative. Refusing to overwrite the durable store (this would have wiped every ' +
      'live hunt). Fix the database connection and RESTART the service to recover.'
    );
  }
  console.error(`[persist] skipped PG write for '${what}' (writes blocked after a failed initial load)`);
  return false;
}

// Atomic replace: write a sibling temp file, then rename over the target. rename(2) is atomic
// within a filesystem, so a crash mid-write leaves the previous good file intact instead of a
// truncated one that JSON.parse rejects on the next boot.
function writeFileAtomic(file, data) {
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, data, 'utf8');
    fs.renameSync(tmp, file);
  } catch (e) {
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch (_) { /* best effort */ }
    throw e;
  }
}

async function initPersistence(deps) {
  pgPool = deps.pgPool;
  if (deps.normalizeSlot) normalizeSlot = deps.normalizeSlot;
  if (deps.statsStore) statsStore = deps.statsStore;
  if (deps.dataDir) {
    HUNTS_FILE       = path.join(deps.dataDir, 'hunts_data.json');
    ARCHIVE_FILE     = path.join(deps.dataDir, 'hunts_archive.json');
    SHARETOKENS_FILE = path.join(deps.dataDir, 'share_tokens.json');
  }
  if (Number.isFinite(deps.huntsFlushMs)) huntsFlushMs = deps.huntsFlushMs;
  // Arm the clobber guard BEFORE anything can write. From here until the boot read succeeds,
  // in-memory state is not authoritative, and server.js is already serving requests against it.
  if (pgPool) pgWritesBlocked = true;
  // Initialize Postgres tables for hunts and archive
  if (pgPool) {
    huntsTableReady = pgPool.query(`
      CREATE TABLE IF NOT EXISTS hunts_kv (
        key TEXT PRIMARY KEY,
        value JSONB NOT NULL
      )
    `).then(() => console.log('[persist] Postgres hunts_kv table ready'))
      .catch(e => { console.error('[persist] hunts_kv init failed:', e.message); });
  }
  await loadPersistedState();
}

// Load persisted hunts on startup — try Postgres first, fall back to file
async function loadPersistedState() {
  let loadedFromPg = false;
  if (pgPool) {
    try {
      await huntsTableReady;
      const huntsRow = await pgPool.query("SELECT value FROM hunts_kv WHERE key='hunts'");
      if (huntsRow.rows[0]) {
        Object.assign(hunts, huntsRow.rows[0].value || {});
        loadedFromPg = true;
      }
      const archiveRow = await pgPool.query("SELECT value FROM hunts_kv WHERE key='archive'");
      if (archiveRow.rows[0]) {
        archive.push(...(archiveRow.rows[0].value || []));
      }
      const tokensRow = await pgPool.query("SELECT value FROM hunts_kv WHERE key='shareTokens'");
      if (tokensRow.rows[0]) Object.assign(shareTokens, tokensRow.rows[0].value || {});
      // Reaching here means every SELECT succeeded. An EMPTY hunts_kv is a perfectly valid
      // state (first boot), so the flag tracks "the read worked", NOT "we found rows" —
      // conflating the two would block writes forever on a genuinely fresh database.
      pgReadOk = true;
      pgWritesBlocked = false;   // read succeeded → in-memory state is authoritative → unblock
      if (loadedFromPg) console.log(`[persist] Loaded ${Object.keys(hunts).length} hunts and ${archive.length} archived from Postgres`);
    } catch(e) { console.error('[persist] PG load failed:', e.message); }
    // Belt and braces: writes were already blocked on entry (see initPersistence), so a failed
    // read simply leaves them blocked. Kept explicit so the invariant survives a reorder.
    if (!pgReadOk) pgWritesBlocked = true; // see the clobber-guard note above
  }
  // Fallback: load from file if Postgres was empty/unavailable
  if (!loadedFromPg) {
    try {
      if (fs.existsSync(HUNTS_FILE)) {
        const saved = JSON.parse(fs.readFileSync(HUNTS_FILE, 'utf8'));
        Object.assign(hunts, saved);
        console.log(`[persist] Loaded ${Object.keys(hunts).length} hunts from file`);
      }
    } catch(e) { console.error('[persist] File load failed:', e.message); }
    try {
      if (fs.existsSync(ARCHIVE_FILE)) {
        const saved = JSON.parse(fs.readFileSync(ARCHIVE_FILE, 'utf8'));
        archive.push(...saved);
        console.log(`[persist] Loaded ${archive.length} archived hunts from file`);
      }
    } catch(e) { console.error('[persist] Archive file load failed:', e.message); }
    try {
      if (fs.existsSync(SHARETOKENS_FILE)) {
        Object.assign(shareTokens, JSON.parse(fs.readFileSync(SHARETOKENS_FILE, 'utf8')));
        console.log(`[persist] Loaded ${Object.keys(shareTokens).length} share tokens from file`);
      }
    } catch(e) { console.error('[persist] Share tokens file load failed:', e.message); }
  }

  // Dedup calls one-time on load (cleanup from before normalization was added)
  let totalRemoved = 0;
  for (const id in hunts) {
    const h = hunts[id];
    if (!h) continue;
    // Backfill activity stamps so the stale-hunt janitor has a baseline. Missing == treat as
    // active "now" so pre-existing hunts get a fresh 36h grace instead of being instantly reaped.
    // (Ended hunts are judged by archivedAt, not updatedAt, so this only grants grace to
    // created/live hunts.)
    const nowIso = new Date().toISOString();
    if (!h.createdAt) h.createdAt = h.startedAt || nowIso;
    if (!h.updatedAt) h.updatedAt = nowIso;
    if (!Array.isArray(h.bonuses)) h.bonuses = [];
    if (!Array.isArray(h.equity))  h.equity  = [];
    if (!Array.isArray(h.calls))   h.calls   = [];
    if (h?.calls?.length) {
      const seen = new Set();
      const before = h.calls.length;
      h.calls = h.calls.filter(c => {
        const key = (c.slot || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
        if (!key || seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      totalRemoved += before - h.calls.length;
    }
  }
  if (totalRemoved > 0) console.log(`[persist] Removed ${totalRemoved} duplicate calls on startup`);

  // One-time archive cleanup: collapse duplicate snapshots created before the upsert fix.
  // Same user + same start time + same bonus count + same total won == one hunt that was
  // ended repeatedly. Keep the newest snapshot of each; preserve newest-first ordering.
  const archiveSig = h => [
    h.user?.id,
    h.startedAt || '',
    Array.isArray(h.bonuses) ? h.bonuses.length : 0,
    Array.isArray(h.bonuses) ? h.bonuses.reduce((s, b) => s + (+b.win || 0), 0) : 0,
  ].join('|');
  const newestBySig = new Map();
  for (const h of archive) {
    const k = archiveSig(h);
    const prev = newestBySig.get(k);
    if (!prev || new Date(h.archivedAt || 0) > new Date(prev.archivedAt || 0)) newestBySig.set(k, h);
  }
  if (newestBySig.size < archive.length) {
    const removedDupes = archive.length - newestBySig.size;
    const deduped = [...newestBySig.values()].sort((a, b) => new Date(b.archivedAt || 0) - new Date(a.archivedAt || 0));
    archive.length = 0;
    archive.push(...deduped);
    persistArchive();
    console.log(`[persist] Collapsed ${removedDupes} duplicate archived hunt(s) on startup, ${archive.length} remain`);
  }
}

// Mark hunt state dirty and make sure a flush is coming. Deliberately cheap: no serialization,
// no disk, no dedupe — a burst of edits during a call rush costs one flush, not one per edit.
function persistHunts() {
  huntsDirty = true;
  if (huntsFlushTimer) return;                       // a flush is already scheduled
  huntsFlushTimer = setTimeout(() => { huntsFlushTimer = null; flushHunts(); }, huntsFlushMs);
  // unref so a pending flush never holds the process (or a test runner) open on its own.
  if (typeof huntsFlushTimer.unref === 'function') huntsFlushTimer.unref();
}

// Perform the write now. Returns a promise that settles when the Postgres write does (already
// resolved if there was nothing to write). Never rejects — callers are shutdown paths.
function flushHunts() {
  if (huntsFlushTimer) { clearTimeout(huntsFlushTimer); huntsFlushTimer = null; }
  if (!huntsDirty) return Promise.resolve();
  huntsDirty = false;

  // Bulletproof: dedupe call arrays before persisting. Keeps first occurrence of each slot.
  // REASSIGNS h.calls rather than splicing: archiveHunt takes a SHALLOW copy, so a live hunt and
  // its archived snapshot share this array object. Replacing it detaches them; mutating in place
  // would rewrite history. Pinned by persistence.debounce.test.js.
  for (const id in hunts) {
    const h = hunts[id];
    if (h?.calls?.length) {
      const seen = new Set();
      h.calls = h.calls.filter(c => {
        const key = c && normalizeSlot(c.slot);
        if (!key || seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    }
  }

  // Postgres is the durable store. The file is the fallback for when it is NOT — no
  // DATABASE_URL (local dev), or writes blocked by the clobber guard. Writing both meant a
  // blocking fs.writeFileSync on every hub broadcast for a file that production never reads:
  // on Railway it lands on an ephemeral disk that is empty after each redeploy.
  if (pgWritable('hunts')) {
    return track(pgPool.query(
      "INSERT INTO hunts_kv(key,value) VALUES('hunts',$1) ON CONFLICT(key) DO UPDATE SET value=$1",
      [JSON.stringify(hunts)]
    ).then(() => notePgWrite('hunts', null),
       e => { notePgWrite('hunts', e); console.error('[persist] PG save hunts failed:', e.message); }));
  }
  try { writeFileAtomic(HUNTS_FILE, JSON.stringify(hunts)); }
  catch(e) { /* file write may fail on ephemeral disk; that's OK if PG works */ }
  return Promise.resolve();
}

// Shutdown: flush anything pending and wait for every in-flight write to settle. Railway sends
// SIGTERM on every redeploy (~11/day), and without this the debounced write would be lost.
//
// Always resolves, and with `timeoutMs` always resolves in bounded time. Both matter: registering
// a SIGTERM listener overrides Node's default exit, so a flush that can hang or throw turns every
// deploy into a wait for Railway's force-kill.
async function flushAll({ timeoutMs } = {}) {
  flushHunts();
  const settled = Promise.allSettled([...inFlight]);
  if (!Number.isFinite(timeoutMs)) return void await settled;
  // Deliberately NOT unref'd: this is the timer we are awaiting. Unref'ing it lets the event loop
  // drain while a hung Postgres write is outstanding, so the process exits before the timeout
  // resolves — under `node --test` that silently CANCELS the remaining tests. It is cleared on
  // the settled path immediately below, so it never holds the process past timeoutMs.
  let timer;
  const bail = new Promise(resolve => { timer = setTimeout(resolve, timeoutMs); });
  await Promise.race([settled, bail]);
  clearTimeout(timer);
}
// NOT debounced: a hunt ending is rare, unlike a hub broadcast. Its write is still tracked so
// flushAll() waits for it on shutdown.
function persistArchive() {
  if (pgWritable('archive')) {
    track(pgPool.query(
      "INSERT INTO hunts_kv(key,value) VALUES('archive',$1) ON CONFLICT(key) DO UPDATE SET value=$1",
      [JSON.stringify(archive)]
    ).then(() => notePgWrite('archive', null),
       e => { notePgWrite('archive', e); console.error('[persist] PG save archive failed:', e.message); }));
  }
  try { writeFileAtomic(ARCHIVE_FILE, JSON.stringify(archive)); }
  catch(e) { /* file write may fail on ephemeral disk */ }
}
function persistShareTokens() {
  if (pgWritable('shareTokens')) {
    track(pgPool.query(
      "INSERT INTO hunts_kv(key,value) VALUES('shareTokens',$1) ON CONFLICT(key) DO UPDATE SET value=$1",
      [JSON.stringify(shareTokens)]
    ).then(() => notePgWrite('shareTokens', null),
       e => { notePgWrite('shareTokens', e); console.error('[persist] PG save shareTokens failed:', e.message); }));
  }
  try { writeFileAtomic(SHARETOKENS_FILE, JSON.stringify(shareTokens)); }
  catch(e) { /* ephemeral disk; OK if PG works */ }
}
// Reverse lookup: the existing token for an owner, or null. Owner keys are unique values.
function tokenForOwner(ownerKey) {
  for (const t in shareTokens) if (shareTokens[t] === ownerKey) return t;
  return null;
}
// Identity of a single hunt instance, used to keep the archive free of duplicates.
// huntId is the stable key (assigned at start/reset, preserved across go-live/end/reopen);
// startedAt is a fallback for legacy snapshots archived before huntId existed.
function sameHuntInstance(a, b) {
  if (a.huntId && b.huntId) return a.huntId === b.huntId;
  return a.user?.id === b.user?.id && a.startedAt === b.startedAt;
}
function archiveHunt(hunt) {
  if (!hunt || !hunt.user) return;
  // Don't archive empty hunts — no bonuses means there's nothing to analyze,
  // and it keeps the archive/history from filling up with blank entries.
  if (!Array.isArray(hunt.bonuses) || hunt.bonuses.length === 0) return;
  const snap = { ...hunt, archivedAt: hunt.archivedAt || new Date().toISOString() };
  // Upsert, never append blindly: one entry per hunt instance. Re-ending the same hunt
  // refreshes its existing snapshot in place instead of stacking duplicate copies.
  const idx = archive.findIndex(h => sameHuntInstance(h, snap));
  if (idx !== -1) {
    archive[idx] = snap;
  } else {
    archive.unshift(snap);
    // Trim only the community this hunt belongs to — never the whole array.
    trimArchive(archive, archiveTenantOf(snap));
  }
  persistArchive();
  // Durable per-hunt history is a SEPARATE store from the archive above, and this handoff used to
  // be fire-and-forget: a rejected recordHunt (PG blip, FX fetch failure inside the transaction,
  // serialization error) left the hunt permanently absent from hunt_history with nothing to retry
  // it. Lifetime stats and the public band would stay one hunt short forever.
  //
  // Mark the failure ON the archive entry — it is already per-hunt, already persisted, and the
  // janitor already sweeps it every 10 minutes (see retryPendingStats).
  if (statsStore) {
    Promise.resolve(statsStore.recordHunt(snap)).catch(e => {
      console.error('[stats] recordHunt failed — queued for retry:', e.message);
      const cur = archive.find(h => sameHuntInstance(h, snap));
      if (cur) { cur.statsPending = true; persistArchive(); }
    });
  }
}

// Re-send archived hunts whose durable stats write failed. Called by the janitor; returns how many
// were recovered. Deliberately re-sends ONLY flagged entries — recordHunt upserts by hunt_key so a
// blanket re-send would be safe but would rewrite the whole archive every sweep.
async function retryPendingStats() {
  if (!statsStore) return 0;
  const pending = archive.filter(h => h && h.statsPending);
  if (!pending.length) return 0;
  let recovered = 0;
  for (const h of pending) {
    try {
      await statsStore.recordHunt(h);
      delete h.statsPending;
      recovered++;
    } catch (e) {
      console.error('[stats] retry still failing for', h.huntId || h.user?.id, '-', e.message);
    }
  }
  if (recovered) {
    console.log(`[stats] recovered ${recovered} hunt(s) into hunt_history`);
    persistArchive();
  }
  return recovered;
}
// Remove a hunt's snapshot from the archive — used when reopening a hunt ended by mistake,
// so history doesn't keep a copy of a hunt that's running again.
function unarchiveHunt(hunt) {
  if (!hunt) return;
  const idx = archive.findIndex(h => sameHuntInstance(h, hunt));
  if (idx !== -1) {
    archive.splice(idx, 1);
    persistArchive();
    if (statsStore) Promise.resolve(statsStore.removeHunt(hunt)).catch(e => console.error('[stats] removeHunt failed:', e.message));
  }
}

module.exports = { hunts, archive, shareTokens, initPersistence, persistHunts, persistArchive, persistShareTokens, tokenForOwner, archiveHunt, unarchiveHunt,
  flushHunts, flushAll,
  trimArchive, retryPendingStats, ARCHIVE_CAP_PER_TENANT, ARCHIVE_CAP_TOTAL,
  // Introspection for tests + a health check: is the durable store authoritative right now?
  pgHealth: () => ({
    pgConfigured: !!pgPool,
    pgReadOk,
    pgWritesBlocked,
    // Hunts archived in memory whose durable hunt_history write failed and is awaiting retry.
    // A number that stays non-zero across sweeps means the retry is not succeeding.
    statsPending: archive.filter(h => h && h.statsPending).length,
    // Runtime liveness, from the outcome of real writes. null = nothing written yet this boot,
    // which is NOT a failure — a quiet server with no hunt edits has simply not exercised PG.
    pgLastWriteOk,
    pgLastErrorAt,
    pgLastErrorMsg,
    // Hunt state edited but not yet written. Normally true only for the debounce window.
    // Stuck true means flushes are not landing.
    huntsFlushPending: huntsDirty || !!huntsFlushTimer,
  }) };
