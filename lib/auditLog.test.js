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

// ── diffMembers (equity membership) ────────────────────────────────
// Equity rows always carry a stable id (uid() from the client; creator_auto/bean_auto/
// host_auto:<slug> server-side). `+ Add person` creates an EMPTY row you then type into, so
// membership is judged on NAMED rows only — that's what makes "type the name" the add event
// instead of the click.
const { diffMembers } = require('./auditLog');

test('diffMembers: naming an empty row IS the add', () => {
  const d = diffMembers([{ id: 'x', name: '' }], [{ id: 'x', name: 'Randy' }]);
  assert.strictEqual(d.added.length, 1);
  assert.strictEqual(d.added[0].name, 'Randy');
  assert.strictEqual(d.removed.length, 0);
});

test('diffMembers: clicking + Add (empty row) logs nothing', () => {
  const d = diffMembers([], [{ id: 'x', name: '', amount: 0 }]);
  assert.strictEqual(d.added.length, 0);
  assert.strictEqual(d.removed.length, 0);
});

test('diffMembers: add-then-delete an empty row (misclick) logs nothing', () => {
  const d = diffMembers([{ id: 'x', name: '' }], []);
  assert.strictEqual(d.added.length, 0);
  assert.strictEqual(d.removed.length, 0);
});

test('diffMembers: removal detected', () => {
  const d = diffMembers(
    [{ id: 'a', name: 'Bean' }, { id: 'b', name: 'Randy' }],
    [{ id: 'a', name: 'Bean' }]);
  assert.strictEqual(d.removed.length, 1);
  assert.strictEqual(d.removed[0].name, 'Randy');
  assert.strictEqual(d.added.length, 0);
});

test('diffMembers: rename is NOT a remove+add (same id)', () => {
  const d = diffMembers([{ id: 'a', name: 'Randy' }], [{ id: 'a', name: 'Randall' }]);
  assert.strictEqual(d.added.length, 0);
  assert.strictEqual(d.removed.length, 0);
});

test('diffMembers: amount edit alone logs nothing', () => {
  const d = diffMembers([{ id: 'a', name: 'Randy', amount: 500 }], [{ id: 'a', name: 'Randy', amount: 50 }]);
  assert.strictEqual(d.added.length, 0);
  assert.strictEqual(d.removed.length, 0);
});

test('diffMembers: the discordId linking pass (name rewritten, id kept) logs nothing', () => {
  const d = diffMembers(
    [{ id: 'creator_auto', name: 'randy' }],
    [{ id: 'creator_auto', name: 'Randy', discordId: '123' }]);
  assert.strictEqual(d.added.length, 0);
  assert.strictEqual(d.removed.length, 0);
});

test('diffMembers: reorder logs nothing', () => {
  const before = [{ id: 'a', name: 'Bean' }, { id: 'b', name: 'Randy' }];
  const after  = [{ id: 'b', name: 'Randy' }, { id: 'a', name: 'Bean' }];
  const d = diffMembers(before, after);
  assert.strictEqual(d.added.length, 0);
  assert.strictEqual(d.removed.length, 0);
});

test('summarize: equity.add / equity.remove name the member and the hunt', () => {
  assert.strictEqual(
    summarize('equity.add', { actorName: 'Kyle', huntLabel: 'the Mod Hunt', members: [{ name: 'Randy' }] }),
    'Kyle added Randy to the Mod Hunt');
  assert.strictEqual(
    summarize('equity.remove', { actorName: 'Kyle', huntLabel: 'the Mod Hunt', members: [{ name: 'Randy' }] }),
    'Kyle removed Randy from the Mod Hunt');
});

// Regression: the two label styles used to each assume the other's shape — personal hunts got
// "added Randy to Goofer" (missing "'s hunt") and shared hunts got "from the Mod Hunt's hunt".
// One `huntLabel` concept fixes both; these pin the exact prose.
test('summarize: personal hunts read "<name>\'s hunt" for BOTH bonus and equity actions', () => {
  assert.strictEqual(
    summarize('equity.add', { actorName: 'Kyle', targetName: 'Goofer', members: [{ name: 'Randy' }] }),
    "Kyle added Randy to Goofer's hunt");
  assert.strictEqual(
    summarize('bonus.delete', { actorName: 'Kyle', targetName: 'Goofer', removed: [{ slot: 'A' }] }),
    "Kyle removed 1 bonus (A) from Goofer's hunt");
});

test('summarize: shared hunts never say "the Mod Hunt\'s hunt"', () => {
  const s = summarize('bonus.delete', { actorName: 'Kyle', huntLabel: 'the Mod Hunt', removed: [{ slot: 'A' }] });
  assert.strictEqual(s, 'Kyle removed 1 bonus (A) from the Mod Hunt');
  assert.doesNotMatch(s, /Hunt's hunt/);
  assert.doesNotMatch(
    summarize('hunt.reset', { actorName: 'Kyle', huntLabel: 'the Affiliate Hunt' }),
    /Hunt's hunt/);
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

test('recordHuntChange: emits equity.remove alongside a bonus.delete in one PUT', async () => {
  await audit.initAuditLog({ pgPool: null });
  const req = { user: { id: '2', displayName: 'Kyle' }, tenant: { id: 'bean' }, ip: '::1' };
  audit.recordHuntChange(req,
    { bonuses: [{ slot: 'A' }, { slot: 'B' }], equity: [{ id: 'a', name: 'Bean' }, { id: 'b', name: 'Randy' }], calls: [] },
    { bonuses: [{ slot: 'A' }],                equity: [{ id: 'a', name: 'Bean' }],                            calls: [] },
    { targetId: '__mod_hunt__', huntLabel: 'the Mod Hunt' });
  const r = await audit.query({ limit: 50 });
  const actions = r.rows.map(x => x.action).sort();
  assert.deepStrictEqual(actions, ['bonus.delete', 'equity.remove']);
  const eq = r.rows.find(x => x.action === 'equity.remove');
  assert.strictEqual(eq.summary, 'Kyle removed Randy from the Mod Hunt');
  assert.ok(eq.detail.before, 'equity row carries a before-snapshot');
});

test('recordHuntChange: equity-only change emits ONLY an equity row', async () => {
  await audit.initAuditLog({ pgPool: null });
  const req = { user: { id: '2', displayName: 'Kyle' }, tenant: { id: 'bean' }, ip: '::1' };
  audit.recordHuntChange(req,
    { bonuses: [{ slot: 'A' }], equity: [{ id: 'a', name: 'Bean' }], calls: [] },
    { bonuses: [{ slot: 'A' }], equity: [], calls: [] },
    { targetId: '9', targetName: 'Bean' });
  const r = await audit.query({ limit: 50 });
  assert.strictEqual(r.rows.length, 1);
  assert.strictEqual(r.rows[0].action, 'equity.remove');
});

test('recordHuntChange: amount-only equity edit emits NOTHING', async () => {
  await audit.initAuditLog({ pgPool: null });
  const req = { user: { id: '2', displayName: 'Kyle' }, tenant: { id: 'bean' }, ip: '::1' };
  audit.recordHuntChange(req,
    { bonuses: [], equity: [{ id: 'a', name: 'Randy', amount: 500 }], calls: [] },
    { bonuses: [], equity: [{ id: 'a', name: 'Randy', amount: 50 }], calls: [] },
    { targetId: '9', targetName: 'Bean' });
  const r = await audit.query({ limit: 50 });
  assert.strictEqual(r.rows.length, 0);
});

test('prune: issues a delete against pgPool when present', async () => {
  const calls = [];
  const mockPool = { query: async (sql, params) => { calls.push({ sql, params }); return { rows: [] }; } };
  await audit.initAuditLog({ pgPool: mockPool });
  calls.length = 0; // ignore table-init calls
  await audit.prune();
  assert.ok(calls.some(c => /DELETE FROM audit_log/i.test(c.sql)));
});

test('getById returns the matching ring row, or null', async () => {
  await audit.initAuditLog({ pgPool: null });   // ring mode
  await audit.record({ category: 'hunt', action: 'bonus.delete', targetId: '__vip_hunt__', summary: 'x' });
  const page = await audit.query({ limit: 1 });
  const id = page.rows[0].id;
  const hit = await audit.getById(id);
  assert.strictEqual(hit.target_id, '__vip_hunt__');
  assert.strictEqual(await audit.getById(999999), null);
});
