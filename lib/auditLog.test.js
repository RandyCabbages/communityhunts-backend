const test = require('node:test');
const assert = require('node:assert');
const { diffBonuses, summarize } = require('./auditLog');

test('diffBonuses: detects a deletion by slot', () => {
  const before = [{ slot: 'Gates of Olympus' }, { slot: 'Sugar Rush' }];
  const after  = [{ slot: 'Gates of Olympus' }];
  const d = diffBonuses(before, after);
  assert.strictEqual(d.removed.length, 1);
  assert.strictEqual(d.removed[0].slot, 'Sugar Rush');
  assert.strictEqual(d.cleared, false);
});

test('diffBonuses: ignores a pure reorder', () => {
  const before = [{ slot: 'A' }, { slot: 'B' }, { slot: 'C' }];
  const after  = [{ slot: 'C' }, { slot: 'A' }, { slot: 'B' }];
  assert.strictEqual(diffBonuses(before, after).removed.length, 0);
});

test('diffBonuses: ignores a win/bet value edit', () => {
  const before = [{ slot: 'A', bet: 1, win: 0 }];
  const after  = [{ slot: 'A', bet: 1, win: 250 }];
  assert.strictEqual(diffBonuses(before, after).removed.length, 0);
});

test('diffBonuses: prefers id over slot, duplicate-safe', () => {
  const before = [{ id: 'x', slot: 'A' }, { id: 'y', slot: 'A' }];
  const after  = [{ id: 'x', slot: 'A' }];
  const d = diffBonuses(before, after);
  assert.strictEqual(d.removed.length, 1);
  assert.strictEqual(d.removed[0].id, 'y');
});

test('diffBonuses: cleared flag when after is empty', () => {
  const d = diffBonuses([{ slot: 'A' }], []);
  assert.strictEqual(d.cleared, true);
  assert.strictEqual(d.removed.length, 1);
});

test('summarize: bonus.delete lists up to 3 + overflow', () => {
  const s = summarize('bonus.delete', {
    actorName: 'Kyle', targetName: 'Bean',
    removed: [{ slot: 'A' }, { slot: 'B' }, { slot: 'C' }, { slot: 'D' }],
  });
  assert.match(s, /Kyle removed 4 bonuses \(A, B, C, \+1\) from Bean's hunt/);
});

const audit = require('./auditLog');

test('ring mode: record + query filters + keyset paging', async () => {
  await audit.initAuditLog({ pgPool: null }); // ring mode
  await audit.record({ category: 'auth', action: 'auth.login', actorId: '1', actorName: 'A', summary: 'A logged in' });
  await audit.record({ category: 'hunt', action: 'bonus.delete', actorId: '2', actorName: 'B', targetId: '9', summary: 'B removed 1 bonus' });
  await audit.record({ category: 'hunt', action: 'hunt.reset', actorId: '2', actorName: 'B', targetId: '9', summary: 'B reset a hunt' });

  const all = await audit.query({ limit: 50 });
  assert.strictEqual(all.rows.length, 3);
  assert.strictEqual(all.rows[0].action, 'hunt.reset'); // newest first

  const hunts = await audit.query({ category: 'hunt' });
  assert.strictEqual(hunts.rows.length, 2);

  const byActor = await audit.query({ actorId: '1' });
  assert.strictEqual(byActor.rows.length, 1);

  const search = await audit.query({ q: 'removed' });
  assert.strictEqual(search.rows.length, 1);

  const page1 = await audit.query({ limit: 2 });
  assert.strictEqual(page1.rows.length, 2);
  assert.ok(page1.nextCursor);
  const page2 = await audit.query({ limit: 2, cursor: page1.nextCursor });
  assert.strictEqual(page2.rows.length, 1);
});

test('query: clamps limit to 200 max', async () => {
  await audit.initAuditLog({ pgPool: null });
  for (let i = 0; i < 250; i++) {
    await audit.record({ category: 'auth', action: 'auth.login', actorId: String(i), summary: `s${i}` });
  }
  const r = await audit.query({ limit: 999 });
  assert.strictEqual(r.rows.length, 200);
});

test('ring mode: RING_MAX cap keeps newest, drops oldest', async () => {
  await audit.initAuditLog({ pgPool: null });
  for (let i = 0; i < audit.RING_MAX + 10; i++) {
    await audit.record({ category: 'auth', action: 'auth.login', actorId: String(i), summary: `s${i}` });
  }
  // Page through everything (query clamps at 200/page) and count the true total.
  let total = 0, cursor = null, first = null;
  do {
    const page = await audit.query({ limit: 200, cursor });
    if (first === null && page.rows.length) first = page.rows[0].summary;
    total += page.rows.length;
    cursor = page.nextCursor;
  } while (cursor);

  assert.strictEqual(total, audit.RING_MAX);                       // capped
  assert.strictEqual(first, `s${audit.RING_MAX + 9}`);             // newest kept
  const oldest = await audit.query({ q: 's0 ' });                  // s0 evicted
  assert.strictEqual(oldest.rows.length, 0);
});

test('recordHuntChange: writes on deletion, silent on value edit', async () => {
  await audit.initAuditLog({ pgPool: null });
  const req = { user: { id: '2', displayName: 'B' }, tenant: { id: 'bean' }, ip: '::1' };
  audit.recordHuntChange(req,
    { bonuses: [{ slot: 'A' }, { slot: 'B' }], equity: [], calls: [] },
    { bonuses: [{ slot: 'A' }], equity: [], calls: [] },
    { targetId: '2', targetName: 'B' });
  audit.recordHuntChange(req,
    { bonuses: [{ slot: 'A', win: 0 }], equity: [], calls: [] },
    { bonuses: [{ slot: 'A', win: 99 }], equity: [], calls: [] },
    { targetId: '2', targetName: 'B' });
  const r = await audit.query({ limit: 50 });
  assert.strictEqual(r.rows.length, 1);
  assert.strictEqual(r.rows[0].action, 'bonus.delete');
  assert.ok(r.rows[0].detail.before); // before-snapshot stored
});

test('prune: issues a delete against pgPool when present', async () => {
  const calls = [];
  const mockPool = { query: async (sql, params) => { calls.push({ sql, params }); return { rows: [] }; } };
  await audit.initAuditLog({ pgPool: mockPool });
  calls.length = 0; // ignore table-init calls
  await audit.prune();
  assert.ok(calls.some(c => /DELETE FROM audit_log/i.test(c.sql)));
});
