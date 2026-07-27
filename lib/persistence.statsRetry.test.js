// archiveHunt's handoff to the durable hunt_history was fire-and-forget:
//
//   if (statsStore) Promise.resolve(statsStore.recordHunt(snap)).catch(e => console.error(...));
//
// The in-memory archive and hunts_kv both get the hunt, but if recordHunt REJECTS — a PG blip, an
// FX fetch failure inside the transaction, a serialization error — the hunt is permanently absent
// from hunt_history. Nothing retries, nothing reconciles, nothing alerts. Lifetime stats and the
// public band stay quietly one hunt short forever, and the only recovery is a backfill script that
// has its own hazards.
//
// The archive entry is the natural place to remember the failure: it is already persisted, already
// per-hunt, and the janitor already sweeps it every 10 minutes.

const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');

const MOD = require.resolve('./persistence');
function freshModule() { delete require.cache[MOD]; return require('./persistence'); }

const okPool = () => ({
  query: async (sql) => {
    if (/CREATE TABLE/i.test(sql)) return { rows: [] };
    if (/^SELECT/i.test(sql)) return { rows: [] };
    return { rows: [] };
  },
});

const HUNT = () => ({
  user: { id: 'u1', displayName: 'Zed' }, huntId: 'h1', tenantId: 'bean',
  bonuses: [{ slot: 'A', bet: 1, win: 5 }], equity: [], calls: [],
});
const settle = () => new Promise(r => setImmediate(r));

beforeEach(() => {
  for (const f of ['hunts_data.json', 'hunts_archive.json', 'share_tokens.json']) {
    const p = path.join(__dirname, '..', f);
    if (fs.existsSync(p)) fs.rmSync(p);
  }
});

async function wire(statsStore) {
  const P = freshModule();
  await P.initPersistence({ pgPool: okPool(), normalizeSlot: s => String(s || ''), statsStore });
  return P;
}

test('a hunt whose recordHunt REJECTS is flagged, not silently lost', async () => {
  const P = await wire({ recordHunt: async () => { throw new Error('connection terminated'); } });

  P.archiveHunt(HUNT());
  await settle();

  assert.strictEqual(P.archive.length, 1, 'still archived in memory — the hunt is not lost from the hub');
  assert.strictEqual(P.archive[0].statsPending, true,
    'the failed durable write must leave a mark, or nothing can ever retry it');
});

test('a successful recordHunt leaves no pending flag', async () => {
  const P = await wire({ recordHunt: async () => {} });
  P.archiveHunt(HUNT());
  await settle();
  assert.ok(!P.archive[0].statsPending, 'the happy path must not accumulate junk on every hunt');
});

test('retryPendingStats re-sends only the flagged hunts and clears them on success', async () => {
  let attempts = 0;
  let failing = true;
  const P = await wire({
    recordHunt: async () => { attempts++; if (failing) throw new Error('down'); },
  });

  P.archiveHunt(HUNT());
  await settle();
  assert.strictEqual(P.archive[0].statsPending, true);
  const afterFirst = attempts;

  failing = false;                       // Postgres comes back
  const n = await P.retryPendingStats();

  assert.strictEqual(n, 1, 'one hunt recovered');
  assert.strictEqual(attempts, afterFirst + 1, 'exactly one retry, not a re-send of everything');
  assert.ok(!P.archive[0].statsPending, 'flag cleared once it actually landed');
});

test('retryPendingStats leaves the flag on if the retry fails again', async () => {
  const P = await wire({ recordHunt: async () => { throw new Error('still down'); } });
  P.archiveHunt(HUNT());
  await settle();

  const n = await P.retryPendingStats();
  assert.strictEqual(n, 0);
  assert.strictEqual(P.archive[0].statsPending, true, 'must stay queued for the next sweep');
});

test('retryPendingStats is a cheap no-op when nothing is pending', async () => {
  let attempts = 0;
  const P = await wire({ recordHunt: async () => { attempts++; } });
  P.archiveHunt(HUNT());
  await settle();

  const before = attempts;
  assert.strictEqual(await P.retryPendingStats(), 0);
  assert.strictEqual(attempts, before, 'must not re-send hunts that already landed');
});

test('pgHealth surfaces the pending count so a stuck backlog is visible', async () => {
  const P = await wire({ recordHunt: async () => { throw new Error('down'); } });
  P.archiveHunt(HUNT());
  await settle();
  assert.strictEqual(P.pgHealth().statsPending, 1);
});

test('no statsStore at all is not an error', async () => {
  const P = await wire(null);
  P.archiveHunt(HUNT());
  await settle();
  assert.ok(!P.archive[0].statsPending, 'file-only mode has no durable stats to fail');
  assert.strictEqual(await P.retryPendingStats(), 0);
});
