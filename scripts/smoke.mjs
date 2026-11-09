// End-to-end smoke test for the API and the built web bundle.
//
// Usage: BASE_URL=http://localhost:8080 node scripts/smoke.mjs
//
// Env:
//   BASE_URL             default http://localhost:8080.
//   SMOKE_CONFERENCE     the primary conference, default kubecon-cloudnativecon-north-america-2026.
//   SMOKE_EXTRA          comma-separated extra conferences, default
//                        mcp-dev-summit-nairobi-2026,pytorch-day-japan-2026.
//   SMOKE_SKIP_BUNDLE=1  skip the bundle scan when web/dist has not been built.
//   SMOKE_SKIP_EXTERNAL=1 skip the one GET of an unavailable conference's official schedule link.
//   ES_URL and ES_PEOPLE_API_KEY (or ELASTISEARCH_API_KEY): used only to write and remove one
//                        expired test profile directly, because the API can never create one, and to
//                        age one test profile's presence, because the API can never set it in the
//                        past. Without a key those two checks are skipped.
//
// The script creates its own temporary test profiles, each with a random device secret, and
// deletes them at the end, together with the blocks and meets they made. It never changes the
// seeded sample profiles. Key values are compared in-process and never printed.
//
// Each check prints one PASS, FAIL or SKIP line. The script exits 1 if any check fails.

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

const BASE_URL = (process.env.BASE_URL || 'http://localhost:8080').replace(/\/$/, '');
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const REQUEST_TIMEOUT_MS = 30000;
const PRIMARY = process.env.SMOKE_CONFERENCE || 'kubecon-cloudnativecon-north-america-2026';
const EXTRA = (process.env.SMOKE_EXTRA ?? 'mcp-dev-summit-nairobi-2026,pytorch-day-japan-2026').split(',').map((s) => s.trim()).filter(Boolean);
const ES_URL = (process.env.ES_URL || 'https://fc875c88f9f44f159f1a359ee724d82b.us-west1.gcp.cloud.es.io:443').replace(/\/$/, '');
const ES_WRITE_KEY = process.env.ES_PEOPLE_API_KEY || process.env.ELASTISEARCH_API_KEY || '';
const PEOPLE_INDEX = process.env.ES_PEOPLE_INDEX || 'caddie-people';

// Attendee-style queries and the talk each one should surface in the top five. The first three
// share no useful words with their talk's title or abstract, so they pass only through semantic
// matching; the last two are paraphrases that lexical and semantic matching both support.
const QUERIES = [
  { query: 'making my cluster greener and using less energy', title: 'Monitoring Power at Planet Scale with Kepler' },
  { query: 'supporting autistic and ADHD colleagues on my team', title: 'Neurodivergent Minds with Wings: Engineering Independence at Work' },
  { query: 'a personal fitness trainer bot for marathon training', title: 'I Built an AI Running Coach: A Personal kagent Agent in Production' },
  { query: 'what does each LLM token cost me', title: 'Clueless About The Cost of AI Model Usage? OpenCost+llm-d = first of a kind inference cost tracking' },
  { query: 'how do I start contributing to the kubernetes project', title: 'Kubernetes 101: New Contributor Orientation' },
];

// Queries that would surface schedule filler if non-talk items leaked into search.
const NON_TALK_QUERIES = ['lunch', 'coffee break', 'registration', 'opening remarks', 'closing', 'keynote welcome'];

// A talk that the seeded samples share for, used as the test circle.
const CIRCLE_TALK_TITLE = 'From Bytes to Traces: A Deep Dive into OpenTelemetry eBPF Instrumentation Internals';

// Topics the test profiles use. The requester wants to learn all three, and exactly one test
// profile can speak to all three, which no sample does.
const LEARN = ['ebpf', 'gpu', 'llm'];

// Find & connect. The passage is specific enough that its author ranks first for the query, and
// the common topic is the one everyone at this conference matches on.
const FIND_PASSAGE = 'ran Postgres operators on bare metal for three years and debugged WAL corruption after a power cut';
const FIND_QUERY = 'postgres operators on bare metal';
const COMMON_TOPIC = 'kubernetes';
const ZONE_A = 'Registration';
const ZONE_F = 'Expo hall';
const WORDLIST = JSON.parse(readFileSync(join(ROOT, 'config', 'moderation-words.json'), 'utf8')).words ?? [];

const BUNDLE_SECRET_VARS = ['ELASTISEARCH_API_KEY', 'GC_API_KEY', 'ES_READONLY_KEY', 'ES_PEOPLE_API_KEY'];
const BUNDLE_PATTERNS = ['ApiKey ', '.es.io', 'AIza', 'BEGIN PRIVATE KEY', 'MOCK_FIXTURE_DO_NOT_SHIP'];

// Wording that must never appear in a response the app generates.
const SCHEDULING_WORDS = /clash|conflict|agenda/i;

let failures = 0;
function report(ok, name, detail = '') {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`);
}
function skip(name, why) {
  console.log(`SKIP ${name} (${why})`);
}
async function check(name, fn) {
  try {
    await fn();
  } catch (err) {
    report(false, name, err.message);
  }
}

// Every response seen, with a label naming who asked, for the leak checks at the end.
const responses = [];
// Every search result seen, for the evidence check.
const allResults = [];

async function api(method, path, body, { device, label = '', origin } = {}) {
  let lastError;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const headers = {};
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      if (device) headers['X-Caddie-Device'] = `${device.profileId}.${device.secret}`;
      if (origin) headers.Origin = origin;
      const res = await fetch(`${BASE_URL}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      const text = await res.text();
      if (res.status >= 500 && attempt === 0) {
        lastError = new Error(`status ${res.status}`);
        continue;
      }
      let json = {};
      try {
        json = JSON.parse(text);
      } catch {
        /* keep {} */
      }
      responses.push({ path, label, status: res.status, text, json });
      return { status: res.status, json, headers: res.headers };
    } catch (err) {
      lastError = err;
    }
  }
  throw new Error(`${method} ${path} failed: ${lastError?.message ?? 'unknown error'}`);
}

async function search(body) {
  const r = await api('POST', '/api/search', { conference: PRIMARY, ...body });
  if (r.status === 200) allResults.push(...(r.json.results ?? []));
  return r;
}

const readNdjson = (slug) => {
  const file = join(ROOT, 'data', slug, 'talks.ndjson');
  return readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
};

// The UTC offset of a zone at an instant, as "+03:00", through Intl.
function offsetAt(iso, timeZone) {
  const ms = Date.parse(iso);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(ms));
  const get = (t) => Number(parts.find((p) => p.type === t).value);
  const local = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  const mins = Math.round((local - ms) / 60000);
  const sign = mins < 0 ? '-' : '+';
  const abs = Math.abs(mins);
  return `${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
}

function newDevice() {
  return { profileId: crypto.randomBytes(16).toString('base64url'), secret: crypto.randomBytes(32).toString('base64url') };
}

const runTag = crypto.randomBytes(4).toString('hex');
const testName = (who) => `Smoke test ${who} ${runTag}`;
const contactMarker = (who) => `smoke-contact-${who}-${runTag}`;

function profileBody(event, who, { learn = [], speak = [], interests = '', expertise = '' } = {}) {
  return {
    display_name: testName(who),
    about: '',
    interests,
    expertise,
    learn_topics: learn,
    speak_topics: speak,
    linkedin_url: null,
    contact_note: contactMarker(who),
  };
}

// Test profiles created in this run, so they can be removed at the end.
const created = []; // { device, event }
async function putProfile(device, event, who, opts, { open = false, shared = [] } = {}) {
  const r = await api('PUT', '/api/people/profile', { event, profile: profileBody(event, who, opts), open_to_meet: open, shared_talk_ids: shared }, { device, label: `${who}-put` });
  if (r.status === 200 && !created.some((c) => c.device === device && c.event === event)) created.push({ device, event });
  return r;
}

const names = (results) => (results ?? []).map((p) => p.display_name);

// ---------------------------------------------------------------------------------------------
// Conferences.

let conferences = [];
await check('conf: GET /api/conferences lists the conferences', async () => {
  const { status, json } = await api('GET', '/api/conferences');
  if (status !== 200) throw new Error(`status ${status}`);
  conferences = json.conferences ?? [];
  const searchable = conferences.filter((c) => c.status === 'searchable').map((c) => c.slug);
  const missing = [PRIMARY, ...EXTRA].filter((s) => !searchable.includes(s));
  const leakedKeys = conferences.flatMap((c) => Object.keys(c)).filter((k) => /sessionize|lf_event_id|status_reason|counts|hash/.test(k));
  report(missing.length === 0 && leakedKeys.length === 0, 'conf: GET /api/conferences lists the searchable conferences and no internal fields',
    missing.length ? `not searchable: ${missing.join(', ')}` : leakedKeys.length ? `internal keys: ${[...new Set(leakedKeys)].join(', ')}` : `${searchable.length} searchable, ${conferences.length - searchable.length} unavailable`);
});
const confBySlug = new Map(conferences.map((c) => [c.slug, c]));

// ---------------------------------------------------------------------------------------------
// KubeCon search checks from the MVP, now with a conference.

let firstTopResult = null;
for (const [i, { query, title }] of QUERIES.entries()) {
  await check(`a${i + 1}: "${query}" has its expected talk in the top five`, async () => {
    const { status, json } = await search({ query, size: 10 });
    if (status !== 200) throw new Error(`status ${status}`);
    const top = (json.results ?? []).slice(0, 5).map((r) => r.title);
    const rank = top.indexOf(title);
    if (i === 0) firstTopResult = json.results?.[0] ?? null;
    report(rank !== -1, `a${i + 1}: "${query}" has its expected talk in the top five`, rank !== -1 ? `rank ${rank + 1}` : `expected "${title}"`);
  });
}

// c. saved_talk_ids is still accepted but no longer filters anything. Ties in semantic ranking
// can reorder equal scores between two identical requests, so text queries compare totals and
// the browse listing, which is sorted by time, compares the exact order.
await check('c: saved_talk_ids no longer filters results', async () => {
  if (!firstTopResult) throw new Error('query 1 returned no results');
  const saved = firstTopResult;
  const problems = [];
  for (const body of [...QUERIES.map(({ query }) => ({ query, size: 50 })), { query: '', size: 50 }]) {
    const plain = await search(body);
    const withSaved = await search({ ...body, saved_talk_ids: [saved.talk_id] });
    if (plain.status !== 200 || withSaved.status !== 200) throw new Error(`status ${plain.status}/${withSaved.status}`);
    if (plain.json.total !== withSaved.json.total) problems.push(`${body.query || 'browse'} total changed`);
    if (!body.query) {
      const a = (plain.json.results ?? []).map((r) => r.talk_id).join(',');
      const b = (withSaved.json.results ?? []).map((r) => r.talk_id).join(',');
      if (a !== b) problems.push('browse order changed');
    }
  }
  const again = await search({ query: QUERIES[0].query, size: 10, saved_talk_ids: [saved.talk_id] });
  if (!(again.json.results ?? []).some((r) => r.talk_id === saved.talk_id)) problems.push('the saved talk itself was removed');
  const bare = await search({ query: 'kubernetes', saved_talk_ids: ['1234567'] });
  if (bare.status !== 400) problems.push(`a bare saved id gave ${bare.status}, not 400`);
  report(problems.length === 0, 'c: saved_talk_ids no longer filters results', problems.length ? problems.join('; ') : `6 queries identical with and without "${saved.title}" saved`);
});

// d. No break, housekeeping or ambient item is ever returned.
await check('d: no break, housekeeping or ambient item appears', async () => {
  const nonTalk = new Map(readNdjson(PRIMARY).filter((d) => d.kind !== 'talk').map((d) => [d.talk_id, d]));
  const browse = await search({ query: '', size: 1 });
  if (browse.status !== 200) throw new Error(`status ${browse.status}`);
  const days = (browse.json.facets?.day ?? []).map((f) => f.value);
  if (!days.length) throw new Error('no day facet values');
  const requests = [...NON_TALK_QUERIES.map((query) => ({ query, size: 50 })), ...days.map((day) => ({ query: '', size: 50, filters: { day } }))];
  const leaked = [];
  for (const body of requests) {
    const { status, json } = await search(body);
    if (status !== 200) throw new Error(`status ${status}`);
    for (const r of json.results ?? []) if (nonTalk.has(r.talk_id)) leaked.push(`${nonTalk.get(r.talk_id).kind} "${r.title}"`);
  }
  report(leaked.length === 0, 'd: no break, housekeeping or ambient item appears', leaked.length ? leaked.slice(0, 3).join('; ') : `${requests.length} requests, ${nonTalk.size} non-talk items checked`);
});

await check('f: an unknown filter value returns 400', async () => {
  const { status } = await search({ query: 'kubernetes', filters: { track: ['No Such Track'] } });
  report(status === 400, 'f: an unknown filter value returns 400', `status ${status}`);
});

await check('f2: a search without a conference, or for an unknown one, returns 400', async () => {
  const none = await api('POST', '/api/search', { query: 'kubernetes' });
  const unknown = await api('POST', '/api/search', { conference: 'no-such-conference-2026', query: 'kubernetes' });
  report(none.status === 400 && unknown.status === 400, 'f2: a search without a conference, or for an unknown one, returns 400', `status ${none.status} and ${unknown.status}`);
});

// ---------------------------------------------------------------------------------------------
// The smaller events: own talks only, own categories, own time zone.

const ownTalks = new Map(); // slug -> Set of kind:talk ids
for (const slug of [PRIMARY, ...EXTRA]) {
  try {
    ownTalks.set(slug, new Set(readNdjson(slug).filter((d) => d.kind === 'talk').map((d) => d.talk_id)));
  } catch {
    ownTalks.set(slug, new Set());
  }
}

for (const slug of [PRIMARY, ...EXTRA]) {
  await check(`x: ${slug} returns only its own talks, chips and time zone`, async () => {
    const conf = confBySlug.get(slug);
    if (!conf) throw new Error('not listed in /api/conferences');
    const docs = readNdjson(slug).filter((d) => d.kind === 'talk');
    const own = ownTalks.get(slug);
    const ownTracks = new Set(docs.map((d) => d.track));
    const ownTagGroups = new Set(docs.flatMap((d) => (d.tags ?? []).map((t) => t.group)));
    const problems = [];
    const queries = ['', 'agents', 'kubernetes', 'pytorch training', 'security'];
    let checked = 0;
    for (const query of queries) {
      const { status, json } = await api('POST', '/api/search', { conference: slug, query, size: 50 });
      if (status !== 200) throw new Error(`status ${status} for "${query}"`);
      allResults.push(...(json.results ?? []));
      if (query === '' && json.total !== own.size) problems.push(`browse total ${json.total}, expected ${own.size}`);
      for (const r of json.results ?? []) {
        checked++;
        if (!own.has(r.talk_id) || r.conference !== slug) problems.push(`foreign talk "${r.title}"`);
        const expected = offsetAt(r.start, conf.time_zone);
        if (!r.start.endsWith(expected)) problems.push(`"${r.title}" starts ${r.start}, expected offset ${expected}`);
      }
      const f = json.facets ?? {};
      for (const b of f.track ?? []) if (!ownTracks.has(b.value)) problems.push(`track chip "${b.value}" is not this event's`);
      for (const g of f.tags ?? []) if (!conf.tag_groups.includes(g.group)) problems.push(`tag group "${g.group}" is not this event's`);
      for (const g of f.tags ?? []) for (const v of g.values) if (v.count > 0 && !ownTagGroups.has(g.group)) problems.push(`tag "${v.value}" is not this event's`);
      if (Boolean(f.level) !== Boolean(conf.has_level)) problems.push(`level facet ${f.level ? 'present' : 'absent'} but has_level is ${conf.has_level}`);
      const facetTotal = (f.has_slides ?? []).reduce((n, b) => n + b.count, 0);
      if (facetTotal !== json.total) problems.push(`has_slides facet sums to ${facetTotal}, total ${json.total}`);
    }
    const unique = [...new Set(problems)];
    report(unique.length === 0, `x: ${slug} returns only its own talks, chips and time zone`, unique.length ? unique.slice(0, 3).join('; ') : `${checked} results in ${conf.time_zone}, ${ownTracks.size} own tracks`);
  });
}

await check('u: a conference that is not on Sessionize is listed as not searchable with a working link', async () => {
  const unavailable = conferences.filter((c) => c.status === 'unavailable');
  if (!unavailable.length) throw new Error('no unavailable conference is listed');
  const c = unavailable[0];
  const problems = [];
  if (!/^https:\/\//.test(c.official_schedule_url ?? '')) problems.push('no https official_schedule_url');
  const s = await api('POST', '/api/search', { conference: c.slug, query: '' });
  if (s.status !== 400) problems.push(`search gave ${s.status}, not 400`);
  if (process.env.SMOKE_SKIP_EXTERNAL === '1') {
    skip('u2: the official schedule link responds', 'SMOKE_SKIP_EXTERNAL=1');
  } else if (!problems.length) {
    const res = await fetch(c.official_schedule_url, { method: 'GET', redirect: 'follow', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS), headers: { 'User-Agent': 'ConferenceCaddie-smoke/0.2' } });
    await res.body?.cancel();
    if (!res.ok) problems.push(`the official link gave ${res.status}`);
  }
  report(problems.length === 0, 'u: a conference that is not on Sessionize is listed as not searchable with a working link', problems.length ? problems.join('; ') : `${c.name}, ${unavailable.length} unavailable in total`);
});

// ---------------------------------------------------------------------------------------------
// Offline schedule export.

const SCHEDULE_KEYS = ['talk_id', 'conference', 'title', 'speakers', 'room', 'start', 'end', 'track', 'level', 'tags', 'topics', 'url', 'slides_url', 'abstract'].sort().join(',');
await check('o: /api/schedule returns only that conference\'s talks, with no other kinds and no people fields', async () => {
  const problems = [];
  let count = 0;
  for (const slug of [PRIMARY, ...EXTRA]) {
    const r = await api('GET', `/api/schedule?event=${encodeURIComponent(slug)}`);
    if (r.status !== 200) {
      problems.push(`${slug} gave ${r.status}`);
      continue;
    }
    if (!/max-age=300/.test(r.headers.get('cache-control') ?? '')) problems.push(`${slug} has Cache-Control "${r.headers.get('cache-control')}"`);
    const own = ownTalks.get(slug);
    const talks = r.json.talks ?? [];
    count += talks.length;
    if (r.json.conference !== slug) problems.push(`${slug} names conference ${r.json.conference}`);
    if (talks.length !== own.size) problems.push(`${slug} has ${talks.length} talks, expected ${own.size} of kind talk`);
    for (const t of talks) {
      if (!own.has(t.talk_id) || t.conference !== slug) problems.push(`${slug} has "${t.title}", which is not one of its talks`);
      const keys = Object.keys(t).sort().join(',');
      if (keys !== SCHEDULE_KEYS) problems.push(`${slug} talk keys are ${keys}`);
      if (typeof t.abstract !== 'string' || t.abstract.length > 410) problems.push(`${slug} "${t.title}" abstract is not trimmed`);
    }
    if (/display_name|learn_topics|speak_topics|linkedin_url|contact_note|open_to_meet|shared_talk_ids|secret_hash|"kind"/.test(JSON.stringify(r.json))) {
      problems.push(`${slug} holds a people field or a kind`);
    }
  }
  const unknown = await api('GET', '/api/schedule?event=no-such-conference-anywhere');
  if (unknown.status !== 400) problems.push(`an unknown slug gave ${unknown.status}`);
  const unavailable = conferences.find((c) => c.status === 'unavailable');
  if (unavailable) {
    const u = await api('GET', `/api/schedule?event=${encodeURIComponent(unavailable.slug)}`);
    if (u.status !== 400) problems.push(`an unavailable conference gave ${u.status}`);
  }
  const unique = [...new Set(problems)];
  report(unique.length === 0, 'o: /api/schedule returns only that conference\'s talks, with no other kinds and no people fields', unique.length ? unique.slice(0, 3).join('; ') : `${count} talks in ${1 + EXTRA.length} conferences`);
});

// ---------------------------------------------------------------------------------------------
// Topics.

const stoplist = readFileSync(join(ROOT, 'config', 'topic-stoplist.txt'), 'utf8').split('\n').map((s) => s.trim().toLowerCase()).filter(Boolean);
const topicsBySlug = new Map();
for (const slug of [PRIMARY, ...EXTRA]) {
  const { status, json } = await api('GET', `/api/topics?event=${encodeURIComponent(slug)}&size=150`);
  topicsBySlug.set(slug, status === 200 ? json.topics ?? [] : []);
}

await check('t: the topic list has Kubernetes, eBPF, a two-word topic and no filler', async () => {
  const topics = topicsBySlug.get(PRIMARY) ?? [];
  const labels = topics.map((t) => t.label);
  const problems = [];
  for (const want of ['Kubernetes', 'eBPF']) if (!labels.includes(want)) problems.push(`no "${want}"`);
  const twoWord = topics.find((t) => t.label.trim().split(/\s+/).length === 2);
  if (!twoWord) problems.push('no two-word topic');
  for (const t of topics) {
    const words = t.topic_id.split('-');
    const bad = words.filter((w) => stoplist.includes(w) || /^\d+$/.test(w) || w.length < 2);
    if (bad.length) problems.push(`"${t.label}" holds filler "${bad.join(' ')}"`);
  }
  if (topics.length > 150) problems.push(`${topics.length} topics, more than 150`);
  report(problems.length === 0, 't: the topic list has Kubernetes, eBPF, a two-word topic and no filler', problems.length ? problems.slice(0, 4).join('; ') : `${topics.length} topics, for example "${twoWord.label}"`);
});

await check('t2: topics do not cross conferences', async () => {
  const problems = [];
  const primaryIds = new Set((topicsBySlug.get(PRIMARY) ?? []).map((t) => t.topic_id));
  for (const slug of EXTRA) {
    const topics = topicsBySlug.get(slug) ?? [];
    if (!topics.length) problems.push(`${slug} has no topics`);
    if (topics.some((t) => t.topic_id === 'kubernetes')) problems.push(`${slug} lists Kubernetes`);
    for (const t of topics) if (t.talk_count > ownTalks.get(slug).size) problems.push(`${slug} "${t.label}" counts ${t.talk_count} talks`);
    const prefix = await api('GET', `/api/topics?event=${encodeURIComponent(slug)}&q=kube`);
    if ((prefix.json.topics ?? []).some((t) => t.topic_id === 'kubernetes')) problems.push(`${slug} type-ahead finds Kubernetes`);
  }
  const mcp = (topicsBySlug.get(EXTRA[0]) ?? []).find((t) => !primaryIds.has(t.topic_id));
  report(problems.length === 0, 't2: topics do not cross conferences', problems.length ? problems.join('; ') : mcp ? `${EXTRA[0]} has "${mcp.label}", which ${PRIMARY} does not` : 'checked');
});

await check('t3: type-ahead and suggestions return topics with talk counts', async () => {
  const { status, json } = await api('GET', `/api/topics?event=${encodeURIComponent(PRIMARY)}&q=kube`);
  const sug = await api('POST', '/api/topics/suggest', { event: PRIMARY, talk_ids: [], text: 'eBPF and GPU scheduling' });
  const ok = status === 200 && (json.topics ?? []).some((t) => t.label === 'Kubernetes' && t.talk_count > 0)
    && sug.status === 200 && (sug.json.topics ?? []).some((t) => t.topic_id === 'ebpf');
  report(ok, 't3: type-ahead and suggestions return topics with talk counts', `type-ahead ${status}, suggest ${sug.status}`);
});

// ---------------------------------------------------------------------------------------------
// People, circles and talks for you. Every test profile is created here and deleted at the end.

const A = newDevice(); // the requester: chips only, visible, shares for the circle talk
const B = newDevice(); // can speak to everything A wants to learn, visible
const C = newDevice(); // can speak to the same, but only shares for the circle talk
const D = newDevice(); // visible at another conference, with the same topics where possible
const N = newDevice(); // visible, but never shares for the circle talk
const F = newDevice(); // Find & connect: the person with the specific passage, can speak to LEARN
const K = newDevice(); // Find & connect: shares only the common topic with A, no text
const X = newDevice(); // Find & connect: never gets a profile
const R = newDevice(); // Report: visible and in the circle, reported by A and B
const spotMarker = `smoke-spot-${runTag}`;
const expiredId = `${PRIMARY}:${crypto.randomBytes(16).toString('base64url')}`;
let expiredWritten = false;
let circleTalk = null;

try {
  await check('p0: the circle talk is found', async () => {
    const { json } = await search({ query: CIRCLE_TALK_TITLE, size: 5 });
    circleTalk = (json.results ?? []).find((r) => r.title === CIRCLE_TALK_TITLE) ?? null;
    report(Boolean(circleTalk), 'p0: the circle talk is found', circleTalk ? 'found' : 'not found');
  });
  if (!circleTalk) throw new Error('the circle talk is missing, so the people checks cannot run');
  const T = circleTalk.talk_id;

  const countOf = async () => (await api('POST', '/api/circles/counts', { event: PRIMARY, talk_ids: [T] }, { label: 'public-counts' })).json.counts?.[T];
  const countBefore = await countOf();

  await check('p1: test profiles are created', async () => {
    const results = [
      await putProfile(A, PRIMARY, 'A', { learn: LEARN, speak: ['kubernetes'] }, { open: true, shared: [T] }),
      await putProfile(B, PRIMARY, 'B', { speak: LEARN, learn: ['kubernetes'] }, { open: true }),
      await putProfile(C, PRIMARY, 'C', { speak: LEARN }, { open: false, shared: [T] }),
      await putProfile(N, PRIMARY, 'N', { speak: ['kubernetes'] }, { open: true }),
    ];
    const extraTopics = (topicsBySlug.get(EXTRA[0]) ?? []).slice(0, 3).map((t) => t.topic_id);
    results.push(await putProfile(D, EXTRA[0], 'D', { speak: extraTopics, learn: extraTopics }, { open: true }));
    const statuses = results.map((r) => r.status);
    report(statuses.every((s) => s === 200), 'p1: test profiles are created', statuses.join(','));
  });

  // The expired profile is written straight to Elasticsearch, because the API always sets
  // visible_until to the end of the conference.
  if (ES_WRITE_KEY) {
    const res = await fetch(`${ES_URL}/${encodeURIComponent(PEOPLE_INDEX)}/_doc/${encodeURIComponent(expiredId)}?refresh=wait_for`, {
      method: 'PUT',
      headers: { Authorization: `ApiKey ${ES_WRITE_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        event_id: PRIMARY,
        profile_id: expiredId.split(':')[1],
        display_name: testName('Expired'),
        about: '', interests: '', expertise: '',
        learn_topics: LEARN, speak_topics: LEARN,
        open_to_meet: true, sample: false,
        shared_talk_ids: [T],
        visible_until: new Date(Date.now() - 3600_000).toISOString(),
        updated_at: new Date().toISOString(),
        linkedin_url: null, contact_note: contactMarker('Expired'),
        secret_hash: crypto.randomBytes(32).toString('hex'), text_hash: '',
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    await res.body?.cancel();
    expiredWritten = res.ok;
    if (!res.ok) report(false, 'p1b: the expired test profile is written', `status ${res.status}`);
  }

  let matchesA = null;
  await check('p2: wanting to learn a topic ranks a person who can speak to it near the top', async () => {
    const { status, json } = await api('POST', '/api/people/matches', { event: PRIMARY, interested_talk_ids: [T] }, { device: A, label: 'A-matches' });
    if (status !== 200) throw new Error(`status ${status}`);
    matchesA = json.results ?? [];
    const rank = names(matchesA).indexOf(testName('B'));
    const b = matchesA[rank];
    const named = b && b.reasons.some((r) => r.startsWith('They can speak to') && r.includes('eBPF')) && b.opener === b.reasons[0];
    report(rank !== -1 && rank < 5 && named, 'p2: wanting to learn a topic ranks a person who can speak to it near the top', rank === -1 ? 'not returned' : `rank ${rank + 1}, reason "${b.reasons[0]}"`);
  });

  await check('p3: a chips-only profile gets people and talk suggestions', async () => {
    const recs = await api('POST', '/api/recommendations', { event: PRIMARY, learn_topics: LEARN, speak_topics: [], interests: '', expertise: '', interested_talk_ids: [] }, { label: 'recs' });
    const ok = (matchesA?.length ?? 0) > 0 && recs.status === 200 && (recs.json.results ?? []).length > 0;
    report(ok, 'p3: a chips-only profile gets people and talk suggestions', `${matchesA?.length ?? 0} people, ${(recs.json.results ?? []).length} talks`);
  });

  await check('p4: sharing for one talk does not put a profile in conference-wide matches', async () => {
    const ok = matchesA && !names(matchesA).includes(testName('C'));
    report(ok, 'p4: sharing for one talk does not put a profile in conference-wide matches', ok ? `${matchesA.length} matches, C absent` : 'C was returned');
  });

  await check('p5: matches need conference-wide visibility', async () => {
    const r = await api('POST', '/api/people/matches', { event: PRIMARY, interested_talk_ids: [] }, { device: C, label: 'C-matches' });
    report(r.status === 403 && r.json.error === 'visibility_required', 'p5: matches need conference-wide visibility', `status ${r.status}`);
  });

  await check('p6: a circle is returned only to a device that shared for that talk', async () => {
    const shared = await api('POST', '/api/circles/members', { event: PRIMARY, talk_id: T }, { device: A, label: 'A-members' });
    const notShared = await api('POST', '/api/circles/members', { event: PRIMARY, talk_id: T }, { device: N, label: 'N-members' });
    const noDevice = await api('POST', '/api/circles/members', { event: PRIMARY, talk_id: T }, { label: 'anon-members' });
    const count = await countOf();
    const members = shared.json.members ?? [];
    const problems = [];
    if (shared.status !== 200) problems.push(`sharer got ${shared.status}`);
    if (!names(members).includes(testName('C'))) problems.push('C is missing from the circle');
    if (!members.find((m) => m.display_name === testName('C'))?.contact?.contact_note) problems.push('the sharer cannot see C\'s contact');
    if (!(shared.json.speakers ?? []).length) problems.push('the circle lists no speakers');
    if (notShared.status !== 403 || notShared.json.error !== 'share_required' || typeof notShared.json.count !== 'number') problems.push(`non-sharer got ${notShared.status} ${notShared.json.error}`);
    if (notShared.json.members || notShared.json.count === undefined) problems.push('non-sharer saw more than a count');
    if (noDevice.status !== 403) problems.push(`no device got ${noDevice.status}`);
    if (typeof count !== 'number' || count < 2) problems.push(`public count is ${count}`);
    report(problems.length === 0, 'p6: a circle is returned only to a device that shared for that talk', problems.length ? problems.join('; ') : `${members.length} members, ${(shared.json.speakers ?? []).length} speakers, everyone else sees the count ${count}`);
  });

  await check('p7: expired profiles never appear', async () => {
    if (!expiredWritten) {
      skip('p7: expired profiles never appear', 'no Elasticsearch write key in the environment');
      return;
    }
    const m = await api('POST', '/api/people/matches', { event: PRIMARY, interested_talk_ids: [T] }, { device: A, label: 'A-matches' });
    const c = await api('POST', '/api/circles/members', { event: PRIMARY, talk_id: T }, { device: A, label: 'A-members' });
    const count = await countOf();
    const expected = (countBefore ?? 0) + 2; // A and C share for T; the expired profile must not count.
    const problems = [];
    if (names(m.json.results).includes(testName('Expired'))) problems.push('in matches');
    if (names(c.json.members).includes(testName('Expired'))) problems.push('in the circle');
    if (count !== expected) problems.push(`count ${count}, expected ${expected}`);
    report(problems.length === 0, 'p7: expired profiles never appear', problems.length ? problems.join('; ') : 'absent from matches, circle and count');
  });

  await check('p8: people do not cross conferences', async () => {
    const problems = [];
    const allKube = [...names(matchesA)];
    const circle = await api('POST', '/api/circles/members', { event: PRIMARY, talk_id: T }, { device: A, label: 'A-members' });
    allKube.push(...names(circle.json.members));
    if (allKube.includes(testName('D'))) problems.push('a profile of another conference appeared');
    const dm = await api('POST', '/api/people/matches', { event: EXTRA[0], interested_talk_ids: [] }, { device: D, label: 'D-matches' });
    if (dm.status !== 200) problems.push(`other conference matches gave ${dm.status}`);
    const foreign = names(dm.json.results).filter((n) => n.startsWith('Smoke test') || n.startsWith('Sample'));
    if (foreign.length) problems.push(`${foreign.join(', ')} crossed into ${EXTRA[0]}`);
    const am = await api('POST', '/api/people/matches', { event: EXTRA[0], interested_talk_ids: [] }, { device: A, label: 'A-other-matches' });
    if (am.status !== 403) problems.push(`A's matches at ${EXTRA[0]} gave ${am.status}`);
    const wrongTopic = await putProfile(A, PRIMARY, 'A', { learn: ['no-such-topic-xyz'] }, { open: true, shared: [T] });
    if (wrongTopic.status !== 400) problems.push(`an unknown topic gave ${wrongTopic.status}`);
    const otherTalk = [...ownTalks.get(EXTRA[0])][0];
    if (otherTalk) {
      const wrongTalk = await putProfile(A, PRIMARY, 'A', { learn: LEARN, speak: ['kubernetes'] }, { open: true, shared: [T, otherTalk] });
      if (wrongTalk.status !== 400) problems.push(`sharing another conference's talk gave ${wrongTalk.status}`);
    }
    const counts = await api('POST', '/api/circles/counts', { event: EXTRA[0], talk_ids: [T] }, { label: 'public-counts' });
    if ((counts.json.counts?.[T] ?? 0) !== 0) problems.push('a circle count crossed conferences');
    report(problems.length === 0, 'p8: people do not cross conferences', problems.length ? problems.join('; ') : 'checked matches, circles, counts and writes');
  });

  await check('p9: a write or read with the wrong secret is rejected', async () => {
    const wrong = { profileId: A.profileId, secret: crypto.randomBytes(32).toString('base64url') };
    const put = await api('PUT', '/api/people/profile', { event: PRIMARY, profile: profileBody(PRIMARY, 'Intruder', { learn: [] }), open_to_meet: true, shared_talk_ids: [] }, { device: wrong, label: 'wrong-put' });
    const del = await api('DELETE', `/api/people/profile?event=${PRIMARY}`, undefined, { device: wrong, label: 'wrong-delete' });
    const m = await api('POST', '/api/people/matches', { event: PRIMARY, interested_talk_ids: [] }, { device: wrong, label: 'wrong-matches' });
    const c = await api('POST', '/api/circles/members', { event: PRIMARY, talk_id: T }, { device: wrong, label: 'wrong-members' });
    const still = await api('POST', '/api/people/matches', { event: PRIMARY, interested_talk_ids: [] }, { device: A, label: 'A-matches' });
    const statuses = [put.status, del.status, m.status, c.status];
    const ok = statuses.every((s) => s === 403) && still.status === 200;
    report(ok, 'p9: a write or read with the wrong secret is rejected', `${statuses.join(',')}; the real profile still answers ${still.status}`);
  });

  await check('p10: a cross-origin write is rejected', async () => {
    const r = await api('PUT', '/api/people/profile', { event: PRIMARY, profile: profileBody(PRIMARY, 'A', { learn: LEARN }), open_to_meet: true, shared_talk_ids: [T] }, { device: A, origin: 'https://evil.example', label: 'cross-origin' });
    report(r.status === 403, 'p10: a cross-origin write is rejected', `status ${r.status}`);
  });

  // ---------------------------------------------------------------------------------------------
  // Find & connect: search by text, presence, meets and blocks. A is the requester.

  const findMatches = (device, label, extra = {}) => api('POST', '/api/people/matches', { event: PRIMARY, interested_talk_ids: [], query: FIND_QUERY, ...extra }, { device, label });
  const personIn = (r, who) => (r.json.results ?? []).find((p) => p.display_name === testName(who));
  let refF = null;
  let refA = null;

  await check('q1: a specific query ranks the person with the matching passage first and returns it as evidence', async () => {
    const f = await putProfile(F, PRIMARY, 'F', { speak: LEARN, expertise: FIND_PASSAGE }, { open: true });
    const k = await putProfile(K, PRIMARY, 'K', { learn: [COMMON_TOPIC] }, { open: true });
    if (f.status !== 200 || k.status !== 200) throw new Error(`profiles gave ${f.status}/${k.status}`);
    const r = await findMatches(A, 'A-find');
    if (r.status !== 200) throw new Error(`status ${r.status}`);
    const rank = names(r.json.results).indexOf(testName('F'));
    const p = r.json.results?.[rank];
    refF = p?.ref ?? null;
    const problems = [];
    if (rank !== 0) problems.push(rank === -1 ? 'F not returned' : `F at rank ${rank + 1}`);
    if (!p?.evidence || !/postgres/i.test(p.evidence.replace(/<\/?mark>/g, ''))) problems.push(`evidence "${p?.evidence}"`);
    if (!p?.reasons?.[0]?.startsWith("They've worked on")) problems.push(`first reason "${p?.reasons?.[0]}"`);
    if (p && (p.around !== false || p.zone !== null)) problems.push('around or zone set before anyone is around');
    if (r.json.from !== 0 || r.json.size !== 20 || typeof r.json.has_more !== 'boolean') problems.push('paging fields missing');
    report(problems.length === 0, 'q1: a specific query ranks the person with the matching passage first and returns it as evidence', problems.length ? problems.join('; ') : `rank 1, evidence "${p.evidence.slice(0, 60)}"`);
  });

  await check('q2: a result sharing only the common topic is dropped', async () => {
    const plain = await api('POST', '/api/people/matches', { event: PRIMARY, interested_talk_ids: [] }, { device: A, label: 'A-matches' });
    const text = await findMatches(A, 'A-find');
    const problems = [];
    if (plain.status !== 200 || text.status !== 200) throw new Error(`status ${plain.status}/${text.status}`);
    if (names(plain.json.results).includes(testName('K'))) problems.push('K in profile matches');
    if (names(text.json.results).includes(testName('K'))) problems.push('K in text matches');
    if (!names(plain.json.results).includes(testName('F'))) problems.push('F (specific topics) missing from profile matches');
    const whenBad = await api('POST', '/api/people/matches', { event: PRIMARY, interested_talk_ids: [], when: 'soon' }, { device: A, label: 'A-matches' });
    if (whenBad.status !== 400) problems.push(`when=soon gave ${whenBad.status}`);
    report(problems.length === 0, 'q2: a result sharing only the common topic is dropped', problems.length ? problems.join('; ') : `K absent, F present among ${plain.json.results.length}`);
  });

  await check('q3: presence needs a visible profile', async () => {
    const none = await api('PUT', '/api/presence', { event: PRIMARY, zone: ZONE_A, spot: '' }, { device: X, label: 'X-presence' });
    const circleOnly = await api('PUT', '/api/presence', { event: PRIMARY, zone: ZONE_A, spot: '' }, { device: C, label: 'C-presence' });
    const badZone = await api('PUT', '/api/presence', { event: PRIMARY, zone: 'No Such Zone', spot: '' }, { device: A, label: 'A-presence' });
    const ok = none.status === 403 && none.json.error === 'profile_required' && circleOnly.status === 403 && circleOnly.json.error === 'profile_required' && badZone.status === 400;
    report(ok, 'q3: presence needs a visible profile', `no profile ${none.status} ${none.json.error}, circle-only ${circleOnly.status} ${circleOnly.json.error}, unknown zone ${badZone.status}`);
  });

  await check('q4: a listed word is rejected', async () => {
    if (!WORDLIST.length) throw new Error('config/moderation-words.json has no words');
    const word = WORDLIST[0];
    const leet = word.replace(/o/g, '0').replace(/i/g, '1').replace(/e/g, '3').replace(/a/g, '4').replace(/s/g, '5');
    const spot = await api('PUT', '/api/presence', { event: PRIMARY, zone: ZONE_A, spot: `by the ${word} stand` }, { device: A, label: 'A-presence' });
    const leetSpot = await api('PUT', '/api/presence', { event: PRIMARY, zone: ZONE_A, spot: `by the ${leet.toUpperCase()} stand` }, { device: A, label: 'A-presence' });
    const url = await api('PUT', '/api/presence', { event: PRIMARY, zone: ZONE_A, spot: 'see example.com/me' }, { device: A, label: 'A-presence' });
    const linkedin = await api('PUT', '/api/presence', { event: PRIMARY, zone: ZONE_A, spot: 'see linkedin.com/in/me' }, { device: A, label: 'A-presence' });
    const filtered = (r) => r.status === 400 && r.json.error === 'filtered' && r.json.message === 'That was held back by the filter. Edit it and try again.';
    report(filtered(spot) && filtered(leetSpot) && filtered(url) && linkedin.status === 200, 'q4: a listed word is rejected', `word ${spot.status}, leet ${leetSpot.status}, url ${url.status}, linkedin.com ${linkedin.status}`);
  });

  await check('q5: results carry no zone unless both are around', async () => {
    const a = await api('PUT', '/api/presence', { event: PRIMARY, zone: ZONE_A, spot: spotMarker }, { device: A, label: 'A-presence' });
    if (a.status !== 200) throw new Error(`A presence gave ${a.status}`);
    const onlyA = await findMatches(A, 'A-find');
    const f1 = personIn(onlyA, 'F');
    const f = await api('PUT', '/api/presence', { event: PRIMARY, zone: ZONE_F, spot: `${spotMarker}-f` }, { device: F, label: 'F-presence' });
    if (f.status !== 200) throw new Error(`F presence gave ${f.status}`);
    const both = await findMatches(A, 'A-find');
    const f2 = personIn(both, 'F');
    const around = await findMatches(A, 'A-find', { when: 'around_now' });
    // K shares only the common topic with A: absent until K is around in A's own zone, then last
    // in the "around now" view only, labelled with the topic.
    const k = await api('PUT', '/api/presence', { event: PRIMARY, zone: ZONE_A, spot: '' }, { device: K, label: 'K-presence' });
    if (k.status !== 200) throw new Error(`K presence gave ${k.status}`);
    const aroundView = await api('POST', '/api/people/matches', { event: PRIMARY, interested_talk_ids: [], when: 'around_now' }, { device: A, label: 'A-matches' });
    const kView = personIn(aroundView, 'K');
    const anyoneView = await api('POST', '/api/people/matches', { event: PRIMARY, interested_talk_ids: [] }, { device: A, label: 'A-matches' });
    const fromN = await findMatches(N, 'N-find');
    const f3 = personIn(fromN, 'F');
    refA = personIn(await findMatches(F, 'F-find', { query: 'eBPF GPU LLM' }), 'A')?.ref ?? null;
    const problems = [];
    if (!f1 || f1.around !== false || f1.zone !== null) problems.push('F not around yet shows around or a zone');
    if (!f2 || f2.around !== true || f2.zone !== ZONE_F) problems.push(`both around: F around ${f2?.around}, zone ${f2?.zone}`);
    if (f2 && !f2.reasons.includes(`They're in ${ZONE_F} right now.`)) problems.push('no zone reason');
    if (!names(around.json.results).includes(testName('F'))) problems.push('around_now misses F');
    if (names(around.json.results).includes(testName('K'))) problems.push('around_now lists K before K is around');
    const kRank = names(aroundView.json.results).indexOf(testName('K'));
    if (kRank === -1 || kRank !== aroundView.json.results.length - 1) problems.push(`K at rank ${kRank + 1} of ${aroundView.json.results.length} in the around-now view`);
    if (kView && !(kView.broad === true && kView.evidence === null && kView.reasons[0] === 'Also interested in Kubernetes.')) problems.push(`K is labelled ${JSON.stringify(kView.reasons)}`);
    if (names(anyoneView.json.results).includes(testName('K'))) problems.push('K in the anyone view');
    if (!f3 || f3.around !== true || f3.zone !== null) problems.push(`N (not around) sees F zone ${f3?.zone}`);
    if (typeof a.json.presence_until !== 'string' || Date.parse(a.json.presence_until) - Date.now() > 61 * 60_000) problems.push('presence_until is not within an hour');
    report(problems.length === 0, 'q5: results carry no zone unless both are around', problems.length ? problems.join('; ') : `F zone ${ZONE_F} shown to A only`);
  });

  let meetId = null;
  await check('q6: a third device gets 403 from a meet, and 410 after found', async () => {
    if (!refF) throw new Error('F has no ref');
    const noted = await api('POST', '/api/meet', { event: PRIMARY, ref: refF, topic_id: null, note: `see ${WORDLIST[0] ?? 'example.com'}` }, { device: A, label: 'A-meet' });
    const r = await api('POST', '/api/meet', { event: PRIMARY, ref: refF, topic_id: 'ebpf', note: 'compare notes on Postgres operators' }, { device: A, label: 'A-meet' });
    if (r.status !== 200) throw new Error(`request gave ${r.status} ${r.json.error ?? ''}`);
    meetId = r.json.meet_id;
    const again = await api('POST', '/api/meet', { event: PRIMARY, ref: refF, topic_id: null, note: '' }, { device: A, label: 'A-meet' });
    const inbox = await api('GET', `/api/meet/inbox?event=${PRIMARY}`, undefined, { device: F, label: 'F-inbox' });
    const third = await api('GET', `/api/meet/${meetId}`, undefined, { device: N, label: 'N-meet' });
    const nobody = await api('GET', `/api/meet/${meetId}`, undefined, { device: X, label: 'X-meet' });
    const thirdAccept = await api('POST', `/api/meet/${meetId}/accept`, {}, { device: N, label: 'N-meet' });
    const accept = await api('POST', `/api/meet/${meetId}/accept`, {}, { device: F, label: 'F-meet' });
    const details = await api('PUT', `/api/meet/${meetId}/details`, { spot_me: `${spotMarker}-me`, rendezvous: ZONE_A }, { device: F, label: 'F-meet' });
    const seen = await api('GET', `/api/meet/${meetId}`, undefined, { device: A, label: 'A-meet' });
    const found = await api('POST', `/api/meet/${meetId}/found`, {}, { device: A, label: 'A-meet' });
    const after = await api('GET', `/api/meet/${meetId}`, undefined, { device: F, label: 'F-meet' });
    const problems = [];
    if (noted.status !== 400 || noted.json.error !== 'filtered') problems.push(`a listed word in a note gave ${noted.status}`);
    if (r.json.state !== 'requested') problems.push(`state after request ${r.json.state}`);
    if (again.status !== 409) problems.push(`a second open request gave ${again.status}`);
    if (!(inbox.json.incoming ?? []).some((m) => m.meet_id === meetId && m.from?.display_name === testName('A') && m.topic_label === 'eBPF')) problems.push('F\'s inbox lacks the request');
    if (third.status !== 403 || nobody.status !== 403 || thirdAccept.status !== 403) problems.push(`third devices got ${third.status}/${nobody.status}/${thirdAccept.status}`);
    if (accept.status !== 200 || accept.json.state !== 'active') problems.push(`accept gave ${accept.status} ${accept.json.state}`);
    if (details.status !== 200) problems.push(`details gave ${details.status}`);
    if (seen.status !== 200 || seen.json.other?.zone !== ZONE_F || seen.json.other?.spot_me !== `${spotMarker}-me` || seen.json.rendezvous !== ZONE_A) problems.push(`A sees ${JSON.stringify(seen.json.other ?? {})}`);
    if (found.status !== 200 || found.json.state !== 'found') problems.push(`found gave ${found.status}`);
    if (after.status !== 410 || after.json.state !== 'found') problems.push(`after found: ${after.status}`);
    report(problems.length === 0, 'q6: a third device gets 403 from a meet, and 410 after found', problems.length ? problems.join('; ') : 'requested, active with zone and spot-me, found, then 410');
  });

  await check('q7: presence expires', async () => {
    if (!ES_WRITE_KEY) {
      skip('q7: presence expires', 'no Elasticsearch write key in the environment');
      return;
    }
    // Aged directly with a Bulk partial update (the write the server itself uses, so nothing is
    // re-embedded), because the API always sets presence_until an hour ahead.
    const res = await fetch(`${ES_URL}/${encodeURIComponent(PEOPLE_INDEX)}/_bulk?refresh=wait_for`, {
      method: 'POST',
      headers: { Authorization: `ApiKey ${ES_WRITE_KEY}`, 'Content-Type': 'application/x-ndjson' },
      body: `${JSON.stringify({ update: { _id: `${PRIMARY}:${A.profileId}` } })}\n${JSON.stringify({ doc: { presence_until: new Date(Date.now() - 60_000).toISOString() } })}\n`,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const aged = res.ok ? await res.json().catch(() => ({})) : {};
    if (!res.ok) await res.body?.cancel();
    if (!res.ok || aged.errors) throw new Error(`aging A's presence gave ${res.status}`);
    const r = await findMatches(A, 'A-find');
    const f = personIn(r, 'F');
    const fromF = personIn(await findMatches(F, 'F-find', { query: 'eBPF GPU LLM' }), 'A');
    const ok = f && f.around === true && f.zone === null && fromF && fromF.around === false;
    report(Boolean(ok), 'q7: presence expires', ok ? 'an aged presence_until hides the zone and shows A as not around' : `F zone ${f?.zone}, A around ${fromF?.around}`);
  });

  await check('q8: block is symmetric and refuses a meet either way with the same body', async () => {
    if (!refF || !refA) throw new Error('refs missing');
    const blk = await api('POST', '/api/people/block', { event: PRIMARY, ref: refF }, { device: A, label: 'A-block' });
    const fromA = await findMatches(A, 'A-find');
    const fromF = await findMatches(F, 'F-find', { query: 'eBPF GPU LLM' });
    const aToF = await api('POST', '/api/meet', { event: PRIMARY, ref: refF, topic_id: null, note: '' }, { device: A, label: 'A-meet' });
    const fToA = await api('POST', '/api/meet', { event: PRIMARY, ref: refA, topic_id: null, note: '' }, { device: F, label: 'F-meet' });
    const list = await api('GET', `/api/people/blocks?event=${PRIMARY}`, undefined, { device: A, label: 'A-blocks' });
    const un = await api('DELETE', '/api/people/block', { event: PRIMARY, ref: refF }, { device: A, label: 'A-block' });
    const back = await findMatches(A, 'A-find');
    const problems = [];
    if (blk.status !== 200) problems.push(`block gave ${blk.status}`);
    if (names(fromA.json.results).includes(testName('F'))) problems.push('F still in A\'s results');
    if (names(fromF.json.results).includes(testName('A'))) problems.push('A still in F\'s results');
    if (aToF.status !== 403 || fToA.status !== 403 || aToF.json.error !== 'blocked' || JSON.stringify(aToF.json) !== JSON.stringify(fToA.json)) problems.push(`meets gave ${aToF.status} ${JSON.stringify(aToF.json)} and ${fToA.status} ${JSON.stringify(fToA.json)}`);
    if (!(list.json.refs ?? []).includes(refF) || !(list.json.blocks ?? []).some((b) => b.ref === refF && b.display_name === testName('F'))) problems.push('blocks list lacks F');
    if (un.status !== 200 || !names(back.json.results).includes(testName('F'))) problems.push('F not back after unblock');
    report(problems.length === 0, 'q8: block is symmetric and refuses a meet either way with the same body', problems.length ? problems.join('; ') : 'hidden both ways, 403 blocked both ways, listed, unblocked');
  });

  await check('q9: delete removes everything', async () => {
    const r = await api('POST', '/api/meet', { event: PRIMARY, ref: refF, topic_id: null, note: '' }, { device: A, label: 'A-meet' });
    const blk = await api('POST', '/api/people/block', { event: PRIMARY, ref: refA }, { device: F, label: 'F-block' });
    if (r.status !== 200 || blk.status !== 200) throw new Error(`setup gave ${r.status}/${blk.status}`);
    const del = await api('DELETE', `/api/people/profile?event=${PRIMARY}`, undefined, { device: F, label: 'F-delete' });
    const meet = await api('GET', `/api/meet/${r.json.meet_id}`, undefined, { device: A, label: 'A-meet' });
    const inbox = await api('GET', `/api/meet/inbox?event=${PRIMARY}`, undefined, { device: A, label: 'A-inbox' });
    const found = await findMatches(A, 'A-find');
    const problems = [];
    if (del.status !== 200) problems.push(`delete gave ${del.status}`);
    if (meet.status !== 404) problems.push(`the meet still answers ${meet.status}`);
    if ((inbox.json.outgoing ?? []).some((m) => m.meet_id === r.json.meet_id)) problems.push('the meet is still in A\'s inbox');
    if (names(found.json.results).includes(testName('F'))) problems.push('F still found');
    // A blocked by F: F's block went with F's profile, so A is not hidden from anyone now.
    const fromN = await findMatches(N, 'N-find', { query: 'eBPF GPU LLM' });
    if (fromN.status !== 200) problems.push(`N's search gave ${fromN.status}`);
    report(problems.length === 0, 'q9: delete removes everything', problems.length ? problems.join('; ') : 'profile, meet and block gone');
  });

  await check('q10: two reports hide a profile from everyone but its owner', async () => {
    // B shares for the circle talk too, so both reporters see the circle. R is the reported person.
    const shareB = await putProfile(B, PRIMARY, 'B', { speak: LEARN, learn: ['kubernetes'] }, { open: true, shared: [T] });
    if (shareB.status !== 200) throw new Error(`B sharing gave ${shareB.status}`);
    const countBeforeR = await countOf();
    const r = await putProfile(R, PRIMARY, 'R', { speak: LEARN, learn: LEARN }, { open: true, shared: [T] });
    if (r.status !== 200) throw new Error(`R gave ${r.status}`);
    const seenBy = async (device, who) => {
      const m = await api('POST', '/api/people/matches', { event: PRIMARY, interested_talk_ids: [] }, { device, label: `${who}-matches` });
      const c = await api('POST', '/api/circles/members', { event: PRIMARY, talk_id: T }, { device, label: `${who}-members` });
      if (m.status !== 200 || c.status !== 200) throw new Error(`${who} got ${m.status}/${c.status}`);
      return { matches: names(m.json.results).includes(testName('R')), circle: names(c.json.members).includes(testName('R')), ref: personIn(m, 'R')?.ref ?? null };
    };
    const beforeA = await seenBy(A, 'A');
    const beforeB = await seenBy(B, 'B');
    if (!beforeA.ref) throw new Error('R is not in A\'s matches before any report');
    const refR = beforeA.ref;
    const reportR = (device, who, reason = 'spam') => api('POST', '/api/people/report', { event: PRIMARY, ref: refR, context: { kind: 'profile', id: refR }, reason }, { device, label: `${who}-report` });
    const first = await reportR(A, 'A');
    const again = await reportR(A, 'A', 'other');
    const stillA = await seenBy(A, 'A');
    const second = await reportR(B, 'B');
    const afterA = await seenBy(A, 'A');
    const afterB = await seenBy(B, 'B');
    const meet = await api('POST', '/api/meet', { event: PRIMARY, ref: refR, topic_id: null, note: '' }, { device: A, label: 'A-meet' });
    const owner = await putProfile(R, PRIMARY, 'R', { speak: LEARN, learn: LEARN }, { open: true, shared: [T] });
    const count = await countOf();
    const problems = [];
    if (!beforeA.matches || !beforeA.circle || !beforeB.matches || !beforeB.circle) problems.push('R not visible to both before the reports');
    if (first.status !== 200 || first.json.hidden !== false) problems.push(`the first report gave ${first.status} hidden ${first.json.hidden}`);
    if (again.status !== 200 || again.json.hidden !== false) problems.push(`the same device's second report gave ${again.status} hidden ${again.json.hidden}`);
    if (!stillA.matches || !stillA.circle) problems.push('one reporter alone hid R');
    if (second.status !== 200 || second.json.hidden !== true) problems.push(`the second reporter gave ${second.status} hidden ${second.json.hidden}`);
    if (afterA.matches || afterA.circle || afterB.matches || afterB.circle) problems.push('R still visible after two reports');
    if (meet.status !== 404) problems.push(`a meet request to R gave ${meet.status}`);
    if (owner.status !== 200 || owner.json.hidden_for_owner !== true) problems.push(`the owner's write gave ${owner.status} hidden_for_owner ${owner.json.hidden_for_owner}`);
    if (count !== countBeforeR) problems.push(`the circle count is ${count}, expected ${countBeforeR} without R`);
    report(problems.length === 0, 'q10: two reports hide a profile from everyone but its owner', problems.length ? problems.join('; ') : 'gone from matches, circles, counts and meets; the owner sees hidden_for_owner');
  });

  await check('p11: a deleted profile disappears at once', async () => {
    const del = await api('DELETE', `/api/people/profile?event=${PRIMARY}`, undefined, { device: B, label: 'B-delete' });
    const m = await api('POST', '/api/people/matches', { event: PRIMARY, interested_talk_ids: [] }, { device: A, label: 'A-matches' });
    const gone = del.status === 200 && m.status === 200 && !names(m.json.results).includes(testName('B'));
    const off = await putProfile(C, PRIMARY, 'C', { speak: LEARN }, { open: false, shared: [] });
    const count = await countOf();
    const ok = gone && off.status === 200 && count === (countBefore ?? 0) + 1;
    report(ok, 'p11: a deleted profile disappears at once', `delete ${del.status}, B ${gone ? 'gone' : 'still there'}; turning both choices off leaves the count at ${count}`);
  });

  // ---------------------------------------------------------------------------------------------
  // Talks for you.

  await check('r1: For you puts talks with a wanted topic first and never an ended or marked one', async () => {
    const first = await api('POST', '/api/recommendations', { event: PRIMARY, learn_topics: ['ebpf'], interests: 'kernel level tracing and observability', interested_talk_ids: [], size: 20 }, { label: 'recs' });
    if (first.status !== 200) throw new Error(`status ${first.status}`);
    const marked = (first.json.results ?? []).slice(0, 2).map((r) => r.talk_id);
    const second = await api('POST', '/api/recommendations', { event: PRIMARY, learn_topics: ['ebpf'], interests: 'kernel level tracing and observability', interested_talk_ids: marked, size: 50 }, { label: 'recs' });
    const chips = await api('POST', '/api/recommendations', { event: PRIMARY, learn_topics: ['ebpf'], interested_talk_ids: marked, size: 50 }, { label: 'recs' });
    const results = second.json.results ?? [];
    const now = Date.now();
    const problems = [];
    if (!results.length) problems.push('no results');
    const hasWanted = (r) => (r.topics ?? []).some((t) => t.topic_id === 'ebpf');
    if (results[0] && !(hasWanted(results[0]) && results[0].why.topics.includes('eBPF'))) problems.push(`the first result "${results[0].title}" lacks eBPF`);
    const chipResults = chips.json.results ?? [];
    if (!chipResults.length || !chipResults.every(hasWanted)) problems.push('a chips-only result lacks the wanted topic');
    for (const r of [...results, ...chipResults]) {
      if (Date.parse(r.end) <= now) problems.push(`ended talk "${r.title}"`);
      if (marked.includes(r.talk_id)) problems.push(`marked talk "${r.title}"`);
      if (!ownTalks.get(PRIMARY).has(r.talk_id)) problems.push(`foreign talk "${r.title}"`);
    }
    const empty = await api('POST', '/api/recommendations', { event: PRIMARY, interested_talk_ids: [] }, { label: 'recs' });
    if (!(empty.status === 200 && empty.json.needs_profile === true)) problems.push('an empty profile does not get needs_profile');
    const unique = [...new Set(problems)];
    report(unique.length === 0, 'r1: For you puts talks with a wanted topic first and never an ended or marked one', unique.length ? unique.slice(0, 3).join('; ') : `${results.length} suggestions, first "${results[0].title}"`);
  });

  await check('r2: For you does not cross conferences', async () => {
    const problems = [];
    for (const slug of EXTRA) {
      const topics = (topicsBySlug.get(slug) ?? []).slice(0, 3).map((t) => t.topic_id);
      const r = await api('POST', '/api/recommendations', { event: slug, learn_topics: topics, interests: 'agents and model training', interested_talk_ids: [], size: 50 }, { label: 'recs' });
      if (r.status !== 200) problems.push(`${slug} gave ${r.status}`);
      for (const t of r.json.results ?? []) if (!ownTalks.get(slug).has(t.talk_id)) problems.push(`${slug} got "${t.title}"`);
    }
    report(problems.length === 0, 'r2: For you does not cross conferences', problems.length ? problems.slice(0, 3).join('; ') : `${EXTRA.length} conferences checked`);
  });
} catch (err) {
  report(false, 'people checks', err.message);
} finally {
  // Remove every test profile, whatever happened above.
  for (const { device, event } of created) {
    await api('DELETE', `/api/people/profile?event=${encodeURIComponent(event)}`, undefined, { device, label: 'cleanup' }).catch(() => {});
  }
  if (expiredWritten) {
    const res = await fetch(`${ES_URL}/${encodeURIComponent(PEOPLE_INDEX)}/_doc/${encodeURIComponent(expiredId)}?refresh=wait_for`, {
      method: 'DELETE',
      headers: { Authorization: `ApiKey ${ES_WRITE_KEY}` },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    }).catch(() => null);
    await res?.body?.cancel();
  }
}

// ---------------------------------------------------------------------------------------------
// Checks over every response seen.

{
  // b. Every search result has non-empty evidence.
  const empty = allResults.filter((r) => typeof r.evidence !== 'string' || !r.evidence.trim());
  report(allResults.length > 0 && empty.length === 0, 'b: every result has non-empty evidence', empty.length ? `${empty.length} empty, for example "${empty[0].title}"` : `${allResults.length} results`);
}

{
  // s. No response names a clash, a conflict or agenda building. Talk titles and abstracts are
  // feed data, so only keys and the strings the app writes itself are checked.
  const hits = [];
  const walk = (v, key, path) => {
    if (Array.isArray(v)) v.forEach((x) => walk(x, key, path));
    else if (v && typeof v === 'object') {
      for (const [k, x] of Object.entries(v)) {
        if (SCHEDULING_WORDS.test(k)) hits.push(`key "${k}" in ${path}`);
        walk(x, k, path);
      }
    } else if (typeof v === 'string' && ['error', 'reasons', 'opener', 'status', 'message'].includes(key) && SCHEDULING_WORDS.test(v)) {
      hits.push(`"${v.slice(0, 60)}" in ${path}`);
    }
  };
  for (const r of responses) walk(r.json, '', r.path);
  report(hits.length === 0, 's: no response mentions a clash, a conflict or agenda building', hits.length ? hits.slice(0, 3).join('; ') : `${responses.length} responses checked`);
}

{
  // l. secret_hash and other private fields never leak, and a test profile's contact details
  // reach only people allowed to see them.
  const hits = [];
  const secrets = [A, B, C, D, N, F, K, X, R].flatMap((d) => [d.secret, d.profileId]);
  const hashes = [A, B, C, D, N, F, K, X, R].map((d) => crypto.createHash('sha256').update(d.secret).digest('hex'));
  for (const r of responses) {
    for (const word of ['secret_hash', 'text_hash', '"profile_id"', '_semantic', 'presence_spot', 'blocker_id', 'blocked_id']) if (r.text.includes(word)) hits.push(`${word} in ${r.path}`);
    for (const s of [...secrets, ...hashes]) if (r.text.includes(s)) hits.push(`a device secret, id or hash in ${r.path}`);
    // Spot lines and spot-me lines leave the server only to the meet's two participants, inside the meet.
    if (r.text.includes(spotMarker) && !(['A-meet', 'F-meet'].includes(r.label) && r.path.startsWith('/api/meet/')) && !['A-presence', 'F-presence'].includes(r.label)) hits.push(`a spot line in ${r.label} ${r.path}`);
    // C shared only for the circle talk, so only fellow sharers (A) may see C's contact.
    if (r.text.includes(contactMarker('C')) && r.label !== 'A-members') hits.push(`C's contact in ${r.label}`);
    // Nobody may see the expired profile's contact.
    if (r.text.includes(contactMarker('Expired'))) hits.push(`the expired contact in ${r.label}`);
    // A non-sharer and anonymous callers see no contact details at all.
    if (['N-members', 'anon-members', 'public-counts', 'C-matches', 'recs'].includes(r.label) && /linkedin_url|contact_note/.test(r.text)) hits.push(`contact fields in ${r.label}`);
  }
  const unique = [...new Set(hits)];
  report(unique.length === 0, 'l: secret_hash and other people\'s contact details never leak', unique.length ? unique.slice(0, 4).join('; ') : `${responses.length} responses checked`);
}

{
  // e. The built bundle holds no credential values, credential-shaped strings or scheduling words.
  const dist = join(ROOT, 'web', 'dist');
  if (!existsSync(dist)) {
    if (process.env.SMOKE_SKIP_BUNDLE === '1') skip('e: bundle scan', 'web/dist does not exist and SMOKE_SKIP_BUNDLE=1');
    else report(false, 'e: bundle scan', 'web/dist does not exist; build it or set SMOKE_SKIP_BUNDLE=1');
  } else {
    const files = [];
    const walk = (dir) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else files.push(p);
      }
    };
    walk(dist);
    const secrets = BUNDLE_SECRET_VARS.filter((v) => process.env[v]).map((v) => ({ label: `the value of ${v}`, bytes: Buffer.from(process.env[v]) }));
    const patterns = BUNDLE_PATTERNS.map((p) => ({ label: `"${p}"`, bytes: Buffer.from(p) }));
    const hits = [];
    for (const file of files) {
      const content = readFileSync(file);
      for (const { label, bytes } of [...secrets, ...patterns]) {
        if (content.includes(bytes)) hits.push(`${label} in ${file.slice(ROOT.length)}`);
      }
      if (/\.(js|html)$/.test(file) && /clash|conflict-free|build my agenda|agenda building/i.test(content.toString('utf8'))) hits.push(`scheduling wording in ${file.slice(ROOT.length)}`);
    }
    report(hits.length === 0, 'e: bundle holds no keys, key-shaped strings or scheduling wording', hits.length ? hits.join('; ') : `${files.length} files, ${secrets.length} key values and ${patterns.length} patterns checked`);
  }
}

process.exit(failures ? 1 : 0);
