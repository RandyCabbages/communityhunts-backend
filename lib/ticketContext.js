// Sanitizer for the ticket `context` blob submitted by the support launcher.
//
// POST /api/tickets is PUBLIC and unauthenticated, so this payload is fully untrusted:
// we whitelist keys, cap string lengths, and discard the whole blob if it is oversized.
// Unknown keys are DROPPED rather than rejected so an older frontend and a newer one
// both work against the same backend (the frontend may add fields before we know them).
//
// Redaction of secrets (share tokens, query strings) happens CLIENT-side in
// src/support/supportContext.js — this is defense in depth, not the primary guard.

const MAX_STR = 300;
const MAX_SERIALIZED = 2048; // bytes of JSON; a well-formed context is ~200 bytes

const STRING_KEYS = ['route', 'tenantSlug', 'userAgent', 'huntId', 'buildSha'];

function str(v) {
  if (typeof v !== 'string' || !v) return undefined;
  return v.slice(0, MAX_STR);
}

function viewport(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
  const w = Number(v.w);
  const h = Number(v.h);
  if (!Number.isFinite(w) || !Number.isFinite(h)) return undefined;
  return { w: Math.round(w), h: Math.round(h) };
}

// Returns a clean object, or null when there is nothing usable / the blob is too big.
function sanitizeContext(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;

  const out = {};
  for (const k of STRING_KEYS) {
    const v = str(raw[k]);
    if (v !== undefined) out[k] = v;
  }
  const vp = viewport(raw.viewport);
  if (vp !== undefined) out.viewport = vp;

  if (Object.keys(out).length === 0) return null;
  if (JSON.stringify(out).length > MAX_SERIALIZED) return null;
  return out;
}

module.exports = { sanitizeContext, MAX_STR, MAX_SERIALIZED };
