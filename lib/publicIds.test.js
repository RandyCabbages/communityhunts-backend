// publicOwnerId is a FOREIGN KEY in somebody else's database. The properties below are the
// promise the docs make about it; each one breaks a consumer if it stops holding.

const { test } = require('node:test');
const assert = require('node:assert');
const ids = require('./publicIds');

function withSecret(value, fn) {
  const prevPublic = process.env.PUBLIC_ID_SECRET;
  const prevSession = process.env.SESSION_SECRET;
  process.env.PUBLIC_ID_SECRET = value;
  delete process.env.SESSION_SECRET;
  ids._resetForTests();
  try { return fn(); } finally {
    if (prevPublic === undefined) delete process.env.PUBLIC_ID_SECRET; else process.env.PUBLIC_ID_SECRET = prevPublic;
    if (prevSession === undefined) delete process.env.SESSION_SECRET; else process.env.SESSION_SECRET = prevSession;
    ids._resetForTests();
  }
}

test('the same owner in the same tenant is the same id, across resets', () => {
  const a = withSecret('s1', () => ids.publicOwnerId('acme', '110983319176384512'));
  const b = withSecret('s1', () => ids.publicOwnerId('acme', '110983319176384512'));
  assert.strictEqual(a, b);
  assert.match(a, /^usr_[A-Za-z0-9_-]{22}$/);
});

test('the raw Discord id never appears in the output', () => {
  withSecret('s1', () => {
    const out = ids.publicOwnerId('acme', '110983319176384512');
    assert.ok(!out.includes('110983319176384512'));
  });
});

test('the same person in two communities gets two unrelated ids', () => {
  // One community's key must not let its holder correlate members against another community's.
  withSecret('s1', () => {
    assert.notStrictEqual(ids.publicOwnerId('acme', '111'), ids.publicOwnerId('other', '111'));
  });
});

test('different owners in one tenant get different ids', () => {
  withSecret('s1', () => {
    assert.notStrictEqual(ids.publicOwnerId('acme', '111'), ids.publicOwnerId('acme', '222'));
  });
});

test('a different secret produces a different id — this is why PUBLIC_ID_SECRET must never rotate', () => {
  const a = withSecret('s1', () => ids.publicOwnerId('acme', '111'));
  const b = withSecret('s2', () => ids.publicOwnerId('acme', '111'));
  assert.notStrictEqual(a, b);
});

test('synthetic shared-hunt keys are owners too, and stable', () => {
  withSecret('s1', () => {
    const a = ids.publicOwnerId('acme', '__tenant_hunt__:acme');
    assert.match(a, /^usr_/);
    assert.strictEqual(a, ids.publicOwnerId('acme', '__tenant_hunt__:acme'));
    assert.notStrictEqual(a, ids.publicOwnerId('acme', '__affiliate_hunt__:acme'));
  });
});

test('a missing owner id is null, not a hash of the empty string', () => {
  withSecret('s1', () => {
    assert.strictEqual(ids.publicOwnerId('acme', null), null);
    assert.strictEqual(ids.publicOwnerId('acme', undefined), null);
    assert.strictEqual(ids.publicOwnerId('acme', ''), null);
  });
});

test('PUBLIC_ID_SECRET and SESSION_SECRET of the same value are not interchangeable', () => {
  // The fallback namespaces its input (`cfg:` vs `sess:`), so setting PUBLIC_ID_SECRET to the
  // value SESSION_SECRET already had does NOT silently keep the ids stable. Deliberate: the two
  // are different configurations and pretending otherwise hides which one is in force.
  const viaPublic = withSecret('same', () => ids.publicOwnerId('acme', '111'));

  const prevPublic = process.env.PUBLIC_ID_SECRET, prevSession = process.env.SESSION_SECRET;
  delete process.env.PUBLIC_ID_SECRET;
  process.env.SESSION_SECRET = 'same';
  ids._resetForTests();
  const viaSession = ids.publicOwnerId('acme', '111');
  if (prevPublic === undefined) delete process.env.PUBLIC_ID_SECRET; else process.env.PUBLIC_ID_SECRET = prevPublic;
  if (prevSession === undefined) delete process.env.SESSION_SECRET; else process.env.SESSION_SECRET = prevSession;
  ids._resetForTests();

  assert.notStrictEqual(viaPublic, viaSession);
});

// isPublicOwnerId is the `?ownerId=` gate. It has to agree with the minter above forever.
test('every minted id passes the shape check — the two can never drift', () => {
  withSecret('drift-check', () => {
    for (const raw of ['110983319176384512', '__tenant_hunt__', '__affiliate_hunt__:acme', 'a', 'x'.repeat(200)]) {
      const id = ids.publicOwnerId('acme', raw);
      assert.ok(ids.isPublicOwnerId(id), `minted id rejected by its own validator: ${id}`);
    }
  });
});

test('isPublicOwnerId rejects what a misconfigured consumer actually sends', () => {
  for (const bad of [
    'usr_nosuchowner',            // a hand-written placeholder
    '110983319176384512',         // a Discord id — this API never accepts or returns one
    'usr_',                       // prefix only
    `usr_${'A'.repeat(21)}`,      // one short
    `usr_${'A'.repeat(23)}`,      // one long
    `usr_${'A'.repeat(21)}+`,     // base64, not base64url
    'USR_AAAAAAAAAAAAAAAAAAAAAA', // wrong-case prefix
    null, undefined, 42, {},
  ]) {
    assert.strictEqual(ids.isPublicOwnerId(bad), false, `should have been rejected: ${String(bad)}`);
  }
});
