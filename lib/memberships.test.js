const { test } = require('node:test');
const assert = require('node:assert');
const memberships = require('./memberships');

// Fake pgPool: records queries, returns canned rows for SELECT, [] otherwise. No real DB.
// Same idiom as lib/bans.test.js.
function makeFakePgPool(selectRows) {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql, params });
      if (/^\s*SELECT\b/i.test(sql)) return { rows: selectRows || [] };
      return { rows: [], rowCount: 0 };
    },
  };
}

// init runs CREATE TABLE / ALTER / the one-time wipe; drop those so assertions read the
// call under test, not the migration noise.
async function poolAfterInit(selectRows) {
  const pool = makeFakePgPool(selectRows);
  await memberships.initMemberships({ pgPool: pool });
  pool.calls.length = 0;
  return pool;
}

const lastWrite = (pool) => pool.calls[pool.calls.length - 1];

test('no DB: every call is a safe no-op', async () => {
  await memberships.initMemberships({});
  assert.equal(await memberships.joinCommunity('1', 'bean'), false);
  assert.equal(await memberships.leaveCommunity('1', 'bean'), false);
  assert.deepEqual(await memberships.getUserCommunities('1'), []);
  assert.equal(await memberships.getMembershipSource('1', 'bean'), null);
  assert.deepEqual(await memberships.getMemberCounts(), {});
});

test('init adds the source column in place (no destructive migration)', async () => {
  const pool = makeFakePgPool();
  await memberships.initMemberships({ pgPool: pool });
  const alter = pool.calls.find(c => /ALTER TABLE community_members/i.test(c.sql));
  assert.ok(alter, 'expected an ALTER TABLE … ADD COLUMN for source');
  assert.match(alter.sql, /ADD COLUMN IF NOT EXISTS source/i);
  // The DEFAULT is the backfill for existing rows — they were all written by reconcileMembership.
  assert.match(alter.sql, /DEFAULT 'role'/i);
});

// ── source stickiness: the heart of the change ───────────────────────────────
// A deliberate join must outrank role churn. reconcileMembership runs on EVERY login, so
// without these two rules it silently evicts anyone who joined via the Settings button.

test("reconcile-join writes source='role' and cannot downgrade an existing self row", async () => {
  const pool = await poolAfterInit();
  await memberships.joinCommunity('1', 'partnerco', 'role');
  const q = lastWrite(pool);
  assert.match(q.sql, /ON CONFLICT[\s\S]*DO NOTHING/i,
    'a role join must not overwrite a self row');
  assert.ok(!/DO UPDATE/i.test(q.sql), 'role join must never DO UPDATE');
  assert.deepEqual(q.params, ['1', 'partnerco', 'role']);
});

test("the Settings join button writes source='self' and upgrades an existing role row", async () => {
  const pool = await poolAfterInit();
  await memberships.joinCommunity('1', 'partnerco'); // default source
  const q = lastWrite(pool);
  assert.match(q.sql, /ON CONFLICT[\s\S]*DO UPDATE SET source/i,
    'an explicit join must upgrade a role row to self, so it survives losing the role');
  assert.deepEqual(q.params, ['1', 'partnerco', 'self']);
});

test('reconcile-evict removes only role rows, sparing a deliberate join', async () => {
  const pool = await poolAfterInit();
  await memberships.leaveCommunity('1', 'partnerco', { onlySource: 'role' });
  const q = lastWrite(pool);
  assert.match(q.sql, /DELETE FROM community_members/i);
  assert.match(q.sql, /source\s*=\s*\$3/i, 'the source must be a bound param, not interpolated');
  assert.deepEqual(q.params, ['1', 'partnerco', 'role']);
});

test('an explicit Leave removes the row whatever its source', async () => {
  const pool = await poolAfterInit();
  await memberships.leaveCommunity('1', 'partnerco');
  const q = lastWrite(pool);
  assert.match(q.sql, /DELETE FROM community_members/i);
  assert.ok(!/source/i.test(q.sql), 'an explicit leave must not be source-scoped');
  assert.deepEqual(q.params, ['1', 'partnerco']);
});

// ── getMembershipSource ──────────────────────────────────────────────────────

test('getMembershipSource returns the stored source, or null when there is no row', async () => {
  const withRow = await poolAfterInit([{ source: 'self' }]);
  assert.equal(await memberships.getMembershipSource('1', 'partnerco'), 'self');
  assert.deepEqual(lastWrite(withRow).params, ['1', 'partnerco']);

  const noRow = await poolAfterInit([]);
  assert.equal(await memberships.getMembershipSource('1', 'partnerco'), null);
  assert.ok(noRow); // silence unused
});

test('getMembershipSource coerces ids to strings, matching the rest of the module', async () => {
  const pool = await poolAfterInit([{ source: 'role' }]);
  assert.equal(await memberships.getMembershipSource(123, 'partnerco'), 'role');
  assert.deepEqual(lastWrite(pool).params, ['123', 'partnerco']);
});

test('getMembershipSource fails closed to null when the query throws', async () => {
  const pool = makeFakePgPool();
  await memberships.initMemberships({ pgPool: pool });
  pool.query = async () => { throw new Error('db down'); };
  // null means "not a member", which denies the Partner perk — the safe direction.
  assert.equal(await memberships.getMembershipSource('1', 'partnerco'), null);
});

test('getUserCommunities is unchanged — still bare slugs, so existing callers are untouched', async () => {
  await poolAfterInit([{ tenant_id: 'bean' }, { tenant_id: 'partnerco' }]);
  assert.deepEqual(await memberships.getUserCommunities('1'), ['bean', 'partnerco']);
});
