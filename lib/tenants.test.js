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
