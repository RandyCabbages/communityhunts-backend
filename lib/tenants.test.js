// getPlatformBotToken resolves the platform (Bean) bot token, env as seed/fallback.
// BEAN_TENANT reads DISCORD_BOT_TOKEN at module load, so set it before require().
process.env.DISCORD_BOT_TOKEN = '  seed-token  ';

const { test } = require('node:test');
const assert = require('node:assert');
const tenants = require('./tenants');

test('getPlatformBotToken returns the platform bot token, trimmed', () => {
  // No DB/admin token loaded → falls back to the env-seeded Bean token, trimmed.
  assert.strictEqual(tenants.getPlatformBotToken(), 'seed-token');
});

test('getPlatformBotToken is exported as a function', () => {
  assert.strictEqual(typeof tenants.getPlatformBotToken, 'function');
});

// ── updateTenantPlan ────────────────────────────────────────────────────────
// Validation runs BEFORE the pgPool guard so it is testable without a database, and
// so a typo can never reach the DB. That matters because normalizePlan silently
// falls back to 'pro' for anything it doesn't recognise — storing "enterprise" would
// look like it worked and quietly leave the tenant on Pro.

test('updateTenantPlan accepts every plan on the community ladder', async () => {
  for (const p of ['free', 'starter', 'pro', 'partner']) {
    assert.strictEqual(await tenants.updateTenantPlan('acme', p), p);
  }
});

test('updateTenantPlan accepts the stored community_ prefixed form', async () => {
  assert.strictEqual(await tenants.updateTenantPlan('acme', 'community_partner'), 'partner');
});

test('updateTenantPlan rejects an unknown plan instead of silently downgrading', async () => {
  await assert.rejects(() => tenants.updateTenantPlan('acme', 'enterprise'), /Invalid plan/);
  await assert.rejects(() => tenants.updateTenantPlan('acme', ''), /Invalid plan/);
  await assert.rejects(() => tenants.updateTenantPlan('acme', null), /Invalid plan/);
  await assert.rejects(() => tenants.updateTenantPlan('acme', 'PRO '), /Invalid plan/);
});

test('the plan a tenant is set to is what normalizePlan reads back', async () => {
  const set = await tenants.updateTenantPlan('acme', 'partner');
  assert.strictEqual(tenants.normalizePlan(`community_${set}`), 'partner');
});
