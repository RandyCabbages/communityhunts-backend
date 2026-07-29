const { test } = require('node:test');
const assert = require('node:assert');
const { createShareCards } = require('./shareCards');

const HOST_ID = '110983319176384512';   // tenant host (Bean)
const OWNER_ID = '222222222222222222';  // hunt runner
const MEMBER_ID = '333333333333333333';
const TENANT = { hostDiscordId: HOST_ID, branding: { crownDiscordId: HOST_ID, hostName: 'Bean' } };

// Build an instance over a fake settings layer. `calls` records every lookup so the tests can
// assert on batching + caching rather than just on the result.
function mk({ cards = {}, names = {}, anon = new Set() } = {}) {
  const calls = { names: [], cardBatches: [] };
  const inst = createShareCards({
    shouldMaskIdentity: ({ discordId, name }) =>
      anon.has(String(discordId)) || anon.has((name || '').toLowerCase()),
    resolveUserIdByName: async (n) => { calls.names.push(n); return names[(n || '').toLowerCase()] || null; },
    cardsForUserIds: async (ids) => {
      calls.cardBatches.push([...ids]);
      return new Map(ids.filter(id => cards[id]).map(id => [id, cards[id]]));
    },
  });
  return { ...inst, calls };
}

test('resolves a linked member by discordId', async () => {
  const s = mk({ cards: { [MEMBER_ID]: 'card_ashbringer' } });
  const out = await s.equippedCardsFor({
    user: { id: OWNER_ID },
    equity: [{ id: 'row1', name: 'Ash', discordId: MEMBER_ID }],
  }, TENANT);
  assert.deepStrictEqual(out, { row1: 'card_ashbringer' });
  assert.strictEqual(s.calls.names.length, 0); // no name lookup when the row is linked
});

test('creator_auto resolves through the hunt owner, bean_auto through the tenant host', async () => {
  const s = mk({ cards: { [OWNER_ID]: 'card_goofer', [HOST_ID]: 'card_bean' } });
  const out = await s.equippedCardsFor({
    user: { id: OWNER_ID },
    equity: [{ id: 'creator_auto', name: 'Goofer' }, { id: 'bean_auto', name: 'Bean' }],
  }, TENANT);
  assert.deepStrictEqual(out, { creator_auto: 'card_goofer', bean_auto: 'card_bean' });
});

test('a placeholder id never resolves as an identity of its own', async () => {
  // creator_auto/bean_auto are reused across every hunt — treating one as a user id would hand
  // one host's card to every other host's rows.
  const s = mk({ cards: { creator_auto: 'card_wrong', bean_auto: 'card_wrong' } });
  const out = await s.equippedCardsFor({
    user: {}, equity: [{ id: 'creator_auto', name: 'Nobody' }, { id: 'bean_auto', name: 'Nobody' }],
  }, {});
  assert.deepStrictEqual(out, {});
});

test('a host-named row with no id falls back to the tenant host', async () => {
  const s = mk({ cards: { [HOST_ID]: 'card_bean' } });
  const out = await s.equippedCardsFor({
    user: { id: OWNER_ID }, equity: [{ id: 'row9', name: 'bean' }],
  }, TENANT);
  assert.deepStrictEqual(out, { row9: 'card_bean' });
});

test('an unlinked member resolves by name', async () => {
  const s = mk({ cards: { [MEMBER_ID]: 'card_cook' }, names: { jearo: MEMBER_ID } });
  const out = await s.equippedCardsFor({
    user: { id: OWNER_ID }, equity: [{ id: 'row1', name: 'Jearo' }],
  }, TENANT);
  assert.deepStrictEqual(out, { row1: 'card_cook' });
  assert.deepStrictEqual(s.calls.names, ['Jearo']);
});

test('ANONYMOUS members get no card, by id or by name', async () => {
  // A card is a name badge: card_ashbringer next to "Anonymous" identifies the person the
  // masking exists to hide.
  const s = mk({
    cards: { [MEMBER_ID]: 'card_ashbringer', [OWNER_ID]: 'card_goofer' },
    names: { ghost: OWNER_ID },
    anon: new Set([MEMBER_ID, 'ghost']),
  });
  const out = await s.equippedCardsFor({
    user: { id: OWNER_ID },
    equity: [{ id: 'row1', name: 'Ash', discordId: MEMBER_ID }, { id: 'row2', name: 'Ghost' }],
  }, TENANT);
  assert.deepStrictEqual(out, {});
  assert.strictEqual(s.calls.names.length, 0); // not even looked up
});

test('members with no equipped card are absent from the map', async () => {
  const s = mk({ cards: {} });
  const out = await s.equippedCardsFor({
    user: { id: OWNER_ID }, equity: [{ id: 'row1', name: 'Ash', discordId: MEMBER_ID }],
  }, TENANT);
  assert.deepStrictEqual(out, {});
});

test('every card lookup lands in ONE batch, and repeat views hit the cache', async () => {
  const ids = ['444444444444444444', '555555555555555555', '666666666666666666'];
  const s = mk({ cards: { [ids[0]]: 'card_a', [ids[2]]: 'card_c' } });
  const hunt = { user: { id: OWNER_ID }, equity: ids.map((d, i) => ({ id: `row${i}`, name: `M${i}`, discordId: d })) };

  const first = await s.equippedCardsFor(hunt, TENANT);
  assert.deepStrictEqual(first, { row0: 'card_a', row2: 'card_c' });
  assert.strictEqual(s.calls.cardBatches.length, 1);
  assert.strictEqual(s.calls.cardBatches[0].length, 3);

  const second = await s.equippedCardsFor(hunt, TENANT);
  assert.deepStrictEqual(second, first);
  assert.strictEqual(s.calls.cardBatches.length, 1); // served from cache, misses included
});

test('the name cache does not memoise a transient lookup failure', async () => {
  let fail = true;
  const inst = createShareCards({
    shouldMaskIdentity: () => false,
    resolveUserIdByName: async (n) => { if (fail) throw new Error('pg down'); return MEMBER_ID; },
    cardsForUserIds: async (ids) => new Map(ids.map(id => [id, 'card_cook'])),
  });
  const hunt = { user: { id: OWNER_ID }, equity: [{ id: 'row1', name: 'Jearo' }] };
  assert.deepStrictEqual(await inst.equippedCardsFor(hunt, TENANT), {});
  fail = false;
  assert.deepStrictEqual(await inst.equippedCardsFor(hunt, TENANT), { row1: 'card_cook' });
});

test('a failing card lookup degrades to no cards rather than throwing', async () => {
  const inst = createShareCards({
    shouldMaskIdentity: () => false,
    resolveUserIdByName: async () => null,
    cardsForUserIds: async () => { throw new Error('pg down'); },
  });
  const out = await inst.equippedCardsFor({
    user: { id: OWNER_ID }, equity: [{ id: 'row1', name: 'Ash', discordId: MEMBER_ID }],
  }, TENANT);
  assert.deepStrictEqual(out, {});
});

test('empty / malformed equity is a no-op', async () => {
  const s = mk();
  assert.deepStrictEqual(await s.equippedCardsFor(null, TENANT), {});
  assert.deepStrictEqual(await s.equippedCardsFor({ equity: [] }, TENANT), {});
  assert.deepStrictEqual(await s.equippedCardsFor({ equity: [null, {}, { name: 'x' }] }, TENANT), {});
});
