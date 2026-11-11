// Web Push subscriptions and native push registrations: the channels that make the pocket case
// work.
//
//   GET    /api/push/vapid                 { publicKey }  (no device header)
//   PUT    /api/push/subscription          { event, subscription: { endpoint, keys: { p256dh, auth } } }
//   DELETE /api/push/subscription          { event, endpoint }
//   PUT    /api/push/native                { event, platform: 'apns' | 'fcm', token, environment? }
//   DELETE /api/push/native                { event, platform, token }
//
// Env: as people.mjs; ES_PEOPLE_PUSH_INDEX (default caddie-people-push) holds the subscriptions
// and the registrations; VAPID_PUBLIC_KEY (not a secret) is what GET /api/push/vapid returns. The
// private key and the Web Push sending live in nudge.mjs; the APNs and FCM settings and sending
// in native-push.mjs.
//
// Rules this module keeps:
// - The subscription and registration routes need the device header and a live profile of the
//   requester at that conference (403 profile_required otherwise), like every Find & connect write.
// - A subscription document is keyed by sha256(endpoint), so the same browser subscribing twice
//   writes one document, and a subscription can be removed by its endpoint alone. A native
//   registration is keyed by sha256(event:profile_id:platform): one per device, platform and
//   conference, so a token the platform rotated replaces the old one, and the delete route removes
//   it only while it still holds the token the request names. Both carry the conference and the
//   profile_id, and expire with the conference (expires_at = visible_until); the purge deletes
//   them then, and deleteConnections deletes them with the profile.
// - The endpoint, the two keys and a native token are stored unindexed and never returned to
//   anyone. The index is dynamic: false and does not map platform, token or environment, so a
//   registration is kept in _source only and needed no mapping change. They leave the server only
//   inside the push request to the browser's push service, to APNs or to FCM.
// - A native registration for a platform this server does not push to (push.apns or push.fcm
//   false, also after native-push.mjs turned the channel off at runtime) is refused with 404
//   push_unavailable and nothing is stored. Removing one always works.
// - A new subscription's endpoint must be https, on a known browser push service host
//   (PUSH_SERVICE_HOSTS in push-hosts.mjs, the same list as the Worker's), on the default port,
//   with no user name or password; any other is refused with 400 "endpoint must be a push service
//   URL", so a profile can never make this server send signed requests to a host of its choosing.
//   Removing a subscription needs only a well-formed https endpoint, so a row stored before this
//   rule can still be removed by its owner, and pushTargetsFor skips such a row, never sends to it.
// - Nothing from a request body or header is logged, except the host (never the endpoint) of a
//   push endpoint refused at subscribe time or skipped at send time, so a push service missing
//   from the list shows up in the logs.

import crypto from 'node:crypto';
import { clientIp } from './ratelimit.mjs';
import { NATIVE_PUSH, nativeTokenOf } from './native-push.mjs';
import { isPushServiceEndpoint } from './push-hosts.mjs';
import {
  people, idx, PUSH_INDEX, LIMITS,
  HttpError, UpstreamError, bad, sendJson, limit, jsonBody, requireDevice, isPlainObject,
  conferenceFor, authenticated, dispatch, deleteWhere,
} from './people.mjs';

const ENDPOINT_MAX = 2048;
const KEY_RE = /^[A-Za-z0-9_-]{16,256}$/;
const SUBSCRIPTION_KEYS = new Set(['event', 'subscription']);
const SUBSCRIPTION_FIELDS = new Set(['endpoint', 'keys', 'expirationTime']);
const KEYS_FIELDS = new Set(['p256dh', 'auth']);
const DELETE_KEYS = new Set(['event', 'endpoint']);
const NATIVE_KEYS = new Set(['event', 'platform', 'token', 'environment']);
const NATIVE_DELETE_KEYS = new Set(['event', 'platform', 'token']);
const ENVIRONMENTS = new Set(['production', 'sandbox']);

const iso = (ms) => new Date(ms).toISOString();
const profileRequired = () => new HttpError(403, { error: 'profile_required' });

// The document id of a subscription: the hash of its endpoint, so the endpoint itself is never a
// path segment and never indexed.
export const subscriptionId = (endpoint) => crypto.createHash('sha256').update(endpoint, 'utf8').digest('hex');
// The document id of a native registration: the hash of its conference, profile and platform. The
// profile_id is the device's own id, so a device keeps one registration per platform at each
// conference it is used at, and a new token (the platforms rotate them) overwrites the old one
// rather than leaving it to fail. A subscription id hashes an https URL, so the two never meet.
export const registrationId = (event, profileId, platform) => crypto.createHash('sha256').update(`${event}:${profileId}:${platform}`, 'utf8').digest('hex');

function writer(req) {
  limit(`people-write:ip:${clientIp(req)}`, LIMITS.writeIp);
  const device = requireDevice(req);
  limit(`people-write:dev:${device.profileId}`, LIMITS.writeDevice);
  return device;
}

// A push endpoint: a https URL of at most ENDPOINT_MAX characters. forWrite (a new subscription)
// also requires a known browser push service host (isPushServiceEndpoint); a delete does not, so
// a row stored before that rule can still be removed.
function endpointOf(value, { forWrite = false } = {}) {
  if (typeof value !== 'string' || !value || value.length > ENDPOINT_MAX) throw bad('endpoint must be a push service URL');
  let u;
  try {
    u = new URL(value);
  } catch {
    throw bad('endpoint must be a push service URL');
  }
  if (u.protocol !== 'https:') throw bad('endpoint must be a https URL');
  if (forWrite && !isPushServiceEndpoint(value)) {
    // Only the host is logged, never the endpoint, so a push service missing from the list shows up.
    console.warn(`push subscription refused: host ${u.hostname.toLowerCase().slice(0, 64)}`);
    throw bad('endpoint must be a push service URL');
  }
  return value;
}

// Validates { endpoint, keys: { p256dh, auth } } as the browser's PushSubscription.toJSON() gives
// it. expirationTime is accepted and ignored.
function subscriptionOf(value) {
  if (!isPlainObject(value)) throw bad('subscription must be an object');
  for (const k of Object.keys(value)) if (!SUBSCRIPTION_FIELDS.has(k)) throw bad(`Unknown key: subscription.${k.slice(0, 40)}`);
  const endpoint = endpointOf(value.endpoint, { forWrite: true });
  if (!isPlainObject(value.keys)) throw bad('subscription.keys must be an object');
  for (const k of Object.keys(value.keys)) if (!KEYS_FIELDS.has(k)) throw bad(`Unknown key: subscription.keys.${k.slice(0, 40)}`);
  const { p256dh, auth } = value.keys;
  if (typeof p256dh !== 'string' || !KEY_RE.test(p256dh)) throw bad('subscription.keys.p256dh must be a base64url key');
  if (typeof auth !== 'string' || !KEY_RE.test(auth)) throw bad('subscription.keys.auth must be a base64url secret');
  return { endpoint, p256dh, auth };
}

// Validates { platform, token } and, for a registration, environment: 'production' (the default)
// or 'sandbox' for an APNs token of a development build; FCM takes none. An APNs token is
// lowercased.
function registrationOf(body, { environment = false } = {}) {
  const { platform } = body;
  if (platform !== 'apns' && platform !== 'fcm') throw bad('platform must be apns or fcm');
  const token = nativeTokenOf(platform, body.token);
  if (!token) throw bad(platform === 'apns' ? 'token must be an APNs device token in hex' : 'token must be an FCM registration token');
  if (!environment) return { platform, token };
  if (platform === 'fcm') {
    if (body.environment !== undefined) throw bad('environment is only for apns');
    return { platform, token };
  }
  const env = body.environment === undefined ? 'production' : body.environment;
  if (!ENVIRONMENTS.has(env)) throw bad('environment must be production or sandbox');
  return { platform, token, environment: env };
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
  await deleteWhere(PUSH_INDEX, conf.slug, {
    bool: {
      filter: [{ ids: { values: [subscriptionId(endpoint)] } }, { term: { event_id: conf.slug } }, { term: { profile_id: me.profile_id } }],
    },
  });
  sendJson(res, 200, { ok: true });
}

async function putRegistration(req, res) {
  const device = writer(req);
  const body = await jsonBody(req, NATIVE_KEYS);
  const reg = registrationOf(body, { environment: true });
  if (!NATIVE_PUSH[reg.platform]) throw new HttpError(404, { error: 'push_unavailable' });
  const conf = await conferenceFor(body.event);
  const me = await requireProfile(device, conf.slug);
  const now = Date.now();
  if (Date.parse(conf.visibleUntil) <= now) throw bad('conference has ended');
  const { status } = await people('PUT', `${idx(PUSH_INDEX)}/_doc/${registrationId(conf.slug, me.profile_id, reg.platform)}?refresh=wait_for`, {
    event_id: conf.slug,
    profile_id: me.profile_id,
    platform: reg.platform,
    token: reg.token,
    ...(reg.environment ? { environment: reg.environment } : {}),
    created_at: iso(now),
    expires_at: conf.visibleUntil,
  });
  if (status < 200 || status > 299) throw new UpstreamError(`status ${status}`);
  sendJson(res, 200, { ok: true });
}

// Removes the requester's registration for that platform at that conference, but only while it
// still holds the token the request names: a stale client (an old install's last call, a retried
// request) cannot remove the registration a fresh token replaced it with. The document is read and
// deleted only if it is unchanged since (if_seq_no), so a PUT in between wins. The token is not
// indexed, so it is compared here rather than in a query. Works whether or not the platform is
// configured, so a device can always remove its token, and answers 200 either way.
async function deleteRegistration(req, res) {
  const device = writer(req);
  const body = await jsonBody(req, NATIVE_DELETE_KEYS);
  const reg = registrationOf(body);
  const conf = await conferenceFor(body.event);
  const me = await requireProfile(device, conf.slug);
  const path = `${idx(PUSH_INDEX)}/_doc/${registrationId(conf.slug, me.profile_id, reg.platform)}`;
  const { status, json } = await people('GET', `${path}?_source_includes=event_id,profile_id,platform,token`, undefined, { okStatuses: [404] });
  const stored = status === 200 && json.found ? json._source ?? {} : null;
  if (stored && stored.event_id === conf.slug && stored.profile_id === me.profile_id && stored.platform === reg.platform && stored.token === reg.token) {
    await people('DELETE', `${path}?refresh=wait_for&if_seq_no=${json._seq_no}&if_primary_term=${json._primary_term}`, undefined, { okStatuses: [404, 409] });
  }
  sendJson(res, 200, { ok: true });
}

// The public VAPID key the browser subscribes with. Null when push is not configured, so the app
// hides the switch.
async function vapid(req, res) {
  limit(`push-vapid:ip:${clientIp(req)}`, LIMITS.publicIp);
  const key = process.env.VAPID_PUBLIC_KEY || null;
  sendJson(res, 200, { publicKey: key }, { 'Cache-Control': 'public, max-age=3600' });
}

// The most subscriptions and registrations one receiver is pushed to per nudge: the newest ones. A
// device has at most one registration per platform; a browser normally one subscription.
export const TARGETS_PER_PROFILE = 10;
// How many of each receiver's newest documents the search reads before the unusable ones (a
// subscription off the push service list, a malformed registration) are dropped and the rest are
// cut to TARGETS_PER_PROFILE: Elasticsearch's default index.max_inner_result_window. So an unusable
// row never takes one of the ten places unless a receiver has more than 90 of them, and no new
// off-list row can be stored.
export const TARGETS_READ_PER_PROFILE = 100;

// Every live Web Push subscription and native registration of these people at one conference,
// as [{ id, profile_id, subscription: { endpoint, keys: { p256dh, auth } } }] for a subscription
// and [{ id, profile_id, native: { platform, token, environment }, guard: { seqNo, primaryTerm } }]
// for a registration. Used by nudge.mjs. One search per nudge, as before native push: a terms
// aggregation on profile_id gives one bucket per person (at most 21: the writer and the 20
// candidates), and its top_hits the newest TARGETS_READ_PER_PROFILE documents of each (created_at
// descending), of which the newest TARGETS_PER_PROFILE usable ones are kept. So one person's many
// subscriptions can never crowd another person's out, and the pushes one nudge sends stay bounded.
// A person over the cap is one log line, without an id. A
// registration's guard is the _seq_no and _primary_term it was read with, so that one APNs or FCM
// reports gone is deleted only while it is still that document (deleteRegistrationIfUnchanged).
// A subscription whose endpoint is not on a known push service host (one stored before that rule)
// is skipped before that cut, so it takes no place, is never sent to and is not deleted; each one
// is a log line with its host only, the Worker's "push skipped: endpoint host not allowed:".
export async function pushTargetsFor(eventId, profileIds) {
  const ids = [...new Set(profileIds)].filter(Boolean);
  if (!ids.length) return [];
  const { json } = await people('POST', `${idx(PUSH_INDEX)}/_search?ignore_unavailable=true`, {
    size: 0,
    query: { bool: { filter: [{ term: { event_id: eventId } }, { terms: { profile_id: ids } }, { range: { expires_at: { gt: 'now' } } }] } },
    aggs: {
      receivers: {
        terms: { field: 'profile_id', size: ids.length },
        aggs: {
          newest: {
            top_hits: {
              size: TARGETS_READ_PER_PROFILE,
              sort: [{ created_at: { order: 'desc', unmapped_type: 'date' } }],
              _source: ['profile_id', 'endpoint', 'keys_p256dh', 'keys_auth', 'platform', 'token', 'environment'],
              seq_no_primary_term: true,
            },
          },
        },
      },
    },
  });
  const buckets = json.aggregations?.receivers?.buckets ?? [];
  const targets = [];
  for (const b of buckets) {
    const usable = (b.newest?.hits?.hits ?? []).flatMap(targetOf);
    if (usable.length > TARGETS_PER_PROFILE || b.doc_count > TARGETS_READ_PER_PROFILE) {
      console.error(`Push targets capped: one receiver has ${b.doc_count}, the newest ${TARGETS_PER_PROFILE} are used`);
    }
    targets.push(...usable.slice(0, TARGETS_PER_PROFILE));
  }
  return targets;
}

// The host of an endpoint for a log line, never its path or query, which are the secret part.
function hostOf(endpoint) {
  try {
    return new URL(endpoint).hostname.toLowerCase().slice(0, 64);
  } catch {
    return 'unparseable';
  }
}

// One search hit of pushTargetsFor as [target], or [] when it cannot be used.
function targetOf(h) {
  const source = h._source ?? {};
  if (!source.profile_id) return [];
  if (source.endpoint && source.keys_p256dh && source.keys_auth) {
    if (!isPushServiceEndpoint(source.endpoint)) {
      console.warn(`push skipped: endpoint host not allowed: ${hostOf(source.endpoint)}`);
      return [];
    }
    return [{ id: h._id, profile_id: source.profile_id, subscription: { endpoint: source.endpoint, keys: { p256dh: source.keys_p256dh, auth: source.keys_auth } } }];
  }
  const token = nativeTokenOf(source.platform, source.token);
  if (!token) return [];
  const environment = source.platform === 'apns' && source.environment === 'sandbox' ? 'sandbox' : 'production';
  const guard = Number.isInteger(h._seq_no) && Number.isInteger(h._primary_term) ? { seqNo: h._seq_no, primaryTerm: h._primary_term } : null;
  return [{ id: h._id, profile_id: source.profile_id, native: { platform: source.platform, token, environment }, guard }];
}

// Removes a subscription the push service said is gone (404 or 410). Its id is the hash of its
// endpoint, and a gone endpoint stays gone, so it is deleted by id alone.
export async function deleteSubscriptionById(id) {
  await people('DELETE', `${idx(PUSH_INDEX)}/_doc/${encodeURIComponent(id)}`, undefined, { okStatuses: [404] });
}

// Removes a native registration APNs or FCM said is gone, but only while it is unchanged since
// pushTargetsFor read it (if_seq_no and if_primary_term): a registration is one document per
// device, platform and conference, so a token the device registered in the meantime has rewritten
// it, and stays. 404 (already removed) and 409 (rewritten since) both leave nothing to do, as in
// deleteRegistration.
export async function deleteRegistrationIfUnchanged(id, guard) {
  await people('DELETE', `${idx(PUSH_INDEX)}/_doc/${encodeURIComponent(id)}?if_seq_no=${guard.seqNo}&if_primary_term=${guard.primaryTerm}`, undefined, { okStatuses: [404, 409] });
}

const ROUTES = {
  '/api/push/vapid': { GET: vapid },
  '/api/push/subscription': { PUT: putSubscription, DELETE: deleteSubscription },
  '/api/push/native': { PUT: putRegistration, DELETE: deleteRegistration },
};

// Handles the push routes. Resolves to true when the request was handled.
export async function handlePushApi(req, res, url) {
  const route = ROUTES[url.pathname];
  if (!route) return false;
  await dispatch(route, req, res, url);
  return true;
}
