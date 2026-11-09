// In-memory token buckets, one per key, for a single server instance.
//
// take(key, limitPerMinute) spends one token. The bucket holds limitPerMinute tokens and refills
// continuously, so a burst up to the limit is allowed and the sustained rate is the limit per
// minute. When no token is left, ok is false and retryAfterSec says how long until one is back.

const buckets = new Map(); // key -> { tokens, at, limit }

export function take(key, limitPerMinute) {
  const now = Date.now();
  let b = buckets.get(key);
  if (!b || b.limit !== limitPerMinute) b = { tokens: limitPerMinute, at: now, limit: limitPerMinute };
  const perMs = limitPerMinute / 60000;
  b.tokens = Math.min(limitPerMinute, b.tokens + (now - b.at) * perMs);
  b.at = now;
  buckets.set(key, b);
  if (b.tokens >= 1) {
    b.tokens -= 1;
    return { ok: true, retryAfterSec: 0 };
  }
  return { ok: false, retryAfterSec: Math.max(1, Math.ceil((1 - b.tokens) / perMs / 1000)) };
}

// Buckets that have refilled completely carry no information, so they are dropped.
setInterval(() => {
  const now = Date.now();
  for (const [key, b] of buckets) if (now - b.at > 120_000) buckets.delete(key);
}, 60_000).unref();
