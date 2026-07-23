const test = require('node:test');
const assert = require('node:assert');
const { vetEquityIdentity, vetCallerIdentity } = require('./identityWrites');

const REAL = '135203806676779008';
const OTHER = '110983319176384512';
const known = new Set([REAL, OTHER]);
const isKnownAccount = async (id) => known.has(String(id));

test('a steady-state save does NO account lookups', async () => {
  let calls = 0;
  const counting = async (id) => { calls++; return known.has(String(id)); };
  const prev = [{ id: 'r1', name: 'Cabbage', discordId: REAL }];
  const next = [{ id: 'r1', name: 'Cabbage', discordId: REAL, amount: 50 }];  // amount changed only
  const { rows, accepted, rejected } = await vetEquityIdentity(prev, next, { isKnownAccount: counting });
  assert.strictEqual(calls, 0, 'unchanged identity must not touch the database');
  assert.strictEqual(rejected.length, 0);
  assert.strictEqual(accepted.length, 0);
  assert.strictEqual(rows[0].discordId, REAL);
});

test('a real account may be attached to a new row', async () => {
  const { rows, accepted } = await vetEquityIdentity([], [{ id: 'r1', name: 'Cabbage', discordId: REAL }], { isKnownAccount });
  assert.strictEqual(rows[0].discordId, REAL);
  assert.deepStrictEqual(accepted, [{ rowId: 'r1', from: null, to: REAL }]);
});

test('a fabricated id is STRIPPED, not stored', async () => {
  const next = [{ id: 'r1', name: 'Victim', discordId: '999999999999999999' }];
  const { rows, rejected } = await vetEquityIdentity([], next, { isKnownAccount });
  assert.strictEqual(rows[0].discordId, undefined, 'must not be stored');
  assert.strictEqual(rows[0].name, 'Victim', 'the rest of the row is untouched');
  assert.strictEqual(rejected.length, 1);
});

test('row ids and manual: placeholders are rejected without a lookup', async () => {
  let calls = 0;
  const counting = async () => { calls++; return true; };
  const next = [{ id: 'r1', discordId: 'creator_auto' }, { id: 'r2', discordId: 'manual:Bob' }, { id: 'r3', discordId: '42' }];
  const { rows, rejected } = await vetEquityIdentity([], next, { isKnownAccount: counting });
  assert.strictEqual(calls, 0, 'shape check must short-circuit before any I/O');
  assert.strictEqual(rejected.length, 3);
  rows.forEach(r => assert.strictEqual(r.discordId, undefined));
});

test('overwriting a good id with a fabricated one is rejected — the old one survives', async () => {
  const prev = [{ id: 'r1', name: 'Cabbage', discordId: REAL }];
  const next = [{ id: 'r1', name: 'Cabbage', discordId: '000000000000000000' }];
  const { rows, rejected } = await vetEquityIdentity(prev, next, { isKnownAccount });
  assert.strictEqual(rows[0].discordId, undefined, 'stripped, so preserveRowIdentity restores the stored id');
  assert.strictEqual(rejected.length, 1);
});

test('an unreachable account directory fails CLOSED', async () => {
  const boom = async () => { throw new Error('pg down'); };
  const { rows, rejected } = await vetEquityIdentity([], [{ id: 'r1', discordId: REAL }], { isKnownAccount: boom });
  assert.strictEqual(rows[0].discordId, undefined);
  assert.strictEqual(rejected.length, 1);
});

test('no validator available means no identity is accepted', async () => {
  const { rows } = await vetEquityIdentity([], [{ id: 'r1', discordId: REAL }], {});
  assert.strictEqual(rows[0].discordId, undefined);
});

test('callerId is accepted when this hunt already links that person', () => {
  const equity = [{ id: 'e1', name: 'Cabbage', discordId: REAL }];
  const next = [{ id: 'c1', user: 'Cabbage', callerId: REAL }];
  const { rows, accepted } = vetCallerIdentity([], next, equity);
  assert.strictEqual(rows[0].callerId, REAL);
  assert.strictEqual(accepted.length, 1);
});

test('callerId for someone NOT in this hunt is stripped', () => {
  const equity = [{ id: 'e1', name: 'Cabbage', discordId: REAL }];
  const next = [{ id: 'c1', user: 'Stranger', callerId: OTHER }];
  const { rows, rejected } = vetCallerIdentity([], next, equity);
  assert.strictEqual(rows[0].callerId, undefined);
  assert.strictEqual(rejected.length, 1);
});

test('callerId cannot be corroborated by an equity id that was itself just rejected', async () => {
  // The equity write is vetted FIRST, so a fabricated equity id never reaches the caller check.
  const eq = await vetEquityIdentity([], [{ id: 'e1', name: 'Victim', discordId: '999999999999999999' }], { isKnownAccount });
  const { rows } = vetCallerIdentity([], [{ id: 'c1', user: 'Victim', callerId: '999999999999999999' }], eq.rows);
  assert.strictEqual(rows[0].callerId, undefined);
});

test('unchanged callerIds pass through untouched', () => {
  const equity = [{ id: 'e1', discordId: REAL }];
  const prev = [{ id: 'c1', user: 'Cabbage', callerId: REAL }];
  const next = [{ id: 'c1', user: 'Cabbage', callerId: REAL, gotIn: true }];
  const { rows, accepted, rejected } = vetCallerIdentity(prev, next, equity);
  assert.strictEqual(rows[0].callerId, REAL);
  assert.strictEqual(accepted.length + rejected.length, 0);
});

test('non-array payloads are passed through unchanged', async () => {
  assert.strictEqual((await vetEquityIdentity([], undefined, { isKnownAccount })).rows, undefined);
  assert.strictEqual(vetCallerIdentity([], null, []).rows, null);
});
