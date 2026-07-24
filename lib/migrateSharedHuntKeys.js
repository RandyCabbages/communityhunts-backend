// One-time, idempotent migration for the tenant-hunt OBS rebrand: the shared "mod hunt" storage
// key was renamed '__mod_hunt__' → '__tenant_hunt__' (so the OBS overlay URL reads
// /:slug/overlay/__tenant_hunt__). This carries existing state forward so nothing a streamer set
// up is lost:
//   • live hunt state — the in-memory `hunts` object (persisted to hunts_kv) is re-keyed, and each
//     shared hunt's user.id (which equals its key, and is what the OBS URL embeds) is updated.
//   • saved overlay styling — user_settings rows keyed by the hunt key are COPIED to the new key.
//
// Covers Bean (bare key '__mod_hunt__') and every namespaced tenant ('__mod_hunt__:<id>'). VIP
// ('__vip_hunt__') and affiliate ('__affiliate_hunt__') keys are deliberately NOT touched — their
// OBS links must not change.
//
// Idempotent + non-destructive: a hunt whose target key already exists is skipped (no clobber);
// the settings copy is INSERT ... ON CONFLICT DO NOTHING; the OLD rows are left in place, so the
// change is reversible and a re-run is a no-op. Archived hunt_history rows keep the old host key
// forever (ledgerQuery.MOD_HUNT_KEYS lists both), so payouts on past tenant hunts still resolve.

const OLD = '__mod_hunt__';
const NEW = '__tenant_hunt__';

// Re-key the in-memory hunts object in place. Pure over its argument (no fs / no pgPool) so it is
// unit testable. Returns the number of hunts moved.
function migrateInMemoryHunts(hunts) {
  let moved = 0;
  for (const key of Object.keys(hunts)) {
    if (key.indexOf(OLD) !== 0) continue;          // '__mod_hunt__' or '__mod_hunt__:<tenant>' only
    const newKey = NEW + key.slice(OLD.length);
    if (hunts[newKey]) continue;                   // already migrated — never clobber the new key
    const h = hunts[key];
    // For shared hunts the key IS the user.id (that's what the OBS URL embeds); keep them in sync.
    if (h && h.user && h.user.id === key) h.user.id = newKey;
    hunts[newKey] = h;
    delete hunts[key];
    moved++;
  }
  return moved;
}

// Copy user_settings (overlay config lives here, keyed by the hunt key) from the old key to the
// new key. Uses left(user_id, len) rather than LIKE so the '_' chars in the key aren't treated as
// wildcards. Defensively ensures the table exists so ordering against initSettings never matters.
async function migrateSettingsRows(pgPool) {
  if (!pgPool) return 0;
  await pgPool.query(
    `CREATE TABLE IF NOT EXISTS user_settings (user_id TEXT PRIMARY KEY, settings JSONB NOT NULL DEFAULT '{}')`
  );
  const r = await pgPool.query(
    `INSERT INTO user_settings(user_id, settings)
       SELECT $2 || substr(user_id, length($1) + 1), settings
         FROM user_settings
        WHERE left(user_id, length($1)) = $1
     ON CONFLICT(user_id) DO NOTHING`,
    [OLD, NEW]
  );
  return r.rowCount || 0;
}

async function migrateSharedHuntKeys({ hunts, pgPool, persistHunts }) {
  const moved = migrateInMemoryHunts(hunts || {});
  if (moved && persistHunts) persistHunts();
  let copied = 0;
  try { copied = await migrateSettingsRows(pgPool); }
  catch (e) { console.error('[migrate] tenant-hunt settings copy failed:', e.message); }
  if (moved || copied) {
    console.log(`[migrate] tenant-hunt key __mod_hunt__ → __tenant_hunt__: ${moved} hunt(s) re-keyed, ${copied} settings row(s) copied`);
  }
}

module.exports = { migrateSharedHuntKeys, migrateInMemoryHunts, migrateSettingsRows, OLD, NEW };
