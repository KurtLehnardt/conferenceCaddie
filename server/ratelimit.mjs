// In-memory token buckets for rate limiting, one bucket per key, per server instance.
//
// take(key, limitPerMinute) removes one token from the bucket for key. A bucket holds at most
// limitPerMinute tokens and refills continuously at limitPerMinute per minute, so a client can
// burst up to the limit and then continue at the steady rate. Buckets that have been idle long
// enough to be full again are dropped by a periodic sweep, which keeps memory bounded.

const buckets = new Map(); // key -> { tokens, at, limit }
const SWEEP_MS = 60_000;

export function take(key, limitPerMinute) {
  const now = Date.now();
  const ratePerMs = limitPerMinute / 60_000;
  let b = buckets.get(key);
  if (!b) {
    b = { tokens: limitPerMinute, at: now, limit: limitPerMinute };
    buckets.set(key, b);
  } else {
    b.tokens = Math.min(limitPerMinute, b.tokens + (now - b.at) * ratePerMs);
    b.at = now;
    b.limit = limitPerMinute;
  }
  if (b.tokens >= 1) {
    b.tokens -= 1;
    return { ok: true, retryAfterSec: 0 };
  }
  return { ok: false, retryAfterSec: Math.max(1, Math.ceil((1 - b.tokens) / ratePerMs / 1000)) };
}

setInterval(() => {
  const now = Date.now();
  for (const [key, b] of buckets) {
    if (b.tokens + (now - b.at) * (b.limit / 60_000) >= b.limit) buckets.delete(key);
  }
}, SWEEP_MS).unref();
