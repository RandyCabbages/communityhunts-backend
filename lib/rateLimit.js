// Per-tenant, tier-based rate limiting. In-memory fixed windows (minute + hour), keyed by
// tenant slug so rolling a key doesn't reset the window. Single-instance; resets on deploy.

const LIMITS = {
  pro:     { perMin: 100, perHour: 2000 },
  partner: { perMin: 300, perHour: 10000 },
};

// slug -> { minStart, minCount, hourStart, hourCount }
const buckets = new Map();
let lastSweep = 0;

function checkRate(slug, tier, now) {
  const lim = LIMITS[tier] || LIMITS.pro;
  let b = buckets.get(slug);
  if (!b) { b = { minStart: now, minCount: 0, hourStart: now, hourCount: 0 }; buckets.set(slug, b); }
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

module.exports = { LIMITS, checkRate, rateLimit };
