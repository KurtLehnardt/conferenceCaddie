// Web Push subscriptions: the channel that makes the pocket case work.
//
//   GET    /api/push/vapid                 { publicKey }  (no device header)
//   PUT    /api/push/subscription          { event, subscription: { endpoint, keys: { p256dh, auth } } }
//   DELETE /api/push/subscription          { event, endpoint }
//
// Env: as people.mjs; ES_PEOPLE_PUSH_INDEX (default caddie-people-push) holds the subscriptions;
// VAPID_PUBLIC_KEY (not a secret) is what GET /api/push/vapid returns. The private key and the
// sending itself live in nudge.mjs.
//
// Rules this module keeps:
// - The two subscription routes need the device header and a live profile of the requester at
//   that conference (403 profile_required otherwise), like every Find & connect write.
// - A subscription document is keyed by sha256(endpoint), so the same browser subscribing twice
//   writes one document, and a subscription can be removed by its endpoint alone. It carries the
//   conference and the profile_id, and expires with the conference (expires_at = visible_until);
//   the purge deletes it then, and deleteConnections deletes it with the profile.
// - The endpoint and the two keys are stored unindexed and never returned to anyone. They leave
//   the server only inside the push request to the browser's own push service.
// - Nothing from a request body or header is logged.

import crypto from 'node:crypto';
import { clientIp } from './ratelimit.mjs';
import {
  people, idx, PUSH_INDEX, LIMITS,
  HttpError, UpstreamError, bad, sendJson, limit, jsonBody, requireDevice, isPlainObject,
  conferenceFor, authenticated, dispatch,
} from './people.mjs';

const ENDPOINT_MAX = 2048;
const KEY_RE = /^[A-Za-z0-9_-]{16,256}$/;
const SUBSCRIPTION_KEYS = new Set(['event', 'subscription']);
const SUBSCRIPTION_FIELDS = new Set(['endpoint', 'keys', 'expirationTime']);
const KEYS_FIELDS = new Set(['p256dh', 'auth']);
const DELETE_KEYS = new Set(['event', 'endpoint']);

const iso = (ms) => new Date(ms).toISOString();
const profileRequired = () => new HttpError(403, { error: 'profile_required' });

// The document id of a subscription: the hash of its endpoint, so the endpoint itself is never a
// path segment and never indexed.
export const subscriptionId = (endpoint) => crypto.createHash('sha256').update(endpoint, 'utf8').digest('hex');

function writer(req) {
  limit(`people-write:ip:${clientIp(req)}`, LIMITS.writeIp);
  const device = requireDevice(req);
  limit(`people-write:dev:${device.profileId}`, LIMITS.writeDevice);
  return device;
}

function endpointOf(value) {
  if (typeof value !== 'string' || !value || value.length > ENDPOINT_MAX) throw bad('endpoint must be a push service URL');
  let u;
  try {
    u = new URL(value);
  } catch {
    throw bad('endpoint must be a push service URL');
  }
  if (u.protocol !== 'https:') throw bad('endpoint must be a https URL');
  return value;
}

// Validates { endpoint, keys: { p256dh, auth } } as the browser's PushSubscription.toJSON() gives
// it. expirationTime is accepted and ignored.
function subscriptionOf(value) {
  if (!isPlainObject(value)) throw bad('subscription must be an object');
  for (const k of Object.keys(value)) if (!SUBSCRIPTION_FIELDS.has(k)) throw bad(`Unknown key: subscription.${k.slice(0, 40)}`);
  const endpoint = endpointOf(value.endpoint);
  if (!isPlainObject(value.keys)) throw bad('subscription.keys must be an object');
  for (const k of Object.keys(value.keys)) if (!KEYS_FIELDS.has(k)) throw bad(`Unknown key: subscription.keys.${k.slice(0, 40)}`);
  const { p256dh, auth } = value.keys;
  if (typeof p256dh !== 'string' || !KEY_RE.test(p256dh)) throw bad('subscription.keys.p256dh must be a base64url key');
  if (typeof auth !== 'string' || !KEY_RE.test(auth)) throw bad('subscription.keys.auth must be a base64url secret');
  return { endpoint, p256dh, auth };
}

async function requireProfile(device, slug) {
  const me = await authenticated(device, slug);
  if (!me) throw profileRequired();
  return me;
}

async function putSubscription(req, res) {
  const device = writer(req);
  const body = await jsonBody(req, SUBSCRIPTION_KEYS);
  const sub = subscriptionOf(body.subscription);
  const conf = await conferenceFor(body.event);
  const me = await requireProfile(device, conf.slug);
  const now = Date.now();
  if (Date.parse(conf.visibleUntil) <= now) throw bad('conference has ended');
  const { status } = await people('PUT', `${idx(PUSH_INDEX)}/_doc/${subscriptionId(sub.endpoint)}?refresh=wait_for`, {
    event_id: conf.slug,
    profile_id: me.profile_id,
    endpoint: sub.endpoint,
    keys_p256dh: sub.p256dh,
    keys_auth: sub.auth,
    created_at: iso(now),
    expires_at: conf.visibleUntil,
  });
  if (status < 200 || status > 299) throw new UpstreamError(`status ${status}`);
  sendJson(res, 200, { ok: true });
}

async function deleteSubscription(req, res) {
  const device = writer(req);
  const body = await jsonBody(req, DELETE_KEYS);
  const endpoint = endpointOf(body.endpoint);
  const conf = await conferenceFor(body.event);
  const me = await requireProfile(device, conf.slug);
  // Only the subscription's own profile can remove it; anyone else's request changes nothing.
  await people('POST', `${idx(PUSH_INDEX)}/_delete_by_query?refresh=true&conflicts=proceed&ignore_unavailable=true`, {
    query: {
      bool: {
        filter: [{ ids: { values: [subscriptionId(endpoint)] } }, { term: { event_id: conf.slug } }, { term: { profile_id: me.profile_id } }],
      },
    },
  });
  sendJson(res, 200, { ok: true });
}

// The public VAPID key the browser subscribes with. Null when push is not configured, so the app
// hides the switch.
async function vapid(req, res) {
  limit(`push-vapid:ip:${clientIp(req)}`, LIMITS.publicIp);
  const key = process.env.VAPID_PUBLIC_KEY || null;
  sendJson(res, 200, { publicKey: key }, { 'Cache-Control': 'public, max-age=3600' });
}

// Every live subscription of these people at one conference, as
// [{ id, profile_id, subscription: { endpoint, keys: { p256dh, auth } } }]. Used by nudge.mjs.
export async function subscriptionsFor(eventId, profileIds) {
  const ids = [...new Set(profileIds)].filter(Boolean);
  if (!ids.length) return [];
  const { json } = await people('POST', `${idx(PUSH_INDEX)}/_search?ignore_unavailable=true`, {
    size: 100,
    _source: ['profile_id', 'endpoint', 'keys_p256dh', 'keys_auth'],
    query: { bool: { filter: [{ term: { event_id: eventId } }, { terms: { profile_id: ids } }, { range: { expires_at: { gt: 'now' } } }] } },
  });
  return (json.hits?.hits ?? [])
    .map((h) => ({ id: h._id, source: h._source ?? {} }))
    .filter(({ source }) => source.profile_id && source.endpoint && source.keys_p256dh && source.keys_auth)
    .map(({ id, source }) => ({
      id,
      profile_id: source.profile_id,
      subscription: { endpoint: source.endpoint, keys: { p256dh: source.keys_p256dh, auth: source.keys_auth } },
    }));
}

// Removes a subscription the push service said is gone (404 or 410).
export async function deleteSubscriptionById(id) {
  await people('DELETE', `${idx(PUSH_INDEX)}/_doc/${encodeURIComponent(id)}`, undefined, { okStatuses: [404] });
}

const ROUTES = {
  '/api/push/vapid': { GET: vapid },
  '/api/push/subscription': { PUT: putSubscription, DELETE: deleteSubscription },
};

// Handles the push routes. Resolves to true when the request was handled.
export async function handlePushApi(req, res, url) {
  const route = ROUTES[url.pathname];
  if (!route) return false;
  await dispatch(route, req, res, url);
  return true;
}
