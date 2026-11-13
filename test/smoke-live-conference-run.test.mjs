// scripts/smoke.mjs end to end against a loopback stub: the live conference of the clock-dependent checks
// (scripts/lib/smoke-live-conference.mjs). The stub serves GET /api/conferences, the published bundles
// (conferences.json and each bundle.json, with talks placed around the real clock), the topic lists, the
// schedules and a For-you endpoint that, like the server, suggests only talks whose end is after now.
// Nine runs:
//   - the primary conference is live: the clock-dependent checks ask it, with the KubeCon topics;
//   - the primary is live but its AI talks have ended: r6 learns agents, which still shares a talk with
//     Kubernetes, instead of failing on "no results";
//   - the primary is live but For you answers nothing: the checks FAIL, they do not SKIP;
//   - the primary has ended and a later conference is live: they ask that one, with its own topics, and
//     r7, which stays on the primary, prints SKIP;
//   - no conference is live: every one of them prints SKIP with the reason and none prints PASS or asks
//     For you anything, and the counts at the end count them as SKIP;
//   - SMOKE_LIVE_CONFERENCE names a live conference: it is used; naming one with no published bundle uses
//     its schedule in place of the expected talks; naming an unavailable one is a FAIL.
// Most other checks fail against the stub; only the lines named here matter. Nothing reaches the network:
// BASE_URL and SMOKE_BUNDLE_BASE point at the stub, and the bundle scan and the external GET are skipped.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SMOKE = fileURLToPath(new URL('../scripts/smoke.mjs', import.meta.url));
const PRIMARY = 'kubecon-cloudnativecon-north-america-2026';
const EXTRA = 'stub-extra-2026';
const LIVE = 'stub-live-2026';
const LATER = 'stub-later-2026';
const UNAVAILABLE = 'stub-unavailable-2026';
const OLD = 'stub-old-2026'; // listed as ended three days ago, whatever its bundle says
const UNPUBLISHED = 'stub-unpublished-2026'; // searchable, with talks to come, but no published bundle
const CIRCLE_TALK_TITLE = 'From Bytes to Traces: A Deep Dive into OpenTelemetry eBPF Instrumentation Internals';
const H = 3600_000;
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const iso = (ms) => new Date(ms).toISOString();

// The checks that run against the live conference, and the reason none qualifies.
const LIVE_CHECKS = ['e2', 'n2', 'p3', 'r1', 'r3', 'r4', 'r6', 'r8'];
const NONE_WHY = `every talk of ${PRIMARY} has ended and no other searchable conference has talks to come`;

// A conference's talks: every talk carries topics, so the For-you stub can answer from them. `offsetH`
// places the talks relative to the real clock (negative: ended). With `ambient`, one co-located event.
function talks(slug, offsetH, topicSets, { ambient = false, from = 0 } = {}) {
  const now = Date.now();
  const docs = topicSets.map((topics, k) => {
    const i = from + k;
    const start = now + (offsetH + k * 0.25) * H;
    return {
      talk_id: `${slug}:t${i}`, kind: 'talk', conference: slug,
      title: `Stub talk number ${i} about ${topics.join(' and ') || 'nothing'} at ${slug}`,
      speakers: [`Speaker ${i}`], room: 'Room 1', track: 'Main', tags: [], start: iso(start), end: iso(start + H / 2),
      day: iso(start).slice(0, 10), end_minutes: 0, topics,
    };
  });
  if (ambient) docs.push({ talk_id: `${slug}:amb`, kind: 'ambient', conference: slug, title: 'Solutions showcase', speakers: [], room: 'Hall', track: 'Solutions Showcase', tags: [], start: iso(now + offsetH * H), end: iso(now + (offsetH + 8) * H), day: iso(now).slice(0, 10), end_minutes: 0, topics: [] });
  return docs;
}

const KUBE_TOPICS = [['kubernetes', 'ai'], ['ai', 'agents'], ['kubernetes'], ['ai', 'gpu'], ['agents', 'kubernetes'], ['ebpf'], ['ai']];
const GRPC_TOPICS = [['grpc', 'python'], ['grpc', 'security'], ['grpc'], ['python', 'grpc'], ['grpc', 'ai'], ['ai']];
const labelOf = (id) => ({ ai: 'AI', grpc: 'gRPC', gpu: 'GPU', ebpf: 'eBPF' }[id] ?? id.charAt(0).toUpperCase() + id.slice(1));
const topicList = (docs) => {
  const n = new Map();
  for (const d of docs) for (const id of d.topics ?? []) n.set(id, (n.get(id) ?? 0) + 1);
  return [...n].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).map(([topic_id, talk_count]) => ({ topic_id, label: labelOf(topic_id), talk_count }));
};

// Listed dates relative to the real clock, so the 36-hour end-date pass-over never depends on the day the
// test runs: by default the conference started three days ago and ends in two.
const isoDate = (ms) => iso(ms).slice(0, 10);
const conference = (slug, status, docs, endDate = isoDate(Date.now() + 48 * H)) => ({
  slug, name: slug, start_date: isoDate(Date.now() - 72 * H), end_date: endDate, time_zone: status === 'searchable' ? 'UTC' : null,
  location: { city: '', region: '', country: '', virtual: true }, status, official_schedule_url: 'https://example.org/schedule/',
  source: 'sessionize', has_level: false, track_group: null, tag_groups: [], talk_count: docs.filter((d) => d.kind === 'talk').length,
});

// The stub backend. bundles: slug -> items (every kind), which the API serves; order: the GET
// /api/conferences order, each [slug, status, listed end date (optional)]. With forYouEmpty, For you
// answers no talk to any request; the conferences in unpublished have no bundle in the index.
function stubBackend(order, bundles, { forYouEmpty = false, unpublished = [] } = {}) {
  const requests = [];
  const files = new Map(); // path under /bundles/ -> bytes
  const entries = order.map(([slug, status, endDate]) => {
    const docs = bundles[slug] ?? [];
    const conf = conference(slug, status, docs, endDate);
    if (status !== 'searchable' || unpublished.includes(slug)) return { ...conf, bundle: null };
    const bytes = Buffer.from(JSON.stringify({ bundle_version: 1, conference: conf, talks: docs }));
    const hash = sha(bytes);
    const path = `${slug}/${hash.slice(0, 16)}/`;
    files.set(`${path}bundle.json`, bytes);
    return {
      ...conf,
      bundle: {
        bundle_version: 1, content_hash: hash, path, model: 'BAAI/bge-small-en-v1.5', dims: 384, talk_count: conf.talk_count, vector_count: conf.talk_count,
        files: { 'bundle.json': { bytes: bytes.length, sha256: hash }, 'vectors.i8': { bytes: 0, sha256: sha(Buffer.alloc(0)) } },
      },
    };
  });
  files.set('conferences.json', Buffer.from(JSON.stringify({ index_version: 1, generated_at: iso(Date.now()), publisher: { name: 'stub', takedown: 'https://example.org/takedown' }, conferences: entries })));
  const json = (res, status, body) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const url = new URL(req.url, 'http://stub');
      let body = null;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null'); } catch { /* not JSON */ }
      requests.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), body });
      if (url.pathname.startsWith('/bundles/')) {
        const bytes = files.get(url.pathname.slice('/bundles/'.length));
        if (!bytes) return json(res, 404, { error: 'Not found' });
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(bytes);
      }
      if (url.pathname === '/api/health') return json(res, 200, { ok: true });
      if (url.pathname === '/api/conferences') return json(res, 200, { conferences: entries.map(({ bundle, ...c }) => c) });
      if (url.pathname === '/api/topics' && req.method === 'GET') return json(res, 200, { topics: topicList(bundles[url.searchParams.get('event')] ?? []) });
      if (url.pathname === '/api/schedule' && req.method === 'GET') {
        const event = url.searchParams.get('event');
        const scheduled = (bundles[event] ?? []).filter((d) => d.kind === 'talk').map((t) => ({ ...t, topics: t.topics.map((id) => ({ topic_id: id, label: labelOf(id) })) }));
        return json(res, 200, { conference: event, talks: scheduled });
      }
      if (url.pathname === '/api/search' && req.method === 'POST') {
        const f = body?.filters ?? {};
        if ('include_events' in f && typeof f.include_events !== 'boolean') return json(res, 400, { error: 'include_events must be a boolean' });
        if ('happening_now' in f && typeof f.happening_now !== 'boolean') return json(res, 400, { error: 'happening_now must be a boolean' });
        if (f.happening_now === true || body?.conference !== PRIMARY) return json(res, 200, { results: [], total: 0 });
        // The people checks start by finding the circle talk.
        return json(res, 200, { results: [{ talk_id: `${PRIMARY}:circle`, title: CIRCLE_TALK_TITLE, conference: PRIMARY }], total: 1 });
      }
      if (url.pathname === '/api/people/profile' && req.method === 'PUT') return json(res, 200, { ok: true, ref: 'r', shared_talk_ids: body?.shared_talk_ids ?? [] });
      if (url.pathname === '/api/people/matches' && req.method === 'POST') return json(res, 200, { results: [{ display_name: 'Someone', reasons: ['Ask them about it'], opener: 'Ask them about it' }] });
      if (url.pathname === '/api/recommendations' && req.method === 'POST') {
        // As the server: learn topics only, talks whose end is after now, never a marked one.
        const learn = body.learn_topics ?? [];
        if (!learn.length && !body.interests) return json(res, 200, { results: [], needs_profile: true });
        if (forYouEmpty) return json(res, 200, { results: [] });
        const marked = new Set(body.interested_talk_ids ?? []);
        const now = Date.now();
        const pool = (bundles[body.event] ?? []).filter((d) => d.kind === 'talk' && Date.parse(d.end) > now && !marked.has(d.talk_id));
        const scored = learn.length
          ? pool.map((t) => ({ t, n: t.topics.filter((id) => learn.includes(id)).length })).filter((x) => x.n).sort((a, b) => b.n - a.n || Date.parse(a.t.start) - Date.parse(b.t.start)).map((x) => x.t)
          : pool;
        const results = scored.slice(0, body.size ?? 10).map((t) => {
          const named = learn.filter((id) => t.topics.includes(id)).map(labelOf);
          return { talk_id: t.talk_id, conference: t.conference, title: t.title, start: t.start, end: t.end, topics: t.topics.map((id) => ({ topic_id: id, label: labelOf(id) })), why: { topics: named, learn_topics: named, passage: null } };
        });
        return json(res, 200, { results });
      }
      return json(res, 404, { error: 'Not found' });
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, requests })));
}

function runSmoke(port, extraEnv = {}) {
  const home = mkdtempSync(join(tmpdir(), 'slive-smoke-home-'));
  return new Promise((resolve) => {
    const env = {
      PATH: process.env.PATH,
      HOME: home,
      CADDIE_ADMIN_HOME: join(home, 'none'),
      BASE_URL: `http://127.0.0.1:${port}`,
      SMOKE_API: 'worker',
      SMOKE_TALKS: 'bundle',
      SMOKE_BUNDLE_BASE: `http://127.0.0.1:${port}/bundles/`,
      SMOKE_EXTRA: EXTRA,
      SMOKE_SKIP_BUNDLE: '1',
      SMOKE_SKIP_EXTERNAL: '1',
      // The loopback stub stands for a deployed backend: the Bluetooth checks that wait stay off.
      SMOKE_TREAT_AS_REMOTE: '1',
      ...extraEnv,
    };
    const child = spawn(process.execPath, [SMOKE], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => {
      rmSync(home, { recursive: true, force: true });
      resolve({ code, stdout, stderr, lines: stdout.split('\n') });
    });
  });
}

const linesOf = (run, id) => run.lines.filter((l) => /^(PASS|FAIL|SKIP) /.test(l) && l.slice(5).startsWith(`${id}:`));
const lineOf = (run, id) => {
  const found = linesOf(run, id);
  assert.equal(found.length, 1, `${id} prints one line:\n${found.join('\n')}`);
  return found[0];
};
const liveNote = (run) => run.lines.find((l) => l.startsWith('NOTE live conference:'));
// The For-you requests that asked for learn topics, by conference.
const learnAsked = (requests) => requests.filter((r) => r.path === '/api/recommendations' && (r.body?.learn_topics ?? []).length > 0);
// The counts on the last line agree with the lines printed: a SKIP is never counted as a PASS.
function assertSummary(run) {
  const summary = run.lines.filter(Boolean).at(-1);
  const n = (word) => run.lines.filter((l) => l.startsWith(`${word} `)).length;
  assert.equal(summary, `SUMMARY ${n('PASS')} PASS, ${n('FAIL')} FAIL, ${n('SKIP')} SKIP`);
}

const ended = (slug, sets = KUBE_TOPICS) => talks(slug, -30, sets, { ambient: true });

describe('scripts/smoke.mjs live conference', { timeout: 600_000 }, () => {
  const runs = {};
  const stubs = [];
  before(async () => {
    const aiEnded = [
      ...talks(PRIMARY, -30, [['ai', 'kubernetes'], ['ai'], ['ai', 'gpu']]),
      ...talks(PRIMARY, 2, [['kubernetes', 'agents'], ['agents'], ['kubernetes'], ['agents', 'gpu']], { from: 3 }),
    ];
    const scenarios = {
      primaryLive: [[[PRIMARY, 'searchable'], [EXTRA, 'searchable'], [LIVE, 'searchable']], { [PRIMARY]: talks(PRIMARY, 2, KUBE_TOPICS, { ambient: true }), [EXTRA]: ended(EXTRA), [LIVE]: talks(LIVE, 2, GRPC_TOPICS) }, {}],
      aiEnded: [[[PRIMARY, 'searchable'], [EXTRA, 'searchable']], { [PRIMARY]: aiEnded, [EXTRA]: ended(EXTRA) }, {}],
      forYouEmpty: [[[PRIMARY, 'searchable'], [EXTRA, 'searchable']], { [PRIMARY]: talks(PRIMARY, 2, KUBE_TOPICS, { ambient: true }), [EXTRA]: ended(EXTRA) }, {}, { forYouEmpty: true }],
      fallback: [[[PRIMARY, 'searchable'], [UNAVAILABLE, 'unavailable'], [EXTRA, 'searchable'], [OLD, 'searchable', isoDate(Date.now() - 72 * H)], [LIVE, 'searchable'], [LATER, 'searchable']], { [PRIMARY]: ended(PRIMARY), [EXTRA]: ended(EXTRA), [OLD]: talks(OLD, 2, GRPC_TOPICS), [LIVE]: talks(LIVE, 2, GRPC_TOPICS, { ambient: true }), [LATER]: talks(LATER, 5, KUBE_TOPICS) }, {}],
      unpublished: [[[PRIMARY, 'searchable'], [EXTRA, 'searchable'], [UNPUBLISHED, 'searchable']], { [PRIMARY]: ended(PRIMARY), [EXTRA]: ended(EXTRA), [UNPUBLISHED]: talks(UNPUBLISHED, 2, GRPC_TOPICS) }, { SMOKE_LIVE_CONFERENCE: UNPUBLISHED }, { unpublished: [UNPUBLISHED] }],
      none: [[[PRIMARY, 'searchable'], [UNAVAILABLE, 'unavailable'], [EXTRA, 'searchable'], [LIVE, 'searchable']], { [PRIMARY]: ended(PRIMARY), [EXTRA]: ended(EXTRA), [LIVE]: ended(LIVE, GRPC_TOPICS) }, {}],
      override: [[[PRIMARY, 'searchable'], [EXTRA, 'searchable'], [LIVE, 'searchable'], [LATER, 'searchable']], { [PRIMARY]: ended(PRIMARY), [EXTRA]: ended(EXTRA), [LIVE]: talks(LIVE, 2, GRPC_TOPICS), [LATER]: talks(LATER, 5, KUBE_TOPICS) }, { SMOKE_LIVE_CONFERENCE: LATER }],
      badOverride: [[[PRIMARY, 'searchable'], [UNAVAILABLE, 'unavailable'], [EXTRA, 'searchable'], [LIVE, 'searchable']], { [PRIMARY]: ended(PRIMARY), [EXTRA]: ended(EXTRA), [LIVE]: talks(LIVE, 2, GRPC_TOPICS) }, { SMOKE_LIVE_CONFERENCE: UNAVAILABLE }],
    };
    await Promise.all(Object.entries(scenarios).map(async ([name, [order, bundles, env, opts]]) => {
      const stub = await stubBackend(order, bundles, opts);
      stubs.push(stub);
      runs[name] = { ...(await runSmoke(stub.port, env)), requests: stub.requests };
    }));
  });
  after(() => {
    for (const s of stubs) s.server.close();
  });

  test('every run finishes, and its last line counts PASS, FAIL and SKIP as printed', () => {
    for (const [name, run] of Object.entries(runs)) {
      assert.ok(run.lines.some((l) => l.startsWith('PASS p0:')), `${name}: the people checks ran\n${run.stderr}`);
      assertSummary(run);
    }
  });

  test('primary live: the primary conference, asked with the KubeCon topics', () => {
    const run = runs.primaryLive;
    assert.match(liveNote(run), new RegExp(`^NOTE live conference: ${PRIMARY} \\(the primary conference, 7 talks to come\\); the For-you part of e2`));
    for (const id of ['e2', 'p3', 'r1', 'r3', 'r4', 'r6', 'r8']) assert.match(lineOf(run, id), /^PASS /, id);
    assert.match(lineOf(run, 'r3'), new RegExp(`^PASS r3: a request without a topic never names that topic in why \\(${PRIMARY}: \\d+ suggestions for ai and agents, some carrying kubernetes, none name Kubernetes\\)`));
    assert.match(lineOf(run, 'n2'), new RegExp(`^SKIP n2: .*no talk of ${PRIMARY} is in progress`));
    assert.doesNotMatch(lineOf(run, 'r7'), /^SKIP /, 'r7 runs while the primary has talks to come');
    const asked = new Set(learnAsked(run.requests).map((r) => r.body.event));
    assert.deepEqual([...asked].sort(), [EXTRA, PRIMARY].sort(), 'r2 asks the extra conference; every other For-you request the primary');
  });

  test('primary live with its AI talks over: r6 learns agents, which still shares a talk with Kubernetes', () => {
    const run = runs.aiEnded;
    assert.match(lineOf(run, 'r6'), new RegExp(`^PASS r6: .*\\(${PRIMARY}, learn agents, speak kubernetes: \\d+ results identical`));
    assert.match(lineOf(run, 'r3'), /^PASS r3: .*suggestions for ai and agents, some carrying kubernetes, none name Kubernetes\)$/);
    for (const id of ['p3', 'r1', 'r4', 'r8']) assert.match(lineOf(run, id), /^PASS /, id);
  });

  test('primary live but For you answers nothing: the clock-dependent checks FAIL instead of skipping', () => {
    const run = runs.forYouEmpty;
    assert.match(liveNote(run), new RegExp(`^NOTE live conference: ${PRIMARY} \\(the primary conference`));
    for (const id of ['e2', 'p3', 'r1', 'r3', 'r4', 'r6', 'r8']) assert.match(lineOf(run, id), /^FAIL /, id);
    assert.match(lineOf(run, 'r2'), new RegExp(`^FAIL r2: .*${PRIMARY} has talks to come on .* but got no suggestion`), 'r2 does not skip when the live conference suggests nothing');
    assert.equal(run.code, 1);
  });

  test('primary ended and another live: the checks ask that conference with its own topics, and say so', () => {
    const run = runs.fallback;
    assert.match(liveNote(run), new RegExp(`^NOTE live conference: ${LIVE} \\(every talk of ${PRIMARY} has ended; ${LIVE} is the first searchable conference of GET /api/conferences with talks to come \\(6\\); passed over: ${EXTRA}: every talk of ${EXTRA} has ended; ${OLD}: ended on ${isoDate(Date.now() - 72 * H)}\\)`));
    assert.ok(!run.requests.some((r) => r.path.startsWith(`/bundles/${OLD}/`)), 'a conference listed as long over is not downloaded');
    for (const id of ['e2', 'p3', 'r1', 'r3', 'r4', 'r6', 'r8']) assert.match(lineOf(run, id), new RegExp(`^PASS .*${LIVE}`), id);
    // gRPC is LIVE's topic with the most talks to come; AI and Python are the two with the most talks to
    // come that share one with it (security shares one too, but has fewer).
    assert.match(lineOf(run, 'r3'), /\(stub-live-2026: 4 suggestions for ai and python, some carrying grpc, none name gRPC\)$/);
    assert.match(lineOf(run, 'n2'), new RegExp(`^SKIP n2: .*no talk of ${LIVE} is in progress`));
    assert.match(lineOf(run, 'r7'), new RegExp(`^SKIP r7: .*every talk of ${PRIMARY} has ended .*stays on the primary conference`));
    const asked = learnAsked(run.requests);
    assert.ok(asked.length >= 12, 'the live checks asked For you');
    for (const r of asked) assert.ok([LIVE, EXTRA].includes(r.body.event), `asked ${r.body.event}`);
    for (const r of asked.filter((x) => x.body.event === LIVE)) for (const id of r.body.learn_topics) assert.ok(['grpc', 'python', 'security', 'ai'].includes(id), `a KubeCon topic was sent to ${LIVE}: ${id}`);
    assert.ok(!run.requests.some((r) => r.path === '/api/topics' && r.query.event === LATER), 'only the first live conference is read');
    assert.ok(run.lines.includes(`NOTE ${['the For-you part of e2', 'the window part of n2', 'the talk part of p3', 'r1', 'r3', 'r4', 'r6 and r8'].join(', ')} ran against ${LIVE}, not the primary conference (${run.lines.find((l) => l.startsWith('NOTE live conference:')).match(/\((every talk.*)\); the For-you/)[1]})`));
    assert.ok(run.lines.some((l) => l.startsWith('NOTE r7 stays on the primary conference')), 'the fallback check is named');
  });

  test('none live: every clock-dependent check prints SKIP with the reason, never PASS, and asks For you nothing', () => {
    const run = runs.none;
    assert.equal(liveNote(run), `NOTE live conference: none (${NONE_WHY}); the For-you part of e2, the window part of n2, the talk part of p3, r1, r3, r4, r6 and r8 print SKIP`);
    for (const id of LIVE_CHECKS) {
      const line = lineOf(run, id);
      assert.ok(line.startsWith('SKIP '), line);
      assert.ok(line.endsWith(`${NONE_WHY})`), line);
    }
    assert.match(lineOf(run, 'e2'), /\(the boolean check passed \(include_events "yes" gave 400\); the For-you part: every talk/);
    assert.match(lineOf(run, 'p3'), /\(the people part passed \(1 people\); the talk part: every talk/);
    assert.deepEqual(learnAsked(run.requests).map((r) => r.body.event).filter((e) => e !== EXTRA), [], 'no For-you request with topics went anywhere but r2\'s extra conference');
    assert.ok(!run.requests.some((r) => r.path === '/api/topics' && r.query.event === LIVE), 'no conference was probed');
    assert.ok(run.lines.includes(`NOTE 8 checks skipped because ${NONE_WHY}; set SMOKE_LIVE_CONFERENCE to a searchable conference with talks to come to run them`));
    const summary = run.lines.filter(Boolean).at(-1);
    const skips = Number(summary.match(/(\d+) SKIP$/)[1]);
    assert.ok(skips >= LIVE_CHECKS.length + 1, `the ${LIVE_CHECKS.length} checks and r7 are counted as SKIP: ${summary}`);
  });

  test('SMOKE_LIVE_CONFERENCE: the named conference is used ahead of the first live one', () => {
    const run = runs.override;
    assert.match(liveNote(run), new RegExp(`^NOTE live conference: ${LATER} \\(SMOKE_LIVE_CONFERENCE, 7 talks to come\\)`));
    for (const id of ['p3', 'r1', 'r3', 'r4', 'r6', 'r8']) assert.match(lineOf(run, id), new RegExp(`^PASS .*${LATER}`), id);
    for (const r of learnAsked(run.requests)) assert.ok([LATER, EXTRA].includes(r.body.event), `asked ${r.body.event}`);
  });

  test('SMOKE_LIVE_CONFERENCE naming a conference with no published bundle: its schedule stands in for the expected talks', () => {
    const run = runs.unpublished;
    assert.match(liveNote(run), new RegExp(`^NOTE live conference: ${UNPUBLISHED} \\(SMOKE_LIVE_CONFERENCE; its talks could not be read: the published bundle of ${UNPUBLISHED}: the published index has no bundle for it, so it is taken as live\\)`));
    for (const id of ['p3', 'r1', 'r2', 'r3', 'r4', 'r6', 'r8']) assert.match(lineOf(run, id), /^PASS /, id);
    assert.match(lineOf(run, 'e2'), new RegExp(`^SKIP e2: .*the expected items of ${UNPUBLISHED} could not be read`));
    assert.match(lineOf(run, 'n2'), new RegExp(`^SKIP n2: .*no talk of ${UNPUBLISHED} is in progress`));
  });

  test('SMOKE_LIVE_CONFERENCE naming a conference that is not searchable is a FAIL, and the checks SKIP with that reason', () => {
    const run = runs.badOverride;
    const why = `SMOKE_LIVE_CONFERENCE=${UNAVAILABLE} is not a searchable conference of GET /api/conferences`;
    assert.ok(run.lines.includes(`FAIL live: SMOKE_LIVE_CONFERENCE names a searchable conference (${why})`));
    assert.equal(run.code, 1);
    for (const id of LIVE_CHECKS) assert.ok(lineOf(run, id).startsWith('SKIP ') && lineOf(run, id).endsWith(`${why})`), lineOf(run, id));
  });
});
