// End-to-end smoke test for the search API and the built web bundle.
//
// Usage: BASE_URL=http://localhost:8080 node scripts/smoke.mjs
// Env:   BASE_URL (default http://localhost:8080), SMOKE_SKIP_BUNDLE=1 to skip the bundle scan
//        when web/dist has not been built. The bundle scan compares the values of
//        ELASTISEARCH_API_KEY, GC_API_KEY and ES_READONLY_KEY in-process and never prints them.
//
// Each check prints one PASS, FAIL or SKIP line. The script exits 1 if any check fails.

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE_URL = (process.env.BASE_URL || 'http://localhost:8080').replace(/\/$/, '');
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const REQUEST_TIMEOUT_MS = 20000;

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

const BUNDLE_SECRET_VARS = ['ELASTISEARCH_API_KEY', 'GC_API_KEY', 'ES_READONLY_KEY'];
const BUNDLE_PATTERNS = ['ApiKey ', '.es.io', 'AIza', 'BEGIN PRIVATE KEY', 'MOCK_FIXTURE_DO_NOT_SHIP'];

let failures = 0;
function report(ok, name, detail = '') {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`);
}

// Every search response seen, so the evidence check can cover all of them.
const allResults = [];

async function search(body) {
  let lastError;
  // One retry, because the Elastic Cloud endpoint is occasionally slow to connect.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(`${BASE_URL}/api/search`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      const json = await res.json().catch(() => ({}));
      if (res.status >= 500 && attempt === 0) {
        lastError = new Error(`status ${res.status}`);
        continue;
      }
      if (res.ok) allResults.push(...(json.results ?? []));
      return { status: res.status, json };
    } catch (err) {
      lastError = err;
    }
  }
  throw new Error(`search request failed: ${lastError?.message ?? 'unknown error'}`);
}

const overlaps = (a, b) => Date.parse(a.start) < Date.parse(b.end) && Date.parse(a.end) > Date.parse(b.start);

async function check(name, fn) {
  try {
    await fn();
  } catch (err) {
    report(false, name, err.message);
  }
}

// a. Each query has its expected talk in the top five.
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

// c. Saving the top result of query 1 removes it and every talk that overlaps it in time.
await check('c: saved talk and its time conflicts are excluded', async () => {
  if (!firstTopResult) throw new Error('query 1 returned no results');
  const saved = firstTopResult;
  const requests = [...QUERIES.map(({ query }) => ({ query, size: 50 })), { query: '', size: 50 }];
  let checked = 0;
  const problems = [];
  for (const body of requests) {
    const { status, json } = await search({ ...body, saved_talk_ids: [saved.talk_id] });
    if (status !== 200) throw new Error(`status ${status} for ${body.query ? `"${body.query}"` : 'browse'}`);
    for (const r of json.results ?? []) {
      checked++;
      if (r.talk_id === saved.talk_id) problems.push('the saved talk was returned');
      else if (overlaps(r, saved)) problems.push(`"${r.title}" overlaps the saved talk`);
    }
  }
  report(problems.length === 0, 'c: saved talk and its time conflicts are excluded', problems.length ? problems.slice(0, 3).join('; ') : `${checked} results checked against "${saved.title}"`);
});

// d. No break, housekeeping or ambient item is ever returned.
await check('d: no break, housekeeping or ambient item appears', async () => {
  const docs = readFileSync(join(ROOT, 'data', 'talks.ndjson'), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
  const nonTalk = new Map(docs.filter((d) => d.kind !== 'talk').map((d) => [d.talk_id, d]));
  const browse = await search({ query: '', size: 1 });
  if (browse.status !== 200) throw new Error(`status ${browse.status}`);
  const days = (browse.json.facets?.day ?? []).map((f) => f.value);
  if (!days.length) throw new Error('no day facet values');
  const requests = [
    ...NON_TALK_QUERIES.map((query) => ({ query, size: 50 })),
    ...days.map((day) => ({ query: '', size: 50, filters: { day } })),
  ];
  const leaked = [];
  for (const body of requests) {
    const { status, json } = await search(body);
    if (status !== 200) throw new Error(`status ${status}`);
    for (const r of json.results ?? []) if (nonTalk.has(r.talk_id)) leaked.push(`${nonTalk.get(r.talk_id).kind} "${r.title}"`);
  }
  report(leaked.length === 0, 'd: no break, housekeeping or ambient item appears', leaked.length ? leaked.slice(0, 3).join('; ') : `${requests.length} requests, ${nonTalk.size} non-talk items checked`);
});

// f. An unknown filter value is rejected.
await check('f: an unknown filter value returns 400', async () => {
  const { status } = await search({ query: 'kubernetes', filters: { track: ['No Such Track'] } });
  report(status === 400, 'f: an unknown filter value returns 400', `status ${status}`);
});

// b. Every result from every request above has non-empty evidence.
{
  const empty = allResults.filter((r) => typeof r.evidence !== 'string' || !r.evidence.trim());
  report(allResults.length > 0 && empty.length === 0, 'b: every result has non-empty evidence', empty.length ? `${empty.length} empty, for example "${empty[0].title}"` : `${allResults.length} results`);
}

// e. The built bundle holds no credential values or credential-shaped strings.
{
  const dist = join(ROOT, 'web', 'dist');
  if (!existsSync(dist)) {
    if (process.env.SMOKE_SKIP_BUNDLE === '1') console.log('SKIP e: web/dist does not exist and SMOKE_SKIP_BUNDLE=1');
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
    }
    report(hits.length === 0, 'e: bundle holds no keys or key-shaped strings', hits.length ? hits.join('; ') : `${files.length} files, ${secrets.length} key values and ${patterns.length} patterns checked`);
  }
}

process.exit(failures ? 1 : 0);
