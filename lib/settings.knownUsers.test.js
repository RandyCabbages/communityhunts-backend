// recordKnownUser sits in the Bearer fallback (lib/auth.js), which runs on EVERY authenticated
// request — and per CLAUDE.md the Bearer path is the normal one, since sessions are in-memory and
// die on each deploy. It issued an unconditional upsert that always set last_seen = NOW().
//
// Measured on the live database during the 2026-07-27 audit:
//   known_users  n_tup_upd = 5,845,582   n_live_tup = 182   heap = 56 kB / 7 pages
//                autovacuum_count = 6,571   autoanalyze_count = 32,436
//
// Nearly six million row versions on a 182-row table. Every one is a new tuple + WAL record on the
// hot path of every request, and the cost scales with REQUEST volume, not user count, so it never
// self-corrects. Almost all of those writes changed nothing: the same person's name and avatar,
// over and over.

const { test } = require('node:test');
const assert = require('node:assert');

const MOD = require.resolve('./settings');
function freshModule() {
  delete require.cache[MOD];
  return require('./settings');
}

// Captures every statement. recordKnownUser also fans out to recordAlias (user_aliases), so
// assertions filter to the known_users upsert specifically.
function fakePool() {
  const queries = [];
  return {
    queries,
    knownUserWrites: () => queries.filter(q => /INTO known_users/i.test(q.sql)),
    query: async (sql, params) => {
      queries.push({ sql, params });
      return { rows: [], rowCount: 1 };
    },
  };
}

function wire() {
  const S = freshModule();
  const pool = fakePool();
  S.initSettings({ pgPool: pool, hunts: {} });
  return { S, pool };
}

const ALICE = { id: '111', displayName: 'Alice', username: 'alice', avatar: 'a.png' };
const settle = () => new Promise(r => setImmediate(r));

test('repeat requests from the same unchanged user do not re-write known_users', async () => {
  const { S, pool } = wire();

  for (let i = 0; i < 50; i++) S.recordKnownUser({ ...ALICE });
  await settle();

  assert.strictEqual(pool.knownUserWrites().length, 1,
    '50 identical requests must produce ONE write, not 50 — this is the 5.8M-update path');
});

test('a changed display name IS written (dedupe must not suppress real changes)', async () => {
  const { S, pool } = wire();

  S.recordKnownUser({ ...ALICE });
  await settle();
  S.recordKnownUser({ ...ALICE, displayName: 'Alice Renamed' });
  await settle();

  const w = pool.knownUserWrites();
  assert.strictEqual(w.length, 2, 'a real identity change must still reach the database');
  assert.strictEqual(w[1].params[1], 'Alice Renamed');
});

test('a changed avatar is also written', async () => {
  const { S, pool } = wire();
  S.recordKnownUser({ ...ALICE });
  await settle();
  S.recordKnownUser({ ...ALICE, avatar: 'b.png' });
  await settle();
  assert.strictEqual(pool.knownUserWrites().length, 2);
});

test('different users each get their own write (the dedupe is per user, not global)', async () => {
  const { S, pool } = wire();

  S.recordKnownUser({ ...ALICE });
  S.recordKnownUser({ id: '222', displayName: 'Bob', username: 'bob', avatar: 'b.png' });
  await settle();

  assert.strictEqual(pool.knownUserWrites().length, 2);
});

// Defence for the case the in-process cache cannot cover: a second Railway instance, or a restart,
// has a cold cache and will send the statement anyway. The statement itself must then decline to
// write when nothing actually changed, so the row version is never created.
test('the upsert carries a no-op guard so a cold-cache write is still free', async () => {
  const { S, pool } = wire();
  S.recordKnownUser({ ...ALICE });
  await settle();

  const sql = pool.knownUserWrites()[0].sql;
  assert.match(sql, /IS DISTINCT FROM/i,
    'the DO UPDATE needs a WHERE guard — without it every cold-cache request writes a row version');
});
