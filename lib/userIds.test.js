const { test } = require('node:test');
const assert = require('node:assert');
const { isRealDiscordId } = require('./userIds');

test('real Discord snowflakes pass', () => {
  assert.equal(isRealDiscordId('110983319176384512'), true); // Bean, 18 digits
  assert.equal(isRealDiscordId('135203806676779008'), true); // Kyle, 18 digits
  assert.equal(isRealDiscordId('12345678901234567'), true);  // 17, lower bound
  assert.equal(isRealDiscordId('12345678901234567890'), true); // 20, upper bound (headroom)
});

test('synthetic manual: rows fail — this is the junk set', () => {
  assert.equal(isRealDiscordId('manual:cabbage'), false);
  assert.equal(isRealDiscordId('manual:'), false);
  assert.equal(isRealDiscordId('MANUAL:Cabbage'), false);
});

test('placeholders and per-row uuids fail', () => {
  assert.equal(isRealDiscordId('creator_auto'), false);
  assert.equal(isRealDiscordId('bean_auto'), false);
  assert.equal(isRealDiscordId('550e8400-e29b-41d4-a716-446655440000'), false);
});

test('out-of-range digit strings fail', () => {
  assert.equal(isRealDiscordId('1234567890123456'), false);      // 16, too short
  assert.equal(isRealDiscordId('123456789012345678901'), false); // 21, too long
});

test('empty and non-string inputs fail without throwing', () => {
  assert.equal(isRealDiscordId(''), false);
  assert.equal(isRealDiscordId(null), false);
  assert.equal(isRealDiscordId(undefined), false);
  assert.equal(isRealDiscordId({}), false);
  assert.equal(isRealDiscordId([]), false);
});

test('a numeric snowflake passes — callers pass ids from pg and from req.params', () => {
  assert.equal(isRealDiscordId(110983319176384512n), true);
});
