// In-memory token buckets for rate limiting, one bucket per key, per server instance.
//
// take(key, limitPerMinute) removes one token from the bucket for key. A bucket holds at most
// limitPerMinute tokens and refills continuously at limitPerMinute per minute, so a client can
// burst up to the limit and then continue at the steady rate. Buckets that have been idle long
// enough to be full again are dropped by a periodic sweep, which keeps memory bounded.

const MAX_IP_LENGTH = 45; // The longest textual IPv6 address.

// The client's address, as the rate limits see it. On Cloud Run, Google's front end appends the
// address it received the connection from to X-Forwarded-For, so the last entry is the real
// client and every earlier entry is whatever the client chose to send. Only the last entry is
// used, capped in length, so a client can neither pick its own bucket nor grow memory with long
// values. Without the header, as in local runs, the socket address is used.
export function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  const last = typeof fwd === 'string' ? fwd.slice(fwd.lastIndexOf(',') + 1).trim() : '';
  return (last || req.socket?.remoteAddress || 'unknown').slice(0, MAX_IP_LENGTH);
}

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
