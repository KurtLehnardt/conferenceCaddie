// What one person looks like to another (PLAN section 1.8), ported from toPerson, reasonsFor and
// proximityBand in server/people.mjs.
//
// Gate 6: a result carries the person's ref, never their profile_id, secret_hash, text_hash,
// position or Bluetooth token. Gate 7: zone and the proximity band only while both people are
// around, and the band comes from grid cells, never from a precise position. Contact fields are
// shaped here, and only the matches and circle-members routes (which passed gates 2 to 4) return
// them; sightings strip them.

import { cutText, escapeHtml, unescapeHtml } from '../lib/text.js';

export const PASSAGE_MAX = 200;
export const EVIDENCE_FALLBACK = 160;

// ---------------------------------------------------------------------------------------------
// Positions. A precise position lives in Durable Object memory only (store.setLocation). Anything a
// stranger can observe, the band on a result and the order the distance leg gives, comes from the
// ~100 m grid cell the position falls in, so a requester who claims any positions they like learns
// at most which cell someone is in, never where in it.

export const CELL_DEG = 0.001;
const CELL_DECIMALS = 6;
// Cell centres closer than this make two people 'around' each other; the same cell is 'near'.
export const PROXIMITY_AROUND_M = 300;
const EARTH_RADIUS_M = 6_371_000;
const rad = (deg) => (deg * Math.PI) / 180;
const roundCell = (v) => Number(v.toFixed(CELL_DECIMALS));

// The centre of the grid cell a position falls in, as { lat, lon }. Latitude snaps to 0.001
// degrees (about 111 m) and longitude to the step that spans the same distance at that latitude.
export function cellFor({ lat, lon }) {
  const cLat = Math.max(-90, Math.min(90, Math.round(lat / CELL_DEG) * CELL_DEG));
  const lonStep = CELL_DEG / Math.max(Math.cos(rad(cLat)), CELL_DEG);
  let cLon = Math.round(lon / lonStep) * lonStep;
  if (cLon > 180) cLon -= 360;
  if (cLon < -180) cLon += 360;
  return { lat: roundCell(cLat), lon: roundCell(cLon) };
}

// Great-circle distance in metres (haversine).
export function distanceM(a, b) {
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

// The cell of a person who is around with a position in memory, else null.
export function cellOf(store, p) {
  if (!store.isAround(p)) return null;
  const l = p.presence?.location;
  if (!l || !Number.isFinite(l.lat) || !Number.isFinite(l.lon)) return null;
  return cellFor(l);
}

// The band between two people who are both around: the same zone first; then, when both have a
// cell, 'near' for the same cell and 'around' for cell centres under 300 m apart; else the venue
// as a whole. Never a number.
export function proximityBand(store, me, them) {
  const myZone = me.presence?.zone ?? null;
  if (myZone && myZone === (them.presence?.zone ?? null)) return 'same_zone';
  const a = cellOf(store, me);
  const b = cellOf(store, them);
  if (!a || !b) return 'venue';
  if (a.lat === b.lat && a.lon === b.lon) return 'near';
  if (distanceM(a, b) < PROXIMITY_AROUND_M) return 'around';
  return 'venue';
}

// ---------------------------------------------------------------------------------------------
// Reasons.

const listFormat = new Intl.ListFormat('en', { style: 'long', type: 'conjunction' });

// The topics a person shares with the requester, in either direction.
export function sharedTopics(me, them) {
  const theirSpeak = new Set(them.speak_topics);
  const theirLearn = new Set(them.learn_topics);
  return [...new Set([...me.learn_topics.filter((t) => theirSpeak.has(t)), ...me.speak_topics.filter((t) => theirLearn.has(t))])];
}

// The reason templates of the product brief, filled from this result's own fields. Only talks in
// talkTitles are named, and the routes put there only talks the caller both marked and shares for
// (gate 5).
export function reasonsFor(me, them, labels, talkTitles, passage, circleTalkId, { evidence = null, zone = null } = {}) {
  const reasons = [];
  const named = (ids) => ids.filter((id) => labels.has(id)).map((id) => labels.get(id));
  const theirSpeak = new Set(them.speak_topics);
  const theirLearn = new Set(them.learn_topics);
  const theirShared = new Set(them.shared_talk_ids);
  const canSpeak = named(me.learn_topics.filter((t) => theirSpeak.has(t)));
  const wantLearn = named(me.speak_topics.filter((t) => theirLearn.has(t)));
  if (evidence) reasons.push(`They've worked on ${cutText(unescapeHtml(evidence), PASSAGE_MAX)}.`);
  if (canSpeak.length) reasons.push(`They can speak to ${listFormat.format(canSpeak.slice(0, 4))}, which you want to learn about.`);
  if (wantLearn.length) reasons.push(`They want to learn about ${listFormat.format(wantLearn.slice(0, 4))}, which you can speak to.`);
  const both = [...talkTitles.keys()].filter((id) => id !== circleTalkId && theirShared.has(id));
  if (both.length) reasons.push(`You are both interested in ${listFormat.format(both.slice(0, 2).map((id) => talkTitles.get(id)))}.`);
  if (passage && !evidence) reasons.push(`Ask them about ${passage}.`);
  if (circleTalkId && talkTitles.has(circleTalkId)) reasons.push(`You are both interested in ${talkTitles.get(circleTalkId)}.`);
  if (zone) reasons.push(`They're in ${zone} right now.`);
  return reasons;
}

// The plain evidence of a person with no lexical or semantic fragment: the start of their
// expertise, or of their about, escaped. Null for a profile with no text.
export function plainEvidence(p) {
  const plain = cutText(p.expertise || p.about || '', EVIDENCE_FALLBACK);
  return plain ? escapeHtml(plain) : null;
}

// Shapes one ranked hit ({ person, legs, broad, evidence, passage } from rankPeople) for the
// requester, as the PersonResult of today. In a text search (search true) the evidence leads the
// reasons. A broad match carries no evidence and is labelled with the common topic it shares.
export function toPerson(ctx, hit, me, labels, talkTitles, circleTalkId, { search = false, broad = false } = {}) {
  const store = ctx.store;
  const p = hit.person;
  const topicsOf = (ids) => ids.filter((id) => labels.has(id)).map((id) => ({ topic_id: id, label: labels.get(id) }));
  const evidence = broad ? null : hit.evidence ?? plainEvidence(p);
  const around = store.isAround(p);
  const both = around && store.isAround(me);
  const zone = both && p.presence.zone ? p.presence.zone : null;
  const proximity = both ? proximityBand(store, me, p) : null;
  let reasons;
  if (broad) {
    const shared = sharedTopics(me, p).filter((t) => labels.has(t)).map((t) => labels.get(t));
    reasons = shared.length ? [`Also interested in ${listFormat.format(shared.slice(0, 4))}.`] : [];
    if (zone) reasons.push(`They're in ${zone} right now.`);
  } else {
    reasons = reasonsFor(me, p, labels, talkTitles, hit.passage ?? null, circleTalkId, { evidence: search ? evidence : null, zone });
  }
  return {
    ref: p.ref,
    display_name: p.display_name,
    about: p.about,
    sample: p.sample === true,
    learn_topics: topicsOf(p.learn_topics),
    speak_topics: topicsOf(p.speak_topics),
    reasons,
    opener: reasons[0] ?? null,
    contact: { linkedin_url: p.linkedin_url ?? null, contact_note: p.contact_note ?? null },
    evidence,
    around,
    zone,
    proximity,
    broad,
  };
}
