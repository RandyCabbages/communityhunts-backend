const { test } = require('node:test');
const assert = require('node:assert');
const makePrivilege = require('./privilege');

function build({ mod = false, supporter = false } = {}) {
  return makePrivilege({
    reqIsMod: () => mod,
    supporters: { isSupporter: (id) => supporter && id === 'u1' },
  });
}

test('no user → not privileged', () => {
  const { isPrivileged } = build();
  assert.equal(isPrivileged({}), false);
});

test('mod (folds admin) → privileged', () => {
  const { isPrivileged } = build({ mod: true });
  assert.equal(isPrivileged({ user: { id: 'u1' } }), true);
});

test('supporter → privileged', () => {
  const { isPrivileged } = build({ supporter: true });
  assert.equal(isPrivileged({ user: { id: 'u1' } }), true);
});

test('tenant host (king) → privileged', () => {
  const { isPrivileged } = build();
  assert.equal(isPrivileged({ user: { id: 'k1' }, tenant: { hostDiscordId: 'k1' } }), true);
});

test('plain signed-in user → not privileged', () => {
  const { isPrivileged } = build();
  assert.equal(isPrivileged({ user: { id: 'nobody' }, tenant: { hostDiscordId: 'k1' } }), false);
});
