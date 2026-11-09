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
//                        expired test profile directly, because the API can never create one. Without
//                        a key that check is skipped.
//
// The script creates its own temporary test profiles, each with a random device secret, and
// deletes them at the end. It never changes the seeded sample profiles. Key values are compared
// in-process and never printed.
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
  const secrets = [A, B, C, D, N].flatMap((d) => [d.secret, d.profileId]);
  const hashes = [A, B, C, D, N].map((d) => crypto.createHash('sha256').update(d.secret).digest('hex'));
  for (const r of responses) {
    for (const word of ['secret_hash', 'text_hash', '"profile_id"', '_semantic']) if (r.text.includes(word)) hits.push(`${word} in ${r.path}`);
    for (const s of [...secrets, ...hashes]) if (r.text.includes(s)) hits.push(`a device secret, id or hash in ${r.path}`);
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
