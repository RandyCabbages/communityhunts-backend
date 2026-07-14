// lib/hallOfFame.js — pure selection logic, no persistence, no env. Fixtures mirror
// the real shapes: hunts = object keyed by userId, archive = array of snapshots.
const { test } = require('node:test');
const assert = require('node:assert');

const { collectHallOfFame, FAME_MIN_MULT, FAME_CAP } = require('./hallOfFame');

const REPLAY = 'https://dhh68l6ktxf70.cloudfront.net/replay-manager/?roundid=1&partner=2881';

const user = (id, name) => ({ id, displayName: name, avatar: `https://cdn.example/${id}.png` });

const hunt = (over = {}) => ({
  user: user('u1', 'Hunter One'),
  isLive: false,
  huntType: 'community',
  startedAt: '2026-07-01T00:00:00.000Z',
  archivedAt: null,
  tenantId: 'bean',
  bonuses: [],
  ...over,
});

const bonus = (over = {}) => ({ slot: 'Gates of Olympus', bet: 1, win: 400, replayUrl: REPLAY, ...over });

test('includes only bonuses with a replayUrl', () => {
  const archive = [hunt({ bonuses: [bonus(), bonus({ slot: 'Sugar Rush', replayUrl: '' })] })];
  const out = collectHallOfFame({}, archive, 'bean');
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].slot, 'Gates of Olympus');
  assert.strictEqual(out[0].replayUrl, REPLAY);
});

test('excludes replay hits under the 300x floor', () => {
  const archive = [hunt({ bonuses: [bonus({ win: 299 })] })];
  assert.strictEqual(collectHallOfFame({}, archive, 'bean').length, 0);
  assert.strictEqual(FAME_MIN_MULT, 300);
});

test('excludes non-http(s) replay urls', () => {
  const archive = [hunt({ bonuses: [bonus({ replayUrl: 'javascript:alert(1)' })] })];
  assert.strictEqual(collectHallOfFame({}, archive, 'bean').length, 0);
});

test('sorts by multiplier descending, not recency', () => {
  const archive = [
    hunt({ archivedAt: '2026-07-14T00:00:00.000Z', bonuses: [bonus({ slot: 'Recent Small', win: 350 })] }),
    hunt({ archivedAt: '2026-05-01T00:00:00.000Z', bonuses: [bonus({ slot: 'Old Record', win: 5000 })] }),
  ];
  const out = collectHallOfFame({}, archive, 'bean');
  assert.deepStrictEqual(out.map(h => h.slot), ['Old Record', 'Recent Small']);
  assert.strictEqual(out[0].mult, 5000);
});

test('no per-user cap — one user may hold several records', () => {
  const archive = [hunt({
    bonuses: [
      bonus({ slot: 'A', win: 400 }),
      bonus({ slot: 'B', win: 500 }),
      bonus({ slot: 'C', win: 600 }),
    ],
  })];
  assert.strictEqual(collectHallOfFame({}, archive, 'bean').length, 3);
});

test('caps the list at FAME_CAP entries', () => {
  const bonuses = Array.from({ length: 15 }, (_, i) => bonus({ slot: `Slot ${i}`, win: 400 + i }));
  const archive = [hunt({ bonuses })];
  assert.strictEqual(collectHallOfFame({}, archive, 'bean').length, FAME_CAP);
  assert.strictEqual(FAME_CAP, 12);
});

test('tenant isolation — other tenants never leak; untagged hunts default to bean', () => {
  const archive = [
    hunt({ tenantId: 'otherstreamer', bonuses: [bonus({ slot: 'Foreign' })] }),
    hunt({ tenantId: undefined, bonuses: [bonus({ slot: 'Untagged' })] }),
  ];
  const out = collectHallOfFame({}, archive, 'bean');
  assert.deepStrictEqual(out.map(h => h.slot), ['Untagged']);
});

test('live hunt copy wins the dedupe over an archived duplicate and is flagged live', () => {
  const dupe = bonus();
  const hunts = { u1: hunt({ isLive: true, bonuses: [dupe] }) };
  const archive = [hunt({ archivedAt: '2026-07-10T00:00:00.000Z', bonuses: [dupe] })];
  const out = collectHallOfFame(hunts, archive, 'bean');
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].live, true);
});

test('payload carries the full card shape', () => {
  const out = collectHallOfFame({}, [hunt({ huntType: 'vip', bonuses: [bonus({ bet: 2, win: 800 })] })], 'bean');
  assert.deepStrictEqual(out[0], {
    slot: 'Gates of Olympus', bet: 2, win: 800, mult: 400,
    userId: 'u1', username: 'Hunter One', avatar: 'https://cdn.example/u1.png',
    huntType: 'vip', live: false, at: '2026-07-01T00:00:00.000Z',
    archivedAt: null, replayUrl: REPLAY,
  });
});
