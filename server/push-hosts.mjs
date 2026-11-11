// The browser push services this server sends Web Push to, and the rule an endpoint must pass to
// be stored (PUT /api/push/subscription) or sent to (nudge.mjs, through pushTargetsFor).
//
// The list and the rule are the same as PUSH_SERVICE_HOSTS and isPushServiceEndpoint in
// worker/src/push/webpush.js (tier 2). The Cloud Run image does not contain worker/, so the list
// is kept here as a copy, and test/push-endpoint-allowlist.test.mjs fails when the two lists hold
// different hosts, when the two functions' source differs, or when the two rules disagree on any
// of its cases. Change both together.
//
// No dependencies, so a test can import it without the rest of the server.

// Chrome Stable, Opera, Samsung Internet and most other Chromium browsers deliver through FCM
// (fcm.googleapis.com; android.googleapis.com is the older FCM and GCM host). Chromium builds on a
// channel other than Stable (Chrome Beta, Dev and Canary, and unbranded Chromium) use
// jmt17.google.com instead (GetGcmEndpointForChannel in Chromium's
// components/push_messaging/push_messaging_utils.cc). Edge, both the Chromium-based one and the
// legacy one, delivers through WNS (*.notify.windows.com), not FCM. Firefox uses Mozilla autopush
// and Safari uses Apple. An entry that starts with a dot matches any subdomain of it, never the
// bare domain; every other entry matches that exact host only. Anything else is refused, so a subscription can never make this server send signed
// requests to a host the person chose.
export const PUSH_SERVICE_HOSTS = Object.freeze([
  'fcm.googleapis.com',
  'android.googleapis.com',
  'jmt17.google.com',
  '.push.services.mozilla.com',
  '.notify.windows.com',
  'web.push.apple.com',
  '.push.apple.com',
]);

// True when value is a https URL on a known push service host, on the default port, with no
// user name or password. The host is compared as the WHATWG URL parser gives it (lowercased, with
// an internationalized name in punycode); a trailing dot is refused. IP literals never match,
// because no allowed host is an IP address. web-push 4.0.0, the exact version package.json pins,
// sends to new URL(endpoint).hostname through https.request, so the host checked here is the host
// the request goes to (test/push-endpoint-allowlist.test.mjs stubs https.request to check it).
// Moving to another web-push version needs that test to pass again.
export function isPushServiceEndpoint(value) {
  let u;
  try {
    u = new URL(value);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:' || u.username || u.password || u.port !== '') return false;
  const host = u.hostname.toLowerCase();
  if (!host || host.endsWith('.')) return false;
  return PUSH_SERVICE_HOSTS.some((h) => (h.startsWith('.') ? host.endsWith(h) && host.length > h.length : host === h));
}
