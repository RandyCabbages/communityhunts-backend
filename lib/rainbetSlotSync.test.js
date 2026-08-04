// The 10-minute slot sync scrapes Rainbet, merges into rainbet_slots.json, and AUTO-COMMITS the
// whole file to main with a GITHUB_PAT. Two things were unguarded.
//
// 1. Re-entrancy. A bare setInterval fired every 10 min, but measured runs on 2026-07-27 took
//    7m20s and 5m26s, and the worst case (2 scrape attempts x nav+Cloudflare+selector timeouts,
//    plus 500 "load more" clicks) is far over 10 minutes. Two overlapping runs both read the same
//    base file, both mutate their own copy, and both write — last writer wins, and the loser's
//    newly added slots are gone.
//
// 2. Stale base. commitViaApi PUTs the whole file using a sha fetched moments earlier, so the sha
//    only protects against a race between that GET and the PUT — NOT against pushing content whose
//    BASE predates a human commit. Kyle made five manual commits to this file in six days,
//    including one collapsing 794 duplicate rows. A container still running its interval with the
//    pre-fix copy will happily overwrite that, authored as "rainbet-slots-bot", with no alert.
//
// (The >1MB content short-circuit above the PUT is already dead: the GitHub Contents API returns
// no `content` for files over 1MB, and rainbet_slots.json is ~1.27MB. So sha is the only signal.)

const { test } = require('node:test');
const assert = require('node:assert');

const MOD = require.resolve('./rainbetSlotSync');
function freshModule() { delete require.cache[MOD]; return require('./rainbetSlotSync'); }

const slotsStub = { reloadRainbetSlots() {} };
const defer = () => { let res; const p = new Promise(r => { res = r; }); return { p, res }; };

test('an overlapping tick is skipped while a run is still going', async () => {
  const S = freshModule();
  let started = 0;
  const gate = defer();
  const runCheck = async () => { started++; await gate.p; return { changed: false }; };

  const first = S.runOnce(slotsStub, { runCheck });
  await new Promise(r => setImmediate(r));
  const second = S.runOnce(slotsStub, { runCheck });   // the 10-minute timer fires again
  await new Promise(r => setImmediate(r));

  assert.strictEqual(started, 1, 'the second tick must not start a concurrent scrape');

  gate.res();
  await Promise.all([first, second]);

  // ...and the guard must RELEASE, or the sync silently stops forever after one slow run.
  await S.runOnce(slotsStub, { runCheck: async () => { started++; return { changed: false }; } });
  assert.strictEqual(started, 2, 'a later run must proceed once the previous one finished');
});

test('the guard releases even when the run throws', async () => {
  const S = freshModule();
  let started = 0;
  await S.runOnce(slotsStub, { runCheck: async () => { started++; throw new Error('scrape exploded'); } });
  await S.runOnce(slotsStub, { runCheck: async () => { started++; return { changed: false }; } });
  assert.strictEqual(started, 2, 'a thrown run must not wedge the guard on');
});

// ── durability: Postgres, not the file, is what keeps a finished scrape ──────
// The catalogue moved into Postgres on 2026-08-04 because the file the deploy resets made it
// hostage to deploy timing — see the header of lib/rainbetSlotStore.js.

const okStore = (rows = []) => ({
  loadAll: async () => rows,
  saveAll: async (entries) => ({ saved: entries.length, deleted: 0 }),
});

test('a finished scrape is written to Postgres BEFORE the repo commit', async () => {
  const S = freshModule();
  const order = [];
  const store = {
    loadAll: async () => [{ rainbetSlug: 'a', name: 'A', thumb: null }],
    saveAll: async (entries) => { order.push(`db:${entries.length}`); return { saved: entries.length }; },
  };
  const files = { readSlotsFile: () => [], writeSlotsFile: () => order.push('file') };
  const kept = [{ rainbetSlug: 'a', name: 'A' }, { rainbetSlug: 'b', name: 'B' }];

  let applied = null;
  const slotsSpy = { setRainbetSlots(e) { applied = e; }, reloadRainbetSlots() { order.push('reread-disk'); } };
  const runCheck = async (hooks) => {
    await hooks.writeResult(kept);
    return { changed: true, added: 1, removed: 0, entries: kept };
  };

  await S.runOnce(slotsSpy, { runCheck, store, files, commit: async () => order.push('commit') });

  // The database write is the durable step, so it has to land before anything that can be
  // interrupted by a deploy. The file + commit are only the repo snapshot.
  assert.deepStrictEqual(order, ['db:2', 'file', 'commit']);
  assert.strictEqual(applied, kept, 'the pool is refreshed from what was persisted, not a re-read');
});

test('the read hook prefers Postgres, falling back to the file only on a fresh database', async () => {
  const S = freshModule();
  const files = { readSlotsFile: () => [{ rainbetSlug: 'from-file', name: 'File' }], writeSlotsFile() {} };
  const seen = [];
  const runCheck = async (hooks) => { seen.push(await hooks.readExisting()); return { changed: false }; };

  await S.runOnce(slotsStub, { runCheck, files, store: okStore([{ rainbetSlug: 'from-db', name: 'Db' }]) });
  await S.runOnce(slotsStub, { runCheck, files, store: okStore([]) });

  assert.strictEqual(seen[0][0].rainbetSlug, 'from-db');
  assert.strictEqual(seen[1][0].rainbetSlug, 'from-file',
    'an empty table is a fresh database, not an empty catalogue');
});

test('a catalogue the store REJECTS is not mirrored to the file, committed, or made live', async () => {
  // Otherwise the shrink guard is undone one layer up: the bad list reaches the repo and the next
  // container seeds from it.
  const S = freshModule();
  const order = [];
  const store = { loadAll: async () => [], saveAll: async () => ({ skipped: 'shrink-guard', before: 100, offered: 3 }) };
  const files = { readSlotsFile: () => [], writeSlotsFile: () => order.push('file') };
  const slotsSpy = { setRainbetSlots: () => order.push('live'), reloadRainbetSlots: () => order.push('live') };
  const runCheck = async (hooks) => {
    await hooks.writeResult([{ rainbetSlug: 'a', name: 'A' }]);
    return { changed: true, added: 0, removed: 97, entries: [{ rainbetSlug: 'a', name: 'A' }] };
  };

  await S.runOnce(slotsSpy, { runCheck, store, files, commit: async () => order.push('commit') });
  assert.deepStrictEqual(order, [], 'nothing may follow a rejected write');
});

test('with no database the run still works off the file', async () => {
  const S = freshModule();
  const order = [];
  const store = { loadAll: async () => null, saveAll: async () => ({ skipped: 'no-db' }) };
  const files = { readSlotsFile: () => [{ rainbetSlug: 'a', name: 'A' }], writeSlotsFile: () => order.push('file') };
  const kept = [{ rainbetSlug: 'a', name: 'A' }, { rainbetSlug: 'b', name: 'B' }];
  const runCheck = async (hooks) => {
    assert.deepStrictEqual(await hooks.readExisting(), [{ rainbetSlug: 'a', name: 'A' }]);
    await hooks.writeResult(kept);
    return { changed: true, added: 1, removed: 0, entries: kept };
  };

  await S.runOnce({ setRainbetSlots: () => order.push('live') }, {
    runCheck, store, files, commit: async () => order.push('commit'),
  });
  // 'no-db' is the local-dev path, not a rejection — the file remains the whole story there.
  assert.deepStrictEqual(order, ['file', 'live', 'commit']);
});

// ── stale-base protection ────────────────────────────────────────────────────
function apiStub({ shas = [], onPut } = {}) {
  const calls = [];
  let i = 0;
  return {
    calls,
    api: async (method, body) => {
      calls.push({ method, body });
      if (method === 'GET') return { sha: shas[Math.min(i++, shas.length - 1)], content: '', encoding: 'none' };
      if (onPut) return onPut(body);
      return { content: { sha: 'sha-after-put' } };
    },
  };
}

test('a push proceeds when the remote is still on the base we started from', async () => {
  const S = freshModule();
  const { api, calls } = apiStub({ shas: ['sha-A', 'sha-A'] });
  await S.captureBaseSha({ api });
  await S.commitViaApi({ api, readContent: () => '[{"x":1}]' });

  assert.strictEqual(calls.filter(c => c.method === 'PUT').length, 1, 'unchanged base → normal push');
});

test('a push is REFUSED when the remote moved off our base (a human commit)', async () => {
  const S = freshModule();
  const { api, calls } = apiStub({ shas: ['sha-A', 'sha-HUMAN'] });
  await S.captureBaseSha({ api });
  await S.commitViaApi({ api, readContent: () => '[{"stale":true}]' });

  assert.strictEqual(calls.filter(c => c.method === 'PUT').length, 0,
    'our base predates the remote — pushing would revert the human commit');
});

test('once refused, it stays refused until the process restarts', async () => {
  const S = freshModule();
  const { api, calls } = apiStub({ shas: ['sha-A', 'sha-HUMAN', 'sha-HUMAN'] });
  await S.captureBaseSha({ api });
  await S.commitViaApi({ api, readContent: () => '[{"stale":true}]' });
  await S.commitViaApi({ api, readContent: () => '[{"stale":true}]' });

  assert.strictEqual(calls.filter(c => c.method === 'PUT').length, 0,
    'a redeploy is what re-bases this container; it must not resume pushing on its own');
});
