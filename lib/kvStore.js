// Shared guard for the hunts_kv single-row collections.
//
// lib/persistence.js learned this twice. PR #108: a transient Postgres error at boot left `hunts`
// empty, the file fallback does not exist on Railway's EPHEMERAL disk, and the next persist()
// upserted `{}` over the row holding every live hunt. PR #118: the guard armed only AFTER a read
// failed, so the window before the read had even happened was still wide open.
//
// Six sibling modules — announcements, cardReleases, cardRequests, slotLists,
// supporterApplications, tickets — carried the identical unguarded shape: load in a try/catch,
// swallow the error, fall back to a file that isn't there, then unconditionally overwrite the
// whole blob on the next write. Lower stakes than hunts, same mechanics, and equally
// unrecoverable while PITR is off.
//
// So the rule is centralised here rather than copy-pasted seven times:
//   - writes are BLOCKED from the moment a pool is attached (fail closed),
//   - and unblocked only when a load actually SUCCEEDS,
//   - where "succeeded" means the query returned, not that it found a row (an empty table is a
//     perfectly valid first boot, and blocking on it would break every fresh deploy).

const TABLE_DDL = `
  CREATE TABLE IF NOT EXISTS hunts_kv (
    key TEXT PRIMARY KEY,
    value JSONB NOT NULL
  )
`;

// Registry so a test can assert EVERY module that uses this is actually guarded — a module can be
// converted to call makeKvStore and still be wired up wrong.
const registry = [];
function _stores() { return registry.slice(); }

function makeKvStore(key, label = `[${key}]`) {
  let pool = null;
  let blocked = true;      // fail closed: nothing may be written before a successful load
  let loggedBlock = false;

  const store = {
    key,
    attach(p) { pool = p || null; blocked = true; loggedBlock = false; },
    async load() {
      if (!pool) return { ok: false, value: null };
      try {
        await pool.query(TABLE_DDL);
        const r = await pool.query('SELECT value FROM hunts_kv WHERE key=$1', [key]);
        blocked = false;
        return { ok: true, value: r.rows[0] ? r.rows[0].value : null };
      } catch (e) {
        console.error(`${label} PG load failed:`, e.message);
        blocked = true;
        return { ok: false, value: null };
      }
    },
    writable() {
      if (!pool) return false;
      if (!blocked) return true;
      if (!loggedBlock) {
        loggedBlock = true;
        console.error(
          `${label} PG WRITES BLOCKED — the initial load from Postgres did not succeed, so the ` +
          'in-memory copy is NOT authoritative. Refusing to overwrite the durable row. Fix the ' +
          'database connection and RESTART the service to recover.'
        );
      }
      return false;
    },
    persist(value) {
      if (!store.writable()) return;
      pool.query(
        'INSERT INTO hunts_kv(key,value) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=$2',
        [key, JSON.stringify(value)]
      ).catch(e => console.error(`${label} PG save failed:`, e.message));
    },
  };

  registry.push(store);
  return store;
}

module.exports = { makeKvStore, _stores };
