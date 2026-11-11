// The server-side nudge (PLAN section 1.11), ported from nudgeAfterPresence in server/nudge.mjs:
// "Someone who's worked on {passage} is in {zone} right now", sent as a Web Push to both people
// of a strong match who are in the same zone.
//
// Rules this module keeps:
// - It runs after a presence write has been answered (T4 calls ctx.waitUntil(afterPresence(ctx,
//   me))), so a slow push service never slows the app. It never throws. Every failure is one log
//   line with a status or an error class, never a person, a zone or a passage.
// - When the daily rows-written meter is past its soft cap (ctx.meter.writesAllowed() is false),
//   or VAPID is not configured, it returns at once: no ranking, no rows, no pushes.
// - The trigger is the client's nudge rule, unchanged: rankPeople as the person whose presence
//   was written, when: 'around_now', size 20, with the same privacy gates and block filter as the
//   Around view. Only hits that are not broad, are around, and are in the same zone count.
// - Once per pair per conference day: the nudges row id is {day}:{min profile}:{max profile},
//   inserted with ON CONFLICT DO NOTHING, so the insert itself is the dedupe. At most 3 pushes
//   per receiver per hour, counted on nudge_sends. The pair's row is written even when nobody can
//   be pushed, so a pair is considered once a day whatever their subscriptions.
// - The push names nobody: the payload is exactly { title: 'Conference Caddie', body, data:
//   { url: '/e/{slug}#/people?around=1' } }, where body carries the other person's matched
//   passage (<mark> stripped, about 80 characters, else their first speak topic) and the zone. No
//   name, no ref, no profile_id, no distance and never a spot line.
// - A hidden or sample profile never takes part, as the trigger or as the other person.
// - At most 40 push requests per call, shared across every payload of the call.

import { rankPeople } from '../people/rank.js';
import { cutText, unescapeHtml } from '../lib/text.js';
import { dayKey, dayBounds } from '../lib/time.js';
import { sendPush, MAX_SENDS } from './send.js';
import { isPushServiceEndpoint, vapidConfigured } from './webpush.js';

const CANDIDATES = 20;
const EVIDENCE_MAX = 80;
const PUSHES_PER_HOUR = 3;
const HOUR_MS = 60 * 60_000;
const TITLE = 'Conference Caddie';

const nudgeId = (day, a, b) => (a < b ? `${day}:${a}:${b}` : `${day}:${b}:${a}`);
const body = (passage, zone) => `Someone who's worked on ${passage} is in ${zone} right now`;

// The passage a receiver hears about the other person: their matched evidence (HTML with <mark>
// tags) as plain text cut at a word boundary, else their plain matched passage, else their first
// speak topic. Null when there is nothing.
function passageOf({ evidence = null, plain = null }, person, labels) {
  const fromEvidence = evidence ? cutText(unescapeHtml(evidence), EVIDENCE_MAX) : '';
  if (fromEvidence) return fromEvidence;
  const fromPlain = plain ? cutText(plain, EVIDENCE_MAX) : '';
  if (fromPlain) return fromPlain;
  const topic = (person.speak_topics ?? []).find((t) => labels.has(t));
  return topic ? labels.get(topic) : null;
}

// Runs the rule for the person whose presence was just written. Resolves when done; never rejects.
export async function afterPresence(ctx, me) {
  try {
    if (!ctx?.meter?.writesAllowed?.()) return;
    if (!vapidConfigured(ctx.env)) return;
    const { store } = ctx;
    // The fresh cached row, so a presence or visibility change made by this request is seen.
    const self = (me?.profile_id && store.person(me.profile_id)) || null;
    if (!self || !store.isLive(self) || !store.isAround(self)) return;
    if (self.hidden || self.sample || !self.open_to_meet) return;
    const zone = self.presence?.zone;
    if (!zone) return;

    const { hits } = await rankPeople(ctx, self, {
      when: 'around_now',
      size: CANDIDATES,
      filter: (p) => !p.sample && !p.hidden && p.open_to_meet === true,
    });
    const strong = (hits ?? []).filter((h) => {
      const p = h?.person;
      return p && p.profile_id !== self.profile_id && !h.broad && !p.sample && !p.hidden && store.isLive(p) && store.isAround(p) && p.presence?.zone === zone;
    });
    if (!strong.length) return;

    const now = ctx.now ?? Date.now();
    const slug = ctx.slug ?? ctx.conf?.slug;
    const timeZone = ctx.conf?.time_zone ?? null;
    const day = dayKey(now, timeZone);
    const dayEnd = dayBounds(now, timeZone).end + 1000;
    const url = `/e/${encodeURIComponent(slug)}#/people?around=1`;
    const { labels } = store.topics();
    // What the other person hears about me: my own words, as evidenceFor falls back to them.
    const myPassage = passageOf({ plain: self.expertise || self.about || null }, self, labels);

    // Who has a live subscription that can be delivered to, in one query. A row whose endpoint is not
    // on the push service allowlist is kept but is never sent to (sendPush skips it), so it does not
    // make its person a receiver: nothing would be delivered and their hourly cap would be used up.
    const ids = [self.profile_id, ...strong.map((h) => h.person.profile_id)];
    const subscribed = new Set(
      ctx.sql
        .exec('SELECT profile_id, endpoint FROM push_subs WHERE profile_id IN (SELECT value FROM json_each(?)) AND expires_at_ms > ?', JSON.stringify(ids), now)
        .toArray()
        .filter((r) => isPushServiceEndpoint(r.endpoint))
        .map((r) => r.profile_id),
    );
    const counts = new Map();
    const underLimit = (id) => {
      if (!counts.has(id)) {
        const row = ctx.sql.exec('SELECT COUNT(*) AS n FROM nudge_sends WHERE receiver_id = ? AND sent_at_ms > ?', id, now - HOUR_MS).toArray()[0];
        counts.set(id, Number(row?.n ?? 0));
      }
      return counts.get(id) < PUSHES_PER_HOUR;
    };

    const budget = { left: MAX_SENDS };
    for (const h of strong) {
      if (budget.left <= 0 || !ctx.meter.writesAllowed()) break;
      const them = h.person;
      const theirPassage = passageOf({ evidence: h.evidence, plain: h.passage }, them, labels);
      const receivers = [];
      if (theirPassage && subscribed.has(self.profile_id) && underLimit(self.profile_id)) receivers.push(self.profile_id);
      if (myPassage && subscribed.has(them.profile_id) && underLimit(them.profile_id)) receivers.push(them.profile_id);

      const [a, b] = self.profile_id < them.profile_id ? [self.profile_id, them.profile_id] : [them.profile_id, self.profile_id];
      const inserted = ctx.sql
        .exec(
          `INSERT INTO nudges (id, day, a_id, b_id, receivers, created_at_ms, expires_at_ms)
           VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING RETURNING 1 AS ok`,
          nudgeId(day, a, b), day, a, b, JSON.stringify(receivers), now, dayEnd,
        )
        .toArray().length;
      if (!inserted) continue;
      for (const id of receivers) {
        ctx.sql.exec('INSERT INTO nudge_sends (receiver_id, sent_at_ms, expires_at_ms) VALUES (?, ?, ?)', id, now, now + HOUR_MS);
        counts.set(id, (counts.get(id) ?? 0) + 1);
      }
      if (receivers.includes(self.profile_id)) {
        await sendPush(ctx, [self.profile_id], { title: TITLE, body: body(theirPassage, zone), data: { url } }, { budget });
      }
      if (receivers.includes(them.profile_id)) {
        await sendPush(ctx, [them.profile_id], { title: TITLE, body: body(myPassage, zone), data: { url } }, { budget });
      }
    }
  } catch (err) {
    console.error(`nudge after presence failed: ${err?.name ?? 'Error'}`);
  }
}
