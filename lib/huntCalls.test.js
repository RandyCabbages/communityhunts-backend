// The one implementation of adding a slot call. Driven directly rather than through a router:
// the rules here (duplicate, rolling, per-person limit) are the ones the Discord bot and the
// website must agree on, and a test that needs an Express app to reach them is a test nobody
// runs while changing them.

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const makeHuntCalls = require('./huntCalls');

const normalizeSlot = (name) => (name || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const nameOf = (user) => (user?.displayName || user?.username || '').toLowerCase().trim();

function harness() {
  const state = { emitted: [], feed: [] };
  const api = makeHuntCalls({
    normalizeSlot,
    nameOf,
    emitHuntUpdate: (key) => state.emitted.push(key),
    activityFeed: { push: (tid, entry) => state.feed.push({ tid, ...entry }) },
  });
  return { ...api, state };
}

const hunt = (over = {}) => ({
  user: { id: '__affiliate_hunt__:bean' },
  tenantId: 'bean',
  calls: [],
  callLimit: 0,
  huntMode: 'hunting',
  ...over,
});

const CABBAGE = { id: '197365493516992512', displayName: 'Cabbage' };

describe('addCallToHunt', () => {
  it('adds a call and reports the hunt updated', () => {
    const { addCallToHunt, state } = harness();
    const h = hunt();

    const out = addCallToHunt(h, CABBAGE, 'Gates of Olympus', {});

    assert.equal(out.ok, true);
    assert.equal(h.calls.length, 1);
    assert.equal(h.calls[0].slot, 'Gates of Olympus');
    assert.equal(h.calls[0].user, 'Cabbage');
    assert.equal(h.calls[0].callerId, '197365493516992512');
    assert.equal(h.calls[0].status, 'pending');
    assert.deepEqual(state.emitted, ['__affiliate_hunt__:bean']);
    assert.equal(state.feed[0].text, 'Cabbage called Gates of Olympus');
  });

  it('refuses a duplicate, normalized: "CULT" and "CULT." are the same slot', () => {
    const { addCallToHunt } = harness();
    const h = hunt();
    addCallToHunt(h, CABBAGE, 'CULT', {});

    const out = addCallToHunt(h, CABBAGE, 'CULT.', {});

    assert.equal(out.ok, undefined);
    assert.equal(out.code, 'duplicate');
    assert.equal(out.status, 400);
    assert.match(out.error, /already suggested/);
    assert.equal(h.calls.length, 1, 'the duplicate is not stored');
  });

  it('refuses past the per-person limit, and does not count other callers', () => {
    const { addCallToHunt } = harness();
    const h = hunt({ callLimit: 2 });
    addCallToHunt(h, CABBAGE, 'One', {});
    addCallToHunt(h, CABBAGE, 'Two', {});
    addCallToHunt(h, { id: '9', displayName: 'Goofer' }, 'Three', {});

    const out = addCallToHunt(h, CABBAGE, 'Four', {});

    assert.equal(out.code, 'limit');
    assert.match(out.error, /limit of 2 calls/);
    assert.equal(h.calls.length, 3);
  });

  it('waives the limit for an editor and for a limit-exempt caller', () => {
    const { addCallToHunt } = harness();
    const h = hunt({ callLimit: 1 });
    addCallToHunt(h, CABBAGE, 'One', {});

    assert.equal(addCallToHunt(h, CABBAGE, 'Two', { isEditor: true }).ok, true);
    assert.equal(addCallToHunt(h, CABBAGE, 'Three', { limitExempt: true }).ok, true);
  });

  it('refuses a non-editor while the hunt is rolling', () => {
    const { addCallToHunt } = harness();
    const h = hunt({ huntMode: 'rolling' });

    const out = addCallToHunt(h, CABBAGE, 'Gates of Olympus', {});

    assert.equal(out.code, 'rolling');
    assert.equal(out.status, 403);
    assert.equal(addCallToHunt(h, CABBAGE, 'Gates of Olympus', { isEditor: true }).ok, true);
  });

  it('refuses a blank slot', () => {
    const { addCallToHunt } = harness();

    assert.equal(addCallToHunt(hunt(), CABBAGE, '   ', {}).code, 'empty');
  });

  it('appends to the END of the pending queue, ahead of non-pending calls', () => {
    const { addCallToHunt } = harness();
    const h = hunt({
      calls: [
        { id: 'a', slot: 'First', user: 'Cabbage', status: 'pending' },
        { id: 'b', slot: 'Opened', user: 'Cabbage', status: 'opened' },
      ],
    });

    addCallToHunt(h, CABBAGE, 'New', {});

    assert.deepEqual(h.calls.map((c) => c.slot), ['First', 'New', 'Opened']);
  });

  it('records source when given one, and omits the field when not', () => {
    const { addCallToHunt } = harness();
    const h = hunt();

    addCallToHunt(h, CABBAGE, 'With', { source: 'discord' });
    addCallToHunt(h, CABBAGE, 'Without', {});

    assert.equal(h.calls[0].source, 'discord');
    assert.equal('source' in h.calls[1], false);
  });

  it('survives a missing activityFeed', () => {
    const api = makeHuntCalls({ normalizeSlot, nameOf, emitHuntUpdate: () => {} });

    assert.equal(api.addCallToHunt(hunt(), CABBAGE, 'Gates', {}).ok, true);
  });
});
