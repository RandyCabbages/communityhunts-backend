const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const makeShareLinks = require('./shareLinks');

function make({ tokens = {}, hunts = {}, frontendUrl = 'https://communityhunts.gg' } = {}) {
  let persisted = 0;
  const links = makeShareLinks({
    shareTokens: tokens,
    tokenForOwner: (owner) => Object.keys(tokens).find((t) => tokens[t] === owner) || null,
    persistShareTokens: () => { persisted += 1; },
    hunts,
    uid: (() => { let n = 0; return () => `minted${++n}`; })(),
    frontendUrl,
  });
  return { links, tokens, persists: () => persisted };
}

describe('ensureShareToken', () => {
  it('mints one for an owner who has none, and stores it', () => {
    const { links, tokens } = make();
    const token = links.ensureShareToken('__affiliate_hunt__:bean');

    assert.equal(token, 'minted1');
    assert.equal(tokens.minted1, '__affiliate_hunt__:bean');
  });

  it('returns the SAME token next time — the link is stable per owner', () => {
    // The whole promise the share link rests on. A second token would leave every link already
    // posted in Discord pointing at a hunt nobody can reach.
    const { links } = make();
    const first = links.ensureShareToken('u1');
    const second = links.ensureShareToken('u1');

    assert.equal(second, first);
  });

  it('writes once, not on every call', () => {
    const { links, persists } = make();
    links.ensureShareToken('u1');
    links.ensureShareToken('u1');

    assert.equal(persists(), 1);
  });

  it('adopts a legacy token stored on the hunt itself', () => {
    // Tokens used to live on the hunt object, where reset destroyed them. Anyone still holding
    // one of those links keeps it.
    const { links, tokens } = make({ hunts: { u1: { shareToken: 'legacy-tok' } } });

    assert.equal(links.ensureShareToken('u1'), 'legacy-tok');
    assert.equal(tokens['legacy-tok'], 'u1');
  });

  it('keeps two owners apart', () => {
    const { links } = make();
    assert.notEqual(links.ensureShareToken('u1'), links.ensureShareToken('u2'));
  });
});

describe('shareUrl', () => {
  it('builds the frontend route, not a backend one', () => {
    const { links } = make();
    assert.equal(links.shareUrl('bean', 'tok'), 'https://communityhunts.gg/bean/share/tok');
  });

  it('does not double the slash on a trailing-slash FRONTEND_URL', () => {
    const { links } = make({ frontendUrl: 'https://communityhunts.gg/' });
    assert.equal(links.shareUrl('bean', 'tok'), 'https://communityhunts.gg/bean/share/tok');
  });

  it('falls back to the bean tenant rather than emitting //share/', () => {
    const { links } = make();
    assert.equal(links.shareUrl(null, 'tok'), 'https://communityhunts.gg/bean/share/tok');
  });

  it('escapes what it is given', () => {
    const { links } = make();
    assert.equal(links.shareUrl('a b', 'x/y'), 'https://communityhunts.gg/a%20b/share/x%2Fy');
  });
});
