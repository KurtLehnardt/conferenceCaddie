// Delivers one push payload to every live subscription of some people at this conference
// (PLAN section 1.6, the binding hook sendPush, and section 1.11).
//
// Rules this module keeps:
// - Nothing is sent unless VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY and VAPID_SUBJECT are all set.
// - At most 40 push requests per call by default, below the Free plan's 50 subrequests per
//   request. A caller that sends several payloads in one request (the nudge rule) passes one
//   shared budget object so the total stays at 40.
// - A subscription the push service reports gone (404 or 410) is deleted at once. A row whose
//   endpoint is not on a known push service host is skipped, logged by host only, and kept, so a
//   gap in the host list never destroys subscriptions. Each push request times out after
//   PUSH_TIMEOUT_MS.
// - A failure is one log line with a status or an error class, never an endpoint, a key, a
//   payload or a person.

import { buildPushRequest, isPushServiceEndpoint, vapidConfigured } from './webpush.js';

export const MAX_SENDS = 40;
// How long one push request may take before it is abandoned.
export const PUSH_TIMEOUT_MS = 10_000;

// The live subscriptions of these people: [{ id, profile_id, endpoint, p256dh, auth }].
export function subscriptionsFor(ctx, profileIds, now = Date.now()) {
  const ids = [...new Set(profileIds)].filter((id) => typeof id === 'string' && id);
  if (!ids.length) return [];
  return ctx.sql
    .exec(
      `SELECT id, profile_id, endpoint, p256dh, auth FROM push_subs
       WHERE profile_id IN (SELECT value FROM json_each(?)) AND expires_at_ms > ?
       ORDER BY created_at_ms DESC`,
      JSON.stringify(ids),
      now,
    )
    .toArray();
}

// Sends payload (an object, serialised as JSON) to every live subscription of profileIds.
// Resolves to the number of subscriptions the push service accepted; never rejects.
// options.budget is a { left } object shared between calls; without one a fresh budget of
// MAX_SENDS is used.
export async function sendPush(ctx, profileIds, payload, { budget = { left: MAX_SENDS } } = {}) {
  try {
    if (!vapidConfigured(ctx.env) || !(budget.left > 0)) return 0;
    const subs = subscriptionsFor(ctx, profileIds).slice(0, Math.max(0, budget.left));
    if (!subs.length) return 0;
    budget.left -= subs.length;
    const data = JSON.stringify(payload);
    const results = await Promise.all(subs.map((s) => deliver(ctx, s, data)));
    return results.filter(Boolean).length;
  } catch (err) {
    console.error(`push send failed: ${err?.name ?? 'Error'}`);
    return 0;
  }
}

// The host of an endpoint for a log line, or a fixed word when it does not parse. Never the path or query.
function hostOf(endpoint) {
  try {
    return new URL(endpoint).hostname.slice(0, 100);
  } catch {
    return 'unparseable';
  }
}

async function deliver(ctx, sub, data) {
  try {
    // A row whose endpoint is not on the push service allowlist is never sent to, and it is kept:
    // only the push service's own 404 or 410 deletes a row, so a gap in the list can never destroy
    // subscriptions. The log line names the host only, never the path (the path is the secret).
    if (!isPushServiceEndpoint(sub.endpoint)) {
      console.error(`push skipped: endpoint host not allowed: ${hostOf(sub.endpoint)}`);
      return false;
    }
    const { url, init } = await buildPushRequest(ctx.env, sub, data);
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(PUSH_TIMEOUT_MS) });
    try {
      await res.body?.cancel();
    } catch {
      // The body is never read.
    }
    if (res.status === 404 || res.status === 410) {
      ctx.sql.exec('DELETE FROM push_subs WHERE id = ?', sub.id);
      return false;
    }
    if (res.status >= 200 && res.status < 300) return true;
    console.error(`push failed: status ${res.status}`);
    return false;
  } catch (err) {
    console.error(`push failed: ${err?.name ?? 'Error'}`);
    return false;
  }
}
