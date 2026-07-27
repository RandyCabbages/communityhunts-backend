// Vault changes were the one money-moving edit the audit log did not record: recordHuntChange
// snapshotted bonuses, equity and calls only. A 2026-07-27 report ("vault button seems broke...
// when we were putting in the correct amount it was off by like 200 so we had to tweak it a lot")
// could not be diagnosed from the log at all — the stored total was provably correct, but nothing
// showed WHAT had been typed, retyped, or removed to arrive there.
//
// The design point that matters: equity deliberately keys on `id` alone, so an amount edit
// ($500 -> $50) logs nothing. For vault that would defeat the purpose — the amount IS the event.
// A re-typed vault figure has to surface as a change with from/to.

const test = require('node:test');
const assert = require('node:assert');
const { diffVault, summarize } = require('./auditLog');

const V = (id, amount, note = '') => ({ id, amount, note, ts: 1 });

test('diffVault: an added entry is reported', () => {
  const d = diffVault([], [V('v1', 785000)]);
  assert.strictEqual(d.added.length, 1);
  assert.strictEqual(d.added[0].amount, 785000);
  assert.strictEqual(d.removed.length, 0);
  assert.strictEqual(d.changed.length, 0);
});

test('diffVault: a removed entry is reported', () => {
  const d = diffVault([V('v1', 785000)], []);
  assert.strictEqual(d.removed.length, 1);
  assert.strictEqual(d.removed[0].amount, 785000);
  assert.strictEqual(d.added.length, 0);
});

// The actual reported scenario: same entry, amount retyped repeatedly.
test('diffVault: an AMOUNT edit is reported with from/to (equity would ignore this)', () => {
  const d = diffVault([V('v1', 785200)], [V('v1', 785000)]);
  assert.strictEqual(d.added.length, 0, 'not an add — same entry');
  assert.strictEqual(d.removed.length, 0, 'not a remove — same entry');
  assert.strictEqual(d.changed.length, 1);
  assert.strictEqual(d.changed[0].from, 785200);
  assert.strictEqual(d.changed[0].to, 785000);
});

test('diffVault: an unchanged entry logs nothing', () => {
  const d = diffVault([V('v1', 785000, 'base game')], [V('v1', 785000, 'base game')]);
  assert.deepStrictEqual([d.added.length, d.removed.length, d.changed.length], [0, 0, 0]);
});

test('diffVault: a note-only edit is not an amount change', () => {
  const d = diffVault([V('v1', 100, 'a')], [V('v1', 100, 'b')]);
  assert.strictEqual(d.changed.length, 0, 'only money movements are worth a log line');
});

test('diffVault: tolerates a missing/legacy vault array', () => {
  const d = diffVault(undefined, undefined);
  assert.deepStrictEqual([d.added.length, d.removed.length, d.changed.length], [0, 0, 0]);
});

test('diffVault: numeric strings compare by value, not identity', () => {
  const d = diffVault([V('v1', 100)], [V('v1', '100')]);
  assert.strictEqual(d.changed.length, 0, "'100' and 100 are the same money");
});

test('summarize: vault.add names the amount', () => {
  const s = summarize('vault.add', {
    actorName: 'Kyle', targetName: 'Bean', entries: [V('v1', 785000)],
  });
  assert.match(s, /Kyle/);
  assert.match(s, /785,?000/);
  assert.match(s, /Bean's hunt/);
});

test('summarize: vault.change shows the movement', () => {
  const s = summarize('vault.change', {
    actorName: 'Kyle', targetName: 'Bean',
    changed: [{ id: 'v1', from: 785200, to: 785000 }],
  });
  assert.match(s, /785,?200/);
  assert.match(s, /785,?000/);
});

// ── through recordHuntChange, the way the routes call it ────────────────────
const audit = require('./auditLog');
const REQ = { user: { id: '2', displayName: 'Kyle' }, tenant: { id: 'bean' }, ip: '::1' };
const base = { bonuses: [], equity: [], calls: [] };

test('recordHuntChange: a retyped vault amount is recorded', async () => {
  await audit.initAuditLog({ pgPool: null });
  audit.recordHuntChange(REQ,
    { ...base, vault: [V('v1', 785200)] },
    { ...base, vault: [V('v1', 785000)] },
    { targetId: '2', targetName: 'zDec' });

  const r = await audit.query({ limit: 50 });
  assert.strictEqual(r.rows.length, 1);
  assert.strictEqual(r.rows[0].action, 'vault.change');
  assert.deepStrictEqual(r.rows[0].detail.changed, [{ id: 'v1', from: 785200, to: 785000 }]);
});

test('recordHuntChange: an added vault entry is recorded with the before-snapshot', async () => {
  await audit.initAuditLog({ pgPool: null });
  audit.recordHuntChange(REQ, { ...base, vault: [] }, { ...base, vault: [V('v1', 785000)] },
    { targetId: '2', targetName: 'zDec' });

  const r = await audit.query({ limit: 50 });
  assert.strictEqual(r.rows.length, 1);
  assert.strictEqual(r.rows[0].action, 'vault.add');
  assert.ok(Array.isArray(r.rows[0].detail.before.vault), 'the before-snapshot must carry vault too');
});

// The wiring hazard: if a caller passes `after.vault` but not `before.vault`, EVERY save would
// look like a fresh add and spam the log. Callers that touch neither must stay silent.
test('recordHuntChange: a hunt with an untouched vault logs nothing', async () => {
  await audit.initAuditLog({ pgPool: null });
  audit.recordHuntChange(REQ,
    { ...base, vault: [V('v1', 785000)] },
    { ...base, vault: [V('v1', 785000)] },
    { targetId: '2', targetName: 'zDec' });
  assert.strictEqual((await audit.query({ limit: 50 })).rows.length, 0);
});

test('recordHuntChange: callers that omit vault entirely stay silent', async () => {
  await audit.initAuditLog({ pgPool: null });
  audit.recordHuntChange(REQ, base, base, { targetId: '2', targetName: 'zDec' });
  assert.strictEqual((await audit.query({ limit: 50 })).rows.length, 0);
});

test('summarize: vault.remove names the amount', () => {
  const s = summarize('vault.remove', {
    actorName: 'Kyle', targetName: 'Bean', entries: [V('v1', 500)],
  });
  assert.match(s, /removed/i);
  assert.match(s, /500/);
});
