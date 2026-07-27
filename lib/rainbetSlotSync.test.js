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
