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

// ── Reserved slugs ──────────────────────────────────────────────────────────
// A slug that collides with a static frontend route is UNRECOVERABLE for whoever claims it:
// React Router ranks a static segment above the dynamic `/:slug`, so their community is
// permanently shadowed and the only fix is renaming their slug. `slugAvailable` short-circuits
// on the reserved set before touching the database, so this needs no pgPool.

test('every top-level frontend route is refused as a community slug', async () => {
  // Mirrors the RESERVED set in the frontend's src/api.js currentSlug(). When a new top-level
  // route ships there, it belongs here too — BEFORE the route goes live.
  const frontendRoutes = [
    'communities', 'explore', 'hunt', 'overlay', 'settings', 'auth', 'api', 'login', 'logout',
    'privacy', 'terms', 'demo', 'admin', 'extension', 'tracker', 'pricing', 'add-community',
    'shop', 'support-us', 'purchase', 'docs',
  ];
  for (const slug of frontendRoutes) {
    assert.strictEqual(await tenants.slugAvailable(slug), false, `"${slug}" must not be claimable`);
  }
});

test('reserved slugs are refused case-insensitively and with surrounding space', async () => {
  for (const slug of ['DOCS', ' docs ', 'Shop']) {
    assert.strictEqual(await tenants.slugAvailable(slug), false, `"${slug}" must not be claimable`);
  }
});

test('an ordinary slug is still allowed', async () => {
  // Guards against over-reserving — the set must not swallow normal community names.
  assert.strictEqual(await tenants.slugAvailable('documentation-station'), true);
  assert.strictEqual(await tenants.slugAvailable('shoply'), true);
});
