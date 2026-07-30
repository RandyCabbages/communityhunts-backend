// Opaque, stable public identifiers for the Developer API.
//
// The API's standing rule is that a raw Discord id NEVER leaves it — maskEquityMember and
// maskCallerEntry strip `discordId`/`callerId` from every public payload, and the docs say so
// out loud. But a consumer building "one streamer's hunts" needs SOME stable handle, and the
// only alternative on offer was matching a display name, which silently empties their hunt list
// the day that person renames. So: an HMAC of the owner key, scoped to the tenant.
//
// Why an HMAC and not a plain hash. A Discord id is a numeric snowflake, so an unkeyed (or
// public-salted) digest is a confirmation oracle: anyone holding a candidate id can hash it and
// check whether it matches an `owner.id` we published. The key removes that.
//
// The tenant is inside the MAC input as well as the cache key, so the same person hosting in two
// communities gets two unrelated public ids — one community's key can never be used to correlate
// its members against another's.

const crypto = require('crypto');

let secret = null;
let warned = false;

// Resolved lazily, not at require time: server.js reads dotenv before the routers are built, and
// test suites set the env per-case.
function getSecret() {
  if (secret) return secret;
  if (process.env.PUBLIC_ID_SECRET) {
    secret = `cfg:${process.env.PUBLIC_ID_SECRET}`;
    return secret;
  }
  if (process.env.SESSION_SECRET) {
    if (!warned) {
      warned = true;
      console.warn('[public-api] PUBLIC_ID_SECRET is not set — deriving public owner ids from SESSION_SECRET. '
        + 'Rotating SESSION_SECRET would then change every `owner.id` this API has ever returned, breaking any '
        + 'consumer that stored one as a foreign key. Set PUBLIC_ID_SECRET once and never rotate it.');
    }
    secret = `sess:${process.env.SESSION_SECRET}`;
    return secret;
  }
  // Local dev with no secrets at all. Random per boot so ids are still unguessable; loud, because
  // "stable" is the entire point of the field and this is the one configuration where it isn't.
  if (!warned) {
    warned = true;
    console.warn('[public-api] neither PUBLIC_ID_SECRET nor SESSION_SECRET is set — public owner ids are random '
      + 'for this process and will change on restart.');
  }
  secret = `boot:${crypto.randomBytes(32).toString('hex')}`;
  return secret;
}

// One HMAC per distinct owner per tenant, not per hunt: the /hunts list maps this over every hunt
// on the page, and `?ownerId=` maps it over the whole tenant's hunts to filter. Distinct owners
// per community is a few dozen; the cap is a runaway guard, not a tuning knob.
const CACHE_MAX = 50000;
const cache = new Map();

/**
 * Public, opaque, stable id for a hunt owner. `rawId` is `hunt.user.id` — either a Discord id or
 * one of the synthetic shared-hunt keys (`__tenant_hunt__`, `__affiliate_hunt__:slug`, …), which
 * are equally valid owners from a consumer's point of view and equally stable.
 */
function publicOwnerId(tenantId, rawId) {
  if (rawId == null || rawId === '') return null;
  const key = `${tenantId || 'bean'}|${rawId}`;
  const hit = cache.get(key);
  if (hit) return hit;
  // 22 base64url chars = 132 bits. Long enough that the field is opaque rather than a truncated
  // hash somebody might try to brute-force, short enough to sit in a VARCHAR(64) alongside a
  // prefix without anyone thinking about it.
  const value = `usr_${crypto.createHmac('sha256', getSecret()).update(key).digest('base64url').slice(0, 22)}`;
  if (cache.size >= CACHE_MAX) cache.clear();
  cache.set(key, value);
  return value;
}

// The shape publicOwnerId mints, as a predicate — `usr_` + 22 base64url characters.
//
// Lives HERE, next to the minter, so the two cannot drift: change the length or the digest
// encoding above and this has to move with it (a test mints an id and asserts it passes).
//
// This is what makes `?ownerId=` able to tell a typo from a legitimate miss. The id is an HMAC,
// so there is no stored list to check membership against — but a malformed value can be rejected
// on sight, which is what a misconfigured consumer actually sends. A WELL-FORMED id that matches
// nothing must still answer 200 with an empty page: an owner who simply has no hunts yet is a
// normal state, and erroring on it would trade one ambiguity for a worse one.
const PUBLIC_OWNER_ID_RE = /^usr_[A-Za-z0-9_-]{22}$/;
function isPublicOwnerId(value) {
  return typeof value === 'string' && PUBLIC_OWNER_ID_RE.test(value);
}

// Tests only: drop the memoized secret and cache so a case can set its own env.
function _resetForTests() {
  secret = null;
  warned = false;
  cache.clear();
}

module.exports = { publicOwnerId, isPublicOwnerId, _resetForTests };
