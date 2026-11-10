// Writes the sample attendee profiles from data/samples/people.json for one conference.
//
// Usage: node scripts/seed-people.mjs --event <slug> [--talk "<title>"]... [--limit n]
//                                     [--file <path> --label <tag>]
//        node scripts/seed-people.mjs --event <slug> --label <tag> --remove
// Env:   ES_URL; ELASTISEARCH_API_KEY (the admin key, required: the sample cleanup runs
//        _delete_by_query?refresh=true, which the people key cannot refresh);
//        ES_PEOPLE_API_KEY (optional) to write the new people, else the admin key writes them;
//        ES_API_KEY (optional) to read conferences, topics and talks, else the admin key reads them;
//        ES_PEOPLE_INDEX, ES_INDEX, ES_TOPICS_INDEX, ES_CONFERENCES_INDEX as for the server.
//
// Every sample has sample: true, a display name starting "Sample · ", the contact note
// "Sample profile, not a real person" and no LinkedIn URL unless the file gives one. Topic labels are resolved against the
// conference's topics and talk titles against its talks; anything that does not resolve is
// skipped with a warning. Each profile gets a random device secret that is hashed and then
// discarded, so nobody can edit a sample through the API. The command first deletes the
// conference's previous samples, so it can be re-run. --talk replaces the file's shared_talks
// titles, in order. --limit writes only the first n profiles, which keeps development indices
// within the embedding budget.
//
// --file reads the profiles from another file in the same format, for example
// data/samples/demo-people.json. --label tags the run (lowercase letters and digits, at most 8
// characters). A labelled profile gets a profile_id that starts with "lbl-<tag>-", and a run with a
// label deletes only the earlier profiles of that conference that carry that prefix. A run without a
// label deletes the conference's samples that carry no label prefix, so the two kinds never touch
// each other. The index keeps no separate label field because its mapping is fixed, so the profile_id
// prefix is the label. With --remove (which needs a label) the run only deletes that label's
// profiles and writes nothing.
//
// A profile may also carry learn_ids and speak_ids (topic ids, used instead of the label lists when
// present), shared_talk_ids (talk ids of that conference, used as they are, with the file's
// "share" indexes still allowed beside them), linkedin_url (it must pass the server's pattern) and
// contact_note. data/samples/dummy-people.json, written by scripts/make-dummy-people.mjs, uses all of these.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { visibleUntil, textHash } from '../server/people.mjs';
import { newDevice, hashSecret, refFor } from '../server/device.mjs';

const ES_URL = (process.env.ES_URL || 'https://fc875c88f9f44f159f1a359ee724d82b.us-west1.gcp.cloud.es.io:443').replace(/\/$/, '');
const ADMIN_KEY = process.env.ELASTISEARCH_API_KEY;
const WRITE_KEY = process.env.ES_PEOPLE_API_KEY || ADMIN_KEY;
const READ_KEY = process.env.ES_API_KEY || process.env.ELASTISEARCH_API_KEY;
const PEOPLE_INDEX = process.env.ES_PEOPLE_INDEX || 'caddie-people';
const TALKS_INDEX = process.env.ES_INDEX || 'caddie-talks';
const TOPICS_INDEX = process.env.ES_TOPICS_INDEX || 'caddie-topics';
const CONFERENCES_INDEX = process.env.ES_CONFERENCES_INDEX || 'caddie-conferences';
const SAMPLE_PREFIX = 'Sample · ';
const CONTACT_NOTE = 'Sample profile, not a real person';
const BATCH = 10;
const LINKEDIN_RE = /^https:\/\/(www\.)?linkedin\.com\/in\/[A-Za-z0-9_-]{3,100}\/?$/;

if (!ADMIN_KEY) {
  console.error('Set ELASTISEARCH_API_KEY (the admin key). Removing the old samples deletes by query with a refresh, which ES_PEOPLE_API_KEY cannot do.');
  process.exit(1);
}

const args = process.argv.slice(2);
let slug = null;
let limit = Infinity;
let fileArg = null;
let label = null;
let removeOnly = false;
const talkArgs = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--event') slug = args[++i];
  else if (args[i] === '--talk') talkArgs.push(args[++i]);
  else if (args[i] === '--limit') limit = Number(args[++i]);
  else if (args[i] === '--file') fileArg = args[++i];
  else if (args[i] === '--label') label = args[++i];
  else if (args[i] === '--remove') removeOnly = true;
  else {
    console.error(`Unknown argument: ${args[i]}`);
    process.exit(1);
  }
}
if (!slug || !/^[a-z0-9][a-z0-9-]{0,119}$/.test(slug) || !(limit > 0) || (label !== null && !/^[a-z0-9]{1,8}$/.test(label)) || (fileArg !== null && !fileArg) || (removeOnly && !label)) {
  console.error('Usage: node scripts/seed-people.mjs --event <slug> [--talk "<title>"]... [--limit n] [--file <path> --label <tag>] | --label <tag> --remove');
  process.exit(1);
}

async function es(key, method, p, body, ndjson = false) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(ES_URL + p, {
      method,
      headers: { Authorization: `ApiKey ${key}`, 'Content-Type': ndjson ? 'application/x-ndjson' : 'application/json' },
      body: body === undefined ? undefined : ndjson ? body : JSON.stringify(body),
      signal: AbortSignal.timeout(120_000),
    });
    if (res.status === 429 && attempt < 5) {
      await res.body?.cancel();
      await new Promise((r) => setTimeout(r, 2000 * 2 ** attempt));
      continue;
    }
    const text = await res.text();
    let json;
    try { json = text ? JSON.parse(text) : {}; } catch { json = {}; }
    if (!res.ok) {
      console.error(`${method} ${p.split('?')[0]} failed with status ${res.status}: ${json.error?.type ?? ''} ${json.error?.reason ?? ''}`);
      process.exit(1);
    }
    return json;
  }
}
const read = (method, p, body) => es(READ_KEY, method, p, body);
const write = (method, p, body, ndjson) => es(WRITE_KEY, method, p, body, ndjson);
const admin = (method, p, body) => es(ADMIN_KEY, method, p, body);
const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim().toLowerCase();

const file = fileArg ? path.resolve(fileArg) : path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data', 'samples', 'people.json');
const LABEL_PREFIX = label ? `lbl-${label}-` : null;
const samples = JSON.parse(fs.readFileSync(file, 'utf8'));

// The conference and its last visible instant.
const confHits = await read('POST', `/${CONFERENCES_INDEX}/_search`, { size: 1, query: { term: { slug } } });
const conf = confHits.hits?.hits?.[0]?._source;
if (!conf?.end_date) {
  console.error(`Conference ${slug} was not found in ${CONFERENCES_INDEX}.`);
  process.exit(1);
}
const until = visibleUntil(conf.end_date, conf.time_zone);
if (Date.parse(until) <= Date.now()) {
  console.error(`Conference ${slug} has ended; samples would never be visible.`);
  process.exit(1);
}

// Topic labels to topic ids.
const topicHits = await read('POST', `/${TOPICS_INDEX}/_search`, {
  size: 1000, _source: ['topic_id', 'label', 'aliases'], query: { term: { conference: slug } },
});
const byLabel = new Map();
for (const h of topicHits.hits?.hits ?? []) {
  const t = h._source ?? {};
  if (!t.topic_id) continue;
  byLabel.set(norm(t.label), t.topic_id);
  byLabel.set(norm(t.topic_id), t.topic_id);
  for (const a of [].concat(t.aliases ?? [])) if (!byLabel.has(norm(a))) byLabel.set(norm(a), t.topic_id);
}
const knownIds = new Set([...byLabel.values()]);
const unresolved = new Set();
const keepKnownIds = (ids) => [...new Set(ids ?? [])].filter((id) => {
  if (knownIds.has(id)) return true;
  unresolved.add(id);
  return false;
});
const resolveTopics = (labels) => {
  const ids = [];
  for (const label of labels ?? []) {
    const id = byLabel.get(norm(label)) ?? byLabel.get(norm(label).replace(/\s+/g, '-'));
    if (id) { if (!ids.includes(id)) ids.push(id); } else unresolved.add(label);
  }
  return ids;
};

// Shared talk titles to talk ids.
const titles = talkArgs.length ? talkArgs : samples.shared_talks ?? [];
const talkIds = [];
for (const title of titles) {
  const res = await read('POST', `/${TALKS_INDEX}/_search`, {
    size: 5,
    _source: ['talk_id', 'title'],
    query: { bool: { filter: [{ term: { conference: slug } }, { term: { kind: 'talk' } }], must: [{ match_phrase: { title } }] } },
  });
  const hits = res.hits?.hits ?? [];
  const exact = hits.find((h) => norm(h._source?.title) === norm(title)) ?? hits[0];
  if (exact) {
    talkIds.push(exact._source?.talk_id ?? exact._id);
    console.log(`Shared talk: ${exact._source?.title}`);
  } else {
    talkIds.push(null);
    console.warn(`Warning: no talk titled "${title}" in ${slug}; profiles sharing for it skip it.`);
  }
}

// Remove the previous samples of this conference: those with this label, or, without a label,
// those that carry no label prefix.
const sameKind = { bool: { filter: [{ term: { event_id: slug } }, { term: { sample: true } }] } };
if (LABEL_PREFIX) sameKind.bool.filter.push({ prefix: { profile_id: LABEL_PREFIX } });
else sameKind.bool.must_not = [{ prefix: { profile_id: 'lbl-' } }];
const deleted = await admin('POST', `/${PEOPLE_INDEX}/_delete_by_query?refresh=true`, { query: sameKind });
console.log(`Deleted ${deleted.deleted ?? 0} previous ${label ? `"${label}" ` : ''}samples.`);
if (removeOnly) process.exit(0);

const now = new Date().toISOString();
const docs = [];
for (const p of samples.profiles.slice(0, limit)) {
  const name = p.display_name.startsWith(SAMPLE_PREFIX) ? p.display_name : SAMPLE_PREFIX + p.display_name;
  const shared = [...new Set([...(p.share ?? []).map((i) => talkIds[i]), ...(p.shared_talk_ids ?? [])].filter(Boolean))].slice(0, 50);
  const linkedin = p.linkedin_url ?? null;
  if (linkedin !== null && !LINKEDIN_RE.test(linkedin)) {
    console.error(`${name}: linkedin_url does not pass the server's pattern.`);
    process.exit(1);
  }
  if (!p.open_to_meet && !shared.length) {
    console.warn(`Warning: ${name} would be neither visible nor sharing; skipped.`);
    continue;
  }
  const device = newDevice();
  if (LABEL_PREFIX) device.profileId = (LABEL_PREFIX + device.profileId).slice(0, 22);
  const text = { about: p.about ?? '', interests: p.interests ?? '', expertise: p.expertise ?? '' };
  docs.push({
    _id: `${slug}:${device.profileId}`,
    doc: {
      event_id: slug,
      profile_id: device.profileId,
      ref: refFor(slug, device.profileId),
      display_name: name,
      ...text,
      learn_topics: (p.learn_ids ? keepKnownIds(p.learn_ids) : resolveTopics(p.learn)).slice(0, 30),
      speak_topics: (p.speak_ids ? keepKnownIds(p.speak_ids) : resolveTopics(p.speak)).slice(0, 30),
      open_to_meet: p.open_to_meet === true,
      sample: true,
      shared_talk_ids: shared,
      visible_until: until,
      updated_at: now,
      linkedin_url: linkedin,
      contact_note: String(p.contact_note ?? CONTACT_NOTE).slice(0, 120),
      secret_hash: hashSecret(device.secret),
      text_hash: textHash(text),
    },
  });
}
for (const label of unresolved) console.warn(`Warning: topic "${label}" is not a topic of ${slug}; skipped.`);

let written = 0;
for (let i = 0; i < docs.length; i += BATCH) {
  const body = docs.slice(i, i + BATCH).map((d) => `${JSON.stringify({ create: { _id: d._id } })}\n${JSON.stringify(d.doc)}\n`).join('');
  const res = await write('POST', `/${PEOPLE_INDEX}/_bulk?refresh=wait_for`, body, true);
  for (const item of res.items ?? []) {
    const r = item.create ?? {};
    if (r.status >= 200 && r.status < 300) written++;
    else console.error(`A sample failed to index: ${r.error?.type ?? r.status}`);
  }
}

if (!talkIds.length) {
  const counts = new Map();
  for (const d of docs) for (const id of d.doc.shared_talk_ids) counts.set(id, (counts.get(id) ?? 0) + 1);
  console.log(`Wrote ${written} of ${docs.length} samples for ${slug}, visible until ${until}.`);
  console.log(`Visible conference-wide: ${docs.filter((d) => d.doc.open_to_meet).length}. Distinct shared talks: ${counts.size}.`);
  if (written !== docs.length) process.exit(2);
  process.exit(0);
}
const perTalk = talkIds.map((id, i) => `${titles[i]}: ${id ? docs.filter((d) => d.doc.shared_talk_ids.includes(id)).length : 0}`);
console.log(`Wrote ${written} of ${docs.length} samples for ${slug}, visible until ${until}.`);
console.log(`Visible conference-wide: ${docs.filter((d) => d.doc.open_to_meet).length}. Sharing per talk:`);
for (const line of perTalk) console.log(`  ${line}`);
if (written !== docs.length) process.exit(2);
