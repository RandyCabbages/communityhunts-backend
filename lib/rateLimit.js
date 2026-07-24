// Per-tenant, tier-based rate limiting. In-memory fixed windows (minute + hour), keyed by
// tenant slug so rolling a key doesn't reset the window. Single-instance; resets on deploy.

const LIMITS = {
  pro:     { perMin: 100, perHour: 2000 },
  partner: { perMin: 300, perHour: 10000 },
};

// Writes are a different cost class: each one archives a hunt, writes Postgres and touches the
// stats store. A ceiling sized for read polling (100/min) is no ceiling at all here.
const WRITE_LIMITS = {
  pro:     { perMin: 10, perHour: 200 },
  partner: { perMin: 30, perHour: 1000 },
};

// IP-keyed floor, applied BEFORE authentication. rateLimit keys off the tenant resolved from the
// key, so a request with a bad key is metered by nothing at all — an unauthenticated amplifier on
// an ACAO:* endpoint (2026-07-23 review). Deliberately generous: this is abuse protection, not a
// product limit, and NATed offices share an address.
const IP_LIMIT_PER_MIN = 60;
const ipBuckets = new Map();
function checkIp(ip, now) {
  let b = ipBuckets.get(ip);
  if (!b || now - b.start >= 60_000) { b = { start: now, count: 0 }; ipBuckets.set(ip, b); }
  if (b.count >= IP_LIMIT_PER_MIN) {
    return { ok: false, retryAfter: Math.max(1, Math.ceil((b.start + 60_000 - now) / 1000)) };
  }
  b.count++;
  return { ok: true, retryAfter: 0 };
}

// slug -> { minStart, minCount, hourStart, hourCount }
const buckets = new Map();
let lastSweep = 0;

function checkRate(slug, tier, now, table = LIMITS) {
  const lim = table[tier] || table.pro;
  // Separate bucket per table, so read traffic can never exhaust the write allowance.
  const bucketKey = table === LIMITS ? slug : `w:${slug}`;
  let b = buckets.get(bucketKey);
  if (!b) { b = { minStart: now, minCount: 0, hourStart: now, hourCount: 0 }; buckets.set(bucketKey, b); }
  if (now - b.minStart >= 60_000)  { b.minStart = now; b.minCount = 0; }
  if (now - b.hourStart >= 3_600_000) { b.hourStart = now; b.hourCount = 0; }

  const minLeft  = lim.perMin  - b.minCount;
  const hourLeft = lim.perHour - b.hourCount;
  const binding  = minLeft <= hourLeft ? 'min' : 'hour';
  const limit    = binding === 'min' ? lim.perMin : lim.perHour;
  const start    = binding === 'min' ? b.minStart : b.hourStart;
  const windowMs = binding === 'min' ? 60_000 : 3_600_000;
  const resetSec = Math.ceil((start + windowMs) / 1000);

  if (minLeft <= 0 || hourLeft <= 0) {
    return { ok: false, limit, remaining: 0, resetSec, retryAfter: Math.max(1, Math.ceil((start + windowMs - now) / 1000)) };
  }
  b.minCount++; b.hourCount++;
  return { ok: true, limit, remaining: Math.max(0, Math.min(minLeft, hourLeft) - 1), resetSec, retryAfter: 0 };
}

function rateLimit(req, res, next) {
  const now = Date.now();
  if (now - lastSweep > 600_000) { // evict idle buckets every ~10m
    lastSweep = now;
    for (const [k, b] of buckets) if (now - b.hourStart > 3_600_000) buckets.delete(k);
  }
  const r = checkRate(req.apiTenant.slug, req.apiTier, now);
  res.set('X-RateLimit-Limit', String(r.limit));
  res.set('X-RateLimit-Remaining', String(r.remaining));
  res.set('X-RateLimit-Reset', String(r.resetSec));
  if (!r.ok) {
    res.set('Retry-After', String(r.retryAfter));
    return res.status(429).json({ error: { code: 'rate_limited', message: 'Rate limit exceeded' } });
  }
  next();
}

// Same shape as rateLimit, but against the write table. Mounted only on mutating routes.
function writeRateLimit(req, res, next) {
  const r = checkRate(req.apiTenant.slug, req.apiTier, Date.now(), WRITE_LIMITS);
  res.set('X-RateLimit-Limit', String(r.limit));
  res.set('X-RateLimit-Remaining', String(r.remaining));
  res.set('X-RateLimit-Reset', String(r.resetSec));
  if (!r.ok) {
    res.set('Retry-After', String(r.retryAfter));
    return res.status(429).json({ error: { code: 'rate_limited', message: 'Write rate limit exceeded' } });
  }
  next();
}

// Mounted BEFORE requireApiKey so an invalid key still costs the caller something.
function ipFloor(req, res, next) {
  const now = Date.now();
  if (ipBuckets.size > 10_000) { // crude sweep; these are 60s buckets
    for (const [k, b] of ipBuckets) if (now - b.start > 60_000) ipBuckets.delete(k);
  }
  const r = checkIp(req.ip || 'unknown', now);
  if (!r.ok) {
    res.set('Retry-After', String(r.retryAfter));
    return res.status(429).json({ error: { code: 'rate_limited', message: 'Too many requests' } });
  }
  next();
}

module.exports = { LIMITS, WRITE_LIMITS, checkRate, checkIp, rateLimit, writeRateLimit, ipFloor };
