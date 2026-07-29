const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const makeSharedHunts = require('./sharedHunts');

const bean = {
  slug: 'bean',
  displayName: 'Bean',
  hostDiscordId: '135203806676779008',
  branding: { hostName: 'Bean' },
};
const other = { slug: 'acme', displayName: 'Acme', hostDiscordId: null, branding: {} };

const tenants = {
  getTenantBySlug: (slug) => (slug === 'bean' ? bean : slug === 'acme' ? other : null),
};
const make = (t = tenants) => makeSharedHunts({ tenants: t, uid: () => 'fixed-uid' });

describe('host identity', () => {
  it('reads the host name from the tenant, not a hardcoded Bean', () => {
    assert.equal(make().hostNameFor('acme'), 'Acme');
  });

  it('still resolves Bean to Bean', () => {
    assert.equal(make().hostNameFor('bean'), 'Bean');
  });

  it('falls back to the bean tenant for an unknown slug', () => {
    assert.equal(make().hostNameFor('nope'), 'Bean');
  });

  it('carries the host discord id onto the seeded equity row', () => {
    // Without it the host shows up in the identity review queue as an unidentified participant.
    assert.equal(make().hostEquityRow('bean', 1000).discordId, '135203806676779008');
  });

  it('omits the id rather than writing a junk one', () => {
    assert.equal('discordId' in make().hostEquityRow('acme', 1000), false);
  });
});

// The values below are the ones the routes wrote before these factories were extracted out of
// routes/mod-hunt.routes.js. They are asserted whole, because the entire risk of that extraction
// is a field quietly changing — a wrong callLimit or a wrong starting equity would be written to
// a real hunt and nothing else in the suite would notice.
describe('the three shared runs, exactly as they were', () => {
  const shared = make();

  it('affiliate: vip type, $1000 seeded to the host, 10 calls', () => {
    const h = shared.emptyAffiliateHunt('bean', null);
    assert.equal(h.user.id, '__affiliate_hunt__');
    assert.equal(h.huntType, 'vip');
    assert.equal(h.callLimit, 10);
    assert.equal(h.roundRobin, true);
    assert.deepEqual(h.equity, [
      { id: 'bean_auto', name: 'Bean', amount: 1000, isRollWinner: false, discordId: '135203806676779008' },
    ]);
  });

  it('vip: same shape, its own key', () => {
    const h = shared.emptyVipHunt('bean', null);
    assert.equal(h.user.id, '__vip_hunt__');
    assert.equal(h.huntType, 'vip');
    assert.equal(h.callLimit, 10);
    assert.equal(h.equity[0].amount, 1000);
  });

  it('mod: solo, no starting equity, no call limit', () => {
    const h = shared.emptyModHunt('bean', null);
    assert.equal(h.huntType, 'solo');
    assert.equal(h.callLimit, 0);
    assert.equal(h.roundRobin, false);
    assert.equal(h.equity[0].amount, 0);
  });

  it('namespaces every key for a non-bean tenant', () => {
    assert.equal(shared.emptyAffiliateHunt('acme').user.id, '__affiliate_hunt__:acme');
    assert.equal(shared.emptyVipHunt('acme').user.id, '__vip_hunt__:acme');
  });

  it('is born live, with no archive stamp', () => {
    const h = shared.emptyAffiliateHunt('bean');
    assert.equal(h.isLive, true);
    assert.equal(h.archivedAt, null);
    assert.equal(h.bonuses.length, 0);
  });

  it('takes a title, and defaults to one naming the host', () => {
    assert.equal(shared.emptyAffiliateHunt('bean', '  Friday $2,500  ').title, 'Friday $2,500');
    assert.match(shared.emptyAffiliateHunt('bean', null).title, /Bean/);
  });

  it('writes every field the routes wrote — none silently dropped', () => {
    // The extraction moved these out of a route file; a field lost in the move would be a hunt
    // missing a setting the rest of the app assumes is there.
    const expected = [
      'user', 'huntId', 'isLive', 'startedAt', 'archivedAt', 'tenantId', 'createdAt', 'updatedAt',
      'title', 'huntType', 'bonuses', 'equity', 'calls', 'invitedEditors', 'callLimit',
      'huntMode', 'roundRobin', 'lockTop4', 'currency', 'publicCalls', 'publicCallsPin',
    ].sort();

    for (const build of ['emptyModHunt', 'emptyAffiliateHunt', 'emptyVipHunt']) {
      assert.deepEqual(Object.keys(shared[build]('bean')).sort(), expected, build);
    }
  });
});
