// The in-memory archive is ONE array shared by every tenant, so a single global cap let a busy
// community evict another community's hunts from every array-backed view (Hub Archived tab,
// stats aggregation, bangers, got-in log). Postgres hunt_history is the uncapped record, so
// nothing is LOST — but a hub degrading because somebody else streamed a lot is still a bug,
// and it arrives the moment a second community is active.
//
// trimArchive is pure over its array argument (no fs, no pgPool) precisely so this can be tested.
const { test } = require('node:test');
const assert = require('node:assert');
const { trimArchive } = require('./persistence');

// Newest-first, matching how archiveHunt unshifts.
const mk = (tenantId, n) => Array.from({ length: n }, (_, i) => ({ tenantId, huntId: `${tenantId}-${i}` }));

test('keeps the newest N for the trimmed tenant and drops the rest', () => {
  const list = mk('acme', 5);
  trimArchive(list, 'acme', 3, 100);
  assert.deepStrictEqual(list.map(h => h.huntId), ['acme-0', 'acme-1', 'acme-2']);
});

test("trimming one tenant never evicts another tenant's hunts", () => {
  // Interleaved, as a real shared archive would be.
  const list = [
    { tenantId: 'acme', huntId: 'a0' }, { tenantId: 'bean', huntId: 'b0' },
    { tenantId: 'acme', huntId: 'a1' }, { tenantId: 'bean', huntId: 'b1' },
    { tenantId: 'acme', huntId: 'a2' }, { tenantId: 'bean', huntId: 'b2' },
  ];
  trimArchive(list, 'acme', 1, 100);
  // Every bean hunt survives; only acme is trimmed to its newest.
  assert.deepStrictEqual(list.map(h => h.huntId), ['a0', 'b0', 'b1', 'b2']);
});

test('a busy tenant cannot push a quiet tenant out (the bug this fixes)', () => {
  const list = [...mk('busy', 50), ...mk('quiet', 2)];
  trimArchive(list, 'busy', 10, 1000);
  assert.strictEqual(list.filter(h => h.tenantId === 'quiet').length, 2);
  assert.strictEqual(list.filter(h => h.tenantId === 'busy').length, 10);
});

test('untagged hunts are treated as bean, matching tenantOf', () => {
  const list = [{ huntId: 'u0' }, { huntId: 'u1' }, { tenantId: 'bean', huntId: 'b0' }];
  trimArchive(list, 'bean', 2, 100);
  assert.deepStrictEqual(list.map(h => h.huntId), ['u0', 'u1']);
});

test('under the cap is a no-op', () => {
  const list = mk('acme', 3);
  const before = list.map(h => h.huntId);
  trimArchive(list, 'acme', 10, 100);
  assert.deepStrictEqual(list.map(h => h.huntId), before);
});

test('the global backstop bounds total memory across tenants', () => {
  const list = [...mk('a', 4), ...mk('b', 4)];
  trimArchive(list, 'a', 100, 5); // per-tenant cap not hit; total cap is
  assert.strictEqual(list.length, 5);
});

test('tolerates an empty array', () => {
  const list = [];
  trimArchive(list, 'acme', 10, 100);
  assert.deepStrictEqual(list, []);
});
