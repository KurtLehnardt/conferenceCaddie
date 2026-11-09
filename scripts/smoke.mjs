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
//   ELASTISEARCH_API_KEY used also to compare index document counts before and after the schedule
//                        imports (the import must store nothing). Without it that check is skipped.
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

// e. The events and showcases toggle: off by default, and when on it adds only kind "ambient" items,
// never a break or a housekeeping item. The expectation comes from the committed data.
await check('e1: include_events adds co-located events and showcases, and nothing else', async () => {
  const docs = readNdjson(PRIMARY);
  const ambient = new Map(docs.filter((d) => d.kind === 'ambient').map((d) => [d.talk_id, d]));
  const other = new Map(docs.filter((d) => d.kind === 'break' || d.kind === 'housekeeping').map((d) => [d.talk_id, d]));
  const track = [...ambient.values()].find((d) => d.track === 'Solutions Showcase')?.track ?? [...ambient.values()][0]?.track;
  if (!track) throw new Error('no ambient item in the committed data');
  const off = await search({ query: '', size: 50, filters: { track: [track] } });
  const on = await search({ query: '', size: 50, filters: { track: [track], include_events: true } });
  if (off.status !== 200 || on.status !== 200) throw new Error(`status ${off.status} and ${on.status}`);
  const problems = [];
  if ((off.json.results ?? []).some((r) => ambient.has(r.talk_id))) problems.push('an event appeared with the toggle off');
  const shown = (on.json.results ?? []).filter((r) => ambient.has(r.talk_id));
  if (!shown.length) problems.push('no event appeared with the toggle on');
  if (shown.some((r) => r.kind !== 'ambient')) problems.push('an event is not marked kind ambient');
  if ((on.json.results ?? []).some((r) => other.has(r.talk_id))) problems.push('a break or housekeeping item appeared');
  if ((off.json.results ?? []).some((r) => r.kind !== 'talk')) problems.push('a talk is not marked kind talk');
  const text = await search({ query: 'solutions showcase and co-located events', size: 50, filters: { include_events: true } });
  if (text.status !== 200) throw new Error(`status ${text.status}`);
  if ((text.json.results ?? []).some((r) => other.has(r.talk_id))) problems.push('a break or housekeeping item matched a text query');
  report(problems.length === 0, 'e1: include_events adds co-located events and showcases, and nothing else', problems.length ? problems.join('; ') : `${shown.length} events in "${track}", ${off.json.total} results off and ${on.json.total} on`);
});

await check('e2: include_events must be a boolean, and For you never holds an event', async () => {
  const bad = await search({ query: 'kubernetes', filters: { include_events: 'yes' } });
  const ambient = new Set(readNdjson(PRIMARY).filter((d) => d.kind === 'ambient').map((d) => d.talk_id));
  const recs = await api('POST', '/api/recommendations', { event: PRIMARY, learn_topics: ['kubernetes', 'ebpf'], interests: 'solutions showcase and co-located events', interested_talk_ids: [], size: 50 }, { label: 'recs' });
  if (recs.status !== 200) throw new Error(`recommendations status ${recs.status}`);
  const list = recs.json.results ?? recs.json.talks ?? [];
  const leaked = list.filter((r) => ambient.has(r.talk_id ?? r.talk?.talk_id));
  report(bad.status === 400 && leaked.length === 0 && list.length > 0, 'e2: include_events must be a boolean, and For you never holds an event', `status ${bad.status}, ${list.length} suggested talks, ${leaked.length} events among them`);
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

// The ranking drawer: "debug": true adds each result's keyword and semantic rank from
// Elasticsearch, and a normal search carries none of it. The reciprocal rank fusion score the
// reported ranks imply must never rise down the list, which shows the ranks are the ones fused.
// The plain and debug result lists are not compared: the primary and replica shard copies hold
// different numbers of deleted documents, so keyword scores, and sometimes the order, can differ
// between two identical requests.
await check('k1: the ranking drawer reports the keyword and semantic ranks that were fused', async () => {
  const body = { query: 'kubernetes security', size: 15, filters: { hide_sponsor: true } };
  const plain = await search(body);
  const debug = await search({ ...body, debug: true });
  if (plain.status !== 200 || debug.status !== 200) throw new Error(`status ${plain.status} and ${debug.status}`);
  const problems = [];
  if ('ranking' in plain.json || (plain.json.results ?? []).some((r) => 'ranking' in r)) problems.push('a normal search carries ranking details');
  const info = debug.json.ranking;
  if (!info || info.filters?.hide_sponsor !== true || info.filters?.kind !== 'talk') problems.push('the applied filters are missing');
  const rrf = (n) => (Number.isInteger(n) && n > 0 ? 1 / (60 + n) : 0);
  let previous = Infinity;
  (debug.json.results ?? []).forEach((r, i) => {
    const g = r.ranking;
    if (!g || g.rank !== i + 1) return problems.push(`result ${i + 1} has no rank`);
    if (g.keyword_rank === null && g.semantic_rank === null) problems.push(`"${r.title}" is in neither ranking`);
    const score = rrf(g.keyword_rank) + rrf(g.semantic_rank);
    if (score > previous + 1e-9) problems.push(`"${r.title}" at ${g.rank} outscores the talk above it`);
    previous = score;
  });
  const first = debug.json.results?.[0]?.ranking;
  report(problems.length === 0, 'k1: the ranking drawer reports the keyword and semantic ranks that were fused', problems.length ? problems.slice(0, 3).join('; ') : `top result keyword ${first?.keyword_rank}, semantic ${first?.semantic_rank}`);
});

await check('k2: debug must be a boolean, and browse mode has no ranking details', async () => {
  const bad = await search({ query: 'kubernetes', debug: 'yes' });
  const browse = await search({ query: '', debug: true });
  const ok = bad.status === 400 && browse.status === 200 && !('ranking' in browse.json);
  report(ok, 'k2: debug must be a boolean, and browse mode has no ranking details', `status ${bad.status} and ${browse.status}`);
});

// Time phrases: "tuesday afternoon" leaves the text and becomes two filters. The expectation is
// computed from the committed data, not from the response: every talk starts on that day at or
// after 12:00, and the day's lunch from the break items bounds "after lunch".
const minutesOf = (iso) => Number(iso.slice(11, 13)) * 60 + Number(iso.slice(14, 16));
await check('m1: "tuesday afternoon" leaves the text, filters the results and can be removed', async () => {
  const start = confBySlug.get(PRIMARY)?.start_date;
  const tuesday = ['2026-11-09', '2026-11-10', '2026-11-11', '2026-11-12'].find((d) => new Date(`${d}T12:00:00Z`).getUTCDay() === 2);
  if (!start || !tuesday) throw new Error('the primary conference has no Tuesday in the data');
  const r = await search({ query: 'kubernetes tuesday afternoon', size: 50 });
  if (r.status !== 200) throw new Error(`status ${r.status}`);
  const keys = (r.json.time_phrases ?? []).filter((p) => p.applied).map((p) => p.key).sort().join(',');
  const wrong = (r.json.results ?? []).filter((t) => !t.start.startsWith(tuesday) || minutesOf(t.start) < 720);
  const off = await search({ query: 'kubernetes tuesday afternoon', size: 50, ignore_phrases: ['tuesday', 'afternoon'] });
  const offApplied = (off.json.time_phrases ?? []).filter((p) => p.applied).length;
  const ok = keys === 'afternoon,tuesday' && r.json.search_text === 'kubernetes' && (r.json.results ?? []).length > 0 && wrong.length === 0
    && off.status === 200 && offApplied === 0 && off.json.total > r.json.total;
  report(ok, 'm1: "tuesday afternoon" leaves the text, filters the results and can be removed', `phrases ${keys}, text "${r.json.search_text}", ${r.json.total} talks, ${wrong.length} outside the filter, ${off.json.total} with both removed`);
});

// Happening now: the chip's window is judged by Elasticsearch against its own clock, and the chip is
// available only on days the conference is running in its own time zone. Both expectations are
// computed here from the committed data and the local clock, with two minutes of slack for skew.
const localDayIn = (ms, timeZone) => new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
await check('n1: Happening now is available exactly when the conference has talks today in its own zone', async () => {
  const problems = [];
  let checked = 0;
  for (const slug of [PRIMARY, ...EXTRA.slice(0, 1)]) {
    const zone = confBySlug.get(slug)?.time_zone;
    if (!zone) throw new Error(`${slug} has no time zone`);
    const before = localDayIn(Date.now(), zone);
    const r = await api('POST', '/api/search', { conference: slug, query: '', size: 1 });
    const after = localDayIn(Date.now(), zone);
    if (r.status !== 200) throw new Error(`status ${r.status}`);
    if (before !== after) continue; // the zone's midnight passed during the request; skip rather than guess
    const days = new Set(readNdjson(slug).filter((d) => d.kind === 'talk').map((d) => d.day));
    const expected = days.has(before);
    checked++;
    if (r.json.happening_now?.available !== expected) problems.push(`${slug}: expected ${expected} on ${before}, got ${JSON.stringify(r.json.happening_now)}`);
  }
  report(problems.length === 0, 'n1: Happening now is available exactly when the conference has talks today in its own zone', problems.length ? problems.join('; ') : `checked ${checked} conferences against the local date in their zones`);
});

await check('n2: Happening now keeps only talks in progress or starting within 60 minutes, and must be a boolean', async () => {
  const slack = 2 * 60_000;
  const at = Date.now();
  const r = await search({ query: '', size: 50, filters: { happening_now: true } });
  const all = await search({ query: '', size: 1 });
  const bad = await search({ query: '', filters: { happening_now: 'yes' } });
  if (r.status !== 200 || all.status !== 200) throw new Error(`status ${r.status} and ${all.status}`);
  const outside = (r.json.results ?? []).filter((t) => !(Date.parse(t.end) > at - slack && Date.parse(t.start) < at + 60 * 60_000 + slack));
  const talks = readNdjson(PRIMARY).filter((d) => d.kind === 'talk');
  const expected = talks.filter((d) => Date.parse(d.end) > at + slack && Date.parse(d.start) < at + 60 * 60_000 - slack).length;
  const ok = outside.length === 0 && r.json.total >= expected && r.json.total <= all.json.total && bad.status === 400;
  report(ok, 'n2: Happening now keeps only talks in progress or starting within 60 minutes, and must be a boolean', `${r.json.total} of ${all.json.total} talks, at least ${expected} expected from the data, ${outside.length} outside the window, bad type gave ${bad.status}`);
});

await check('m2: "after lunch day 2" uses that day\'s lunch break and an empty remainder browses', async () => {
  const day2 = '2026-11-10';
  const lunch = readNdjson(PRIMARY).filter((d) => d.kind === 'break' && d.day === day2 && /lunch/i.test(d.title));
  if (!lunch.length) throw new Error('no lunch break on day 2 in the data');
  const lunchEnd = Math.max(...lunch.map((d) => d.end_minutes));
  const r = await search({ query: 'after lunch day 2', size: 50 });
  if (r.status !== 200) throw new Error(`status ${r.status}`);
  const wrong = (r.json.results ?? []).filter((t) => !t.start.startsWith(day2) || minutesOf(t.start) < lunchEnd);
  const unknown = await search({ query: 'day 9 friday', size: 5 });
  const ok = r.json.search_text === '' && (r.json.results ?? []).length > 0 && wrong.length === 0
    && unknown.status === 200 && (unknown.json.time_phrases ?? []).length === 0 && unknown.json.search_text === 'day 9 friday';
  report(ok, 'm2: "after lunch day 2" uses that day\'s lunch break and an empty remainder browses', `${r.json.total} talks, ${wrong.length} outside the window, lunch ends at minute ${lunchEnd}`);
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
// Import my schedule. Every file here is synthetic, built from public talk titles of the primary
// conference. The import makes seven requests, under the endpoint's limit of ten a minute. It runs
// before the people checks, so no smoke write happens while the index doc counts are compared.

// Five talks with a unique, plain ASCII title of at least four words, spread over the schedule.
function importPicks(slug, n) {
  const talks = readNdjson(slug).filter((d) => d.kind === 'talk');
  const seen = new Map();
  for (const t of talks) seen.set(t.title, (seen.get(t.title) ?? 0) + 1);
  const pool = talks
    .filter((t) => seen.get(t.title) === 1 && /^[\x20-\x7e]+$/.test(t.title) && t.title.trim().split(/\s+/).length >= 4)
    .sort((a, b) => (a.talk_id < b.talk_id ? -1 : 1));
  const step = Math.max(1, Math.floor(pool.length / n));
  return pool.filter((_, i) => i % step === 0).slice(0, n);
}

// A schedule as an attendee might save it: day headers, time ranges, titles, speakers, rooms and
// calendar links.
function scheduleText(talks, timeZone) {
  const day = (iso) => new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'long', month: 'long', day: 'numeric' }).format(new Date(iso));
  const time = (iso) => new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', minute: '2-digit' }).format(new Date(iso));
  const lines = ['My schedule', ''];
  for (const t of [...talks].sort((a, b) => Date.parse(a.start) - Date.parse(b.start))) {
    lines.push(day(t.start), '', `${time(t.start)} – ${time(t.end)}`, t.title, `Speakers: ${t.speakers.join(', ')}`, t.room ?? 'Room 1', 'Add to calendar', '');
  }
  return lines.join('\n');
}

// A minimal one-page PDF (Helvetica, WinAnsi text) with one line per item, for the Tika path.
function makePdf(lines) {
  const esc = (s) => s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
  const content = ['BT', '/F1 9 Tf', '40 800 Td', '12 TL', ...lines.map((l) => `(${esc(l)}) Tj T*`), 'ET'].join('\n');
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    `<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`,
  ];
  let out = '%PDF-1.4\n';
  const offsets = [];
  objs.forEach((o, i) => {
    offsets.push(Buffer.byteLength(out, 'latin1'));
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

// Document counts of every non-hidden index, except caddie-people, where live attendees may save
// profiles at any moment (the import's key cannot touch it). Needs ELASTISEARCH_API_KEY.
// The deployed import key cannot write any index at all; scripts/create-es-keys.mjs checks that.
async function indexCounts() {
  const res = await fetch(`${ES_URL}/_cat/indices?format=json&h=index,docs.count&expand_wildcards=open`, {
    headers: { Authorization: `ApiKey ${process.env.ELASTISEARCH_API_KEY}` },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`index listing gave ${res.status}`);
  const rows = await res.json();
  return new Map(rows.filter((r) => !r.index.startsWith('.') && !r.index.startsWith('caddie-people')).map((r) => [r.index, r['docs.count']]));
}

const IMPORT_OTHER = EXTRA[0];
const picks = importPicks(PRIMARY, 5);
const pickIds = new Set(picks.map((t) => t.talk_id));
const importBody = scheduleText(picks, confBySlug.get(PRIMARY)?.time_zone ?? 'UTC');
let countsBefore = null;
if (process.env.ELASTISEARCH_API_KEY) {
  try {
    countsBefore = await indexCounts();
  } catch (err) {
    report(false, 'im5: an import adds nothing to any index', err.message);
  }
}
const exactHits = (json) => (json.matched ?? []).filter((m) => pickIds.has(m.talk?.talk_id) && m.confidence === 'exact_title').length;

await check('im1: a text file with 5 real titles gets at least 4 matches at "exact title"', async () => {
  const { status, json } = await api('POST', '/api/import/schedule', { event: PRIMARY, text: importBody });
  if (status !== 200) throw new Error(`status ${status}`);
  const exact = exactHits(json);
  const foreign = (json.matched ?? []).filter((m) => m.talk?.conference !== PRIMARY).length;
  report(picks.length === 5 && exact >= 4 && foreign === 0, 'im1: a text file with 5 real titles gets at least 4 matches at "exact title"',
    `${exact} of ${picks.length} at exact title, ${json.matched?.length ?? 0} matched, ${json.unmatched_count} unmatched, ${json.extracted_chars} characters`);
});

await check(`im2: the same file against ${IMPORT_OTHER} gets none of the first conference's talks`, async () => {
  const { status, json } = await api('POST', '/api/import/schedule', { event: IMPORT_OTHER, text: importBody });
  if (status !== 200) throw new Error(`status ${status}`);
  const primaryTalks = ownTalks.get(PRIMARY);
  const crossed = (json.matched ?? []).filter((m) => primaryTalks.has(m.talk?.talk_id) || m.talk?.conference !== IMPORT_OTHER);
  report(crossed.length === 0, `im2: the same file against ${IMPORT_OTHER} gets none of the first conference's talks`,
    crossed.length ? `${crossed.length} crossed, for example "${crossed[0].talk?.title}"` : `${json.matched?.length ?? 0} matched, all of ${IMPORT_OTHER}`);
});

await check('im3: a PDF goes through the attachment processor and finds the same talks', async () => {
  const pdf = makePdf(importBody.split('\n'));
  const { status, json } = await api('POST', '/api/import/schedule', { event: PRIMARY, filename: 'schedule.pdf', mime: 'application/pdf', content_base64: pdf.toString('base64') });
  if (status !== 200) throw new Error(`status ${status}${json.error ? `: ${json.error}` : ''}`);
  const exact = exactHits(json);
  report(exact >= 4, 'im3: a PDF goes through the attachment processor and finds the same talks', `${exact} of ${picks.length} at exact title, ${json.extracted_chars} characters extracted`);
});

await check('im4: a 6 MB upload gets 413, and unknown keys, binary files and unknown conferences are refused', async () => {
  const big = await api('POST', '/api/import/schedule', { event: PRIMARY, filename: 'big.txt', mime: 'text/plain', content_base64: Buffer.alloc(6 * 1024 * 1024, 0x41).toString('base64') });
  const unknownKey = await api('POST', '/api/import/schedule', { event: PRIMARY, text: 'Kubernetes 101 New Contributor Orientation', store: true });
  const binary = await api('POST', '/api/import/schedule', { event: PRIMARY, filename: 'x.png', mime: 'image/png', content_base64: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0xfe, 0x00, 0x80]).toString('base64') });
  const unknownEvent = await api('POST', '/api/import/schedule', { event: 'no-such-conference-2026', text: 'Kubernetes 101 New Contributor Orientation' });
  report(big.status === 413 && unknownKey.status === 400 && binary.status === 415 && unknownEvent.status === 400,
    'im4: a 6 MB upload gets 413, and unknown keys, binary files and unknown conferences are refused',
    `6 MB ${big.status}, unknown key ${unknownKey.status}, binary ${binary.status}, unknown conference ${unknownEvent.status}`);
});

if (!process.env.ELASTISEARCH_API_KEY) {
  skip('im5: an import adds nothing to any index', 'ELASTISEARCH_API_KEY is not set');
} else if (countsBefore) {
  await check('im5: an import adds nothing to any index', async () => {
    // A write would be searchable after the one-second refresh interval.
    await new Promise((r) => setTimeout(r, 1500));
    const after = await indexCounts();
    const changed = [...new Set([...countsBefore.keys(), ...after.keys()])].filter((i) => countsBefore.get(i) !== after.get(i));
    const describe = (list) => list.map((i) => `${i}: ${countsBefore.get(i) ?? 'none'} -> ${after.get(i) ?? 'none'}`).join('; ');
    // The indices the import reads must not change at all, and no new index may appear under their
    // names. Other sessions and operators share the cluster and may build their own indices during
    // the run, so a change elsewhere is listed but not judged.
    const judged = changed.filter((i) => /^caddie-(talks|conferences|topics)/.test(i));
    const others = changed.filter((i) => !judged.includes(i));
    report(judged.length === 0, 'im5: an import adds nothing to any index',
      judged.length ? describe(judged) : `${after.size} indices compared, the talks, conferences and topics indices unchanged${others.length ? `; changed by other writers: ${describe(others)}` : ', and every other index unchanged too'}`);
  });
}

// ---------------------------------------------------------------------------------------------
// People, circles and talks for you. Every test profile is created here and deleted at the end.

const A = newDevice(); // the requester: chips only, visible, shares for the circle talk
const B = newDevice(); // can speak to everything A wants to learn, visible
const C = newDevice(); // can speak to the same, but only shares for the circle talk
const D = newDevice(); // visible at another conference, with the same topics where possible
const N = newDevice(); // visible, but never shares for the circle talk
const E = newDevice(); // shares through the exact writes the Interested screen's auto-share switch sends
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

  await check('p12: the writes behind the auto-share switch are accepted, and a rejection says why', async () => {
    // The web app sends this body shape for every share, unshare and auto-share write: the same
    // eight profile keys, "contact_note" as an empty string, and the full list of shared talks.
    const [t1, t2] = [...ownTalks.get(PRIMARY)].filter((id) => id !== T).slice(0, 2);
    if (!t1 || !t2) {
      skip('p12: the writes behind the auto-share switch are accepted, and a rejection says why', 'the conference has fewer than three talks');
      return;
    }
    const body = (shared, over = {}) => ({
      event: PRIMARY,
      profile: { display_name: testName('E'), about: '', interests: '', expertise: '', learn_topics: [], speak_topics: [], linkedin_url: null, contact_note: '', ...over },
      open_to_meet: false,
      shared_talk_ids: shared,
    });
    const put = (b) => api('PUT', '/api/people/profile', b, { device: E, label: 'E-put' });
    const problems = [];
    const first = await put(body([t1]));
    if (first.status === 200) created.push({ device: E, event: PRIMARY });
    const again = await put(body([t1])); // switching auto-share on re-sends the list that is already shared
    const marked = await put(body([t1, t2])); // a newly marked talk is shared
    const unmarked = await put(body([t2])); // an unmarked talk is unshared
    const steps = [['first share', first, 1], ['same list again', again, 1], ['a marked talk', marked, 2], ['an unmarked talk', unmarked, 1]];
    for (const [label, r, count] of steps) {
      if (r.status !== 200) problems.push(`${label} gave ${r.status} ${r.json.error ?? ''}`.trim());
      else if (r.json.shared_talk_ids?.length !== count || r.json.open_to_meet !== false) problems.push(`${label} echoed the wrong list`);
    }
    // A topic the list does not offer is rejected with a message that names the topic field; the web
    // app reads it, removes the topic from the phone's profile and sends the write again.
    const retired = await put(body([t2], { learn_topics: ['no-such-topic-xyz'] }));
    if (retired.status !== 400 || !/^learn_topics contains an unknown topic/.test(retired.json.error ?? '')) problems.push(`an unknown topic gave ${retired.status} ${retired.json.error ?? ''}`.trim());
    const noName = await put(body([t2], { display_name: '' }));
    if (noName.status !== 400 || !/^display_name is required/.test(noName.json.error ?? '')) problems.push(`no name gave ${noName.status} ${noName.json.error ?? ''}`.trim());
    const extraKey = await put(body([t2], { auto_share: true }));
    if (extraKey.status !== 400 || !/^Unknown key: profile\.auto_share/.test(extraKey.json.error ?? '')) problems.push(`an unknown profile key gave ${extraKey.status}`);
    const topKey = await put({ ...body([t2]), share_new: true });
    if (topKey.status !== 400 || !/^Unknown key: share_new/.test(topKey.json.error ?? '')) problems.push(`an unknown body key gave ${topKey.status}`);
    const off = await api('DELETE', `/api/people/profile?event=${PRIMARY}`, undefined, { device: E, label: 'E-delete' });
    if (off.status !== 200) problems.push(`delete gave ${off.status}`);
    report(problems.length === 0, 'p12: the writes behind the auto-share switch are accepted, and a rejection says why', problems.length ? problems.join('; ') : 'share, re-send, mark and unmark all 200; unknown topic, missing name and unknown keys 400 with their reasons');
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

  // The reasons on a suggestion must name only topics the request sent. A user who removes
  // Kubernetes from their profile must never be told a talk matched on it.
  const labelOf = new Map((topicsBySlug.get(PRIMARY) ?? []).map((t) => [t.topic_id, t.label]));
  const ask = (learn, speak) => api('POST', '/api/recommendations', { event: PRIMARY, learn_topics: learn, speak_topics: speak, interests: '', expertise: '', interested_talk_ids: [], size: 50 }, { label: 'recs' });
  const whyProblems = (results, learn, speak) => {
    const labels = (ids) => new Set(ids.map((id) => labelOf.get(id)));
    const learnSet = labels(learn);
    const speakSet = labels(speak);
    const inSet = (list, set) => (list ?? []).every((l) => set.has(l));
    const out = [];
    for (const r of results) {
      const w = r.why ?? {};
      if (!inSet(w.topics, new Set([...learnSet, ...speakSet]))) out.push(`"${r.title}" names a topic that was not sent: ${(w.topics ?? []).join(', ')}`);
      if (!inSet(w.learn_topics, learnSet)) out.push(`"${r.title}" lists a learn topic that was not sent`);
      if (!inSet(w.speak_topics, speakSet)) out.push(`"${r.title}" lists a speak topic that was not sent`);
      if ((w.speak_topics ?? []).some((l) => (w.learn_topics ?? []).includes(l))) out.push(`"${r.title}" repeats a topic in both sets`);
      if (JSON.stringify(w.topics) !== JSON.stringify([...(w.learn_topics ?? []), ...(w.speak_topics ?? [])])) out.push(`"${r.title}" has a why.topics that is not learn then speak`);
    }
    return out;
  };

  await check('r3: a request without kubernetes never names kubernetes in why', async () => {
    if (!labelOf.has('kubernetes') || !labelOf.has('ai') || !labelOf.has('agents')) {
      skip('r3: a request without kubernetes never names kubernetes in why', 'the conference has no kubernetes, ai or agents topic');
      return;
    }
    const learn = ['ai', 'agents'];
    const r = await ask(learn, []);
    if (r.status !== 200) throw new Error(`status ${r.status}`);
    const results = r.json.results ?? [];
    const problems = whyProblems(results, learn, []);
    for (const x of results) {
      const named = [...(x.why?.topics ?? []), ...(x.why?.learn_topics ?? []), ...(x.why?.speak_topics ?? [])];
      if (named.some((l) => /kubernetes/i.test(l))) problems.push(`"${x.title}" names Kubernetes`);
    }
    // The check has teeth only when some returned talk really carries the kubernetes topic.
    const carries = results.some((x) => (x.topics ?? []).some((t) => t.topic_id === 'kubernetes'));
    if (!carries) problems.push('no returned talk carries the kubernetes topic, so the check proves nothing');
    const unique = [...new Set(problems)];
    report(unique.length === 0, 'r3: a request without kubernetes never names kubernetes in why', unique.length ? unique.slice(0, 3).join('; ') : `${results.length} suggestions, none name Kubernetes`);
  });

  await check('r4: the topics in why are a subset of the request, split by set', async () => {
    const have = (ids) => ids.filter((id) => labelOf.has(id));
    const cases = [
      [have(['ai', 'agents']), have(['kubernetes'])],
      [have(['kubernetes']), have(['ai'])],
      [have(['ebpf', 'gpu']), have(['llm', 'kubernetes'])],
      [have(['kubernetes', 'ai']), have(['kubernetes'])],
      [[...labelOf.keys()].slice(0, 5), [...labelOf.keys()].slice(3, 8)],
    ].filter(([learn, speak]) => learn.length + speak.length > 0);
    const problems = [];
    let sawSpeak = false;
    for (const [learn, speak] of cases) {
      const r = await ask(learn, speak);
      if (r.status !== 200) {
        problems.push(`status ${r.status}`);
        continue;
      }
      const results = r.json.results ?? [];
      problems.push(...whyProblems(results, learn, speak));
      if (results.some((x) => (x.why?.speak_topics ?? []).length > 0)) sawSpeak = true;
    }
    if (!sawSpeak) problems.push('no suggestion named a topic from the speak set, so the split is untested');
    const unique = [...new Set(problems)];
    report(unique.length === 0, 'r4: the topics in why are a subset of the request, split by set', unique.length ? unique.slice(0, 3).join('; ') : `${cases.length} requests checked`);
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
// Related talks.

await check('rel1: GET /api/related returns up to five other talks of the same conference', async () => {
  if (!firstTopResult) throw new Error('query 1 returned no results');
  const self = firstTopResult.talk_id;
  const { status, json } = await api('GET', `/api/related?event=${encodeURIComponent(PRIMARY)}&talk_id=${encodeURIComponent(self)}`);
  if (status !== 200) throw new Error(`status ${status}`);
  const results = json.results ?? [];
  const ids = results.map((r) => r.talk_id);
  const ok = results.length >= 1 && results.length <= 5 && !ids.includes(self) && new Set(ids).size === ids.length && results.every((r) => r.conference === PRIMARY && r.title && r.url);
  report(ok, 'rel1: GET /api/related returns up to five other talks of the same conference', `${results.length} results, the first is "${results[0]?.title ?? ''}"`);
});

await check('rel2: GET /api/related validates its input', async () => {
  const good = firstTopResult?.talk_id ?? `${PRIMARY}:1`;
  const bad = await api('GET', `/api/related?event=${encodeURIComponent(PRIMARY)}&talk_id=${encodeURIComponent('not an id')}`);
  const extra = await api('GET', `/api/related?event=${encodeURIComponent(PRIMARY)}&talk_id=${encodeURIComponent(good)}&x=1`);
  const missing = await api('GET', `/api/related?event=${encodeURIComponent(PRIMARY)}&talk_id=${encodeURIComponent(`${PRIMARY}:no-such-talk`)}`);
  const post = await api('POST', '/api/related', {});
  report(bad.status === 400 && extra.status === 400 && missing.status === 404 && post.status === 405, 'rel2: GET /api/related validates its input',
    `bad id ${bad.status}, extra parameter ${extra.status}, unknown talk ${missing.status}, POST ${post.status}`);
});

// Rate limiting. The burst goes to an unknown /api path, which has a bucket of its own (60 a
// minute per address), so no other check here is affected.

await check('rl1: a burst of requests gets 429 with Retry-After, and the other endpoints still answer', async () => {
  const burst = await Promise.all(Array.from({ length: 80 }, () =>
    fetch(`${BASE_URL}/api/rate-limit-probe`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) }).then(async (r) => { await r.arrayBuffer(); return r; })));
  const limited = burst.filter((r) => r.status === 429);
  const retryAfter = Number(limited[0]?.headers.get('retry-after'));
  const health = await fetch(`${BASE_URL}/api/health`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  const ok = limited.length >= 1 && burst.every((r) => r.status === 404 || r.status === 429) && Number.isInteger(retryAfter) && retryAfter >= 1 && health.status === 200;
  report(ok, 'rl1: a burst of requests gets 429 with Retry-After, and the other endpoints still answer',
    `${limited.length} of ${burst.length} limited, Retry-After ${retryAfter}, health ${health.status}`);
});

// Install onboarding.

await check('inst1: the manifest makes the app installable and the page links it', async () => {
  const m = await fetch(`${BASE_URL}/manifest.webmanifest`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  const manifest = await m.json();
  const page = await (await fetch(`${BASE_URL}/`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })).text();
  const icons = manifest.icons ?? [];
  const ok = m.status === 200 && manifest.display === 'standalone' && manifest.start_url && icons.some((i) => i.sizes === '192x192') && icons.some((i) => i.sizes === '512x512') && /rel="manifest"/.test(page);
  report(ok, 'inst1: the manifest makes the app installable and the page links it', `display ${manifest.display}, ${icons.length} icons`);
});

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
    // i. The install card ships in the bundle with its Android and iOS wording.
    const js = files.filter((f) => f.endsWith('.js')).map((f) => readFileSync(f, 'utf8')).join('\n');
    const wording = ['beforeinstallprompt', 'Add to Home screen', 'Add to Home Screen', 'caddie.install.offered.v1'].filter((w) => !js.includes(w));
    report(wording.length === 0, 'inst2: the bundle ships the install card with the Android and iOS wording', wording.length ? `missing ${wording.join(', ')}` : 'all four strings found');
    report(hits.length === 0, 'e: bundle holds no keys, key-shaped strings or scheduling wording', hits.length ? hits.join('; ') : `${files.length} files, ${secrets.length} key values and ${patterns.length} patterns checked`);
  }
}

process.exit(failures ? 1 : 0);
