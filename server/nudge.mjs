// The server-side nudge: "Someone who's worked on {evidence} is in {zone} right now", sent as a
// Web Push, and as a generic alert through APNs or FCM to the official apps, to both people of a
// strong match who are in the same zone.
//
// Env: as people.mjs; ES_PEOPLE_NUDGES_INDEX (default caddie-people-nudges) records every nudge
// sent; VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY (Secret Manager caddie-vapid-private) and
// VAPID_SUBJECT (mailto: or https:) sign the Web Pushes; the APNs and FCM settings are read by
// native-push.mjs. PUSH_TRANSPORT=stub (tests only) replaces web-push, APNs and FCM with a
// recorder at PUSH_STUB_URL.
//
// Rules this module keeps:
// - It runs after a presence write has been answered (connect.mjs calls nudgeAfterPresence and
//   does not wait for it), so a slow push service never slows the app. Every failure is one log
//   line that names a status or an error class, never a person, a zone or a passage.
// - The trigger is the client's nudge rule, unchanged: one matches query AS THE PERSON whose
//   presence was written, when: around_now, built by people.mjs's peopleQuery so the ranking and
//   the block filter are the same as in the app; only results that are not broad, are around, and
//   are in the same zone count. Nothing here ranks or re-ranks.
// - Once per pair per conference day: the nudge record's _id is
//   {event}:{day}:{min_profile_id}:{max_profile_id}, written with op_type create, so the write
//   itself is the dedupe and two instances cannot both send. At most 3 pushes per receiver per
//   hour, counted from the records' receivers field. Records expire with the conference.
// - The channels share both limits. A receiver is anyone with a Web Push subscription or a native
//   registration on a channel this server sends on, and one nudge to a receiver is one push to
//   each of their subscriptions and registrations, counted once against the hourly limit.
// - When both people of a pair receive the nudge, the pushes to the second person wait a random
//   0 to 3 seconds after those to the first (pairDelayMs), on every channel, so two phones side by
//   side never light up at the same moment and point the two people at each other. The pause is
//   part of this background work, never of the presence write's answer. The writer receives at
//   most 3 nudges an hour, so one run pauses at most 3 times, 9 seconds in all.
// - The push names nobody. The Web Push one, which is end-to-end encrypted to the browser, has the
//   title "Conference Caddie", the sentence above with the other person's matched passage (<mark>
//   stripped, about 80 characters, else their first speak topic) and the zone as its body, and the
//   app URL as its data. A native push goes to Apple and Google in plain text, so it carries none
//   of that: it is the constant NATIVE_ALERT of native-push.mjs, the same bytes for every receiver.
//   No push carries a name, a distance, a ref, a profile_id or a spot line.
// - A profile hidden after reports, or a sample (demo or seeded) profile, never takes part: as the
//   trigger the rule stops before any query, and as the other person the query leaves them out
//   (peopleQuery drops hidden documents; sample ones are filtered here). So a hidden profile's
//   text never reaches anyone through a push, and no sample profile can push a real attendee.
// - A subscription the push service reports gone (404 or 410) is deleted, and so is a native
//   registration that APNs or FCM reports gone (native-push.mjs says when), but only while it is
//   unchanged since it was read: a token the device rotated to in the meantime is kept.

import crypto from 'node:crypto';
import {
  people, idx, NUDGES_INDEX, UpstreamError,
  peopleQuery, rankPeople, isBroad, evidenceFor, cutText, unescapeHtml, topicsOf, blockedIds, isAround, cellOf, SEMANTIC_FLOORS,
} from './people.mjs';
import { pushTargetsFor, deleteSubscriptionById, deleteRegistrationIfUnchanged } from './push.mjs';
import { NATIVE_PUSH } from './native-push.mjs';

const CANDIDATES = 20;
const EVIDENCE_MAX = 80;
const PUSHES_PER_HOUR = 3;
const HOUR_MS = 60 * 60_000;
const TTL_SECONDS = 600;
const TITLE = 'Conference Caddie';
// How long one Web Push request may stay idle before it is abandoned, as the Worker's
// PUSH_TIMEOUT_MS. web-push sends with https.request, which never follows a redirect, so the
// signed request cannot be forwarded to a host that is not on the push service list either.
export const PUSH_TIMEOUT_MS = 10_000;
// The longest pause between the pushes to the two people of a pair.
export const PAIR_JITTER_MAX_MS = 3000;

const iso = (ms) => new Date(ms).toISOString();

// ---------------------------------------------------------------------------------------------
// Transport. web-push is loaded on first use, so a server without the dependency or the keys
// still serves everything else and says once why Web Push nudges are off. Native pushes go
// through native-push.mjs, which says at start why a native channel is off.

let transportPromise = null;

async function loadTransport() {
  if (process.env.PUSH_TRANSPORT === 'stub') {
    const url = process.env.PUSH_STUB_URL;
    if (!url) throw new Error('PUSH_STUB_URL is not set');
    // Test-only recorder: the receiving server records the payload; a non-2xx status is thrown
    // the way web-push throws it, with statusCode.
    return async (subscription, payload, options) => {
      const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ endpoint: subscription.endpoint, payload: JSON.parse(payload), options }) });
      if (!res.ok) throw Object.assign(new Error('push failed'), { statusCode: res.status });
      await res.body?.cancel();
    };
  }
  const publicKey = process.env.VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  const subject = process.env.VAPID_SUBJECT;
  if (!publicKey || !privateKey || !subject) throw new Error('VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY and VAPID_SUBJECT are not all set');
  const mod = await import('web-push');
  const webpush = mod.default ?? mod;
  const vapidDetails = { subject, publicKey, privateKey };
  return (subscription, payload, options) => webpush.sendNotification(subscription, payload, webPushOptions(options, vapidDetails));
}

// The options of one web-push send: the caller's (TTL, urgency), the VAPID details and the timeout.
export const webPushOptions = (options, vapidDetails) => ({ ...options, vapidDetails, timeout: PUSH_TIMEOUT_MS });

function transport() {
  if (!transportPromise) {
    transportPromise = loadTransport().catch((err) => {
      console.error(`Web Push nudges are off: ${err.message}`);
      return null;
    });
  }
  return transportPromise;
}

// ---------------------------------------------------------------------------------------------

// YYYY-MM-DD of an instant in the conference's time zone (UTC-12 when it has none, as dayBounds).
function dayKey(nowMs, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: timeZone || 'Etc/GMT+12', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(nowMs));
  const get = (type) => parts.find((p) => p.type === type)?.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

const nudgeId = (eventId, day, a, b) => `${eventId}:${day}:${a < b ? a : b}:${a < b ? b : a}`;

// The passage the receiver hears about: the other person's matched evidence with its <mark> tags
// removed, cut at a word boundary, else their first speak topic. Null when there is nothing.
function passageOf(evidence, source, labels) {
  const text = evidence ? cutText(unescapeHtml(evidence), EVIDENCE_MAX) : '';
  if (text) return text;
  const topic = (source.speak_topics ?? []).find((t) => labels.has(t));
  return topic ? labels.get(topic) : null;
}

const body = (passage, zone) => `Someone who's worked on ${passage} is in ${zone} right now`;

// How many nudges this person received in the last hour.
async function recentCount(eventId, profileId, nowMs) {
  const { json } = await people('POST', `${idx(NUDGES_INDEX)}/_count?ignore_unavailable=true`, {
    query: { bool: { filter: [{ term: { event_id: eventId } }, { term: { receivers: profileId } }, { range: { created_at: { gte: iso(nowMs - HOUR_MS) } } }] } },
  });
  return json.count ?? 0;
}

// Sends one nudge to every subscription and native registration of one person: the Web Push
// payload to each subscription, and the generic native alert, which takes no payload, to each
// registration. A subscription the push service reports gone (404 or 410) is deleted, and a
// registration APNs or FCM reports gone is deleted only while it is unchanged since it was read
// (its guard), so a token the device registered while the push was out stays; the ids of both are
// returned so the caller stops using them.
async function pushTo(send, subs, payload) {
  const data = JSON.stringify(payload);
  const gone = [];
  for (const s of subs) {
    if (s.native) {
      if ((await NATIVE_PUSH.send(s.native, { ttl: TTL_SECONDS })) === 'gone') {
        gone.push(s.id);
        if (s.guard) await deleteRegistrationIfUnchanged(s.id, s.guard).catch(() => undefined);
      }
      continue;
    }
    try {
      await send(s.subscription, data, { TTL: TTL_SECONDS, urgency: 'normal' });
    } catch (err) {
      const status = err?.statusCode;
      if (status === 404 || status === 410) {
        gone.push(s.id);
        await deleteSubscriptionById(s.id).catch(() => undefined);
      } else {
        console.error(`Push failed: ${status ?? err?.name ?? 'error'}`);
      }
    }
  }
  return gone;
}

/** A random whole number of milliseconds from 0 to PAIR_JITTER_MAX_MS, each value as likely. */
export const pairDelayMs = () => crypto.randomInt(0, PAIR_JITTER_MAX_MS + 1);
const pairPause = () => new Promise((resolve) => {
  setTimeout(resolve, pairDelayMs());
});

// Runs the rule for one person whose presence (me.presence_zone, me.presence_until) was just
// written. Resolves when done; never rejects. pause is what waits between the pushes to the two
// people of a pair: a random pause of pairDelayMs, unless a test passes another.
export async function nudgeAfterPresence(me, conf, { pause = pairPause } = {}) {
  try {
    const zone = me.presence_zone;
    if (!zone || !isAround(me)) return;
    if (me.hidden === true || me.sample === true) return;
    const send = await transport();
    if (!send && !NATIVE_PUSH.apns && !NATIVE_PUSH.fcm) return;
    const blocked = await blockedIds(conf.slug, me.profile_id);
    // The same query the Around view runs, distance leg included when I sent a position; the
    // distance leg never decides specificity (people.mjs), so it cannot create a nudge. The
    // semantic legs use the stricter push floor, so a text match must be close to nudge anyone.
    // When inference fails it falls back to keyword legs like the Around view (rankPeople).
    const filters = [{ term: { open_to_meet: true } }, { range: { presence_until: { gt: 'now' } } }, { bool: { must_not: [{ term: { sample: true } }] } }];
    const build = (semantic) => peopleQuery(me, filters, { size: CANDIDATES, blocked, explain: true, origin: cellOf(me), semantic, floor: SEMANTIC_FLOORS.push });
    const [ranked, topics] = await Promise.all([rankPeople(conf.slug, build), topicsOf(conf.slug)]);
    if (!ranked) return;
    const { json, q } = ranked;
    const hits = (json.hits?.hits ?? []).filter((h) => {
      const s = h._source ?? {};
      return s.profile_id && s.sample !== true && isAround(s) && s.presence_zone === zone && !isBroad(h, q.legs, me, topics.common);
    });
    if (!hits.length) return;

    const now = Date.now();
    const day = dayKey(now, conf.timeZone);
    const url = `/e/${encodeURIComponent(conf.slug)}#/people?around=1`;
    // What the other person hears about me: my own words, the same fallback evidenceFor uses.
    const myPassage = passageOf(me.expertise || me.about || null, me, topics.labels);
    // Only the subscriptions and registrations of a channel this server sends on.
    const usable = (s) => (s.native ? NATIVE_PUSH[s.native.platform] === true : Boolean(send));
    let subs = (await pushTargetsFor(conf.slug, [me.profile_id, ...hits.map((h) => h._source.profile_id)])).filter(usable);
    const subsOf = (id) => subs.filter((s) => s.profile_id === id);
    const drop = (gone) => {
      if (gone.length) subs = subs.filter((s) => !gone.includes(s.id));
    };
    const counts = new Map();
    const underLimit = async (id) => {
      if (!counts.has(id)) counts.set(id, await recentCount(conf.slug, id, now));
      return counts.get(id) < PUSHES_PER_HOUR;
    };

    for (const h of hits) {
      const them = h._source;
      const theirPassage = passageOf(evidenceFor(h), them, topics.labels);
      // Who gets a push: whoever has a subscription or a registration and is under the hourly
      // limit. The record is written either way, so the pair is nudged once a day whatever their
      // subscriptions.
      const receivers = [];
      if (theirPassage && subsOf(me.profile_id).length && (await underLimit(me.profile_id))) receivers.push(me.profile_id);
      if (myPassage && subsOf(them.profile_id).length && (await underLimit(them.profile_id))) receivers.push(them.profile_id);
      const { status } = await people('PUT', `${idx(NUDGES_INDEX)}/_create/${encodeURIComponent(nudgeId(conf.slug, day, me.profile_id, them.profile_id))}?refresh=wait_for`, {
        event_id: conf.slug,
        day,
        profile_ids: [me.profile_id, them.profile_id],
        receivers,
        created_at: iso(now),
        expires_at: conf.visibleUntil,
      }, { okStatuses: [409] });
      if (status === 409) continue;
      for (const id of receivers) counts.set(id, (counts.get(id) ?? 0) + 1);
      const toMe = receivers.includes(me.profile_id);
      const toThem = receivers.includes(them.profile_id);
      if (toMe) drop(await pushTo(send, subsOf(me.profile_id), { title: TITLE, body: body(theirPassage, zone), data: { url } }));
      if (toMe && toThem) await pause();
      if (toThem) drop(await pushTo(send, subsOf(them.profile_id), { title: TITLE, body: body(myPassage, zone), data: { url } }));
    }
  } catch (err) {
    console.error(`Nudge after presence failed: ${err instanceof UpstreamError ? err.message : (err?.name ?? 'error')}`);
  }
}
