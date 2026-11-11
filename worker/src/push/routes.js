// Web Push subscriptions (PLAN section 2, rows 28 and 29), ported from server/push.mjs.
//
//   PUT    /api/push/subscription   { event, subscription: { endpoint, keys: { p256dh, auth }, expirationTime? } }
//   DELETE /api/push/subscription   { event, endpoint }
//
// GET /api/push/vapid is answered by the Worker itself (src/index.js).
//
// Rules this module keeps:
// - Both routes need the device header and a live profile of the caller at this conference
//   (403 profile_required otherwise), like every Find & connect write.
// - A subscription row is keyed by sha256(endpoint), so the same browser subscribing twice writes
//   one row and a subscription can be removed by its endpoint alone. It expires with the
//   profile's visible_until_ms; the cron purge deletes it then, and deletePersonEverywhere
//   deletes it with the profile. A profile keeps at most 10 subscriptions (the newest).
// - The endpoint must be https and at most 1,000 characters, and a new subscription's endpoint
//   must be on a known browser push service host (PUSH_SERVICE_HOSTS in webpush.js), on the
//   default port; p256dh must be the base64url of a valid 65-byte P-256 point and auth the
//   base64url of 16 bytes.
// - The endpoint and the keys are never returned to anyone and never logged. They leave the
//   object only inside the encrypted push request to the browser's own push service.

import { HttpError, bad, json, readJson, isPlainObject } from '../lib/http.js';
import { requireDevice, sha256Hex } from '../lib/device.js';
import { b64urlDecode, isPushServiceEndpoint, isValidP256Point } from './webpush.js';

const ENDPOINT_MAX = 1000;
const SUBS_PER_PROFILE = 10;
const WRITE_IP = 60;
const WRITE_DEVICE = 20;
const FAIL = 'People are temporarily unavailable';
const PUT_KEYS = new Set(['event', 'subscription']);
const SUBSCRIPTION_FIELDS = new Set(['endpoint', 'keys', 'expirationTime']);
const KEYS_FIELDS = new Set(['p256dh', 'auth']);
const DELETE_KEYS = new Set(['event', 'endpoint']);

const profileRequired = () => new HttpError(403, { error: 'profile_required' });

function writer(ctx, req) {
  ctx.limit(`people-write:ip:${ctx.ip}`, WRITE_IP);
  const device = requireDevice(req);
  ctx.limit(`people-write:dev:${device.profileId}`, WRITE_DEVICE);
  return device;
}

function endpointOf(value, { forWrite = false } = {}) {
  if (typeof value !== 'string' || !value || value.length > ENDPOINT_MAX) throw bad('endpoint must be a push service URL');
  let u;
  try {
    u = new URL(value);
  } catch {
    throw bad('endpoint must be a push service URL');
  }
  if (u.protocol !== 'https:') throw bad('endpoint must be a https URL');
  if (u.username || u.password || !u.hostname) throw bad('endpoint must be a push service URL');
  // A new subscription must point at a known browser push service. Removing one only needs a
  // well-formed https URL, so a row stored before this rule can still be deleted by its owner.
  if (forWrite && !isPushServiceEndpoint(value)) throw bad('endpoint must be a push service URL');
  return value;
}

// Validates { endpoint, keys: { p256dh, auth } } as PushSubscription.toJSON() gives it.
// expirationTime is accepted and ignored.
async function subscriptionOf(value) {
  if (!isPlainObject(value)) throw bad('subscription must be an object');
  for (const k of Object.keys(value)) if (!SUBSCRIPTION_FIELDS.has(k)) throw bad(`Unknown key: subscription.${k.slice(0, 40)}`);
  const endpoint = endpointOf(value.endpoint, { forWrite: true });
  if (!isPlainObject(value.keys)) throw bad('subscription.keys must be an object');
  for (const k of Object.keys(value.keys)) if (!KEYS_FIELDS.has(k)) throw bad(`Unknown key: subscription.keys.${k.slice(0, 40)}`);
  const { p256dh, auth } = value.keys;
  if (typeof p256dh !== 'string' || p256dh.length > 100 || !(await isValidP256Point(p256dh))) throw bad('subscription.keys.p256dh must be a base64url key');
  const authBytes = typeof auth === 'string' && auth.length <= 32 ? b64urlDecode(auth) : null;
  if (!authBytes || authBytes.length !== 16) throw bad('subscription.keys.auth must be a base64url secret');
  return { endpoint, p256dh: p256dh.replace(/=+$/, ''), auth: auth.replace(/=+$/, '') };
}

async function requireProfile(ctx, device) {
  const me = await ctx.store.authenticate(device);
  if (!me) throw profileRequired();
  return me;
}

async function putSubscription(ctx, req) {
  const device = writer(ctx, req);
  const body = await readJson(req, PUT_KEYS);
  const sub = await subscriptionOf(body.subscription);
  const me = await requireProfile(ctx, device);
  if (Number.isFinite(ctx.conf?.visible_until_ms) && ctx.conf.visible_until_ms <= ctx.now) throw bad('conference has ended');
  const id = await sha256Hex(sub.endpoint);
  ctx.sql.exec(
    `INSERT INTO push_subs (id, profile_id, endpoint, p256dh, auth, created_at_ms, expires_at_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET profile_id = excluded.profile_id, endpoint = excluded.endpoint,
       p256dh = excluded.p256dh, auth = excluded.auth, created_at_ms = excluded.created_at_ms,
       expires_at_ms = excluded.expires_at_ms`,
    id, me.profile_id, sub.endpoint, sub.p256dh, sub.auth, ctx.now, me.visible_until_ms,
  );
  ctx.sql.exec(
    `DELETE FROM push_subs WHERE profile_id = ? AND id NOT IN
       (SELECT id FROM push_subs WHERE profile_id = ? ORDER BY created_at_ms DESC, id LIMIT ?)`,
    me.profile_id, me.profile_id, SUBS_PER_PROFILE,
  );
  return json(200, { ok: true });
}

async function deleteSubscription(ctx, req) {
  const device = writer(ctx, req);
  const body = await readJson(req, DELETE_KEYS);
  const endpoint = endpointOf(body.endpoint);
  const me = await requireProfile(ctx, device);
  // Only the subscription's own profile can remove it; anyone else's request changes nothing.
  ctx.sql.exec('DELETE FROM push_subs WHERE id = ? AND profile_id = ?', await sha256Hex(endpoint), me.profile_id);
  return json(200, { ok: true });
}

export default [
  { method: 'PUT', path: '/api/push/subscription', bucket: 'write', fail: FAIL, handler: putSubscription },
  { method: 'DELETE', path: '/api/push/subscription', bucket: 'write', fail: FAIL, handler: deleteSubscription },
];
