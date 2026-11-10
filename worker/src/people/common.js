// Shared pieces of the people routes (PLAN section 1.8): the rate-limit numbers and keys of
// server/people.mjs, the caller's authentication, and the ref lookup that every gate relies on.
//
// The rate limits are the in-memory token buckets of the ConferenceDO (ctx.limit), with the same
// keys and numbers as today, so the write, read and poll buckets stay shared with the connect
// routes (T4), which use the same key names.

import { HttpError } from '../lib/http.js';
import { requireDevice } from '../lib/device.js';

export const LIMITS = {
  writeDevice: 20,
  writeIp: 60,
  readDevice: 30,
  readIp: 90,
  // The inbox and meet polls and the timer-driven Around refresh, kept apart from the read buckets
  // so that many attendees behind one venue address do not starve searches.
  pollDevice: 30,
  pollIp: 1200,
  publicIp: 60,
};

export const notFound = () => new HttpError(404, { error: 'not_found' });
export const profileRequired = () => new HttpError(403, { error: 'profile_required' });
export const visibilityRequired = () => new HttpError(403, { error: 'visibility_required' });

// The write buckets (per address, then per device). Returns the device of the request.
export function writer(ctx, req) {
  ctx.limit(`people-write:ip:${ctx.ip}`, LIMITS.writeIp);
  const device = requireDevice(req);
  ctx.limit(`people-write:dev:${device.profileId}`, LIMITS.writeDevice);
  return device;
}

// The read buckets (per address, then per device). Returns the device of the request.
export function reader(ctx, req) {
  ctx.limit(`people-read:ip:${ctx.ip}`, LIMITS.readIp);
  const device = requireDevice(req);
  ctx.limit(`people-read:dev:${device.profileId}`, LIMITS.readDevice);
  return device;
}

// The caller's live person, or 403 profile_required. A wrong secret is 403 forbidden.
export async function requireProfile(ctx, device) {
  const me = await ctx.store.authenticate(device);
  if (!me) throw profileRequired();
  return me;
}

// The live person a result's ref points at, other than the caller, or null. Hidden people are
// included on purpose: a hidden person must stay blockable and reportable (server/people.mjs
// docByRef). Use visibleByRef for anything that shows or contacts the person.
export function liveByRef(ctx, me, ref) {
  const p = ctx.store.personByRef(ref);
  if (!p || !ctx.store.isLive(p) || p.profile_id === me.profile_id) return null;
  return p;
}

// Gate 9: the person a ref points at, only when the caller could have seen them under gates 1 to
// 3: live, not the caller, not hidden after reports, not blocked in either direction, and either
// visible conference-wide or sharing a talk the caller also shares for. Null otherwise.
export function visibleByRef(ctx, me, ref) {
  const p = liveByRef(ctx, me, ref);
  if (!p || p.hidden) return null;
  if (ctx.store.blockedBetween(me.profile_id, p.profile_id)) return null;
  if (p.open_to_meet) return p;
  const mine = new Set(me.shared_talk_ids);
  return p.shared_talk_ids.some((id) => mine.has(id)) ? p : null;
}

// Throws 403 forbidden when a person row exists for the device with another secret. Returns the
// row (live or not), or null when there is none. The secret is compared in constant time.
export async function ownRow(ctx, device) {
  const own = ctx.store.person(device.profileId);
  if (!own) return null;
  // authenticate throws 403 on a wrong secret, whether or not the row is live.
  await ctx.store.authenticate(device);
  return own;
}
