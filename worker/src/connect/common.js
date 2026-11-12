// Helpers shared by the presence, meet and Bluetooth routes of this module: rate-limit buckets,
// error bodies, the line filter, visibility of a person by ref, and the geometry of positions.
// Ported from server/connect.mjs and server/people.mjs with the same constants and messages.

import { HttpError, bad, isPlainObject, text, REF_RE } from '../lib/http.js';
import { requireDevice } from '../lib/device.js';
import { moderate } from './moderation.js';
import { stripControls } from '../lib/text.js';

// The per-minute buckets of server/people.mjs LIMITS. The keys are the same as today's, so the
// buckets are shared with the people routes that use the same names.
export const LIMITS = {
  writeDevice: 20,
  writeIp: 60,
  readDevice: 30,
  readIp: 90,
  pollDevice: 30,
  pollIp: 1200,
};

export const MINUTE_MS = 60_000;
export const HOUR_MS = 60 * MINUTE_MS;

export const iso = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString() : null);

export const profileRequired = () => new HttpError(403, { error: 'profile_required' });
export const blocked = () => new HttpError(403, { error: 'blocked' });
export const notFound = () => new HttpError(404, { error: 'not_found' });
export const presenceRequired = () => new HttpError(403, { error: 'presence_required', message: "Turn on 'Around and up for a conversation' first." });
export const notAround = () => new HttpError(409, { error: 'not_around', message: "They're not around right now." });

// The write, read and poll buckets: per address first, then per device. Each returns the device.
// The inbox and meet polls run in the background on every device that is around, and attendees
// often share one venue Wi-Fi address, so they have their own large per-address bucket.
export function writer(ctx, req) {
  ctx.limit(`people-write:ip:${ctx.ip}`, LIMITS.writeIp);
  const device = requireDevice(req);
  ctx.limit(`people-write:dev:${device.profileId}`, LIMITS.writeDevice);
  return device;
}

export function poller(ctx, req) {
  ctx.limit(`people-poll:ip:${ctx.ip}`, LIMITS.pollIp);
  const device = requireDevice(req);
  ctx.limit(`people-poll:dev:${device.profileId}`, LIMITS.pollDevice);
  return device;
}

// The caller's live profile at this conference, else 403 profile_required. A wrong secret is 403
// forbidden (Store.authenticate).
export async function requireProfile(ctx, device) {
  const me = await ctx.store.authenticate(device);
  if (!me) throw profileRequired();
  return me;
}

export function refOf(body) {
  if (typeof body.ref !== 'string' || !REF_RE.test(body.ref)) throw bad('ref must be a result reference');
  return body.ref;
}

// A short line other people will read: trimmed, capped and passed through the filter. Returns
// { text, pending }, text null for an empty line. A rejected line is 400 filtered. Nothing is held
// on the free stack (there is no classifier), so pending is always false; the field stays so the
// stored shape and the responses are those of today.
export function line(value, name, max) {
  // Control characters go before the filter sees the line, so none can split a listed word.
  const t = text(stripControls(value), name, max);
  if (!t) return { text: null, pending: false };
  const verdict = moderate(t);
  if (verdict.outcome === 'reject') throw new HttpError(400, verdict.body);
  return { text: t, pending: false };
}

// The person a result's ref points at, or null (gate 9). Only someone the caller could have seen
// qualifies: live, not the caller, not hidden after reports, and visible conference-wide or
// sharing a talk the caller also shares for. Blocks are checked by the caller afterwards, so a
// blocked pair answers 403 blocked rather than 404.
export function personByRef(ctx, me, ref) {
  const s = ctx.store.personByRef(ref);
  if (!s || !ctx.store.isLive(s) || s.profile_id === me.profile_id || s.hidden) return null;
  if (s.open_to_meet) return s;
  const mine = new Set(me.shared_talk_ids ?? []);
  return (s.shared_talk_ids ?? []).some((id) => mine.has(id)) ? s : null;
}

// Actions carry an empty JSON object, or no body at all.
export async function emptyBody(req) {
  const raw = await req.text();
  if (!raw) return;
  const type = (req.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (type !== 'application/json') throw new HttpError(415, { error: 'Content-Type must be application/json' });
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    throw bad('Malformed JSON');
  }
  if (!isPlainObject(body)) throw bad('Body must be a JSON object');
  const extra = Object.keys(body)[0];
  if (extra !== undefined) throw bad(`Unknown key: ${extra.slice(0, 40)}`);
}

// n random bytes as base64url without padding (12 bytes give 16 characters, 16 give 22).
export function randomId(n) {
  const bytes = crypto.getRandomValues(new Uint8Array(n));
  let s = '';
  for (const x of bytes) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// ---------------------------------------------------------------------------------------------
// Positions. They live in memory only (Store.setLocation) and leave the server only as a
// distance and a bearing inside an active meet.

const EARTH_RADIUS_M = 6_371_000;
const rad = (deg) => (deg * Math.PI) / 180;

// The precise position of a person who is around and sent one, else null.
export function locationOf(store, p) {
  if (!store.isAround(p)) return null;
  const l = p.presence?.location;
  if (!l || !Number.isFinite(l.lat) || !Number.isFinite(l.lon)) return null;
  return { lat: l.lat, lon: l.lon };
}

// Great-circle distance in metres (haversine).
export function distanceM(a, b) {
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

// Initial bearing from a to b, 0 to 360 degrees clockwise from north.
export function bearingDeg(a, b) {
  const dLon = rad(b.lon - a.lon);
  const y = Math.sin(dLon) * Math.cos(rad(b.lat));
  const x = Math.cos(rad(a.lat)) * Math.sin(rad(b.lat)) - Math.sin(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.cos(dLon);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}
