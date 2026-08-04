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
      const [slugs, names, thumbs] = params;
      slugs.forEach((slug, i) => {
        const hit = state.find(r => r.rainbet_slug === slug);
        if (hit) { hit.name = names[i]; hit.thumb = thumbs[i]; }
        else state.push({ rainbet_slug: slug, name: names[i], thumb: thumbs[i] });
      });
      return { rows: [] };
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
