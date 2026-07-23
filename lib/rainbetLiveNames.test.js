const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadLiveNames } = require('./slots');

test('loadLiveNames returns a Set of the artifact names', () => {
  const tmp = path.join(os.tmpdir(), `live-names-${Date.now()}.json`);
  fs.writeFileSync(tmp, JSON.stringify({ generatedAt: 'x', names: ['sixsixsix', 'gatesofolympus'] }));
  const set = loadLiveNames(tmp);
  fs.unlinkSync(tmp);
  assert.ok(set instanceof Set);
  assert.strictEqual(set.size, 2);
  assert.ok(set.has('sixsixsix'));
  assert.ok(set.has('gatesofolympus'));
});

test('loadLiveNames returns an empty Set when the file is missing (fail-open)', () => {
  const set = loadLiveNames(path.join(os.tmpdir(), 'does-not-exist-xyz.json'));
  assert.ok(set instanceof Set);
  assert.strictEqual(set.size, 0);
});
