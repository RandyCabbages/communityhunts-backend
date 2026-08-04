// lib/huntReassign.js — pure planning + apply. Fixtures mirror the real shapes:
// hunts = object keyed by userId, archive = array of snapshots.
const { test } = require('node:test');
const assert = require('node:assert');

const { planReassign, applyReassign, isSharedHuntKey } = require('./huntReassign');

const WALKER = '110983319176384511';
const MCFLURRY = '220983319176384522';
const THIRD = '330983319176384533';

const user = (id, name) => ({ id, displayName: name, avatar: `https://cdn.example/${id}.png` });

const hunt = (over = {}) => ({
  user: user(WALKER, 'TheOnlyWalker'),
  huntId: 'h-1',
  isLive: false,
  huntType: 'community',
  startedAt: '2026-07-01T00:00:00.000Z',
  archivedAt: null,
  tenantId: 'bean',
  bonuses: [{ slot: 'Miami Mayhem', bet: 1.6, win: 24000 }],
  equity: [{ id: 'creator_auto', name: 'TheOnlyWalker', discordId: WALKER, amount: 200 }],
  ...over,
});

const owner = { id: MCFLURRY, displayName: 'Mcflurry', avatar: 'https://cdn.example/mcf.png' };

// ── Happy paths ──────────────────────────────────────────────────────

test('moves the current hunt and re-keys the hunts map', () => {
  const hunts = { [WALKER]: hunt() };
  const plan = planReassign({ hunts, archive: [], tenantId: 'bean', userId: WALKER, newOwnerId: MCFLURRY });
  assert.ok(!plan.error, plan.error);

  const res = applyReassign({ hunts, plan, owner });
  assert.deepStrictEqual(res, { movedCurrent: true, movedArchived: 0, resync: false });
  assert.strictEqual(hunts[WALKER], undefined, 'old key must be gone so the row is DELETEd on flush');
  assert.strictEqual(hunts[MCFLURRY].user.id, MCFLURRY);
  assert.strictEqual(hunts[MCFLURRY].user.displayName, 'Mcflurry');
  assert.strictEqual(hunts[MCFLURRY].user.avatar, 'https://cdn.example/mcf.png');
});

test('moves every archived snapshot of the same hunt instance', () => {
  const archived = hunt({ archivedAt: '2026-07-02T00:00:00.000Z', archiveId: 'a-1' });
  const hunts = { [WALKER]: hunt() };
  const archive = [archived];

  const plan = planReassign({ hunts, archive, tenantId: 'bean', userId: WALKER, newOwnerId: MCFLURRY });
  const res = applyReassign({ hunts, plan, owner });

  assert.deepStrictEqual(res, { movedCurrent: true, movedArchived: 1, resync: false });
  assert.strictEqual(archived.user.id, MCFLURRY);
  assert.strictEqual(archived.archiveId, 'a-1', 'archive row id is stable — the row is updated, not orphaned');
});

test('targeting the archived snapshot also moves the live record of the same instance', () => {
  // Otherwise archiveHunt() rewrites the snapshot from the live hunt on the next end and the
  // reassignment silently reverts.
  const archived = hunt({ archivedAt: '2026-07-02T00:00:00.000Z' });
  const hunts = { [WALKER]: hunt() };

  const plan = planReassign({
    hunts, archive: [archived], tenantId: 'bean',
    userId: WALKER, archivedAt: '2026-07-02T00:00:00.000Z', newOwnerId: MCFLURRY,
  });
  applyReassign({ hunts, plan, owner });

  assert.strictEqual(archived.user.id, MCFLURRY);
  assert.strictEqual(hunts[MCFLURRY].user.id, MCFLURRY);
});

test('leaves an unrelated newer hunt sitting at the same key alone', () => {
  // The owner archived one hunt and opened another; only the archived one is being reassigned.
  const archived = hunt({ huntId: 'h-old', archivedAt: '2026-07-02T00:00:00.000Z' });
  const newer = hunt({ huntId: 'h-new', isLive: true });
  const hunts = { [WALKER]: newer };

  const plan = planReassign({
    hunts, archive: [archived], tenantId: 'bean',
    userId: WALKER, archivedAt: '2026-07-02T00:00:00.000Z', newOwnerId: MCFLURRY,
  });
  const res = applyReassign({ hunts, plan, owner });

  assert.deepStrictEqual(res, { movedCurrent: false, movedArchived: 1, resync: false });
  assert.strictEqual(archived.user.id, MCFLURRY);
  assert.strictEqual(hunts[WALKER], newer, "the owner's current hunt must not move");
  assert.strictEqual(newer.user.id, WALKER);
});

test('equity rows are left untouched — ownership is not the same question as who got paid', () => {
  const hunts = { [WALKER]: hunt() };
  const plan = planReassign({ hunts, archive: [], tenantId: 'bean', userId: WALKER, newOwnerId: MCFLURRY });
  applyReassign({ hunts, plan, owner });
  assert.deepStrictEqual(hunts[MCFLURRY].equity,
    [{ id: 'creator_auto', name: 'TheOnlyWalker', discordId: WALKER, amount: 200 }]);
});

// ── The stats key ────────────────────────────────────────────────────

test('statsKey uses huntId when present', () => {
  const hunts = { [WALKER]: hunt({ huntId: 'h-42' }) };
  const plan = planReassign({ hunts, archive: [], tenantId: 'bean', userId: WALKER, newOwnerId: MCFLURRY });
  assert.strictEqual(plan.statsKey, 'h-42');
});

test('statsKey falls back to the PRE-MOVE owner id when the hunt has no huntId', () => {
  // The fallback form embeds the owner id, so capturing it after the move would look up a row
  // that never existed and leave the hunt credited to the old owner in hunt_history forever.
  const hunts = { [WALKER]: hunt({ huntId: undefined }) };
  const plan = planReassign({ hunts, archive: [], tenantId: 'bean', userId: WALKER, newOwnerId: MCFLURRY });
  assert.strictEqual(plan.statsKey, `${WALKER}|2026-07-01T00:00:00.000Z`);
});

// ── Refusals ─────────────────────────────────────────────────────────

test('refuses a destination that already has a current hunt', () => {
  const hunts = { [WALKER]: hunt(), [MCFLURRY]: hunt({ user: user(MCFLURRY, 'Mcflurry'), huntId: 'h-2' }) };
  const plan = planReassign({ hunts, archive: [], tenantId: 'bean', userId: WALKER, newOwnerId: MCFLURRY });
  assert.strictEqual(plan.status, 409);
  assert.strictEqual(hunts[MCFLURRY].huntId, 'h-2', 'the destination hunt must survive');
});

test('allows reassigning an ARCHIVED hunt even when the destination has a current hunt', () => {
  // Only the live map is single-slot; the archive holds many hunts per user.
  const archived = hunt({ huntId: 'h-old', archivedAt: '2026-07-02T00:00:00.000Z' });
  const hunts = { [MCFLURRY]: hunt({ user: user(MCFLURRY, 'Mcflurry'), huntId: 'h-2' }) };
  const plan = planReassign({
    hunts, archive: [archived], tenantId: 'bean',
    userId: WALKER, archivedAt: '2026-07-02T00:00:00.000Z', newOwnerId: MCFLURRY,
  });
  assert.ok(!plan.error, plan.error);
  assert.deepStrictEqual(applyReassign({ hunts, plan, owner }), { movedCurrent: false, movedArchived: 1, resync: false });
});

test('refuses a shared community hunt key', () => {
  const hunts = { __vip_hunt__: hunt({ user: user('__vip_hunt__', 'Bean') }) };
  const plan = planReassign({ hunts, archive: [], tenantId: 'bean', userId: '__vip_hunt__', newOwnerId: MCFLURRY });
  assert.strictEqual(plan.status, 400);
  assert.match(plan.error, /Shared community hunts/);
});

test('isSharedHuntKey covers bare + namespaced keys and the pre-rebrand tenant-hunt key', () => {
  // Bean uses the bare key; every other tenant namespaces it. '__mod_hunt__' is the old value of
  // MOD_HUNT_ID and still owns already-archived tenant hunts, so it has to be refused too.
  for (const k of ['__tenant_hunt__', '__mod_hunt__', '__affiliate_hunt__', '__vip_hunt__']) {
    assert.ok(isSharedHuntKey(k), `bare ${k}`);
    assert.ok(isSharedHuntKey(`${k}:someslug`), `namespaced ${k}`);
  }
  assert.ok(!isSharedHuntKey(WALKER));
  assert.ok(!isSharedHuntKey(null));
});

test('refuses a new owner that is not a linked Discord account', () => {
  const hunts = { [WALKER]: hunt() };
  for (const bad of ['manual:mcflurry', 'creator_auto', '', 'not-an-id']) {
    const plan = planReassign({ hunts, archive: [], tenantId: 'bean', userId: WALKER, newOwnerId: bad });
    assert.strictEqual(plan.status, 400, `expected ${bad} to be refused`);
  }
});

test('re-running a landed reassign is a RESYNC, not a refusal', () => {
  // The records and the durable stats are separate stores, so a failed stats handoff leaves the
  // hunt renamed with stale rollups. The retry is the only repair — refusing it as a no-op would
  // strand that state.
  const existing = hunt({ user: user(MCFLURRY, 'Mcflurry') });
  const hunts = { [MCFLURRY]: existing };
  const plan = planReassign({ hunts, archive: [], tenantId: 'bean', userId: MCFLURRY, newOwnerId: MCFLURRY });
  assert.ok(!plan.error, plan.error);
  assert.strictEqual(plan.resync, true);
  assert.strictEqual(plan.statsKey, 'h-1');

  const res = applyReassign({ hunts, plan, owner });
  assert.deepStrictEqual(res, { movedCurrent: false, movedArchived: 0, resync: true });
  assert.strictEqual(hunts[MCFLURRY], existing, 'the hunt stays put and keeps its key');
});

test('a normal move reports resync false', () => {
  const hunts = { [WALKER]: hunt() };
  const plan = planReassign({ hunts, archive: [], tenantId: 'bean', userId: WALKER, newOwnerId: MCFLURRY });
  assert.strictEqual(plan.resync, false);
  assert.deepStrictEqual(applyReassign({ hunts, plan, owner }),
    { movedCurrent: true, movedArchived: 0, resync: false });
});

test('refuses a hunt belonging to another tenant', () => {
  const hunts = { [WALKER]: hunt({ tenantId: 'other' }) };
  const plan = planReassign({ hunts, archive: [], tenantId: 'bean', userId: WALKER, newOwnerId: MCFLURRY });
  assert.strictEqual(plan.status, 404);
});

test('refuses an archived snapshot belonging to another tenant', () => {
  const archived = hunt({ tenantId: 'other', archivedAt: '2026-07-02T00:00:00.000Z' });
  const plan = planReassign({
    hunts: {}, archive: [archived], tenantId: 'bean',
    userId: WALKER, archivedAt: '2026-07-02T00:00:00.000Z', newOwnerId: MCFLURRY,
  });
  assert.strictEqual(plan.status, 404);
});

test('refuses an unknown hunt', () => {
  const plan = planReassign({ hunts: {}, archive: [], tenantId: 'bean', userId: THIRD, newOwnerId: MCFLURRY });
  assert.strictEqual(plan.status, 404);
});
