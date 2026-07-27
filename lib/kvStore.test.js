// Shared hunts_kv guard. lib/persistence.js learned this the hard way twice (PR #108, then #118):
// a transient Postgres error at boot leaves the in-memory collection EMPTY, the file fallback does
// not exist on Railway's ephemeral disk, and the next persist() upserts that empty value over the
// row holding real data. Six sibling modules still carried the unguarded shape.

const { test } = require('node:test');
const assert = require('node:assert');
const { makeKvStore, _stores } = require('./kvStore');

function pool({ selectThrows = false, value } = {}) {
  const queries = [];
  return {
    queries,
    writes: () => queries.filter(q => /^INSERT/i.test(q.sql)),
    query: async (sql, params) => {
      queries.push({ sql, params });
      if (/CREATE TABLE/i.test(sql)) return { rows: [] };
      if (/^SELECT/i.test(sql)) {
        if (selectThrows) throw new Error('connection terminated unexpectedly');
        return { rows: value === undefined ? [] : [{ value }] };
      }
      return { rows: [] };
    },
  };
}

test('writes are blocked BEFORE the load runs (fail closed, as in persistence #118)', () => {
  const s = makeKvStore('demo');
  s.attach(pool());
  assert.strictEqual(s.writable(), false,
    'the window between attach and a completed load is exactly where the clobber happens');
});

test('a failed load keeps writes blocked, and persist writes nothing', async () => {
  const p = pool({ selectThrows: true });
  const s = makeKvStore('demo');
  s.attach(p);
  const r = await s.load();

  assert.strictEqual(r.ok, false);
  assert.strictEqual(s.writable(), false);
  s.persist([{ real: 'data' }]);
  assert.deepStrictEqual(p.writes(), [], 'must not upsert over the surviving row');
});

test('a successful load unblocks writes and persists', async () => {
  const p = pool({ value: [{ a: 1 }] });
  const s = makeKvStore('demo');
  s.attach(p);
  const r = await s.load();

  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.value, [{ a: 1 }]);
  s.persist([{ a: 2 }]);

  const w = p.writes();
  assert.strictEqual(w.length, 1);
  assert.match(w[0].sql, /INSERT INTO hunts_kv/);
  assert.deepStrictEqual(w[0].params, ['demo', JSON.stringify([{ a: 2 }])]);
});

test('an EMPTY table is a valid first boot — reads ok, writes allowed', async () => {
  const p = pool();                       // no row yet
  const s = makeKvStore('demo');
  s.attach(p);
  const r = await s.load();

  assert.strictEqual(r.ok, true, 'the flag tracks "the read worked", not "we found rows"');
  assert.strictEqual(r.value, null);
  s.persist([{ a: 1 }]);
  assert.strictEqual(p.writes().length, 1, 'blocking here would break every fresh deploy');
});

test('with no pool at all, persist is a no-op rather than a crash', () => {
  const s = makeKvStore('demo');
  assert.strictEqual(s.writable(), false);
  s.persist([1]);   // file-only mode; must not throw
});

// Every converted module registers its store, so this fails if one is wired up but left unguarded.
test('EVERY hunts_kv-backed module is guarded after a failed boot read', async () => {
  const p = pool({ selectThrows: true });
  const mods = [
    ['announcements',         'initAnnouncements'],
    ['cardReleases',          'initCardReleases'],
    ['cardRequests',          'initCardRequests'],
    ['slotLists',             'initSlotLists'],
    ['supporterApplications', 'initSupporterApplications'],
    ['tickets',               'initTickets'],
  ];
  for (const [file, init] of mods) {
    delete require.cache[require.resolve(`./${file}`)];
    await require(`./${file}`)[init]({ pgPool: p });
  }

  // Match on the hunts_kv keys the modules actually use, so stores created by other tests in this
  // process are not counted.
  const expected = ['announcements', 'card_releases', 'card_requests', 'slot_lists',
                    'supporter_applications', 'tickets'];
  const byKey = new Map(_stores().map(s => [s.key, s]));
  for (const key of expected) {
    const s = byKey.get(key);
    assert.ok(s, `no kv store registered for '${key}' — that module is still unguarded`);
    assert.strictEqual(s.writable(), false, `${key} must refuse writes after a failed load`);
  }
  assert.deepStrictEqual(p.writes(), [], 'no module may upsert over its row after a failed read');
});

// End-to-end through one module's real mutation, proving the guard is actually on the write path
// and not merely constructed.
test('tickets: creating a ticket after a failed boot read does not reach Postgres', async () => {
  const p = pool({ selectThrows: true });
  delete require.cache[require.resolve('./tickets')];
  const tickets = require('./tickets');
  await tickets.initTickets({ pgPool: p });

  const before = tickets.listTickets().length;
  tickets.createTicket({ type: 'Bug', issue: 'something broke', username: 'someone' }, null);

  assert.strictEqual(tickets.listTickets().length, before + 1,
    'the ticket must still be accepted in memory — the guard protects the DURABLE store, not the feature');
  assert.deepStrictEqual(p.writes(), [], 'but it must not overwrite the tickets row with a near-empty list');
});
