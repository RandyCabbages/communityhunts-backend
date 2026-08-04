// lib/rainbetSlotStore.js — the Postgres home for the Rainbet slot catalogue.
// The fake pool actually applies the upsert/delete so the assertions are about resulting
// CONTENT, not about which SQL strings were emitted.
const { test } = require('node:test');
const assert = require('node:assert');

const store = require('./rainbetSlotStore');

function fakePool({ rows = [], failOn = null } = {}) {
  const calls = [];
  const state = rows.map(r => ({ ...r }));
  const query = async (sql, params = []) => {
    calls.push({ sql, params });
    if (failOn && failOn.test(sql)) throw new Error('pg down');
    if (/CREATE TABLE/i.test(sql)) return { rows: [] };
    if (/SELECT COUNT/i.test(sql)) return { rows: [{ n: state.length }] };
    if (/SELECT rainbet_slug/i.test(sql)) {
      return { rows: [...state].sort((a, b) => a.rainbet_slug.localeCompare(b.rainbet_slug)) };
    }
    if (/INSERT INTO rainbet_slots/i.test(sql)) {
      const [slugs, names, thumbs, marks] = params;
      slugs.forEach((slug, i) => {
        const missing_since = marks ? marks[i] : null;
        const hit = state.find(r => r.rainbet_slug === slug);
        if (hit) { hit.name = names[i]; hit.thumb = thumbs[i]; hit.missing_since = missing_since; }
        else state.push({ rainbet_slug: slug, name: names[i], thumb: thumbs[i], missing_since });
      });
      return { rows: [] };
    }
    if (/UPDATE rainbet_slots SET missing_since = NULL/i.test(sql)) {
      const hit = new Set(params[0]);
      for (const r of state) if (hit.has(r.rainbet_slug)) r.missing_since = null;
      return { rows: [] };
    }
    if (/UPDATE rainbet_slots SET missing_since = m\.stamp/i.test(sql)) {
      const [slugs, stamps] = params;
      slugs.forEach((slug, i) => {
        const hit = state.find(r => r.rainbet_slug === slug);
        if (hit) hit.missing_since = stamps[i];
      });
      return { rows: [] };
    }
    // Targeted sweep (applyReconcile) uses `= ANY`; the whole-catalogue replace uses `<> ALL`.
    if (/DELETE FROM rainbet_slots WHERE rainbet_slug = ANY/i.test(sql)) {
      const drop = new Set(params[0]);
      const before = state.length;
      for (let i = state.length - 1; i >= 0; i--) if (drop.has(state[i].rainbet_slug)) state.splice(i, 1);
      return { rows: [], rowCount: before - state.length };
    }
    if (/DELETE FROM rainbet_slots/i.test(sql)) {
      const keep = new Set(params[0]);
      const before = state.length;
      for (let i = state.length - 1; i >= 0; i--) if (!keep.has(state[i].rainbet_slug)) state.splice(i, 1);
      return { rows: [], rowCount: before - state.length };
    }
    return { rows: [] };
  };
  const pool = { calls, state, query };
  pool.connect = async () => ({ query, release() {} });
  return pool;
}

const entry = (slug, name, thumb = `https://cdn/${slug}.webp`) => ({ rainbetSlug: slug, name, thumb });
const row = (slug, name, thumb = `https://cdn/${slug}.webp`) => ({ rainbet_slug: slug, name, thumb });

test('loadAll returns the catalogue in the file shape, slug-ordered', async () => {
  const pool = fakePool({ rows: [row('b-two', 'Two'), row('a-one', 'One')] });
  await store.initRainbetSlotStore({ pgPool: pool });
  const all = await store.loadAll();
  // Slug order keeps the snapshot the sync commits back to the repo stable — an unordered dump
  // would produce a churny 7,000-line diff on every write.
  assert.deepStrictEqual(all, [
    { rainbetSlug: 'a-one', name: 'One', thumb: 'https://cdn/a-one.webp' },
    { rainbetSlug: 'b-two', name: 'Two', thumb: 'https://cdn/b-two.webp' },
  ]);
});

test('saveAll upserts new rows, updates changed ones, and drops delisted ones', async () => {
  const pool = fakePool({ rows: [row('keep', 'Keep'), row('gone', 'Gone'), row('upgrade', 'Upgrade', null)] });
  await store.initRainbetSlotStore({ pgPool: pool });

  const res = await store.saveAll([
    entry('keep', 'Keep'),
    entry('upgrade', 'Upgrade', 'https://cdn/real.webp'),   // null thumb filled in
    entry('brand-new', 'Brand New'),
  ]);

  assert.strictEqual(res.saved, 3);
  assert.strictEqual(res.deleted, 1);
  const all = await store.loadAll();
  assert.deepStrictEqual(all.map(s => s.rainbetSlug), ['brand-new', 'keep', 'upgrade']);
  assert.strictEqual(all.find(s => s.rainbetSlug === 'upgrade').thumb, 'https://cdn/real.webp');
});

test('a null thumb round-trips rather than becoming the string "null"', async () => {
  const pool = fakePool();
  await store.initRainbetSlotStore({ pgPool: pool });
  await store.saveAll([{ rainbetSlug: 'no-thumb', name: 'No Thumb', thumb: null }]);
  assert.strictEqual((await store.loadAll())[0].thumb, null);
});

test('rows without a slug or a name are dropped rather than written', async () => {
  const pool = fakePool();
  await store.initRainbetSlotStore({ pgPool: pool });
  const res = await store.saveAll([
    entry('good', 'Good'),
    { rainbetSlug: '', name: 'No slug' },
    { rainbetSlug: 'no-name', name: '' },
    null,
  ]);
  assert.strictEqual(res.saved, 1);
  assert.deepStrictEqual((await store.loadAll()).map(s => s.rainbetSlug), ['good']);
});

// ── Guards ───────────────────────────────────────────────────────────

test('the shrink guard refuses a write that would halve the catalogue', async () => {
  const rows = Array.from({ length: 100 }, (_, i) => row(`slot-${i}`, `Slot ${i}`));
  const pool = fakePool({ rows });
  await store.initRainbetSlotStore({ pgPool: pool });

  const res = await store.saveAll(rows.slice(0, 40).map(r => entry(r.rainbet_slug, r.name)));
  assert.strictEqual(res.skipped, 'shrink-guard');
  assert.strictEqual(res.before, 100);
  assert.strictEqual(res.offered, 40);
  assert.strictEqual((await store.loadAll()).length, 100, 'nothing may be written on a suspicious run');
});

test('a write just above the floor is allowed through', async () => {
  const rows = Array.from({ length: 100 }, (_, i) => row(`slot-${i}`, `Slot ${i}`));
  const pool = fakePool({ rows });
  await store.initRainbetSlotStore({ pgPool: pool });
  const res = await store.saveAll(rows.slice(0, 60).map(r => entry(r.rainbet_slug, r.name)));
  assert.strictEqual(res.saved, 60);
  assert.strictEqual(res.deleted, 40);
});

test('an empty catalogue is never written', async () => {
  const pool = fakePool({ rows: [row('keep', 'Keep')] });
  await store.initRainbetSlotStore({ pgPool: pool });
  assert.strictEqual((await store.saveAll([])).skipped, 'empty');
  assert.strictEqual((await store.saveAll(null)).skipped, 'not-an-array');
  assert.strictEqual((await store.loadAll()).length, 1);
});

test('a failed write rolls back and propagates rather than reporting success', async () => {
  const pool = fakePool({ rows: [row('keep', 'Keep')], failOn: /INSERT INTO rainbet_slots/i });
  await store.initRainbetSlotStore({ pgPool: pool });
  await assert.rejects(() => store.saveAll([entry('keep', 'Keep'), entry('new', 'New')]), /pg down/);
  assert.ok(pool.calls.some(c => /ROLLBACK/i.test(c.sql)), 'must roll back');
});

// ── The reconcile mark (missingSince) ────────────────────────────────
// rainbetReconcile stamps an entry that has vanished from Rainbet's live set and only sweeps it
// once the stamp is 3 days old. If the store dropped the stamp, the 10-minute sync would erase
// every mark on its next write, the grace could never elapse, and nothing would EVER be swept.

test('a reconcile mark survives a round trip through the store', async () => {
  const pool = fakePool();
  await store.initRainbetSlotStore({ pgPool: pool });
  await store.saveAll([{ ...entry('vanished', 'Vanished'), missingSince: '2026-08-01' }]);
  assert.strictEqual((await store.loadAll())[0].missingSince, '2026-08-01');
});

test('an unmarked entry carries no missingSince key at all', async () => {
  // Matching the file exactly: rainbetReconcile clears a mark by DROPPING the key, and a null on
  // every row would also churn ~7,600 lines of the committed snapshot on each write.
  const pool = fakePool();
  await store.initRainbetSlotStore({ pgPool: pool });
  await store.saveAll([entry('here', 'Here')]);
  assert.ok(!('missingSince' in (await store.loadAll())[0]));
});

test('saveAll clears a mark when the entry comes back without one', async () => {
  const pool = fakePool({ rows: [{ ...row('back', 'Back'), missing_since: '2026-08-01' }] });
  await store.initRainbetSlotStore({ pgPool: pool });
  await store.saveAll([entry('back', 'Back')]);   // reappeared — rainbetReconcile dropped the key
  assert.ok(!('missingSince' in (await store.loadAll())[0]), 'absent must mean cleared, not unchanged');
});

// ── Targeted reconciliation ──────────────────────────────────────────

test('diffReconcile derives removals, new marks and cleared marks', () => {
  const before = [
    entry('swept', 'Swept'),
    entry('fresh-mark', 'Fresh Mark'),
    { ...entry('came-back', 'Came Back'), missingSince: '2026-08-01' },
    { ...entry('still-marked', 'Still Marked'), missingSince: '2026-08-01' },
    entry('untouched', 'Untouched'),
  ];
  const after = [
    { ...entry('fresh-mark', 'Fresh Mark'), missingSince: '2026-08-04' },
    entry('came-back', 'Came Back'),
    { ...entry('still-marked', 'Still Marked'), missingSince: '2026-08-01' },
    entry('untouched', 'Untouched'),
  ];
  const d = store.diffReconcile(before, after);
  assert.deepStrictEqual(d.removed, ['swept']);
  assert.deepStrictEqual(d.marked, [{ rainbetSlug: 'fresh-mark', missingSince: '2026-08-04' }]);
  assert.deepStrictEqual(d.cleared, ['came-back']);
});

test('applyReconcile touches only what changed, leaving slots added meanwhile alone', async () => {
  // The reconcile job reads, then spends ~20 minutes crawling. The live sync keeps adding new
  // releases in that window; a whole-catalogue replace built from the stale read would delete them.
  const pool = fakePool({ rows: [
    row('swept', 'Swept'),
    row('mark-me', 'Mark Me'),
    { ...row('came-back', 'Came Back'), missing_since: '2026-08-01' },
    row('added-mid-run', 'Added Mid Run'),   // the live sync inserted this after the job read
  ] });
  await store.initRainbetSlotStore({ pgPool: pool });

  const res = await store.applyReconcile({
    removed: ['swept'],
    marked: [{ rainbetSlug: 'mark-me', missingSince: '2026-08-04' }],
    cleared: ['came-back'],
  });

  assert.deepStrictEqual(res, { removed: 1, marked: 1, cleared: 1 });
  const all = await store.loadAll();
  assert.deepStrictEqual(all.map(s => s.rainbetSlug), ['added-mid-run', 'came-back', 'mark-me']);
  assert.strictEqual(all.find(s => s.rainbetSlug === 'mark-me').missingSince, '2026-08-04');
  assert.ok(!('missingSince' in all.find(s => s.rainbetSlug === 'came-back')));
});

test('applyReconcile refuses a sweep larger than a tenth of the catalogue', async () => {
  const rows = Array.from({ length: 1000 }, (_, i) => row(`slot-${i}`, `Slot ${i}`));
  const pool = fakePool({ rows });
  await store.initRainbetSlotStore({ pgPool: pool });
  const res = await store.applyReconcile({ removed: rows.slice(0, 200).map(r => r.rainbet_slug) });
  assert.strictEqual(res.skipped, 'sweep-cap');
  assert.strictEqual(res.offered, 200);
  assert.strictEqual((await store.loadAll()).length, 1000, 'a broken crawl must remove nothing');
});

test('the sweep cap has an absolute floor so a small catalogue is not frozen', async () => {
  // A pure fraction would refuse to remove even one row from a handful — wrong for a dev database,
  // and irrelevant to the ~7,600-row catalogue this guard actually protects.
  const rows = Array.from({ length: 4 }, (_, i) => row(`slot-${i}`, `Slot ${i}`));
  const pool = fakePool({ rows });
  await store.initRainbetSlotStore({ pgPool: pool });
  assert.deepStrictEqual(await store.applyReconcile({ removed: ['slot-0'] }),
    { removed: 1, marked: 0, cleared: 0 });
});

test('applyReconcile with nothing to do is a no-op, not an error', async () => {
  const pool = fakePool({ rows: [row('a', 'A')] });
  await store.initRainbetSlotStore({ pgPool: pool });
  assert.deepStrictEqual(await store.applyReconcile({}), { removed: 0, marked: 0, cleared: 0 });
  assert.strictEqual((await store.loadAll()).length, 1);
});

test('applyReconcile without a database says so rather than pretending', async () => {
  await store.initRainbetSlotStore({ pgPool: null });
  assert.deepStrictEqual(await store.applyReconcile({ removed: ['x'] }), { skipped: 'no-db' });
});

// ── Seeding + no-database fallback ───────────────────────────────────

test('seedIfEmpty fills a fresh database from the committed file', async () => {
  const pool = fakePool();
  await store.initRainbetSlotStore({ pgPool: pool });
  assert.deepStrictEqual(await store.seedIfEmpty([entry('a', 'A'), entry('b', 'B')]), { seeded: 2 });
  assert.strictEqual((await store.loadAll()).length, 2);
});

test('seedIfEmpty never overwrites a live catalogue with the stale repo snapshot', async () => {
  // The file in git lags the database by design once the sync is running against Postgres.
  const pool = fakePool({ rows: [row('live', 'Live')] });
  await store.initRainbetSlotStore({ pgPool: pool });
  assert.deepStrictEqual(await store.seedIfEmpty([entry('stale', 'Stale')]), { seeded: 0 });
  assert.deepStrictEqual((await store.loadAll()).map(s => s.rainbetSlug), ['live']);
});

test('with no database the store is inert and says so', async () => {
  await store.initRainbetSlotStore({ pgPool: null });
  assert.strictEqual(await store.loadAll(), null, 'null tells the caller to stay on the file');
  assert.strictEqual((await store.saveAll([entry('a', 'A')])).skipped, 'no-db');
  assert.strictEqual(await store.count(), 0);
});
