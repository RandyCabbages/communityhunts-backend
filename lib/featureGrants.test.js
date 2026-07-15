const { test } = require('node:test');
const assert = require('node:assert');
const fg = require('./featureGrants');

// Minimal fake pg pool backed by an in-memory array of {discord_id, feature_key, granted_by}.
function fakePool() {
  const rows = [];
  return {
    rows,
    query: async (sql, params = []) => {
      if (/CREATE TABLE/i.test(sql)) return { rows: [] };
      if (/SELECT discord_id, feature_key/i.test(sql)) return { rows: rows.map(r => ({ ...r })) };
      if (/INSERT INTO feature_grants/i.test(sql)) {
        const [id, key, by] = params;
        if (!rows.find(r => r.discord_id === id && r.feature_key === key))
          rows.push({ discord_id: id, feature_key: key, granted_by: by, granted_at: new Date().toISOString() });
        return { rows: [] };
      }
      if (/DELETE FROM feature_grants/i.test(sql)) {
        const [id, key] = params;
        const i = rows.findIndex(r => r.discord_id === id && r.feature_key === key);
        if (i >= 0) rows.splice(i, 1);
        return { rows: [] };
      }
      return { rows: [] };
    },
  };
}

test('no pgPool → all reads empty, writes no-op', async () => {
  await fg.initFeatureGrants({ pgPool: null });
  assert.strictEqual(fg.hasGrant('123', 'full_extension'), false);
  assert.deepStrictEqual(fg.getGrantsForUser('123'), []);
  await fg.addGrant('123', 'full_extension', 'admin'); // must not throw
  assert.strictEqual(fg.hasGrant('123', 'full_extension'), false);
});

test('add / has / getGrantsForUser / remove with a DB', async () => {
  const pool = fakePool();
  await fg.initFeatureGrants({ pgPool: pool });
  await fg.addGrant('123', 'full_extension', 'admin');
  assert.strictEqual(fg.hasGrant('123', 'full_extension'), true);
  assert.deepStrictEqual(fg.getGrantsForUser('123'), ['full_extension']);
  await fg.removeGrant('123', 'full_extension');
  assert.strictEqual(fg.hasGrant('123', 'full_extension'), false);
});

test('init seeds nothing — grants come from the DB only', async () => {
  const pool = fakePool();
  await fg.initFeatureGrants({ pgPool: pool });
  assert.deepStrictEqual(pool.rows, []);
});
