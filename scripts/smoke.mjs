// End-to-end smoke test for the API and the built web bundle.
//
// Usage: BASE_URL=http://localhost:8080 node scripts/smoke.mjs
//
// It tests two stacks, each serving the web app and the API from one origin: the Cloud Run server,
// and the free stack's Cloudflare Worker, which serves the app as static assets. A build whose API
// is on another origin (the Vite dev server against a local Worker) is still supported: the script
// keeps the two addresses apart and adds the cross-origin checks.
//
// Env:
//   BASE_URL             the web app, including any base path, for example
//                        https://conference-caddie.<subdomain>.workers.dev. Default http://localhost:8080.
//   API_BASE             the API origin. Default: the origin of BASE_URL, so the Cloud Run and Worker
//                        command lines stay BASE_URL=... node scripts/smoke.mjs. When it differs from
//                        BASE_URL's origin, the API is taken to be the Worker.
//   SMOKE_API            worker or cloudrun: which API this is. Default: worker when API_BASE differs
//                        from BASE_URL's origin or an admin token is set, otherwise cloudrun. The Worker
//                        without an admin token needs SMOKE_API=worker.
//   SMOKE_ORIGIN         the Origin that browser-like requests to the Worker send, and that the CORS
//                        checks use. Default: the origin of BASE_URL. The Worker allows its own origin
//                        and the development origins in its ALLOWED_ORIGINS.
//   SMOKE_DIST           the built web app the bundle scan reads, relative to the repository root.
//                        Default web/dist-worker against the Worker on BASE_URL's origin, else web/dist.
//   ADMIN_TOKEN or ADMIN_TOKEN_FILE  the Worker's admin token (the file's first line is used). With it
//                        the three Elasticsearch helpers below are replaced by the Worker's test
//                        fixtures: POST /admin/test/profile (the expired profile),
//                        POST /admin/test/age-presence (the aged presence) and GET /admin/stats (the
//                        "an import stores nothing" counts), cleaned up with DELETE /admin/test/profile.
//                        Check meter1 also uses POST /admin/test/meter-restart (a new usage meter).
//                        The reports the run makes are removed at the end with POST /admin/moderation.
//                        The token is only ever used towards API_BASE: as the key of the X-Caddie-Admin
//                        signature (SMOKE_ADMIN_AUTH=signed) or as a bearer (SMOKE_ADMIN_AUTH=bearer).
//   SMOKE_ADMIN_AUTH     signed or bearer: how the admin calls authenticate. signed builds the
//                        X-Caddie-Admin header of scripts/lib/admin-sign.mjs for every admin call, with a
//                        fresh nonce and timestamp on each attempt, and sends no Authorization header;
//                        bearer sends Authorization: Bearer <token>, the scheme of a local or old Worker
//                        that does not have the signed admin routes (a current Worker answers it 404).
//                        Default signed. No admin request follows a redirect: a 3xx is a FAIL.
//                        When the Worker answers 404 to a /admin/test/* fixture while GET /admin/stats
//                        works, its test routes are gated off (ADMIN_TEST_ROUTES is not "1" on that
//                        Worker) and the checks that need them (meter1, the expired profile, the aged
//                        presence, unav1) print SKIP instead of FAIL.
//   SMOKE_CONFERENCE     the primary conference, default kubecon-cloudnativecon-north-america-2026.
//   SMOKE_EXTRA          comma-separated extra conferences, default
//                        mcp-dev-summit-nairobi-2026,pytorch-day-japan-2026.
//   SMOKE_SKIP_BUNDLE=1  skip the bundle scan when the web app (SMOKE_DIST) has not been built.
//   SMOKE_TALKS          bundle or data: where the checks that need a conference's own talks (d, e1,
//                        e2, n1, n2, m2, x, o, sch1 and the import picks) take them from. bundle (the
//                        default against a deployed Worker) reads the published talk bundles, the ones native
//                        clients use: the ingest run publishes them from the same fetch it pushes to
//                        the Worker, so a schedule change upstream moves both and passes, while a
//                        Worker that serves other talks than the bundles fails. data (the default
//                        against Cloud Run, whose index is loaded by hand, and against an API on
//                        localhost or 127.0.0.1, which is loaded from the seed) reads the committed
//                        data/ snapshot. Check bun1 compares every searchable conference with its bundle.
//   SMOKE_BUNDLE_BASE    the talk bundle base for SMOKE_TALKS=bundle, an https URL ending in "/" (or
//                        http://localhost or http://127.0.0.1 for a local test). Default https://kurtlehnardt.github.io/conferenceCaddie/bundles/.
//   SMOKE_STRICT=1       count every first-attempt 5xx or network error (the NOTE lines) as a failure at
//                        the end of the run, even when the retry passed. Default off.
//   SMOKE_SKIP_EXTERNAL=1 skip the one GET of an unavailable conference's official schedule link.
//   SMOKE_BLE=1          run the Bluetooth resolution checks (ble2) against a remote API. They put test
//                        profiles with a specific match around, so they run by default only against a
//                        local API (localhost or 127.0.0.1), never next to real attendees.
//   SMOKE_NATIVE_PUSH    the native push platforms this backend is expected to push to: "none", or a
//                        comma-separated list of apns and fcm. Check np2 then compares push.apns and
//                        push.fcm with it. Unset, np2 passes when both are false and is skipped when
//                        one is true, because the script cannot tell whether the backend should
//                        hold that platform's key.
//   SMOKE_UNAVAILABLE=<slug>  with an admin token and a local API: flip that conference to unavailable
//                        for check unav1 (an owner can still delete) and restore it. Never against a
//                        deployed Worker, because the conference would vanish from the app meanwhile.
//   ES_URL and ES_PEOPLE_API_KEY (or ELASTISEARCH_API_KEY): used only against Cloud Run, and only
//                        when there is no admin token, to write and remove one expired test profile
//                        directly, because the API can never create one, and to age one test profile's
//                        presence, because the API can never set it in the past. Without a key (or an
//                        admin token) those two checks are skipped.
//   ELASTISEARCH_API_KEY used also, against Cloud Run, to compare index document counts before and
//                        after the schedule imports (the import must store nothing). Without it, or an
//                        admin token, that check is skipped.
//
// The script creates its own temporary test profiles, each with a random device secret, and
// deletes them at the end, together with the blocks and meets they made. It never changes the
// seeded sample profiles. Key values and the admin token are compared in-process and never printed.
// The test profiles' words are synthetic and carry the run's tag, so they share no word with a
// real attendee of the live conference, and no nudge can pair one with a real attendee (see
// SMOKE_SUBJECT below).
//
// Each check prints one PASS, FAIL or SKIP line. The script exits 1 if any check fails. A request
// that answers 5xx or fails on its first attempt is retried once, and prints a NOTE line either way;
// with SMOKE_STRICT=1 those first-attempt failures also fail the run.

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { signAdminRequest, UsageError } from './lib/admin-sign.mjs';
import { MIN_UPCOMING, countUpcoming, pickUpcomingTopic } from './lib/smoke-topic-pick.mjs';
import { validator } from '../contracts/js/schemas.mjs';
import { decodeKey, deriveToken, encodeToken, windowOf } from '../contracts/js/ble-token.mjs';
import { readConferenceIndex, sha256hex, BUNDLE_FILE } from '../contracts/js/bundle.mjs';

const BASE_URL = (process.env.BASE_URL || 'http://localhost:8080').replace(/\/+$/, '');
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const REQUEST_TIMEOUT_MS = 30000;
const PRIMARY = process.env.SMOKE_CONFERENCE || 'kubecon-cloudnativecon-north-america-2026';
const EXTRA = (process.env.SMOKE_EXTRA ?? 'mcp-dev-summit-nairobi-2026,pytorch-day-japan-2026').split(',').map((s) => s.trim()).filter(Boolean);
const ES_URL = (process.env.ES_URL || 'https://fc875c88f9f44f159f1a359ee724d82b.us-west1.gcp.cloud.es.io:443').replace(/\/$/, '');
const ES_WRITE_KEY = process.env.ES_PEOPLE_API_KEY || process.env.ELASTISEARCH_API_KEY || '';
const PEOPLE_INDEX = process.env.ES_PEOPLE_INDEX || 'caddie-people';

// The web app address, the API address and the browser origin. Anything printed about an address is
// its origin only, never a user name, password or query, so a token in a URL cannot reach the log.
function parseAddress(value, name) {
  try {
    return new URL(value);
  } catch {
    console.log(`FAIL config: ${name} is not a valid URL`);
    process.exit(1);
  }
}
const BASE_ORIGIN = parseAddress(BASE_URL, 'BASE_URL').origin;
const API_BASE = (process.env.API_BASE || BASE_ORIGIN).replace(/\/+$/, '');
const API_ORIGIN = parseAddress(API_BASE, 'API_BASE').origin;
const SMOKE_ORIGIN = (process.env.SMOKE_ORIGIN || BASE_ORIGIN).replace(/\/+$/, '');
const BASE_PATH = new URL(BASE_URL).pathname.replace(/\/+$/, ''); // '' at the root, else '/conferenceCaddie'
const CROSS_ORIGIN_API = API_ORIGIN !== BASE_ORIGIN;
const EVIL_ORIGIN = 'https://evil.example';

// The admin token comes from the environment or from the first line of a file, and is never printed.
function readAdminToken() {
  if (process.env.ADMIN_TOKEN) return process.env.ADMIN_TOKEN.trim();
  const file = process.env.ADMIN_TOKEN_FILE;
  if (!file) return '';
  try {
    return readFileSync(file, 'utf8').split('\n')[0].trim();
  } catch {
    console.log('FAIL config: ADMIN_TOKEN_FILE cannot be read');
    process.exit(1);
  }
}
const ADMIN_TOKEN = readAdminToken();

// How the admin calls authenticate (SMOKE_ADMIN_AUTH above). The signed scheme needs a key of at
// least 32 characters, which the Worker requires of ADMIN_TOKEN anyway.
const ADMIN_AUTH = (process.env.SMOKE_ADMIN_AUTH || 'signed').toLowerCase();
if (!['signed', 'bearer'].includes(ADMIN_AUTH)) {
  console.log('FAIL config: SMOKE_ADMIN_AUTH must be signed or bearer');
  process.exit(1);
}
if (ADMIN_TOKEN && ADMIN_AUTH === 'signed' && ADMIN_TOKEN.length < 32) {
  console.log('FAIL config: the admin token must have at least 32 characters to sign with (SMOKE_ADMIN_AUTH=signed)');
  process.exit(1);
}
// The auth headers of one admin attempt. A signed header carries a fresh nonce and timestamp
// each time it is built, so a retry never resends one. `key` is the real token unless a probe
// deliberately signs with a wrong one.
function adminAuthHeaders(method, path, body, key = ADMIN_TOKEN) {
  return adminAuth(method, path, body, key).headers;
}
// The auth headers and the URL of one admin attempt. In signed mode the URL is the one the signer
// canonicalised and signed, so what is sent is exactly what the signature covers.
function adminAuth(method, path, body, key = ADMIN_TOKEN) {
  if (ADMIN_AUTH === 'bearer') return { headers: { Authorization: `Bearer ${key}` }, url: `${API_BASE}${path}` };
  const signed = signAdminRequest({ method, path, base: API_BASE, body, key });
  return { headers: { 'X-Caddie-Admin': signed.header }, url: signed.url };
}

// Which API this is. The Worker needs the CORS checks, the admin fixtures and text-only imports;
// Cloud Run serves everything from one origin and keeps the Elasticsearch helpers.
const API_KIND_ENV = (process.env.SMOKE_API || '').toLowerCase();
if (API_KIND_ENV && !['worker', 'cloudrun'].includes(API_KIND_ENV)) {
  console.log('FAIL config: SMOKE_API must be worker or cloudrun');
  process.exit(1);
}
const IS_WORKER = API_KIND_ENV ? API_KIND_ENV === 'worker' : CROSS_ORIGIN_API || Boolean(ADMIN_TOKEN);
// A browser sends its Origin on every call to a Worker on another origin, and on every same-origin
// POST, PUT and DELETE, so the run sends it on every call to the Worker. Against Cloud Run no Origin
// is sent, as before.
const SEND_ORIGIN = IS_WORKER;
// The Worker serving the web app itself, on BASE_URL's origin (the free stack as deployed).
const WORKER_SERVES_APP = IS_WORKER && !CROSS_ORIGIN_API;
const DIST_DIR = process.env.SMOKE_DIST || (WORKER_SERVES_APP ? 'web/dist-worker' : 'web/dist');
// A local API (wrangler dev or a local server) on this machine.
// Where the expected talks of a conference come from (SMOKE_TALKS above). A Worker on this machine
// is loaded from the committed data/, not from the schedules the ingest published, so it is compared
// with data/ by default.
const LOCAL_API = ['localhost', '127.0.0.1', '[::1]'].includes(new URL(API_BASE).hostname);
const TALKS_FROM = (process.env.SMOKE_TALKS || (IS_WORKER && !LOCAL_API ? 'bundle' : 'data')).toLowerCase();
if (!['bundle', 'data'].includes(TALKS_FROM)) {
  console.log('FAIL config: SMOKE_TALKS must be bundle or data');
  process.exit(1);
}
const BUNDLE_BASE = process.env.SMOKE_BUNDLE_BASE || 'https://kurtlehnardt.github.io/conferenceCaddie/bundles/';
// https, or plain http to this machine for a local test.
if (TALKS_FROM === 'bundle' && !/^https:\/\/[^\s?#]+\/$/.test(BUNDLE_BASE) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/[^\s?#]*)?\/$/.test(BUNDLE_BASE)) {
  console.log('FAIL config: SMOKE_BUNDLE_BASE must be an https URL that ends in "/"');
  process.exit(1);
}

// Where the three helpers that reach behind the API get their way in: the Worker's admin fixtures,
// Elasticsearch (Cloud Run only), or nowhere, in which case the checks that need them are skipped.
const WRITE_MODE = ADMIN_TOKEN ? 'admin' : !IS_WORKER && ES_WRITE_KEY ? 'es' : 'none';
const COUNT_MODE = ADMIN_TOKEN ? 'admin' : !IS_WORKER && process.env.ELASTISEARCH_API_KEY ? 'es' : 'none';
const NO_WRITE_WHY = IS_WORKER ? 'no ADMIN_TOKEN or ADMIN_TOKEN_FILE in the environment' : 'no Elasticsearch write key in the environment';
const NO_COUNT_WHY = IS_WORKER ? 'no ADMIN_TOKEN or ADMIN_TOKEN_FILE in the environment' : 'ELASTISEARCH_API_KEY is not set';

// Fail fast when the API cannot be reached, with a message that names the origin and nothing else.
{
  let failure = '';
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(`${API_BASE}/api/health`, { signal: AbortSignal.timeout(10000) });
      await res.arrayBuffer();
      failure = res.status === 200 ? '' : `health answered ${res.status}`;
      break;
    } catch (err) {
      failure = `no connection (${err.cause?.code ?? err.name ?? 'error'})`;
      if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  if (failure) {
    console.log(`FAIL api: ${API_ORIGIN} is not reachable or not healthy: ${failure}. Check API_BASE and BASE_URL.`);
    process.exit(1);
  }
}

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

// Topics a talk recommendations request asks for. That request stores nothing; no test profile
// carries these topics.
const LEARN = ['ebpf', 'gpu', 'llm'];

// The test profiles run against the live conference, and the server nudges two people who are a
// specific match and around in the same zone. So every test profile's words are synthetic: made-up
// tokens with this run's tag, which no real attendee's text or search can share. No test profile
// carries a topic except the common one, which only ever makes a broad match, and broad matches
// are never nudged. The profiles that go around (A, F and K) also keep interests and expertise
// empty while they are around: a nudge is looked for without a search text, so it reads topics,
// interests and expertise and never about, and a semantic neighbour cannot pick them either.
const runTag = crypto.randomBytes(4).toString('hex');
// A local API (LOCAL_API, wrangler dev or a local server): checks that need test profiles with a
// specific match to be around, or a conference to be flipped, run only there unless asked for.
// What A wants to learn (A's interests) and B, C, R and the expired profile have worked on (their
// expertise; B also wants it, so B finds R).
const SMOKE_SUBJECT = `zqvsmoke${runTag} vexmorlith quabbit flarnishing`;
const SMOKE_EXPERTISE = `tuned ${SMOKE_SUBJECT} rigs for three yonders`;
// Find & connect. F's about line is specific enough that F ranks first for the query, and the
// common topic is the one everyone at this conference matches on.
const FIND_WORD = `zqvfind${runTag}`;
const FIND_PASSAGE = `plonkered gravitronic snorbels on ${FIND_WORD} lattices for three yonders and debugged a wibblecorn after a glimmerfault`;
const FIND_QUERY = `gravitronic snorbels on ${FIND_WORD} lattices`;
// A's about line, which F and N search for.
const ASKER_WORD = `zqvasker${runTag}`;
const ASKER_ABOUT = `sprocketeer of hummable glintwork at ${ASKER_WORD}`;
const ASKER_QUERY = `hummable glintwork ${ASKER_WORD}`;
const COMMON_TOPIC = 'kubernetes';
// A's two profiles: with interests while A is not around, about and the common topic only while it is.
const A_LEARNING = { about: ASKER_ABOUT, interests: SMOKE_SUBJECT, speak: [COMMON_TOPIC] };
const A_AROUND = { about: ASKER_ABOUT, speak: [COMMON_TOPIC] };
const ZONE_A = 'Registration';
const ZONE_F = 'Expo hall';
const WORDLIST = JSON.parse(readFileSync(join(ROOT, 'config', 'moderation-words.json'), 'utf8')).words ?? [];

const BUNDLE_SECRET_VARS = ['ELASTISEARCH_API_KEY', 'GC_API_KEY', 'ES_READONLY_KEY', 'ES_PEOPLE_API_KEY', 'ADMIN_TOKEN', 'CLOUDFLARE_API_TOKEN', 'VAPID_PRIVATE_KEY', 'REF_SALT'];
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
// Thrown inside a check that cannot run here (a gated fixture route): the check prints SKIP, not FAIL.
class SkipCheck extends Error {}
async function check(name, fn) {
  try {
    await fn();
  } catch (err) {
    if (err instanceof SkipCheck) skip(name, err.message);
    else report(false, name, err.message);
  }
}

// Every response seen, with a label naming who asked, for the leak checks at the end.
const responses = [];
// Page and admin responses, which the leak check scans for secret values only.
const otherResponses = [];
const headerText = (headers) => [...headers].map(([k, v]) => `${k}: ${v}`).join('\n');
// Every search result seen, for the evidence check.
const allResults = [];
// The talks each test device shares for, per conference: device -> Map(event -> talk ids). A
// profile write the server accepted (200) records the list its request sent, and a delete clears
// it. Each recorded response carries its caller's list from when the request was sent, so the leak
// check can tell a fellow sharer from anyone else whatever order the checks run in.
const sharing = new Map();
// Accepted profile writes, and those whose answer echoed a different shared_talk_ids from the
// request's.
let echoChecked = 0;
const echoMismatches = [];
// Accepted profile writes read back through the API the app uses (POST /api/circles/members answers
// from the stored profile), and the writes whose stored shared talks differed from the request's.
let storedChecked = 0;
const storedMismatches = [];
const storedInconclusive = [];
// Requests that answered 5xx or failed on the first attempt and were retried.
let retried = 0;

const MAX_RATE_WAITS = 8;

async function api(method, path, body, { device, label = '', origin } = {}) {
  let lastError;
  let result;
  let readBackJob = null;
  let rateWaits = 0;
  const url = new URL(path, API_BASE);
  const event = body?.event ?? url.searchParams.get('event');
  const sharedTalks = [...(device && event ? sharing.get(device)?.get(event) ?? [] : [])];
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const headers = {};
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      if (device) headers['X-Caddie-Device'] = `${device.profileId}.${device.secret}`;
      if (origin) headers.Origin = origin;
      else if (SEND_ORIGIN) headers.Origin = SMOKE_ORIGIN;
      const res = await fetch(`${API_BASE}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      const text = await res.text();
      // A local server answers fast enough for the checks to outrun the per-address search limit
      // (60 per minute), so a 429 waits for its Retry-After and asks again. Only the rate-limit
      // check rl1 wants a 429, and it calls fetch directly.
      if (res.status === 429 && rateWaits < MAX_RATE_WAITS) {
        rateWaits++;
        const sec = Math.min(15, Math.max(1, Number(res.headers.get('retry-after')) || 1));
        await new Promise((resolve) => setTimeout(resolve, sec * 1000));
        attempt--;
        continue;
      }
      // A 5xx is retried once, but never silently: a check that passes on the retry can still
      // hide a server error, so every first-attempt 5xx prints a NOTE line.
      if (res.status >= 500 && attempt === 0) {
        retried++;
        console.log(`NOTE ${method} ${url.pathname} (${label || 'no label'}) answered ${res.status} on the first attempt; retrying once`);
        lastError = new Error(`status ${res.status}`);
        continue;
      }
      let json = {};
      try {
        json = JSON.parse(text);
      } catch {
        /* keep {} */
      }
      if (device && event && res.status === 200 && url.pathname === '/api/people/profile') {
        if (!sharing.has(device)) sharing.set(device, new Map());
        if (method === 'PUT') {
          // The request is the source of truth for what the device now shares; the server drops
          // duplicates, so they are dropped here too before its echo is compared with it.
          const requested = Array.isArray(body?.shared_talk_ids) ? [...new Set(body.shared_talk_ids)] : [];
          const echoed = Array.isArray(json.shared_talk_ids) ? json.shared_talk_ids : null;
          echoChecked++;
          if (JSON.stringify(echoed) !== JSON.stringify(requested)) echoMismatches.push(label || 'no label');
          const before = sharing.get(device).get(event) ?? [];
          sharing.get(device).set(event, requested);
          readBackJob = { device, event, requested, before, label: label || 'no label' };
        }
        if (method === 'DELETE') sharing.get(device).delete(event);
      }
      responses.push({ path, label, status: res.status, text, headersText: headerText(res.headers), json, request: body, sharedTalks });
      result = { status: res.status, json, headers: res.headers };
      break;
    } catch (err) {
      lastError = err;
      if (attempt === 0) {
        retried++;
        console.log(`NOTE ${method} ${url.pathname} (${label || 'no label'}) failed on the first attempt (${err.message}); retrying once`);
      }
    }
  }
  if (!result) throw new Error(`${method} ${path} failed: ${lastError?.message ?? 'unknown error'}`);
  // The read-back runs outside the retry loop above, so a failure in it can never repeat the write.
  if (readBackJob) await readBackShared(readBackJob.device, readBackJob.event, readBackJob.requested, readBackJob.before, readBackJob.label);
  return result;
}

// The server echoes the list it parsed, which says nothing about what it stored. So read the stored
// profile back the way the app does: POST /api/circles/members authenticates the device, loads its
// stored profile and answers 200 only for a talk the stored shared_talk_ids holds, or 403 with
// share_required for any other. A sample of the requested talks must answer 200 and a sample of
// the talks the device shared before and no longer does must answer 403 share_required.
async function readBackShared(device, event, requested, before, label) {
  const present = [...new Set([requested[0], requested[Math.floor(requested.length / 2)], requested[requested.length - 1]])].filter(Boolean);
  const removed = before.filter((id) => !requested.includes(id)).slice(0, 2);
  for (const [talkId, shouldHold] of [...present.map((id) => [id, true]), ...removed.map((id) => [id, false])]) {
    try {
      const r = await api('POST', '/api/circles/members', { event, talk_id: talkId }, { device, label: `${label}-readback` });
      storedChecked++;
      if (r.status === 200) {
        if (!shouldHold) storedMismatches.push(`${label} (${talkId} should not be stored, status 200)`);
      } else if (r.status === 403 && r.json.error === 'share_required') {
        if (shouldHold) storedMismatches.push(`${label} (${talkId} should be stored, answered share_required)`);
      } else {
        storedInconclusive.push(`${label} (status ${r.status})`);
      }
    } catch (err) {
      storedInconclusive.push(`${label} (${err.message})`);
    }
  }
}

// The Worker's admin routes. The token goes only into the auth header (adminAuthHeaders), and no
// Origin header is sent, because the Worker answers 404 to an admin request that carries one. Like
// api(), a 5xx or a network failure is retried once with a NOTE line, and the retry builds its
// headers afresh, so a signed attempt is never resent with the same nonce. A retry can repeat a
// write whose answer was lost; every admin write the run makes is idempotent (the fixture profile
// and the aged presence are upserts, a meter restart reads the stored totals, PUT /admin/conferences
// upserts, the fixture delete and the unhide are no-ops the second time), so that is safe. Flags
// for a route go in the JSON body, never in the query string, so the body hash covers them.
// Nothing here prints the token, a request body or a response body.
class AdminRedirectError extends Error {}
async function admin(method, path, body) {
  const serialised = body === undefined ? undefined : JSON.stringify(body);
  let lastError;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const { headers, url } = adminAuth(method, path, serialised);
      if (serialised !== undefined) headers['Content-Type'] = 'application/json';
      const res = await fetch(url, {
        method,
        headers,
        body: serialised,
        redirect: 'manual',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      // A redirect is never followed: it would carry the admin credentials (and a signed body) to
      // wherever the Location points. It is a failure, not a network error, so it is never retried.
      if (res.status >= 300 && res.status < 400) {
        await res.body?.cancel();
        throw new AdminRedirectError(`${method} ${path.split('?')[0]} (admin) answered ${res.status}, a redirect; admin requests never follow redirects`);
      }
      const text = await res.text();
      if (res.status >= 500 && attempt === 0) {
        retried++;
        console.log(`NOTE ${method} ${path.split('?')[0]} (admin) answered ${res.status} on the first attempt; retrying once`);
        continue;
      }
      let json = {};
      try {
        json = JSON.parse(text);
      } catch {
        /* keep {} */
      }
      otherResponses.push({ label: 'admin', path: path.split('?')[0], text, headersText: headerText(res.headers) });
      noteFixtureAnswer(path, res.status);
      return { status: res.status, json, headers: res.headers };
    } catch (err) {
      // A request the signer refuses is a bug in this script, not a network failure: no retry.
      if (err instanceof UsageError || err instanceof AdminRedirectError) throw err;
      lastError = err;
      if (attempt === 0) {
        retried++;
        console.log(`NOTE ${method} ${path.split('?')[0]} (admin) failed on the first attempt (${err.message}); retrying once`);
      }
    }
  }
  throw lastError;
}

// Whether the Worker serves its /admin/test/* fixtures. A deployed Worker has them gated off unless
// ADMIN_TEST_ROUTES is "1" (then they answer 404 while the other admin routes work), and the checks
// that need them print SKIP. Decided once, on the first fixture call that answers 404: when
// GET /admin/stats answers 200 with the same credentials, the fixtures are gated; otherwise the
// 404 is an auth or routing failure and the check fails as before.
let fixturesGated = null;
const FIXTURES_GATED_WHY = 'the Worker answers 404 to /admin/test/*: its fixtures are gated off; deploy it with ADMIN_TEST_ROUTES=1 to run this check';
function noteFixtureAnswer(path, status) {
  if (!path.startsWith('/admin/test/') || fixturesGated !== null) return;
  if (status !== 404) fixturesGated = false;
}
async function fixture(method, path, body) {
  const r = await admin(method, path, body);
  if (r.status === 404 && fixturesGated === null) {
    const stats = await admin('GET', `/admin/stats?event=${encodeURIComponent(PRIMARY)}`);
    fixturesGated = stats.status === 200;
  }
  if (r.status === 404 && fixturesGated) throw new SkipCheck(FIXTURES_GATED_WHY);
  return r;
}

// A page of the web app, relative to BASE_URL (which includes the base path).
async function staticPage(path) {
  const res = await fetch(`${BASE_URL}${path}`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  const text = await res.text();
  otherResponses.push({ label: 'page', path, text, headersText: headerText(res.headers) });
  return { status: res.status, text, headers: res.headers };
}

// Moves one test profile's presence end into the past, which the API can never do. On the Worker this
// is the admin fixture. On Cloud Run it is a Bulk partial update (the write the server itself uses, so
// nothing is re-embedded). Both leave the profile's meets open, as lapsing does.
async function agePresence(device, who) {
  if (WRITE_MODE === 'admin') {
    const r = await fixture('POST', `/admin/test/age-presence?event=${encodeURIComponent(PRIMARY)}`, { profile_id: device.profileId, until_ms: Date.now() - 60_000 });
    if (r.status !== 200) throw new Error(`aging ${who}'s presence gave ${r.status}`);
    return;
  }
  const res = await fetch(`${ES_URL}/${encodeURIComponent(PEOPLE_INDEX)}/_bulk?refresh=wait_for`, {
    method: 'POST',
    headers: { Authorization: `ApiKey ${ES_WRITE_KEY}`, 'Content-Type': 'application/x-ndjson' },
    body: `${JSON.stringify({ update: { _id: `${PRIMARY}:${device.profileId}` } })}\n${JSON.stringify({ doc: { presence_until: new Date(Date.now() - 60_000).toISOString() } })}\n`,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const aged = res.ok ? await res.json().catch(() => ({})) : {};
  if (!res.ok) await res.body?.cancel();
  if (!res.ok || aged.errors) throw new Error(`aging ${who}'s presence gave ${res.status}`);
}

async function search(body) {
  const r = await api('POST', '/api/search', { conference: PRIMARY, ...body });
  if (r.status === 200) allResults.push(...(r.json.results ?? []));
  return r;
}

// A conference's own items (every kind), from the published bundle or the committed data/
// (SMOKE_TALKS). Bundle talks carry the fields the checks read (talk_id, kind, title, speakers, room,
// track, tags, start, end, day, end_minutes).
const bundleTalks = new Map(); // slug -> { docs } or { error }, filled by loadBundleTalks
const readNdjson = (slug) => {
  if (TALKS_FROM === 'bundle') {
    const ref = bundleTalks.get(slug);
    if (!ref) throw new Error(`the published bundle of ${slug} was not loaded`);
    if (ref.error) throw new Error(`the published bundle of ${slug}: ${ref.error}`);
    return ref.docs;
  }
  const file = join(ROOT, 'data', slug, 'talks.ndjson');
  return readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
};

// Reads the published index and the bundle.json of each slug, checked against the index's size and
// SHA-256. Returns the index (readConferenceIndex) or null when it cannot be read; failures per slug
// are kept in bundleTalks and fail the checks that need them.
async function loadBundleTalks(slugs) {
  const get = async (url) => {
    const res = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    if (!res.ok) {
      await res.body?.cancel();
      throw new Error(`${new URL(url).pathname} gave ${res.status}`);
    }
    return Buffer.from(await res.arrayBuffer());
  };
  let index;
  try {
    index = readConferenceIndex(JSON.parse((await get(`${BUNDLE_BASE}conferences.json`)).toString('utf8')));
    if (!index.ok) throw new Error(`the published conferences.json is not a usable index (${index.reason})`);
  } catch (err) {
    for (const slug of slugs) bundleTalks.set(slug, { error: err.message });
    return null;
  }
  for (const slug of slugs) {
    const entry = index.conferences.find((c) => c.conference.slug === slug)?.bundle;
    if (!entry) {
      bundleTalks.set(slug, { error: 'the published index has no bundle for it' });
      continue;
    }
    try {
      const bytes = await get(`${BUNDLE_BASE}${entry.path}${BUNDLE_FILE}`);
      const meta = entry.files[BUNDLE_FILE];
      if (bytes.length !== meta.bytes || sha256hex(bytes) !== meta.sha256) throw new Error(`${entry.path}${BUNDLE_FILE} does not match the index`);
      bundleTalks.set(slug, { docs: JSON.parse(bytes.toString('utf8')).talks ?? [], path: entry.path });
    } catch (err) {
      bundleTalks.set(slug, { error: err.message });
    }
  }
  return index;
}

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

const testName = (who) => `Smoke test ${who} ${runTag}`;
const contactMarker = (who) => `smoke-contact-${who}-${runTag}`;

function profileBody(event, who, { learn = [], speak = [], about = '', interests = '', expertise = '' } = {}) {
  return {
    display_name: testName(who),
    about,
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
// The refs the report check (q10) reported. Reports are never purged automatically, so with an
// admin token the run removes them again through POST /admin/moderation (action unhide).
const reportedRefs = [];
async function putProfile(device, event, who, opts, { open = false, shared = [] } = {}) {
  const r = await api('PUT', '/api/people/profile', { event, profile: profileBody(event, who, opts), open_to_meet: open, shared_talk_ids: shared }, { device, label: `${who}-put` });
  if (r.status === 200 && !created.some((c) => c.device === device && c.event === event)) created.push({ device, event });
  return r;
}

const names = (results) => (results ?? []).map((p) => p.display_name);

// ---------------------------------------------------------------------------------------------
// Conferences.

const NOT_WORKER_WHY_EARLY = 'the API is not the Worker (Cloud Run sends no CORS headers)';
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

// The expected talks (SMOKE_TALKS), and, with the bundles, check bun1: the Worker and the published
// bundles list the same searchable conferences with the same talk counts. The ingest run publishes
// both from one fetch, so a difference means one of them missed a publish (or a Pages deploy of the
// same run is still in progress: the index is cached for up to ten minutes).
if (TALKS_FROM === 'data') {
  console.log('NOTE talks: the expected talks come from the committed data/ (SMOKE_TALKS=data)');
} else {
  const published = await loadBundleTalks([PRIMARY, ...EXTRA]);
  const loaded = [...bundleTalks].filter(([, r]) => r.docs).map(([slug, r]) => `${slug} ${r.path}`);
  console.log(`NOTE talks: the expected talks come from the published bundles at ${new URL(BUNDLE_BASE).origin}${loaded.length ? `: ${loaded.join(', ')}` : ''} (SMOKE_TALKS=data uses the committed data/)`);
  await check('bun1: the published talk bundles list the Worker\'s searchable conferences with the same talk counts', async () => {
    if (!published) throw new Error(bundleTalks.get(PRIMARY)?.error ?? 'the published index could not be read');
    const bundled = new Map(published.conferences.filter((c) => c.bundle).map((c) => [c.conference.slug, c.bundle.talk_count]));
    const problems = [];
    for (const c of conferences.filter((x) => x.status === 'searchable')) {
      if (!bundled.has(c.slug)) problems.push(`${c.slug} has no published bundle`);
      else if (bundled.get(c.slug) !== c.talk_count) problems.push(`${c.slug}: the Worker has ${c.talk_count} talks, the bundle ${bundled.get(c.slug)}`);
    }
    for (const slug of bundled.keys()) if (confBySlug.get(slug)?.status !== 'searchable') problems.push(`${slug} has a bundle but is not searchable on the Worker`);
    report(problems.length === 0, 'bun1: the published talk bundles list the Worker\'s searchable conferences with the same talk counts',
      problems.length ? `${problems.slice(0, 3).join('; ')}; the Worker and the bundles hold different schedules until an ingest run publishes both` : `${bundled.size} conferences`);
  });
}

// The Worker's capabilities document (docs/contracts/capabilities.md), validated as a producer's,
// in closed mode. Later checks read ble.mode from it.
let capsDoc = null;
if (!IS_WORKER) {
  skip('cap1: GET /api/capabilities serves a valid tier 2 document', NOT_WORKER_WHY_EARLY);
} else {
  await check('cap1: GET /api/capabilities serves a valid tier 2 document', async () => {
    const res = await fetch(`${API_BASE}/api/capabilities`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    const text = await res.text();
    otherResponses.push({ label: 'capabilities', path: '/api/capabilities', text, headersText: headerText(res.headers) });
    const problems = [];
    if (res.status !== 200) throw new Error(`status ${res.status}`);
    capsDoc = JSON.parse(text);
    const v = validator('capabilities.v1')(capsDoc, { closed: true });
    if (!v.valid) problems.push(`schema: ${v.errors.slice(0, 3).map((e) => `${e.path} ${e.message}`).join('; ')}`);
    if (capsDoc.tier !== 'free') problems.push(`tier ${capsDoc.tier}`);
    if (capsDoc.talks?.bundle_base !== 'https://kurtlehnardt.github.io/conferenceCaddie/bundles/') problems.push(`bundle_base ${capsDoc.talks?.bundle_base}`);
    if (!/public/.test(res.headers.get('cache-control') ?? '') || !/max-age=300/.test(res.headers.get('cache-control') ?? '')) problems.push(`Cache-Control ${res.headers.get('cache-control')}`);
    if (res.headers.get('access-control-allow-origin') !== '*') problems.push(`Access-Control-Allow-Origin ${res.headers.get('access-control-allow-origin')}`);
    report(problems.length === 0, 'cap1: GET /api/capabilities serves a valid tier 2 document', problems.length ? problems.join('; ') : `closed-mode valid, ble.mode ${capsDoc.ble?.mode}, people.semantic ${capsDoc.people?.semantic}`);
  });
}

// ---------------------------------------------------------------------------------------------
// Native push (docs/contracts/capabilities.md, push.apns and push.fcm; docs/contracts/people-api.md,
// Native push registration). Every backend answers the two flags as booleans; one without the
// platform's key answers false, and then refuses PUT /api/push/native for that platform with 404
// push_unavailable (or, on a backend without the route, 404 Not found). A made-up token is never
// registered on a backend that pushes to the platform: those checks are skipped there.

const NATIVE_PLATFORMS = ['apns', 'fcm'];
const NATIVE_EXPECTED_ENV = (process.env.SMOKE_NATIVE_PUSH ?? '').trim().toLowerCase();
let nativeFlags = null; // { apns, fcm } once np1 has read them
await check('np1: GET /api/capabilities answers push.apns and push.fcm as booleans', async () => {
  const res = await fetch(`${API_BASE}/api/capabilities`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  const text = await res.text();
  otherResponses.push({ label: 'capabilities-native', path: '/api/capabilities', text, headersText: headerText(res.headers) });
  if (res.status !== 200) throw new Error(`status ${res.status}`);
  const push = JSON.parse(text).push ?? {};
  const wrong = NATIVE_PLATFORMS.filter((p) => typeof push[p] !== 'boolean');
  if (!wrong.length) nativeFlags = { apns: push.apns, fcm: push.fcm };
  report(wrong.length === 0, 'np1: GET /api/capabilities answers push.apns and push.fcm as booleans', wrong.length ? `not a boolean: ${wrong.map((p) => `push.${p}`).join(', ')}` : `push.apns ${push.apns}, push.fcm ${push.fcm}`);
});

const NP2 = 'np2: push.apns and push.fcm are false unless the backend holds that platform\'s key';
if (!nativeFlags) {
  skip(NP2, 'np1 did not read the flags');
} else if (NATIVE_EXPECTED_ENV) {
  const expected = new Set(NATIVE_EXPECTED_ENV === 'none' ? [] : NATIVE_EXPECTED_ENV.split(',').map((p) => p.trim()).filter(Boolean));
  const unknown = [...expected].filter((p) => !NATIVE_PLATFORMS.includes(p));
  const off = NATIVE_PLATFORMS.filter((p) => nativeFlags[p] !== expected.has(p));
  report(unknown.length === 0 && off.length === 0, NP2, unknown.length ? `SMOKE_NATIVE_PUSH names ${unknown.join(', ')}` : off.length ? off.map((p) => `push.${p} ${nativeFlags[p]}, expected ${expected.has(p)}`).join('; ') : `as SMOKE_NATIVE_PUSH=${NATIVE_EXPECTED_ENV} says`);
} else if (NATIVE_PLATFORMS.some((p) => nativeFlags[p])) {
  skip(NP2, `${NATIVE_PLATFORMS.filter((p) => nativeFlags[p]).map((p) => `push.${p}`).join(' and ')} true: this backend holds that key; set SMOKE_NATIVE_PUSH to check which platforms to expect`);
} else {
  report(true, NP2, 'both false: no native push keys');
}

const NP3 = 'np3: PUT /api/push/native answers 404 push_unavailable for a platform whose flag is false';
const offPlatforms = nativeFlags ? NATIVE_PLATFORMS.filter((p) => !nativeFlags[p]) : [];
if (!nativeFlags) {
  skip(NP3, 'np1 did not read the flags');
} else if (!offPlatforms.length) {
  skip(NP3, 'both flags are true; a made-up token is never registered on a backend that pushes');
} else {
  await check(NP3, async () => {
    // A test profile of its own, visible and without words, removed again at once (and at the end).
    const NP = newDevice();
    const made = await putProfile(NP, PRIMARY, 'NP', {}, { open: true });
    if (made.status !== 200) throw new Error(`the test profile could not be created (status ${made.status})`);
    const problems = [];
    const seen = [];
    try {
      const tokens = { apns: crypto.randomBytes(32).toString('hex'), fcm: `${crypto.randomBytes(8).toString('base64url')}:smoke${runTag}${crypto.randomBytes(48).toString('base64url')}` };
      for (const platform of offPlatforms) {
        const r = await api('PUT', '/api/push/native', { event: PRIMARY, platform, token: tokens[platform] }, { device: NP, label: `np3-${platform}` });
        const error = r.json?.error;
        // Tier 3 serves the route; a backend without it (the Worker today) answers Not found.
        const ok = r.status === 404 && (error === 'push_unavailable' || (IS_WORKER && error === 'Not found'));
        if (!ok) problems.push(`${platform}: ${r.status} ${JSON.stringify(r.json).slice(0, 80)}`);
        else seen.push(`${platform} 404 ${error}`);
      }
    } finally {
      await api('DELETE', `/api/people/profile?event=${encodeURIComponent(PRIMARY)}`, undefined, { device: NP, label: 'np3-cleanup' }).catch(() => {});
    }
    report(problems.length === 0, NP3, problems.length ? problems.join('; ') : seen.join(', '));
  });
}

// ---------------------------------------------------------------------------------------------
// Cross-origin behaviour of the Worker. Cloud Run serves the app and the API from one origin and sends
// no CORS headers, so the checks that need the Worker are skipped there.

const NOT_WORKER_WHY = NOT_WORKER_WHY_EARLY;
const listHas = (value, item) => (value ?? '').split(',').map((x) => x.trim().toLowerCase()).includes(item.toLowerCase());
const hasCorsHeader = (headers) => [...headers.keys()].some((k) => k.toLowerCase().startsWith('access-control-'));

// A preflight for the profile write, the way a browser sends it from a page at the given origin.
async function preflight(origin) {
  const res = await fetch(`${API_BASE}/api/people/profile`, {
    method: 'OPTIONS',
    headers: { Origin: origin, 'Access-Control-Request-Method': 'PUT', 'Access-Control-Request-Headers': 'content-type, x-caddie-device' },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  await res.arrayBuffer();
  return res;
}

if (!IS_WORKER) {
  skip('cors1: a preflight from the app origin is allowed and permits the device header', NOT_WORKER_WHY);
  skip('cors2: a preflight from another origin gets no CORS headers', NOT_WORKER_WHY);
} else {
  await check('cors1: a preflight from the app origin is allowed and permits the device header', async () => {
    const res = await preflight(SMOKE_ORIGIN);
    const h = res.headers;
    const problems = [];
    if (![200, 204].includes(res.status)) problems.push(`status ${res.status}`);
    if (h.get('access-control-allow-origin') !== SMOKE_ORIGIN) problems.push('Access-Control-Allow-Origin is not the request origin');
    const allowHeaders = h.get('access-control-allow-headers');
    if (!listHas(allowHeaders, 'x-caddie-device') && (allowHeaders ?? '').trim() !== '*') problems.push('X-Caddie-Device is not an allowed header');
    const allowMethods = h.get('access-control-allow-methods');
    if (!listHas(allowMethods, 'PUT') && (allowMethods ?? '').trim() !== '*') problems.push('PUT is not an allowed method');
    if (!(Number(h.get('access-control-max-age')) > 0)) problems.push('no Access-Control-Max-Age, so every call would be preflighted');
    if (!listHas(h.get('vary'), 'origin')) problems.push('no Vary: Origin');
    report(problems.length === 0, 'cors1: a preflight from the app origin is allowed and permits the device header', problems.length ? problems.join('; ') : `status ${res.status}, max-age ${h.get('access-control-max-age')}`);
  });

  await check('cors2: a preflight from another origin gets no CORS headers', async () => {
    const res = await preflight(EVIL_ORIGIN);
    const problems = [];
    if (res.status !== 403) problems.push(`status ${res.status}, not 403`);
    if (hasCorsHeader(res.headers)) problems.push('the answer carries Access-Control headers');
    report(problems.length === 0, 'cors2: a preflight from another origin gets no CORS headers', problems.length ? problems.join('; ') : `status ${res.status}, no Access-Control headers`);
  });
}

// The admin routes are never advertised: without a valid token, or with an Origin header, they answer 404
// and send no CORS headers. The wrong token is random, so no real token is ever tried.
if (!IS_WORKER) {
  skip('adm1: the admin routes answer 404 without a valid token and send no CORS headers', NOT_WORKER_WHY);
} else {
  await check('adm1: the admin routes answer 404 without a valid token and send no CORS headers', async () => {
    const probe = async (label, headers) => {
      const res = await fetch(`${API_BASE}/admin/stats?event=${encodeURIComponent(PRIMARY)}`, { headers, redirect: 'manual', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      // Never follow a redirect with admin headers on it (see admin()); the probe fails naming the status.
      if (res.status >= 300 && res.status < 400) {
        await res.body?.cancel();
        return [`${label} gave ${res.status}, a redirect that was not followed`];
      }
      const text = await res.text();
      otherResponses.push({ label: 'admin-probe', path: '/admin/stats', text, headersText: headerText(res.headers) });
      const bad = [];
      if (res.status !== 404) bad.push(`${label} gave ${res.status}`);
      if (hasCorsHeader(res.headers)) bad.push(`${label} carries Access-Control headers`);
      if (/"usage"|"talks"|"people"/.test(text)) bad.push(`${label} returned counts`);
      return bad;
    };
    const probePath = `/admin/stats?event=${encodeURIComponent(PRIMARY)}`;
    const problems = [
      ...(await probe('no token', {})),
      ...(await probe('a wrong token', adminAuthHeaders('GET', probePath, undefined, crypto.randomBytes(32).toString('hex')))),
    ];
    // With the real token, an Origin header must still be refused, because a browser page must never reach admin.
    // The probe is signed in signed mode on purpose: the Worker refuses the Origin header before it
    // verifies anything, so a valid signature proves the refusal is the Origin rule and not the signature.
    if (ADMIN_TOKEN) problems.push(...(await probe('the token with an Origin header', { ...adminAuthHeaders('GET', probePath, undefined), Origin: SMOKE_ORIGIN })));
    report(problems.length === 0, 'adm1: the admin routes answer 404 without a valid token and send no CORS headers', problems.length ? problems.join('; ') : `${ADMIN_TOKEN ? 3 : 2} requests, all 404 without CORS headers`);
  });
}

// The daily meter behind X-Caddie-Pace and the soft caps. Five requests must raise the day's
// counts by at least five, and a reading must never go down within a UTC day, even across a new
// meter. POST /admin/test/meter-restart starts a new meter from the stored totals and drops the
// old one's unwritten counts, as an eviction of the object would (on a deployed Worker that loses
// at most a few seconds of real counts). The second restart comes right after a reading taken
// while the meter still held unwritten counts, so a meter that reports counts it has not stored
// fails here whenever the run gets from the first reading to the last within its 15-second write
// interval, which it does in well under a second.
if (IS_WORKER && ADMIN_TOKEN) {
  await check('meter1: the daily usage meter counts requests and never goes down across a new meter', async () => {
    const name = 'meter1: the daily usage meter counts requests and never goes down across a new meter';
    const ev = encodeURIComponent(PRIMARY);
    const usage = async () => (await admin('GET', `/admin/stats?event=${ev}`)).json.usage ?? null;
    const restart = async () => (await fixture('POST', `/admin/test/meter-restart?event=${ev}`, {})).status;
    const started = Date.now();
    const first = await restart();
    const before = await usage();
    for (let i = 0; i < 5; i++) await api('GET', `/api/topics?event=${ev}`, undefined, { label: 'meter' });
    const middle = await usage();
    const second = await restart();
    const after = await usage();
    const took = Date.now() - started;
    const problems = [];
    if (first !== 200 || second !== 200) problems.push(`meter-restart gave ${first} and ${second}`);
    if (!before || !middle || !after) problems.push('no usage in /admin/stats');
    else if (before.day === middle.day && middle.day === after.day) {
      if (middle.requests < before.requests + 5) problems.push(`five requests raised requests from ${before.requests} only to ${middle.requests}`);
      if (after.requests < middle.requests + 1) problems.push(`requests went from ${middle.requests} to ${after.requests} across a new meter`);
      for (const f of ['rows_read', 'rows_written']) {
        if (middle[f] < before[f] || after[f] < middle[f]) problems.push(`${f} went ${before[f]}, ${middle[f]}, ${after[f]}`);
      }
    }
    const detail = before && middle && after
      ? `requests ${before.requests}, ${middle.requests}, then ${after.requests} after a new meter; rows written ${before.rows_written}, ${middle.rows_written}, ${after.rows_written}; ${took} ms`
      : '';
    report(problems.length === 0, name, problems.length ? problems.join('; ') : detail);
  });
}

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

// c. saved_talk_ids is still accepted but no longer filters anything. Text queries compare totals
// and the browse listing, which is sorted by time, compares the exact order. (Identical requests
// return the same order because the server pins every search for a conference to one shard copy;
// the For you check r8 asserts that.)
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
// never a break or a housekeeping item. The expectation comes from the expected talks (SMOKE_TALKS).
await check('e1: include_events adds co-located events and showcases, and nothing else', async () => {
  const docs = readNdjson(PRIMARY);
  const ambient = new Map(docs.filter((d) => d.kind === 'ambient').map((d) => [d.talk_id, d]));
  const other = new Map(docs.filter((d) => d.kind === 'break' || d.kind === 'housekeeping').map((d) => [d.talk_id, d]));
  const track = [...ambient.values()].find((d) => d.track === 'Solutions Showcase')?.track ?? [...ambient.values()][0]?.track;
  if (!track) throw new Error('no ambient item in the expected talks');
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

// Once the primary conference's last talk has ended, For you and Happening now (which the server filters
// with end > now) have nothing to return for it, so the checks that need upcoming talks print SKIP
// instead of failing on "no results" or passing vacuously.
const PRIMARY_OVER_WHY = 'no talk of the primary conference is still to come (the server only suggests talks whose end is after now)';
function skipIfPrimaryOver() {
  const talks = readNdjson(PRIMARY).filter((d) => d.kind === 'talk');
  const now = Date.now();
  if (talks.length && !talks.some((d) => Date.parse(d.end) > now)) throw new SkipCheck(PRIMARY_OVER_WHY);
}

await check('e2: include_events must be a boolean, and For you never holds an event', async () => {
  skipIfPrimaryOver();
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
// The plain and debug result lists are not compared here. The server sends both to the same shard
// copy, so they come back in the same order, but this check only needs the ranks to be coherent.
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
// computed from the expected talks (SMOKE_TALKS), not from the response: every talk starts on that day at or
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
// computed here from the expected talks (SMOKE_TALKS) and the local clock, with two minutes of slack for skew.
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
  skipIfPrimaryOver();
  const slack = 2 * 60_000;
  const at = Date.now();
  const r = await search({ query: '', size: 50, filters: { happening_now: true } });
  const all = await search({ query: '', size: 1 });
  const bad = await search({ query: '', filters: { happening_now: 'yes' } });
  if (r.status !== 200 || all.status !== 200) throw new Error(`status ${r.status} and ${all.status}`);
  const outside = (r.json.results ?? []).filter((t) => !(Date.parse(t.end) > at - slack && Date.parse(t.start) < at + 60 * 60_000 + slack));
  const talks = readNdjson(PRIMARY).filter((d) => d.kind === 'talk');
  const expected = talks.filter((d) => Date.parse(d.end) > at + slack && Date.parse(d.start) < at + 60 * 60_000 - slack).length;
  // An empty window makes the bound above vacuous, and no talk is then inspected for being outside it.
  if (r.status === 200 && r.json.total === 0) throw new SkipCheck('no talk is in progress or starting within 60 minutes, so the window has nothing to check');
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

// Value matching: track, room, speaker and tag names found in the search text come back as
// suggested chips. They are only suggestions, so the results never change because of them, and
// they come from the requested conference's own names.
await check('v1: a track name in the search text is suggested as a chip, never applied, and applying it filters', async () => {
  const track = 'Platform Engineering';
  const r = await search({ query: `${track.toLowerCase()} talks`, size: 50 });
  if (r.status !== 200) throw new Error(`status ${r.status}`);
  const chip = (r.json.suggestions ?? []).find((s) => s.kind === 'track' && s.value === track);
  const applied = await search({ query: `${track.toLowerCase()} talks`, size: 50, filters: { track: [track] } });
  const wrong = (applied.json.results ?? []).filter((t) => t.track !== track);
  const after = (applied.json.suggestions ?? []).some((s) => s.kind === 'track' && s.value === track);
  const other = await search({ query: 'pytorch ecosystem', size: 5 });
  const leaked = (other.json.suggestions ?? []).some((s) => s.value === 'PyTorch Ecosystem');
  const ok = Boolean(chip) && (r.json.results ?? []).some((t) => t.track !== track) && applied.status === 200 && (applied.json.results ?? []).length > 0
    && wrong.length === 0 && !after && !leaked;
  report(ok, 'v1: a track name in the search text is suggested as a chip, never applied, and applying it filters', `${(r.json.suggestions ?? []).length} chips, ${r.json.total} talks before, ${applied.json.total} once applied, ${wrong.length} outside the track`);
});

await check('v2: a speaker name and a room are suggested as chips and filter the results', async () => {
  const sample = (await search({ query: '', size: 50 })).json.results?.find((t) => t.speakers?.length && t.room);
  if (!sample) throw new Error('no talk with a speaker and a room');
  const name = sample.speakers[0];
  const r = await search({ query: name, size: 50 });
  const chip = (r.json.suggestions ?? []).find((s) => s.kind === 'speaker' && s.value === name);
  const bySpeaker = await search({ query: '', size: 50, filters: { speaker: [name] } });
  const byRoom = await search({ query: '', size: 50, filters: { room: [sample.room] } });
  const roomChip = (await search({ query: sample.room.split('|').pop().trim(), size: 5 })).json.suggestions?.find((s) => s.kind === 'room' && s.value === sample.room);
  const bad = await search({ query: '', filters: { speaker: 'x' } });
  const ok = Boolean(chip) && bySpeaker.status === 200 && bySpeaker.json.results.length > 0 && bySpeaker.json.results.every((t) => t.speakers.includes(name))
    && byRoom.status === 200 && byRoom.json.results.length > 0 && byRoom.json.results.every((t) => t.room === sample.room) && Boolean(roomChip) && bad.status === 400;
  report(ok, 'v2: a speaker name and a room are suggested as chips and filter the results', `speaker chip ${Boolean(chip)}, room chip ${Boolean(roomChip)}, ${bySpeaker.json.total} talks by the speaker, ${byRoom.json.total} in the room`);
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

// The text of the PDF that makePdf builds, as a browser would extract it: the Worker takes text only.
function extractPdfText(pdf) {
  return [...pdf.toString('latin1').matchAll(/\(((?:\\.|[^\\)])*)\) Tj/g)].map((m) => m[1].replace(/\\([\\()])/g, '$1')).join('\n');
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

// The same comparison through the Worker's admin stats: row counts of the two conferences the imports
// touch. Only these four say anything is stored for the import; people and meets change with live use.
const ADMIN_COUNT_KEYS = ['talks', 'vectors', 'topics', 'facets', 'people', 'shared_talks', 'presence', 'blocks', 'meets', 'reports', 'push_subs', 'nudges'];
async function adminCounts() {
  const out = new Map();
  for (const slug of [PRIMARY, IMPORT_OTHER]) {
    const r = await admin('GET', `/admin/stats?event=${encodeURIComponent(slug)}`);
    if (r.status !== 200) throw new Error(`stats for ${slug} gave ${r.status}`);
    for (const key of ADMIN_COUNT_KEYS) out.set(`${slug} ${key}`, r.json[key]);
  }
  return out;
}
const takeCounts = () => (COUNT_MODE === 'admin' ? adminCounts() : indexCounts());

const IMPORT_OTHER = EXTRA[0];
const picks = importPicks(PRIMARY, 5);
const pickIds = new Set(picks.map((t) => t.talk_id));
const importBody = scheduleText(picks, confBySlug.get(PRIMARY)?.time_zone ?? 'UTC');
let countsBefore = null;
if (COUNT_MODE !== 'none') {
  try {
    countsBefore = await takeCounts();
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
  if (IS_WORKER) {
    // The Worker has no attachment processor: it answers 415 to a PDF, and the free stack's web app
    // extracts the text in the browser and sends that. So send the file once to see the refusal, then
    // send the text the browser would extract.
    const refused = await api('POST', '/api/import/schedule', { event: PRIMARY, filename: 'schedule.pdf', mime: 'application/pdf', content_base64: pdf.toString('base64') });
    const sent = await api('POST', '/api/import/schedule', { event: PRIMARY, text: extractPdfText(pdf) });
    if (sent.status !== 200) throw new Error(`status ${sent.status}${sent.json.error ? `: ${sent.json.error}` : ''}`);
    const exact = exactHits(sent.json);
    report(exact >= 4 && refused.status === 415, 'im3: a PDF goes through the attachment processor and finds the same talks',
      `the PDF itself ${refused.status}, its extracted text: ${exact} of ${picks.length} at exact title, ${sent.json.extracted_chars} characters`);
    return;
  }
  const { status, json } = await api('POST', '/api/import/schedule', { event: PRIMARY, filename: 'schedule.pdf', mime: 'application/pdf', content_base64: pdf.toString('base64') });
  if (status !== 200) throw new Error(`status ${status}${json.error ? `: ${json.error}` : ''}`);
  const exact = exactHits(json);
  report(exact >= 4, 'im3: a PDF goes through the attachment processor and finds the same talks', `${exact} of ${picks.length} at exact title, ${json.extracted_chars} characters extracted`);
});

await check('im3b: text the browser extracted from a PDF, sent with its file name and type, finds the same talks', async () => {
  // The Worker build (VITE_CLIENT_EXTRACT=1) reads a PDF, Word or OpenDocument file in the browser
  // and sends { filename, mime: 'text/plain', text }; filename and mime are only format hints.
  const pdf = makePdf(importBody.split('\n'));
  const { status, json } = await api('POST', '/api/import/schedule', { event: PRIMARY, filename: 'schedule.pdf', mime: 'text/plain', text: extractPdfText(pdf) });
  if (status !== 200) throw new Error(`status ${status}${json.error ? `: ${json.error}` : ''}`);
  const exact = exactHits(json);
  report(exact >= 4, 'im3b: text the browser extracted from a PDF, sent with its file name and type, finds the same talks', `${exact} of ${picks.length} at exact title`);
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

if (COUNT_MODE === 'none') {
  skip('im5: an import adds nothing to any index', NO_COUNT_WHY);
} else if (countsBefore) {
  await check('im5: an import adds nothing to any index', async () => {
    // A write would be searchable after the one-second refresh interval (Elasticsearch only; the
    // Worker's storage is consistent at once).
    if (COUNT_MODE === 'es') await new Promise((r) => setTimeout(r, 1500));
    const after = await takeCounts();
    const changed = [...new Set([...countsBefore.keys(), ...after.keys()])].filter((i) => countsBefore.get(i) !== after.get(i));
    const describe = (list) => list.map((i) => `${i}: ${countsBefore.get(i) ?? 'none'} -> ${after.get(i) ?? 'none'}`).join('; ');
    // The indices the import reads must not change at all, and no new index may appear under their
    // names. Other sessions and operators share the cluster and may build their own indices during
    // the run, so a change elsewhere is listed but not judged.
    const worker = COUNT_MODE === 'admin';
    const judged = changed.filter((i) => (worker ? /\s(talks|vectors|topics|facets)$/ : /^caddie-(talks|conferences|topics)/).test(i));
    const others = changed.filter((i) => !judged.includes(i));
    report(judged.length === 0, 'im5: an import adds nothing to any index',
      judged.length ? describe(judged) : worker
        ? `${after.size} counters compared, the talks, vectors, topics and facets counts unchanged${others.length ? `; changed by other writers: ${describe(others)}` : ', and every other counter unchanged too'}`
        : `${after.size} indices compared, the talks, conferences and topics indices unchanged${others.length ? `; changed by other writers: ${describe(others)}` : ', and every other index unchanged too'}`);
  });
}

// ---------------------------------------------------------------------------------------------
// People, circles and talks for you. Every test profile is created here and deleted at the end.

const A = newDevice(); // the requester: wants to learn SMOKE_SUBJECT, visible, shares for the circle talk
const B = newDevice(); // has worked on what A wants to learn, visible
const C = newDevice(); // has worked on the same, but only shares for the circle talk
const D = newDevice(); // visible at another conference, wanting what B, C and R have worked on
const N = newDevice(); // visible, but never shares for the circle talk; no words
const E = newDevice(); // shares through the exact writes the Interested screen's auto-share switch sends
const F = newDevice(); // Find & connect: the person with the specific passage, in about only
const K = newDevice(); // Find & connect: shares only the common topic with A, no text
const X = newDevice(); // Find & connect: never gets a profile
const R = newDevice(); // Report: visible and in the circle, has worked on what A wants, reported by A and B
const spotMarker = `smoke-spot-${runTag}`;
const expiredId = `${PRIMARY}:${crypto.randomBytes(16).toString('base64url')}`;
const expiredProfileId = expiredId.split(':')[1];
const expiredSecretHash = crypto.randomBytes(32).toString('hex');
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
      await putProfile(A, PRIMARY, 'A', A_LEARNING, { open: true, shared: [T] }),
      await putProfile(B, PRIMARY, 'B', { interests: SMOKE_SUBJECT, expertise: SMOKE_EXPERTISE }, { open: true }),
      await putProfile(C, PRIMARY, 'C', { expertise: SMOKE_EXPERTISE }, { open: false, shared: [T] }),
      await putProfile(N, PRIMARY, 'N', {}, { open: true }),
    ];
    // D wants what B, C and R have worked on, so any of them crossing conferences would match D.
    results.push(await putProfile(D, EXTRA[0], 'D', { interests: SMOKE_SUBJECT }, { open: true }));
    const statuses = results.map((r) => r.status);
    report(statuses.every((s) => s === 200), 'p1: test profiles are created', statuses.join(','));
  });

  // The expired profile is written behind the API's back (through the Worker's admin fixture, or
  // straight to Elasticsearch on Cloud Run), because the API always sets visible_until to the end of
  // the conference.
  if (WRITE_MODE === 'admin') {
    await check('p1b: the expired test profile is written', async () => {
      const r = await fixture('POST', `/admin/test/profile?event=${encodeURIComponent(PRIMARY)}`, {
        profile_id: expiredProfileId,
        secret_hash: expiredSecretHash,
        display_name: testName('Expired'),
        visible_until_ms: Date.now() - 3600_000,
        open_to_meet: true,
        shared_talk_ids: [T],
      });
      expiredWritten = r.status === 200;
      if (!expiredWritten) report(false, 'p1b: the expired test profile is written', `status ${r.status}`);
    });
  } else if (WRITE_MODE === 'es') {
    const res = await fetch(`${ES_URL}/${encodeURIComponent(PEOPLE_INDEX)}/_doc/${encodeURIComponent(expiredId)}?refresh=wait_for`, {
      method: 'PUT',
      headers: { Authorization: `ApiKey ${ES_WRITE_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        event_id: PRIMARY,
        profile_id: expiredId.split(':')[1],
        display_name: testName('Expired'),
        about: '', interests: '', expertise: SMOKE_EXPERTISE,
        learn_topics: [], speak_topics: [],
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
  await check('p2: wanting to learn something ranks a person who has worked on it near the top', async () => {
    const { status, json } = await api('POST', '/api/people/matches', { event: PRIMARY, interested_talk_ids: [T] }, { device: A, label: 'A-matches' });
    if (status !== 200) throw new Error(`status ${status}`);
    matchesA = json.results ?? [];
    const rank = names(matchesA).indexOf(testName('B'));
    const b = matchesA[rank];
    const named = b && b.reasons.some((r) => r.startsWith('Ask them about') && r.includes('vexmorlith')) && b.opener === b.reasons[0];
    report(rank !== -1 && rank < 5 && named, 'p2: wanting to learn something ranks a person who has worked on it near the top', rank === -1 ? 'not returned' : `rank ${rank + 1}, reason "${b.reasons[0]}"`);
  });

  await check('p3: a profile gets people suggestions, and chips alone get talk suggestions', async () => {
    const recs = await api('POST', '/api/recommendations', { event: PRIMARY, learn_topics: LEARN, interests: '', interested_talk_ids: [] }, { label: 'recs' });
    const ok = (matchesA?.length ?? 0) > 0 && recs.status === 200 && (recs.json.results ?? []).length > 0;
    report(ok, 'p3: a profile gets people suggestions, and chips alone get talk suggestions', `${matchesA?.length ?? 0} people, ${(recs.json.results ?? []).length} talks`);
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

  // The app reads share_required, blocked and Retry-After from error bodies and headers, so an
  // error answer sent to the app's origin must carry the CORS headers and expose the two headers.
  if (!IS_WORKER) {
    skip('cors3: an error response to the app origin carries the CORS headers and exposes Retry-After and X-Caddie-Pace', NOT_WORKER_WHY);
  } else {
    await check('cors3: an error response to the app origin carries the CORS headers and exposes Retry-After and X-Caddie-Pace', async () => {
      const r = await api('POST', '/api/circles/members', { event: PRIMARY, talk_id: T }, { device: N, origin: SMOKE_ORIGIN, label: 'N-members' });
      const problems = [];
      if (r.status !== 403 || r.json.error !== 'share_required') problems.push(`status ${r.status} ${r.json.error ?? ''}`.trim());
      if (r.headers.get('access-control-allow-origin') !== SMOKE_ORIGIN) problems.push('no Access-Control-Allow-Origin on the error answer');
      const exposed = r.headers.get('access-control-expose-headers');
      if (!listHas(exposed, 'retry-after')) problems.push('Retry-After is not exposed');
      if (!listHas(exposed, 'x-caddie-pace')) problems.push('X-Caddie-Pace is not exposed');
      if (!listHas(r.headers.get('vary'), 'origin')) problems.push('no Vary: Origin');
      report(problems.length === 0, 'cors3: an error response to the app origin carries the CORS headers and exposes Retry-After and X-Caddie-Pace', problems.length ? problems.join('; ') : '403 share_required with the CORS headers, both headers exposed');
    });
  }

  await check('p7: expired profiles never appear', async () => {
    if (!expiredWritten) {
      skip('p7: expired profiles never appear', fixturesGated ? FIXTURES_GATED_WHY : NO_WRITE_WHY);
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
      const wrongTalk = await putProfile(A, PRIMARY, 'A', A_LEARNING, { open: true, shared: [T, otherTalk] });
      if (wrongTalk.status !== 400) problems.push(`sharing another conference's talk gave ${wrongTalk.status}`);
    }
    const counts = await api('POST', '/api/circles/counts', { event: EXTRA[0], talk_ids: [T] }, { label: 'public-counts' });
    if ((counts.json.counts?.[T] ?? 0) !== 0) problems.push('a circle count crossed conferences');
    report(problems.length === 0, 'p8: people do not cross conferences', problems.length ? problems.join('; ') : 'checked matches, circles, counts and writes');
  });

  await check('p9: a write or read with the wrong secret is rejected', async () => {
    const wrong = { profileId: A.profileId, secret: crypto.randomBytes(32).toString('base64url') };
    const put = await api('PUT', '/api/people/profile', { event: PRIMARY, profile: profileBody(PRIMARY, 'Intruder', {}), open_to_meet: true, shared_talk_ids: [] }, { device: wrong, label: 'wrong-put' });
    const del = await api('DELETE', `/api/people/profile?event=${PRIMARY}`, undefined, { device: wrong, label: 'wrong-delete' });
    const m = await api('POST', '/api/people/matches', { event: PRIMARY, interested_talk_ids: [] }, { device: wrong, label: 'wrong-matches' });
    const c = await api('POST', '/api/circles/members', { event: PRIMARY, talk_id: T }, { device: wrong, label: 'wrong-members' });
    const still = await api('POST', '/api/people/matches', { event: PRIMARY, interested_talk_ids: [] }, { device: A, label: 'A-matches' });
    const statuses = [put.status, del.status, m.status, c.status];
    const ok = statuses.every((s) => s === 403) && still.status === 200;
    report(ok, 'p9: a write or read with the wrong secret is rejected', `${statuses.join(',')}; the real profile still answers ${still.status}`);
  });

  await check('p10: a cross-origin write is rejected', async () => {
    const r = await api('PUT', '/api/people/profile', { event: PRIMARY, profile: profileBody(PRIMARY, 'A', A_LEARNING), open_to_meet: true, shared_talk_ids: [T] }, { device: A, origin: 'https://evil.example', label: 'cross-origin' });
    report(r.status === 403, 'p10: a cross-origin write is rejected', `status ${r.status}`);
  });

  // The same refusal on a read route that takes the device header, and no CORS grant for the origin.
  await check('cors4: a device route called from another origin gets 403 and no CORS headers', async () => {
    const r = await api('POST', '/api/circles/members', { event: PRIMARY, talk_id: T }, { device: A, origin: EVIL_ORIGIN, label: 'cross-origin' });
    const problems = [];
    if (r.status !== 403) problems.push(`status ${r.status}`);
    if (hasCorsHeader(r.headers)) problems.push('the refusal carries Access-Control headers');
    if (r.json.members) problems.push('the refusal carries members');
    report(problems.length === 0, 'cors4: a device route called from another origin gets 403 and no CORS headers', problems.length ? problems.join('; ') : `status ${r.status}, no Access-Control headers`);
  });

  // ---------------------------------------------------------------------------------------------
  // Find & connect: search by text, presence, meets and blocks. A is the requester.

  const findMatches = (device, label, extra = {}) => api('POST', '/api/people/matches', { event: PRIMARY, interested_talk_ids: [], query: FIND_QUERY, ...extra }, { device, label });
  const personIn = (r, who) => (r.json.results ?? []).find((p) => p.display_name === testName(who));
  // A chips-only person can rank far down a text search on a cluster with many sample profiles,
  // so this pages through the results (at most eight pages of 20) until it finds them.
  const findPerson = async (device, label, who, extra = {}) => {
    for (let from = 0; from < 160; from += 20) {
      const r = await findMatches(device, label, { ...extra, from });
      const p = personIn(r, who);
      if (p || r.status !== 200 || !r.json.has_more) return p ?? null;
    }
    return null;
  };
  let refF = null;
  let refA = null;

  await check('q1: a specific query ranks the person with the matching passage first and returns it as evidence', async () => {
    const f = await putProfile(F, PRIMARY, 'F', { about: FIND_PASSAGE }, { open: true });
    const k = await putProfile(K, PRIMARY, 'K', { learn: [COMMON_TOPIC] }, { open: true });
    if (f.status !== 200 || k.status !== 200) throw new Error(`profiles gave ${f.status}/${k.status}`);
    const r = await findMatches(A, 'A-find');
    if (r.status !== 200) throw new Error(`status ${r.status}`);
    const rank = names(r.json.results).indexOf(testName('F'));
    const p = r.json.results?.[rank];
    refF = p?.ref ?? null;
    const problems = [];
    if (rank !== 0) problems.push(rank === -1 ? 'F not returned' : `F at rank ${rank + 1}`);
    if (!p?.evidence || !/gravitronic/i.test(p.evidence.replace(/<\/?mark>/g, ''))) problems.push(`evidence "${p?.evidence}"`);
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
    if (!names(plain.json.results).includes(testName('B'))) problems.push('B (a specific match) missing from profile matches');
    const whenBad = await api('POST', '/api/people/matches', { event: PRIMARY, interested_talk_ids: [], when: 'soon' }, { device: A, label: 'A-matches' });
    if (whenBad.status !== 400) problems.push(`when=soon gave ${whenBad.status}`);
    report(problems.length === 0, 'q2: a result sharing only the common topic is dropped', problems.length ? problems.join('; ') : `K absent, B present among ${plain.json.results.length}`);
  });

  // A is around from q4 to q9, so its interests go first (see SMOKE_SUBJECT); without that no
  // presence check runs.
  const quiet = await putProfile(A, PRIMARY, 'A', A_AROUND, { open: true, shared: [T] });
  if (quiet.status !== 200) throw new Error(`A without interests gave ${quiet.status}, so the presence checks cannot run`);

  await check('q3: presence needs a visible profile', async () => {
    const none = await api('PUT', '/api/presence', { event: PRIMARY, zone: ZONE_A, spot: '' }, { device: X, label: 'X-presence' });
    const circleOnly = await api('PUT', '/api/presence', { event: PRIMARY, zone: ZONE_A, spot: '' }, { device: C, label: 'C-presence' });
    const badZone = await api('PUT', '/api/presence', { event: PRIMARY, zone: 'No Such Zone', spot: '' }, { device: A, label: 'A-presence' });
    const ok = none.status === 403 && none.json.error === 'profile_required' && circleOnly.status === 403 && circleOnly.json.error === 'profile_required' && badZone.status === 400;
    report(ok, 'q3: presence needs a visible profile', `no profile ${none.status} ${none.json.error}, circle-only ${circleOnly.status} ${circleOnly.json.error}, unknown zone ${badZone.status}`);
  });

  // Both backends accept a push subscription only on a known browser push service host, so a
  // profile can never make them send signed requests to a host of its choosing. The accepted
  // subscription is removed again at once.
  await check('push1: a push subscription must point at a known push service', async () => {
    const P = newDevice();
    // A visible profile with no words of the other checks, deleted again below so it never shows up in them.
    const made = await putProfile(P, PRIMARY, 'P', { about: 'Push subscription check.' }, { open: true });
    if (made.status !== 200) throw new Error(`the push test profile gave ${made.status}`);
    const ecdh = crypto.createECDH('prime256v1');
    ecdh.generateKeys();
    const keys = { p256dh: ecdh.getPublicKey().toString('base64url'), auth: crypto.randomBytes(16).toString('base64url') };
    const sub = (endpoint) => api('PUT', '/api/push/subscription', { event: PRIMARY, subscription: { endpoint, keys } }, { device: P, label: 'P-push' });
    const problems = [];
    for (const endpoint of ['https://example.com/not-a-push-service', 'https://192.0.2.10/push', 'https://fcm.googleapis.com:8443/fcm/send/x', 'https://x.jmt17.google.com/fcm/send/x', 'https://jmt17.google.com.evil.com/fcm/send/x', 'https://jmt17.google.com:8443/fcm/send/x']) {
      const r = await sub(endpoint);
      if (r.status !== 400) problems.push(`${new URL(endpoint).host} gave ${r.status}`);
    }
    // fcm.googleapis.com is Chrome Stable; jmt17.google.com is Chrome Beta, Dev, Canary and Chromium.
    for (const host of ['fcm.googleapis.com', 'jmt17.google.com']) {
      const good = `https://${host}/fcm/send/smoke-${crypto.randomBytes(12).toString('base64url')}`;
      const ok = await sub(good);
      if (ok.status !== 200) problems.push(`${host} gave ${ok.status}`);
      const del = await api('DELETE', '/api/push/subscription', { event: PRIMARY, endpoint: good }, { device: P, label: 'P-push-delete' });
      if (del.status !== 200) problems.push(`delete of ${host} gave ${del.status}`);
    }
    const gone = await api('DELETE', `/api/people/profile?event=${encodeURIComponent(PRIMARY)}`, undefined, { device: P, label: 'P-delete' });
    if (gone.status !== 200) problems.push(`profile delete gave ${gone.status}`);
    report(problems.length === 0, 'push1: a push subscription must point at a known push service', problems.length ? problems.join('; ') : 'other hosts, IP literals, subdomain and look-alike hosts and other ports refused; fcm.googleapis.com and jmt17.google.com accepted and removed');
  });

  await check('q4: a listed word is rejected', async () => {
    if (!WORDLIST.length) throw new Error('config/moderation-words.json has no words');
    const word = WORDLIST[0];
    const leet = word.replace(/o/g, '0').replace(/i/g, '1').replace(/e/g, '3').replace(/a/g, '4').replace(/s/g, '5');
    const spot = await api('PUT', '/api/presence', { event: PRIMARY, zone: ZONE_A, spot: `by the ${word} stand` }, { device: A, label: 'A-presence' });
    const leetSpot = await api('PUT', '/api/presence', { event: PRIMARY, zone: ZONE_A, spot: `by the ${leet.toUpperCase()} stand` }, { device: A, label: 'A-presence' });
    const url = await api('PUT', '/api/presence', { event: PRIMARY, zone: ZONE_A, spot: 'see example.com/me' }, { device: A, label: 'A-presence' });
    const linkedin = await api('PUT', '/api/presence', { event: PRIMARY, zone: ZONE_A, spot: 'see linkedin.com/in/me' }, { device: A, label: 'A-presence' });
    // Script, project and bare domain names are not web addresses.
    const projectNames = await api('PUT', '/api/presence', { event: PRIMARY, zone: ZONE_A, spot: 'kubectl get pods, node.js v1.2, k8s.io, example.com' }, { device: A, label: 'A-presence' });
    const filtered = (r) => r.status === 400 && r.json.error === 'filtered' && r.json.message === 'That was held back by the filter. Edit it and try again.';
    report(filtered(spot) && filtered(leetSpot) && filtered(url) && linkedin.status === 200 && projectNames.status === 200, 'q4: a listed word is rejected', `word ${spot.status}, leet ${leetSpot.status}, url ${url.status}, linkedin.com ${linkedin.status}, tech text ${projectNames.status}`);
  });

  await check('q4b: an ask needs both people around', async () => {
    if (!refF) throw new Error('F has no ref');
    // q4 left A around (its linkedin.com spot line was accepted), so A turns presence off first.
    const off = await api('DELETE', `/api/presence?event=${PRIMARY}`, undefined, { device: A, label: 'A-presence' });
    if (off.status !== 200) throw new Error(`A presence off gave ${off.status}`);
    const nobody = await api('POST', '/api/meet', { event: PRIMARY, ref: refF, topic_id: null, note: '' }, { device: A, label: 'A-meet' });
    const on = await api('PUT', '/api/presence', { event: PRIMARY, zone: ZONE_A, spot: '' }, { device: A, label: 'A-presence' });
    if (on.status !== 200) throw new Error(`A presence gave ${on.status}`);
    const themNot = await api('POST', '/api/meet', { event: PRIMARY, ref: refF, topic_id: null, note: '' }, { device: A, label: 'A-meet' });
    const problems = [];
    if (nobody.status !== 403 || nobody.json.error !== 'presence_required' || nobody.json.message !== "Turn on 'Around and up for a conversation' first.") problems.push(`asking while not around gave ${nobody.status} ${JSON.stringify(nobody.json)}`);
    if (themNot.status !== 409 || themNot.json.error !== 'not_around' || themNot.json.message !== "They're not around right now.") problems.push(`asking someone not around gave ${themNot.status} ${JSON.stringify(themNot.json)}`);
    report(problems.length === 0, 'q4b: an ask needs both people around', problems.length ? problems.join('; ') : '403 presence_required, then 409 not_around');
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
    refA = personIn(await findMatches(F, 'F-find', { query: ASKER_QUERY, when: 'around_now' }), 'A')?.ref ?? null;
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
    // A topic on an ask is only its label; it never takes part in matching.
    const r = await api('POST', '/api/meet', { event: PRIMARY, ref: refF, topic_id: 'ebpf', note: `compare notes on ${FIND_WORD}` }, { device: A, label: 'A-meet' });
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
    const ttl = Date.parse(r.json.expires_at) - Date.parse(r.json.created_at);
    if (!(ttl > 14 * 60_000 && ttl <= 15 * 60_000)) problems.push(`the ask runs out after ${Math.round(ttl / 60_000)} min, not 15`);
    if (r.json.same_zone !== false) problems.push(`same_zone ${r.json.same_zone} across two zones`);
    if (again.status !== 409 || again.json.error !== 'meet_open') problems.push(`a second open request gave ${again.status} ${again.json.error}`);
    if (!(inbox.json.incoming ?? []).some((m) => m.meet_id === meetId && m.from?.display_name === testName('A') && m.topic_label === 'eBPF' && typeof m.expires_at === 'string')) problems.push('F\'s inbox lacks the request');
    if (third.status !== 403 || nobody.status !== 403 || thirdAccept.status !== 403) problems.push(`third devices got ${third.status}/${nobody.status}/${thirdAccept.status}`);
    const activeFor = accept.json.active_until ? Date.parse(accept.json.active_until) - Date.now() : 0;
    if (accept.status !== 200 || accept.json.state !== 'active' || !accept.json.active_since || !(activeFor > 19 * 60_000 && activeFor <= 20 * 60_000)) problems.push(`accept gave ${accept.status} ${accept.json.state}, active for ${Math.round(activeFor / 60_000)} min`);
    if (details.status !== 200) problems.push(`details gave ${details.status}`);
    if (seen.status !== 200 || seen.json.other?.zone !== ZONE_F || seen.json.other?.spot_me !== `${spotMarker}-me` || seen.json.rendezvous !== ZONE_A) problems.push(`A sees ${JSON.stringify(seen.json.other ?? {})}`);
    if (found.status !== 200 || found.json.state !== 'found') problems.push(`found gave ${found.status}`);
    if (after.status !== 410 || after.json.state !== 'found') problems.push(`after found: ${after.status}`);
    report(problems.length === 0, 'q6: a third device gets 403 from a meet, and 410 after found', problems.length ? problems.join('; ') : '15-min ask, accept -> active at once with zone and spot-me, found, then 410');
  });

  await check('q6b: a silent "Not now" leaves the asker\'s view, details and cancel unchanged', async () => {
    // A and K are both around in ZONE_A since q5, so A's ask to K is a same-zone ask.
    const view = await api('POST', '/api/people/matches', { event: PRIMARY, interested_talk_ids: [], when: 'around_now' }, { device: A, label: 'A-matches' });
    const refK = personIn(view, 'K')?.ref;
    if (!refK) throw new Error('K has no ref in A\'s around-now view');
    const r = await api('POST', '/api/meet', { event: PRIMARY, ref: refK, topic_id: null, note: 'Hi there' }, { device: A, label: 'A-meet' });
    if (r.status !== 200) throw new Error(`request gave ${r.status} ${r.json.error ?? ''}`);
    const id = r.json.meet_id;
    const spot = await api('PUT', `/api/meet/${id}/details`, { spot_me: 'blue cap' }, { device: A, label: 'A-meet' });
    const before = await api('GET', `/api/meet/${id}`, undefined, { device: A, label: 'A-meet' });
    const decline = await api('POST', `/api/meet/${id}/decline`, {}, { device: K, label: 'K-meet' });
    const after = await api('GET', `/api/meet/${id}`, undefined, { device: A, label: 'A-meet' });
    const again = await api('PUT', `/api/meet/${id}/details`, { spot_me: 'blue cap, red bag' }, { device: A, label: 'A-meet' });
    const inbox = await api('GET', `/api/meet/inbox?event=${PRIMARY}`, undefined, { device: A, label: 'A-inbox' });
    const cancel = await api('POST', `/api/meet/${id}/cancel`, {}, { device: A, label: 'A-meet' });
    const gone = await api('GET', `/api/meet/${id}`, undefined, { device: A, label: 'A-meet' });
    const shape = (j) => JSON.stringify({ state: j.state, note: j.note, rendezvous: j.rendezvous, spot_me: j.mine?.spot_me, zone: j.other?.zone, same_zone: j.same_zone, active_until: j.active_until });
    const problems = [];
    if (spot.status !== 200) problems.push(`details before the decline gave ${spot.status}`);
    if (before.status !== 200 || before.json.other?.zone !== ZONE_A || before.json.mine?.spot_me !== 'blue cap') problems.push(`before: ${shape(before.json)}`);
    if (decline.status !== 200 || decline.json.state !== 'declined') problems.push(`decline gave ${decline.status} ${decline.json.state}`);
    if (after.status !== 200 || shape(after.json) !== shape(before.json)) problems.push(`after the decline A sees ${shape(after.json)}, before ${shape(before.json)}`);
    if (again.status !== 200 || again.json.state !== 'requested' || again.json.mine?.spot_me !== 'blue cap, red bag') problems.push(`details after the decline gave ${again.status} ${JSON.stringify(again.json)}`);
    if (!(inbox.json.outgoing ?? []).some((m) => m.meet_id === id && m.state === 'requested' && m.note === 'Hi there')) problems.push('A\'s inbox lacks the waiting ask');
    if (cancel.status !== 200 || cancel.json.state !== 'cancelled') problems.push(`cancel gave ${cancel.status} ${cancel.json.state}`);
    if (gone.status !== 410 || gone.json.state !== 'cancelled') problems.push(`after cancel: ${gone.status} ${gone.json.state}`);
    report(problems.length === 0, 'q6b: a silent "Not now" leaves the asker\'s view, details and cancel unchanged', problems.length ? problems.join('; ') : 'same view with zone, 200 details, 200 cancelled, then 410 cancelled');
  });

  await check('q6c: asking again after Not now answers 409 meet_open, as for a pending ask', async () => {
    if (!refA) throw new Error('A has no ref');
    // F asks A here, and cancels at the end, so no declined ask stands in the way of later asks.
    const r = await api('POST', '/api/meet', { event: PRIMARY, ref: refA, topic_id: null, note: '' }, { device: F, label: 'F-meet' });
    if (r.status !== 200) throw new Error(`request gave ${r.status} ${r.json.error ?? ''}`);
    const decline = await api('POST', `/api/meet/${r.json.meet_id}/decline`, {}, { device: A, label: 'A-meet' });
    const again = await api('POST', '/api/meet', { event: PRIMARY, ref: refA, topic_id: null, note: '' }, { device: F, label: 'F-meet' });
    const inboxA = await api('GET', `/api/meet/inbox?event=${PRIMARY}`, undefined, { device: A, label: 'A-inbox' });
    const cancel = await api('POST', `/api/meet/${r.json.meet_id}/cancel`, {}, { device: F, label: 'F-meet' });
    const problems = [];
    if (decline.status !== 200 || decline.json.state !== 'declined') problems.push(`decline gave ${decline.status} ${decline.json.state}`);
    if (again.status !== 409 || again.json.error !== 'meet_open' || again.json.meet_id !== r.json.meet_id) problems.push(`asking again gave ${again.status} ${JSON.stringify(again.json)}`);
    if ((inboxA.json.incoming ?? []).some((m) => m.from?.display_name === testName('F'))) problems.push('A got a new card from F');
    if (cancel.status !== 200 || cancel.json.state !== 'cancelled') problems.push(`cancel gave ${cancel.status} ${cancel.json.state}`);
    report(problems.length === 0, 'q6c: asking again after Not now answers 409 meet_open, as for a pending ask', problems.length ? problems.join('; ') : 'the re-ask gets 409 meet_open with the same meet, A sees no new card');
  });

  await check('q7: presence expires', async () => {
    if (WRITE_MODE === 'none') {
      skip('q7: presence expires', NO_WRITE_WHY);
      return;
    }
    await agePresence(A, 'A');
    const r = await findMatches(A, 'A-find');
    const f = personIn(r, 'F');
    const fromF = await findPerson(F, 'F-find', 'A', { query: ASKER_QUERY });
    const ok = f && f.around === true && f.zone === null && fromF && fromF.around === false;
    report(Boolean(ok), 'q7: presence expires', ok ? 'an aged presence_until hides the zone and shows A as not around' : `F zone ${f?.zone}, A around ${fromF?.around}`);
  });

  await check('q8: block is symmetric and refuses a meet either way with the same body', async () => {
    if (!refF || !refA) throw new Error('refs missing');
    // q7 aged A's presence away. With A around again, F's around-now view lists A unless the
    // block hides A, so the check below cannot pass only because A ranked past the first page.
    const back = await api('PUT', '/api/presence', { event: PRIMARY, zone: ZONE_A, spot: '' }, { device: A, label: 'A-presence' });
    if (back.status !== 200) throw new Error(`A presence gave ${back.status}`);
    const blk = await api('POST', '/api/people/block', { event: PRIMARY, ref: refF }, { device: A, label: 'A-block' });
    const fromA = await findMatches(A, 'A-find');
    const fromF = await findMatches(F, 'F-find', { query: ASKER_QUERY, when: 'around_now' });
    const aToF = await api('POST', '/api/meet', { event: PRIMARY, ref: refF, topic_id: null, note: '' }, { device: A, label: 'A-meet' });
    const fToA = await api('POST', '/api/meet', { event: PRIMARY, ref: refA, topic_id: null, note: '' }, { device: F, label: 'F-meet' });
    const list = await api('GET', `/api/people/blocks?event=${PRIMARY}`, undefined, { device: A, label: 'A-blocks' });
    const un = await api('DELETE', '/api/people/block', { event: PRIMARY, ref: refF }, { device: A, label: 'A-block' });
    const after = await findMatches(A, 'A-find');
    const problems = [];
    if (blk.status !== 200) problems.push(`block gave ${blk.status}`);
    if (names(fromA.json.results).includes(testName('F'))) problems.push('F still in A\'s results');
    if (names(fromF.json.results).includes(testName('A'))) problems.push('A still in F\'s results');
    if (aToF.status !== 403 || fToA.status !== 403 || aToF.json.error !== 'blocked' || JSON.stringify(aToF.json) !== JSON.stringify(fToA.json)) problems.push(`meets gave ${aToF.status} ${JSON.stringify(aToF.json)} and ${fToA.status} ${JSON.stringify(fToA.json)}`);
    if (!(list.json.refs ?? []).includes(refF) || !(list.json.blocks ?? []).some((b) => b.ref === refF && b.display_name === testName('F'))) problems.push('blocks list lacks F');
    if (un.status !== 200 || !names(after.json.results).includes(testName('F'))) problems.push('F not back after unblock');
    report(problems.length === 0, 'q8: block is symmetric and refuses a meet either way with the same body', problems.length ? problems.join('; ') : 'hidden both ways, 403 blocked both ways, listed, unblocked');
  });

  await check('q8a: a block refuses every meet route between the pair, and closes their meet', async () => {
    if (!refF || !refA) throw new Error('refs missing');
    // F asks, so A's asks stay within the hourly limit.
    const r = await api('POST', '/api/meet', { event: PRIMARY, ref: refA, topic_id: null, note: '' }, { device: F, label: 'F-meet' });
    if (r.status !== 200) throw new Error(`request gave ${r.status} ${r.json.error ?? ''}`);
    const id = r.json.meet_id;
    const accept = await api('POST', `/api/meet/${id}/accept`, {}, { device: A, label: 'A-meet' });
    if (accept.status !== 200) throw new Error(`accept gave ${accept.status} ${accept.json.error ?? ''}`);
    const blk = await api('POST', '/api/people/block', { event: PRIMARY, ref: refF }, { device: A, label: 'A-block' });
    const fGet = await api('GET', `/api/meet/${id}`, undefined, { device: F, label: 'F-meet' });
    const fDetails = await api('PUT', `/api/meet/${id}/details`, { spot_me: 'by the door' }, { device: F, label: 'F-meet' });
    const fCancel = await api('POST', `/api/meet/${id}/cancel`, {}, { device: F, label: 'F-meet' });
    const aGet = await api('GET', `/api/meet/${id}`, undefined, { device: A, label: 'A-meet' });
    const un = await api('DELETE', '/api/people/block', { event: PRIMARY, ref: refF }, { device: A, label: 'A-block' });
    const after = await api('GET', `/api/meet/${id}`, undefined, { device: A, label: 'A-meet' });
    const problems = [];
    if (blk.status !== 200 || un.status !== 200) problems.push(`block ${blk.status}, unblock ${un.status}`);
    const refused = [fGet, fDetails, fCancel, aGet];
    if (!refused.every((x) => x.status === 403 && x.json.error === 'blocked')) problems.push(`while blocked: ${refused.map((x) => `${x.status} ${x.json.error}`).join(', ')}`);
    if (after.status !== 410) problems.push(`after unblock the meet answers ${after.status} ${after.json.state ?? ''}`);
    report(problems.length === 0, 'q8a: a block refuses every meet route between the pair, and closes their meet', problems.length ? problems.join('; ') : 'GET, details and cancel 403 blocked both ways; the meet stays over after unblock');
  });

  await check('q8b: the inbox omits the spot-me line once a presence lapses', async () => {
    if (WRITE_MODE === 'none') {
      skip('q8b: the inbox omits the spot-me line once a presence lapses', NO_WRITE_WHY);
      return;
    }
    if (!refA) throw new Error('A has no ref');
    // K (around since q5) asks A; K's presence is then aged directly, as in q7, without the
    // DELETE that would close the meet.
    const kSpot = `smoke-kspot-${runTag}`;
    const r = await api('POST', '/api/meet', { event: PRIMARY, ref: refA, topic_id: null, note: '' }, { device: K, label: 'K-meet' });
    if (r.status !== 200) throw new Error(`request gave ${r.status} ${r.json.error ?? ''}`);
    const id = r.json.meet_id;
    const accept = await api('POST', `/api/meet/${id}/accept`, {}, { device: A, label: 'A-meet' });
    const details = await api('PUT', `/api/meet/${id}/details`, { spot_me: kSpot }, { device: K, label: 'K-meet' });
    if (accept.status !== 200 || details.status !== 200) throw new Error(`accept ${accept.status}, details ${details.status}`);
    const before = await api('GET', `/api/meet/inbox?event=${PRIMARY}`, undefined, { device: A, label: 'A-inbox' });
    await agePresence(K, 'K');
    const inbox = await api('GET', `/api/meet/inbox?event=${PRIMARY}`, undefined, { device: A, label: 'A-inbox' });
    const meet = await api('GET', `/api/meet/${id}`, undefined, { device: A, label: 'A-meet' });
    const problems = [];
    const seenBefore = [...(before.json.incoming ?? []), ...(before.json.outgoing ?? [])].find((m) => m.meet_id === id);
    if (seenBefore?.other?.spot_me !== kSpot) problems.push('the active meet\'s card lacked the spot-me line while both were around');
    if (inbox.status !== 200 || JSON.stringify(inbox.json).includes(kSpot)) problems.push(`after K's presence lapsed the inbox gave ${inbox.status} and ${JSON.stringify(inbox.json).includes(kSpot) ? 'still carries' : 'omits'} the spot-me line`);
    if (meet.status !== 410) problems.push(`the meet answers ${meet.status}`);
    report(problems.length === 0, 'q8b: the inbox omits the spot-me line once a presence lapses', problems.length ? problems.join('; ') : 'shown while both around, gone from the inbox once K lapsed, and the meet is over');
  });

  await check('q9: delete removes everything', async () => {
    // An ask needs A around; q8 turned A's presence back on, and this keeps it on.
    const back = await api('PUT', '/api/presence', { event: PRIMARY, zone: ZONE_A, spot: '' }, { device: A, label: 'A-presence' });
    if (back.status !== 200) throw new Error(`A presence gave ${back.status}`);
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
    const fromN = await findMatches(N, 'N-find', { query: ASKER_QUERY });
    if (fromN.status !== 200) problems.push(`N's search gave ${fromN.status}`);
    report(problems.length === 0, 'q9: delete removes everything', problems.length ? problems.join('; ') : 'profile, meet and block gone');
  });

  await check('q10: two reports hide a profile from everyone but its owner', async () => {
    // A leaves presence for good and takes its interests back, so R is in A's matches. B shares
    // for the circle talk too, so both reporters see the circle. R is the reported person.
    const away = await api('DELETE', `/api/presence?event=${PRIMARY}`, undefined, { device: A, label: 'A-presence' });
    if (away.status !== 200) throw new Error(`A presence off gave ${away.status}`);
    const learning = await putProfile(A, PRIMARY, 'A', A_LEARNING, { open: true, shared: [T] });
    if (learning.status !== 200) throw new Error(`A with interests gave ${learning.status}`);
    const shareB = await putProfile(B, PRIMARY, 'B', { interests: SMOKE_SUBJECT, expertise: SMOKE_EXPERTISE }, { open: true, shared: [T] });
    if (shareB.status !== 200) throw new Error(`B sharing gave ${shareB.status}`);
    const countBeforeR = await countOf();
    const r = await putProfile(R, PRIMARY, 'R', { expertise: SMOKE_EXPERTISE }, { open: true, shared: [T] });
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
    reportedRefs.push(refR);
    const reportR = (device, who, reason = 'spam') => api('POST', '/api/people/report', { event: PRIMARY, ref: refR, context: { kind: 'profile', id: refR }, reason }, { device, label: `${who}-report` });
    const first = await reportR(A, 'A');
    const again = await reportR(A, 'A', 'other');
    const stillA = await seenBy(A, 'A');
    const second = await reportR(B, 'B');
    const afterA = await seenBy(A, 'A');
    const afterB = await seenBy(B, 'B');
    const meet = await api('POST', '/api/meet', { event: PRIMARY, ref: refR, topic_id: null, note: '' }, { device: A, label: 'A-meet' });
    const owner = await putProfile(R, PRIMARY, 'R', { expertise: SMOKE_EXPERTISE }, { open: true, shared: [T] });
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
    const off = await putProfile(C, PRIMARY, 'C', { expertise: SMOKE_EXPERTISE }, { open: false, shared: [] });
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
    const name = 'r1: For you puts talks with a wanted topic first and never an ended or marked one';
    skipIfPrimaryOver();
    // The topic is chosen now: the one with the most talks that have not ended (end after now, as the
    // server decides it), and at least MIN_UPCOMING, because two are marked and one must remain.
    const candidates = [];
    for (const t of (topicsBySlug.get(PRIMARY) ?? []).slice(0, 12)) {
      const r = await api('POST', '/api/recommendations', { event: PRIMARY, learn_topics: [t.topic_id], interested_talk_ids: [], size: 50 }, { label: 'recs' });
      if (r.status !== 200) throw new Error(`status ${r.status}`);
      candidates.push({ topic_id: t.topic_id, label: t.label, upcoming: countUpcoming(r.json.results ?? [], t.topic_id, Date.now()) });
    }
    const topic = pickUpcomingTopic(candidates);
    if (!topic) throw new SkipCheck(`no topic has ${MIN_UPCOMING} or more talks that have not ended`);
    const first = await api('POST', '/api/recommendations', { event: PRIMARY, learn_topics: [topic.topic_id], interested_talk_ids: [], size: 20 }, { label: 'recs' });
    if (first.status !== 200) throw new Error(`status ${first.status}`);
    const marked = (first.json.results ?? []).slice(0, 2).map((r) => r.talk_id);
    const second = await api('POST', '/api/recommendations', { event: PRIMARY, learn_topics: [topic.topic_id], interested_talk_ids: marked, size: 50 }, { label: 'recs' });
    const chips = await api('POST', '/api/recommendations', { event: PRIMARY, learn_topics: [topic.topic_id], interested_talk_ids: marked, size: 50 }, { label: 'recs' });
    const results = second.json.results ?? [];
    const now = Date.now();
    const problems = [];
    if (!results.length) problems.push('no results');
    const hasWanted = (r) => (r.topics ?? []).some((t) => t.topic_id === topic.topic_id);
    if (results[0] && !(hasWanted(results[0]) && results[0].why.topics.includes(topic.label))) problems.push(`the first result "${results[0].title}" lacks ${topic.label}`);
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
    report(unique.length === 0, name, unique.length ? unique.slice(0, 3).join('; ') : `${results.length} suggestions on ${topic.label} (${topic.upcoming} upcoming), first "${results[0].title}"`);
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

  // For you is learn-only. The reasons on a suggestion must name only learn topics the request
  // sent. A user who removes Kubernetes from their profile must never be told a talk matched on
  // it, and a topic the user can speak to is never a signal and never named.
  const labelOf = new Map((topicsBySlug.get(PRIMARY) ?? []).map((t) => [t.topic_id, t.label]));
  const ask = (learn, speak = [], extra = {}) => api('POST', '/api/recommendations', { event: PRIMARY, learn_topics: learn, speak_topics: speak, interests: '', expertise: '', interested_talk_ids: [], size: 50, ...extra }, { label: 'recs' });
  const whyProblems = (results, learn) => {
    const learnSet = new Set(learn.map((id) => labelOf.get(id)));
    const out = [];
    for (const r of results) {
      const w = r.why ?? {};
      if (!(w.learn_topics ?? []).every((l) => learnSet.has(l))) out.push(`"${r.title}" lists a learn topic that was not sent`);
      if (JSON.stringify(w.topics) !== JSON.stringify(w.learn_topics)) out.push(`"${r.title}" has a why.topics that is not equal to learn_topics`);
      if ('speak_topics' in w) out.push(`"${r.title}" returns speak_topics in why`);
    }
    return out;
  };

  await check('r3: a request without kubernetes never names kubernetes in why', async () => {
    if (!labelOf.has('kubernetes') || !labelOf.has('ai') || !labelOf.has('agents')) {
      skip('r3: a request without kubernetes never names kubernetes in why', 'the conference has no kubernetes, ai or agents topic');
      return;
    }
    const learn = ['ai', 'agents'];
    const r = await ask(learn);
    if (r.status !== 200) throw new Error(`status ${r.status}`);
    const results = r.json.results ?? [];
    const problems = whyProblems(results, learn);
    for (const x of results) {
      const named = [...(x.why?.topics ?? []), ...(x.why?.learn_topics ?? [])];
      if (named.some((l) => /kubernetes/i.test(l))) problems.push(`"${x.title}" names Kubernetes`);
    }
    // The check has teeth only when some returned talk really carries the kubernetes topic.
    const carries = results.some((x) => (x.topics ?? []).some((t) => t.topic_id === 'kubernetes'));
    if (!carries) problems.push('no returned talk carries the kubernetes topic, so the check proves nothing');
    const unique = [...new Set(problems)];
    report(unique.length === 0, 'r3: a request without kubernetes never names kubernetes in why', unique.length ? unique.slice(0, 3).join('; ') : `${results.length} suggestions, none name Kubernetes`);
  });

  await check('r4: the topics in why are a subset of the learn topics sent, with no speak topics', async () => {
    const have = (ids) => ids.filter((id) => labelOf.has(id));
    const cases = [
      [have(['ai', 'agents']), have(['kubernetes'])],
      [have(['kubernetes']), have(['ai'])],
      [have(['ebpf', 'gpu']), have(['llm', 'kubernetes'])],
      [have(['kubernetes', 'ai']), have(['kubernetes'])],
      [[...labelOf.keys()].slice(0, 5), [...labelOf.keys()].slice(3, 8)],
    ].filter(([learn]) => learn.length > 0);
    const problems = [];
    let sawLearn = false;
    for (const [learn, speak] of cases) {
      const r = await ask(learn, speak);
      if (r.status !== 200) {
        problems.push(`status ${r.status}`);
        continue;
      }
      const results = r.json.results ?? [];
      problems.push(...whyProblems(results, learn));
      if (results.some((x) => (x.why?.learn_topics ?? []).length > 0)) sawLearn = true;
    }
    if (!sawLearn) problems.push('no suggestion named a learn topic, so the check proves nothing');
    const unique = [...new Set(problems)];
    report(unique.length === 0, 'r4: the topics in why are a subset of the learn topics sent, with no speak topics', unique.length ? unique.slice(0, 3).join('; ') : `${cases.length} requests checked`);
  });

  await check('r5: a request with only speak_topics and expertise needs a profile and returns nothing', async () => {
    const speak = ['kubernetes', 'ai'].filter((id) => labelOf.has(id));
    const r = await ask([], speak, { expertise: 'I run Kubernetes clusters and teach operators' });
    const ok = r.status === 200 && r.json.needs_profile === true && (r.json.results ?? []).length === 0;
    report(ok, 'r5: a request with only speak_topics and expertise needs a profile and returns nothing', `status ${r.status}, needs_profile ${r.json.needs_profile}, ${(r.json.results ?? []).length} results`);
  });

  await check('r6: speak topics change neither the ranking nor the reasons', async () => {
    if (!labelOf.has('kubernetes') || !labelOf.has('ai')) {
      skip('r6: speak topics change neither the ranking nor the reasons', 'the conference has no kubernetes or ai topic');
      return;
    }
    const withSpeak = await ask(['ai'], ['kubernetes'], { expertise: 'Kubernetes operators and controllers', size: 10 });
    const without = await ask(['ai'], [], { size: 10 });
    if (withSpeak.status !== 200 || without.status !== 200) throw new Error(`status ${withSpeak.status}/${without.status}`);
    const a = (withSpeak.json.results ?? []).map((x) => x.talk_id);
    const b = (without.json.results ?? []).map((x) => x.talk_id);
    const problems = [];
    if (!a.length) problems.push('no results');
    if (JSON.stringify(a) !== JSON.stringify(b)) problems.push('the top results differ when speak_topics is sent');
    for (const x of withSpeak.json.results ?? []) {
      const named = [...(x.why?.topics ?? []), ...(x.why?.learn_topics ?? [])];
      if (named.some((l) => /kubernetes/i.test(l)) || 'speak_topics' in (x.why ?? {})) problems.push(`"${x.title}" shows kubernetes in why`);
    }
    report(problems.length === 0, 'r6: speak topics change neither the ranking nor the reasons', problems.length ? problems.slice(0, 3).join('; ') : `${a.length} results identical with and without speak_topics`);
  });

  await check('r7: the learn and problems text alone returns talks with a relevant passage', async () => {
    skipIfPrimaryOver();
    const r = await ask([], [], { interests: 'our GPU inference costs are too high', size: 10 });
    if (r.status !== 200) throw new Error(`status ${r.status}`);
    const results = r.json.results ?? [];
    const relevant = /gpu|inference|cost|efficien|scal|latency|throughput|serving|accelerat|resource|utiliz|llm|model/i;
    const top = results.slice(0, 5);
    const withPassage = top.filter((x) => x.why?.passage && relevant.test(x.why.passage));
    const problems = [];
    if (r.json.needs_profile) problems.push('needs_profile was returned for a request with text');
    if (results.length === 0) problems.push('no results');
    if (top.length && withPassage.length < Math.min(3, top.length)) problems.push(`only ${withPassage.length} of the top ${top.length} have a relevant passage`);
    if (results.some((x) => (x.why?.learn_topics ?? []).length > 0)) problems.push('a topic was named although no topic was sent');
    report(problems.length === 0, 'r7: the learn and problems text alone returns talks with a relevant passage', problems.length ? problems.join('; ') : `${results.length} talks, first "${results[0].title}"`);
  });

  // The primary and replica copies of the talks shard hold different numbers of deleted
  // documents, so they break ties between equal scores differently. The server pins every search
  // for a conference to one copy (a preference), so the same request must always give the same
  // order. Many talks share a topic, so the tie is real for a single learn topic.
  await check('r8: the same For you request made five times returns the same talk order', async () => {
    skipIfPrimaryOver();
    const topic = labelOf.has('ai') ? 'ai' : [...labelOf.keys()][0];
    if (!topic) {
      skip('r8: the same For you request made five times returns the same talk order', 'the conference has no topics');
      return;
    }
    const orders = [];
    for (let i = 0; i < 5; i++) {
      const r = await ask([topic], [], { size: 10 });
      if (r.status !== 200) throw new Error(`status ${r.status}`);
      orders.push((r.json.results ?? []).map((x) => x.talk_id));
    }
    const distinct = new Set(orders.map((o) => o.join(',')));
    const problems = [];
    if (!orders[0].length) problems.push('no results');
    if (distinct.size !== 1) problems.push(`${distinct.size} different orders in 5 identical requests`);
    report(problems.length === 0, 'r8: the same For you request made five times returns the same talk order', problems.length ? problems.join('; ') : `5 requests, one order of ${orders[0].length} talks for "${topic}"`);
  });

  await check('q8c: a block outlives the blocked profile: a re-created profile stays blocked, and the block can still be lifted', async () => {
    // Blocks belong to the blocker (docs/contracts/people-api.md). Both profiles have only about
    // text, which nudges never read, so being around for the ask cannot nudge anyone.
    const BL = newDevice();
    const BD = newDevice();
    const word = `zqvblock${runTag}`;
    const aboutBL = `untangles glimberwick ${word} sprockets`;
    const aboutBD = `polishes quorbial ${word} flanges`;
    await putProfile(BL, PRIMARY, 'BL', { about: aboutBL }, { open: true });
    await putProfile(BD, PRIMARY, 'BD', { about: aboutBD }, { open: true });
    const find = (device, label, query) => api('POST', '/api/people/matches', { event: PRIMARY, interested_talk_ids: [], query }, { device, label });
    const refBD = ((await find(BL, 'BL-find', `quorbial ${word} flanges`)).json.results ?? []).find((p) => p.display_name === testName('BD'))?.ref;
    const refBL = ((await find(BD, 'BD-find', `glimberwick ${word} sprockets`)).json.results ?? []).find((p) => p.display_name === testName('BL'))?.ref;
    if (!refBD || !refBL) throw new Error('the two profiles did not find each other');
    const blk = await api('POST', '/api/people/block', { event: PRIMARY, ref: refBD }, { device: BL, label: 'BL-block' });
    const gone = await api('DELETE', `/api/people/profile?event=${PRIMARY}`, undefined, { device: BD, label: 'BD-delete' });
    const listGone = await api('GET', `/api/people/blocks?event=${PRIMARY}`, undefined, { device: BL, label: 'BL-blocks' });
    await putProfile(BD, PRIMARY, 'BD', { about: aboutBD }, { open: true });
    const fromBD = await find(BD, 'BD-find', `glimberwick ${word} sprockets`);
    await api('PUT', '/api/presence', { event: PRIMARY, zone: ZONE_A, spot: '' }, { device: BL, label: 'BL-presence' });
    await api('PUT', '/api/presence', { event: PRIMARY, zone: ZONE_A, spot: '' }, { device: BD, label: 'BD-presence' });
    const ask = await api('POST', '/api/meet', { event: PRIMARY, ref: refBL, topic_id: null, note: '' }, { device: BD, label: 'BD-meet' });
    const un = await api('DELETE', '/api/people/block', { event: PRIMARY, ref: refBD }, { device: BL, label: 'BL-block' });
    const listAfter = await api('GET', `/api/people/blocks?event=${PRIMARY}`, undefined, { device: BL, label: 'BL-blocks' });
    await api('DELETE', `/api/presence?event=${PRIMARY}`, undefined, { device: BL, label: 'BL-presence' });
    await api('DELETE', `/api/presence?event=${PRIMARY}`, undefined, { device: BD, label: 'BD-presence' });
    if (ask.status === 200) await api('POST', `/api/meet/${ask.json.meet_id}/cancel`, {}, { device: BD, label: 'BD-meet' });
    const problems = [];
    if (blk.status !== 200 || gone.status !== 200) problems.push(`block ${blk.status}, delete ${gone.status}`);
    const row = (listGone.json.blocks ?? []).find((b) => b.ref === refBD);
    if (!row || row.display_name !== null || !(listGone.json.refs ?? []).includes(refBD)) problems.push(`after the delete the blocks list holds ${JSON.stringify(listGone.json)}`);
    if (names(fromBD.json.results).includes(testName('BL'))) problems.push('the re-created profile finds the blocker');
    if (ask.status !== 403 || ask.json.error !== 'blocked') problems.push(`the re-created profile's ask gave ${ask.status} ${JSON.stringify(ask.json)}`);
    if (un.status !== 200 || (listAfter.json.blocks ?? []).length !== 0) problems.push(`unblock gave ${un.status}, list after ${JSON.stringify(listAfter.json)}`);
    report(problems.length === 0, 'q8c: a block outlives the blocked profile: a re-created profile stays blocked, and the block can still be lifted', problems.length ? problems.join('; ') : 'listed with display_name null, still hidden and 403 blocked after re-creating, unblocked by ref');
  });

  // Bluetooth. ble1 needs no match: a profile with only the common topic, so it is safe anywhere.
  const tokenOf = (keyText, dw = 0) => encodeToken(deriveToken(decodeKey(keyText), windowOf(Date.now() / 1000) + BigInt(dw)));
  await check('ble1: Bluetooth sessions follow ble.mode, and sightings need a live session', async () => {
    if (!IS_WORKER || !capsDoc) {
      skip('ble1: Bluetooth sessions follow ble.mode, and sightings need a live session', 'no capabilities document');
      return;
    }
    const BT = newDevice();
    await putProfile(BT, PRIMARY, 'BT', { speak: [COMMON_TOPIC] }, { open: true });
    const on = await api('PUT', '/api/presence', { event: PRIMARY, zone: ZONE_A, spot: '', ble: true }, { device: BT, label: 'BT-presence' });
    const derived = capsDoc.ble?.mode === 'derived-v1';
    const problems = [];
    const pv = validator('people-api.v1', 'PresencePutResponse')(on.json, { closed: true });
    if (on.status !== 200 || !pv.valid) problems.push(`presence gave ${on.status}${pv.valid ? '' : `, schema: ${pv.errors[0]?.path} ${pv.errors[0]?.message}`}`);
    if (derived && !(/^[A-Za-z0-9_-]{43}$/.test(on.json.ble_key ?? '') && /^[A-Za-z0-9_-]{11}$/.test(on.json.ble_key_id ?? ''))) problems.push('derived-v1 but no ble_key and ble_key_id');
    if (!derived && (on.json.ble_key || !on.json.ble?.token)) problems.push('server-rotate but no legacy token, or a key');
    const own = derived ? tokenOf(on.json.ble_key) : on.json.ble?.token;
    const sight = await api('POST', '/api/presence/sightings', { event: PRIMARY, sightings: [{ token: own, rssi: -40 }, { token: crypto.randomBytes(16).toString('base64url'), rssi: -40 }] }, { device: BT, label: 'BT-sightings' });
    const sv = validator('people-api.v1', 'SightingsResponse')(sight.json, { closed: true });
    if (sight.status !== 200 || !sv.valid || (sight.json.nearby ?? []).length !== 0) problems.push(`own and unknown tokens gave ${sight.status} ${JSON.stringify(sight.json)}`);
    if (derived && sight.json.ble_key_id !== on.json.ble_key_id) problems.push('the sightings answer does not name the current key');
    const off = await api('PUT', '/api/presence', { event: PRIMARY, zone: ZONE_A, spot: '', ble: false }, { device: BT, label: 'BT-presence' });
    const after = await api('POST', '/api/presence/sightings', { event: PRIMARY, sightings: [{ token: own, rssi: -40 }] }, { device: BT, label: 'BT-sightings' });
    if (off.status !== 200 || after.status !== 403 || after.json.error !== 'ble_required') problems.push(`after ble:false sightings gave ${after.status} ${JSON.stringify(after.json)}`);
    await api('DELETE', `/api/presence?event=${PRIMARY}`, undefined, { device: BT, label: 'BT-presence' });
    report(problems.length === 0, 'ble1: Bluetooth sessions follow ble.mode, and sightings need a live session', problems.length ? problems.join('; ') : `${capsDoc.ble?.mode}: ${derived ? 'key and key id once, ' : ''}own and unknown tokens resolve nobody, 403 ble_required after ble:false`);
  });

  await check('ble2: sightings resolve only co-located people, with a zone only in the requester\'s zone, at most 10 new people per window', async () => {
    if (!IS_WORKER || !capsDoc || capsDoc.ble?.mode === 'none') {
      skip('ble2: sightings resolve only co-located people, with a zone only in the requester\'s zone, at most 10 new people per window', 'no Bluetooth on this backend');
      return;
    }
    if (!LOCAL_API && process.env.SMOKE_BLE !== '1') {
      skip('ble2: sightings resolve only co-located people, with a zone only in the requester\'s zone, at most 10 new people per window', 'it puts specific-match test profiles around; set SMOKE_BLE=1 to run it against a deployed API');
      return;
    }
    const derived = capsDoc.ble.mode === 'derived-v1';
    const word = `zqvble${runTag}`;
    const BR = newDevice();
    await putProfile(BR, PRIMARY, 'BR', { interests: `${word} glimmering quabbit rigs` }, { open: true });
    await api('PUT', '/api/presence', { event: PRIMARY, zone: ZONE_A, spot: '', ble: true }, { device: BR, label: 'BR-presence' });
    const tokens = [];
    const around = [BR];
    for (let i = 0; i < 12; i++) {
      const d = newDevice();
      around.push(d);
      await putProfile(d, PRIMARY, `BN${i}`, { expertise: `tuned ${word} glimmering quabbit rigs ${i}` }, { open: true });
      const p = await api('PUT', '/api/presence', { event: PRIMARY, zone: i === 11 ? ZONE_F : ZONE_A, spot: '', ble: true }, { device: d, label: `BN${i}-presence` });
      tokens.push(derived ? tokenOf(p.json.ble_key) : p.json.ble?.token);
    }
    const near = await api('POST', '/api/presence/sightings', { event: PRIMARY, sightings: tokens.slice(0, 11).map((token) => ({ token, rssi: -50 })) }, { device: BR, label: 'BR-sightings' });
    const far = await api('POST', '/api/presence/sightings', { event: PRIMARY, sightings: [{ token: tokens[11], rssi: -40 }] }, { device: BR, label: 'BR-sightings' });
    for (const d of around) await api('DELETE', `/api/presence?event=${PRIMARY}`, undefined, { device: d, label: 'ble2-presence' });
    const nearby = near.json.nearby ?? [];
    const problems = [];
    if (near.status !== 200) problems.push(`sightings gave ${near.status}`);
    if (nearby.length !== 10) problems.push(`${nearby.length} of 11 co-located matches returned, expected the cap of 10`);
    if (nearby.some((p) => p.zone !== ZONE_A)) problems.push('a same-zone person came without the zone');
    if ((far.json.nearby ?? []).length !== 0) problems.push(`a person in ${ZONE_F} resolved for a requester in ${ZONE_A}`);
    report(problems.length === 0, 'ble2: sightings resolve only co-located people, with a zone only in the requester\'s zone, at most 10 new people per window', problems.length ? problems.join('; ') : `${capsDoc.ble.mode}: 10 of 11 co-located matches, zone shown, another zone resolves nobody`);
  });

  await check('unav1: an owner can delete while the conference is unavailable', async () => {
    const slug = process.env.SMOKE_UNAVAILABLE;
    if (!slug || WRITE_MODE !== 'admin' || !LOCAL_API) {
      skip('unav1: an owner can delete while the conference is unavailable', 'needs SMOKE_UNAVAILABLE=<slug>, an admin token and a local API');
      return;
    }
    // A Worker with its fixtures gated off is a deployed one, whose conferences must not be flipped.
    if (fixturesGated) throw new SkipCheck(FIXTURES_GATED_WHY);
    const doc = JSON.parse(readFileSync(join(ROOT, 'data', slug, 'conference.json'), 'utf8'));
    const U = newDevice();
    await putProfile(U, slug, 'U', {}, { open: true });
    const flip = await admin('PUT', '/admin/conferences', { conferences: [{ ...doc, status: 'unavailable', status_reason: 'fetch_failed' }] });
    const write = await api('PUT', '/api/people/profile', { event: slug, profile: profileBody(slug, 'U'), open_to_meet: true, shared_talk_ids: [] }, { device: U, label: 'U-put' });
    const presence = await api('DELETE', `/api/presence?event=${slug}`, undefined, { device: U, label: 'U-presence' });
    const del = await api('DELETE', `/api/people/profile?event=${slug}`, undefined, { device: U, label: 'U-delete' });
    const stats = await admin('GET', `/admin/stats?event=${slug}`);
    const restore = await admin('PUT', '/admin/conferences', { conferences: [doc] });
    const problems = [];
    if (flip.status !== 200) problems.push(`flip gave ${flip.status}`);
    if (write.status !== 400) problems.push(`a profile write while unavailable gave ${write.status}`);
    if (presence.status !== 200 || del.status !== 200) problems.push(`presence delete ${presence.status}, profile delete ${del.status}`);
    if (stats.status !== 200) problems.push(`admin stats gave ${stats.status}`);
    if (restore.status !== 200 || restore.json.searchable !== 1) problems.push(`restore gave ${restore.status}`);
    report(problems.length === 0, 'unav1: an owner can delete while the conference is unavailable', problems.length ? problems.join('; ') : 'writes refused, presence and profile deletes and admin stats served, restored');
  });
} catch (err) {
  report(false, 'people checks', err.message);
} finally {
  // Remove the reports the run made, while their target still exists, so none is left behind.
  if (WRITE_MODE === 'admin') {
    for (const ref of reportedRefs) {
      // A failed cleanup is a FAIL, so a run never claims to leave no reports when it did.
      const r = await admin('POST', `/admin/moderation?event=${encodeURIComponent(PRIMARY)}`, { action: 'unhide', kind: 'profile', id: ref })
        .catch((err) => ({ status: 0, json: { error: err.message } }));
      if (r.status !== 200) report(false, 'cleanup: reports', `unhide of a reported test profile gave ${r.status}; remove its reports by hand`);
    }
  }
  // Remove every test profile, whatever happened above.
  for (const { device, event } of created) {
    await api('DELETE', `/api/people/profile?event=${encodeURIComponent(event)}`, undefined, { device, label: 'cleanup' }).catch(() => {});
  }
  if (expiredWritten && WRITE_MODE === 'admin') {
    await admin('DELETE', `/admin/test/profile?event=${encodeURIComponent(PRIMARY)}&profile_id=${encodeURIComponent(expiredProfileId)}`).catch(() => {});
  } else if (expiredWritten) {
    const res = await fetch(`${ES_URL}/${encodeURIComponent(PEOPLE_INDEX)}/_doc/${encodeURIComponent(expiredId)}?refresh=wait_for`, {
      method: 'DELETE',
      headers: { Authorization: `ApiKey ${ES_WRITE_KEY}` },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    }).catch(() => null);
    await res?.body?.cancel();
  }
}

// ---------------------------------------------------------------------------------------------
// The full schedule view.

// sch. The full schedule view lists one day in Elasticsearch's start order, page by page with
// "from" (browse mode only). The busiest day needs several pages; together they must hold exactly
// that day's talks, with no duplicates and starts that never go backwards. These checks run after
// the people checks, so the search requests near the top have left the per-minute search limit.
await check('sch1: browsing one day pages through only that day\'s talks in start order, with no duplicates', async () => {
  const docs = new Map(readNdjson(PRIMARY).map((d) => [d.talk_id, d]));
  const first = await search({ query: '', size: 1 });
  if (first.status !== 200) throw new Error(`status ${first.status}`);
  const busiest = [...(first.json.facets?.day ?? [])].sort((a, b) => b.count - a.count)[0];
  if (!busiest) throw new Error('no day facet values');
  const day = busiest.value;
  const expected = [...docs.values()].filter((d) => d.kind === 'talk' && d.day === day).length;
  const seen = [];
  let total = null;
  for (let from = 0; from <= 1000; from += 50) {
    const r = await search({ query: '', size: 50, from, filters: { day } });
    if (r.status !== 200) throw new Error(`page from ${from} gave ${r.status}`);
    total = r.json.total;
    seen.push(...(r.json.results ?? []));
    if (!r.json.results?.length || seen.length >= total) break;
  }
  const problems = [];
  const ids = seen.map((r) => r.talk_id);
  if (new Set(ids).size !== ids.length) problems.push(`${ids.length - new Set(ids).size} duplicates across pages`);
  if (seen.length !== total || total !== expected) problems.push(`${seen.length} listed, total ${total}, expected ${expected} talks`);
  for (const r of seen) {
    const d = docs.get(r.talk_id);
    if (!d || d.kind !== 'talk' || d.day !== day || r.kind !== 'talk') problems.push(`"${r.title}" is not a talk on ${day}`);
  }
  for (let i = 1; i < seen.length; i++) {
    if (Date.parse(seen[i].start) < Date.parse(seen[i - 1].start)) problems.push(`start goes backwards at position ${i + 1}`);
  }
  if (Math.ceil(expected / 50) < 2) problems.push(`the busiest day has only ${expected} talks, so paging was not exercised`);
  report(problems.length === 0, 'sch1: browsing one day pages through only that day\'s talks in start order, with no duplicates',
    problems.length ? problems.slice(0, 3).join('; ') : `${day}: ${seen.length} talks in ${Math.ceil(seen.length / 50)} pages`);
});

await check('sch2: "from" is validated and accepted only in browse mode', async () => {
  const bad = [
    { query: 'kubernetes', from: 50 },
    { query: '', from: -1 },
    { query: '', from: 1001 },
    { query: '', from: '50' },
    { query: '', from: 1.5 },
  ];
  const wrong = [];
  for (const body of bad) {
    const r = await search({ size: 10, ...body });
    if (r.status !== 400) wrong.push(`${JSON.stringify(body)} gave ${r.status}`);
  }
  const ok = await search({ query: '', size: 10, from: 0 });
  if (ok.status !== 200) wrong.push(`from 0 gave ${ok.status}`);
  report(wrong.length === 0, 'sch2: "from" is validated and accepted only in browse mode', wrong.length ? wrong.join('; ') : `${bad.length} bad requests refused`);
});

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
  const headers = SEND_ORIGIN ? { Origin: SMOKE_ORIGIN } : {};
  const fire = (path, n) => Promise.all(Array.from({ length: n }, () =>
    fetch(`${API_BASE}${path}`, { headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) }).then(async (r) => { await r.arrayBuffer(); return r; })));
  let burst = await fire('/api/rate-limit-probe', 80);
  let accepted = [404, 429];
  // The Worker's router answers an unknown /api path without touching a Durable Object, so it may have
  // no bucket for it; its per-address read bucket (90 a minute) is then the one to burst.
  if (IS_WORKER && !burst.some((r) => r.status === 429)) {
    burst = await fire(`/api/topics?event=${encodeURIComponent(PRIMARY)}&size=1`, 130);
    accepted = [200, 429];
  }
  const limited = burst.filter((r) => r.status === 429);
  const retryAfter = Number(limited[0]?.headers.get('retry-after'));
  const health = await fetch(`${API_BASE}/api/health`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  const ok = limited.length >= 1 && burst.every((r) => accepted.includes(r.status)) && Number.isInteger(retryAfter) && retryAfter >= 1 && health.status === 200;
  report(ok, 'rl1: a burst of requests gets 429 with Retry-After, and the other endpoints still answer',
    `${limited.length} of ${burst.length} limited, Retry-After ${retryAfter}, health ${health.status}`);
});

// Install onboarding.

await check('inst1: the manifest makes the app installable and the page links it', async () => {
  const m = await staticPage('/manifest.webmanifest');
  const manifest = JSON.parse(m.text);
  const page = (await staticPage('/')).text;
  const icons = manifest.icons ?? [];
  const ok = m.status === 200 && manifest.display === 'standalone' && manifest.start_url && icons.some((i) => i.sizes === '192x192') && icons.some((i) => i.sizes === '512x512') && /rel="manifest"/.test(page);
  // Under a base path (GitHub Pages project site) the start URL, the scope and the icons must resolve
  // inside the base, or the installed app would start outside the site. The service worker is served
  // as JavaScript, and a deep link boots the app: 200, or 404 with the app shell when there is a base
  // path (Pages serves 404.html, a copy of index.html, for a path it does not have).
  const manifestUrl = `${BASE_URL}/manifest.webmanifest`;
  const inside = (ref) => {
    const u = new URL(ref, manifestUrl);
    return u.origin === BASE_ORIGIN && (u.pathname === BASE_PATH || u.pathname.startsWith(`${BASE_PATH}/`));
  };
  const problems = [];
  if (!ok) problems.push('the manifest or the page link is not installable');
  if (manifest.start_url && !inside(manifest.start_url)) problems.push(`start_url ${manifest.start_url} is outside ${BASE_PATH || '/'}`);
  if (manifest.scope && !inside(manifest.scope)) problems.push(`scope ${manifest.scope} is outside ${BASE_PATH || '/'}`);
  const outsideIcon = icons.find((i) => !inside(i.src));
  if (outsideIcon) problems.push(`icon ${outsideIcon.src} is outside ${BASE_PATH || '/'}`);
  const sw = await staticPage('/sw.js');
  if (sw.status !== 200 || !/javascript/i.test(sw.headers.get('content-type') ?? '') || !sw.text.trim()) problems.push(`sw.js gave ${sw.status} ${sw.headers.get('content-type')}`);
  const deep = await staticPage(`/e/${encodeURIComponent(PRIMARY)}`);
  // At the root, a server that has no /e/ route (Cloud Run's) answers 404 with no shell, which is not
  // judged here; only a 200 must be the app shell.
  const isShell = deep.text.trim() === page.trim();
  const deepOk = BASE_PATH === '' ? deep.status === 404 || (deep.status === 200 && isShell) : (deep.status === 200 || deep.status === 404) && isShell;
  if (!deepOk) problems.push(`the deep link /e/${PRIMARY} gave ${deep.status}${isShell ? '' : ' and is not the app shell'}`);
  report(problems.length === 0, 'inst1: the manifest makes the app installable and the page links it', problems.length ? problems.join('; ') : `display ${manifest.display}, ${icons.length} icons, sw.js ${sw.status}, deep link ${deep.status}`);
});

// The Worker's static assets: the app's pages carry the security headers, hashed files are cached
// for good and the rest is revalidated, the static files never reach the API's meter, and /api and
// /admin paths are answered by the Worker, never by the app's index.html.
if (!WORKER_SERVES_APP) {
  skip('host1: the Worker serves the app with its security and cache headers', IS_WORKER ? 'the web app is on another origin than the Worker' : NOT_WORKER_WHY);
} else {
  await check('host1: the Worker serves the app with its security and cache headers', async () => {
    const problems = [];
    const cc = (r) => r.headers.get('cache-control') ?? '';
    const page = await staticPage('/');
    const deep = await staticPage(`/e/${encodeURIComponent(PRIMARY)}`);
    for (const [label, r] of [['/', page], [`/e/${PRIMARY}`, deep]]) {
      const csp = r.headers.get('content-security-policy') ?? '';
      if (r.status !== 200 || !/text\/html/.test(r.headers.get('content-type') ?? '')) problems.push(`${label} gave ${r.status} ${r.headers.get('content-type')}`);
      if (!/connect-src 'self'(;|$)/.test(csp) || !/frame-ancestors 'none'/.test(csp) || !/script-src 'self'(;|$)/.test(csp)) problems.push(`${label} has CSP "${csp}"`);
      if (r.headers.get('x-content-type-options') !== 'nosniff') problems.push(`${label} lacks nosniff`);
      if (!/max-age=\d+/.test(r.headers.get('strict-transport-security') ?? '')) problems.push(`${label} lacks Strict-Transport-Security`);
      if (!/no-cache/.test(cc(r))) problems.push(`${label} has Cache-Control "${cc(r)}"`);
      if (r.headers.has('x-caddie-pace')) problems.push(`${label} went through the API meter`);
    }
    for (const path of ['/sw.js', '/manifest.webmanifest']) {
      const r = await staticPage(path);
      if (r.status !== 200 || !/no-cache/.test(cc(r))) problems.push(`${path} gave ${r.status} with Cache-Control "${cc(r)}"`);
    }
    const asset = /\/assets\/[A-Za-z0-9._-]+\.js/.exec(page.text)?.[0];
    if (!asset) problems.push('the page names no /assets/ script');
    else {
      const r = await staticPage(asset);
      if (r.status !== 200 || !/javascript/.test(r.headers.get('content-type') ?? '')) problems.push(`${asset} gave ${r.status} ${r.headers.get('content-type')}`);
      if (!/immutable/.test(cc(r)) || !/max-age=31536000/.test(cc(r))) problems.push(`${asset} has Cache-Control "${cc(r)}"`);
      if (r.headers.has('x-caddie-pace')) problems.push(`${asset} went through the API meter`);
    }
    // A file that no build has: the asset layer may answer with index.html, but never for a year.
    const missing = await staticPage(`/assets/no-such-file-${crypto.randomBytes(4).toString('hex')}.js`);
    if (/immutable/.test(cc(missing))) problems.push(`a missing /assets/ file is cached with "${cc(missing)}"`);
    for (const path of ['/api/no-such-route', '/admin/no-such-route']) {
      const r = await staticPage(path);
      if (r.status !== 404 || !/application\/json/.test(r.headers.get('content-type') ?? '')) problems.push(`${path} gave ${r.status} ${r.headers.get('content-type')}, not the Worker's JSON 404`);
    }
    report(problems.length === 0, 'host1: the Worker serves the app with its security and cache headers', problems.length ? problems.join('; ') : `CSP and cache headers on /, the deep link, sw.js, the manifest and ${asset}`);
  });
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
  // The expired fixture's id and hash, and the admin token, may appear in no response body or header.
  const fixtureSecrets = [expiredProfileId, expiredSecretHash, ...(ADMIN_TOKEN ? [ADMIN_TOKEN] : [])];
  for (const r of otherResponses) {
    const hay = `${r.text}\n${r.headersText}`;
    if (hay.includes('secret_hash')) hits.push(`secret_hash in ${r.label} ${r.path}`);
    for (const s of [...secrets, ...hashes, ...fixtureSecrets]) if (hay.includes(s)) hits.push(`a device secret, id, hash or the admin token in ${r.label} ${r.path}`);
  }
  for (const r of responses) {
    const hay = `${r.text}\n${r.headersText}`;
    for (const word of ['secret_hash', 'text_hash', '"profile_id"', '_semantic', 'presence_spot', 'blocker_id', 'blocked_id']) if (r.text.includes(word)) hits.push(`${word} in ${r.path}`);
    if (r.headersText.includes('secret_hash')) hits.push(`secret_hash in a header of ${r.path}`);
    for (const s of [...secrets, ...hashes, ...fixtureSecrets]) if (hay.includes(s)) hits.push(`a device secret, id, hash or the admin token in ${r.path}`);
    // Spot lines and spot-me lines leave the server only to the meet's two participants, inside the meet.
    if (r.text.includes(spotMarker) && !(['A-meet', 'F-meet'].includes(r.label) && r.path.startsWith('/api/meet/')) && !['A-presence', 'F-presence'].includes(r.label)) hits.push(`a spot line in ${r.label} ${r.path}`);
    // C shared only for the circle talk, so C's contact may appear only in that circle's member
    // list, answered to a caller who shared for the talk when it asked: A from p1 on, and B once q10
    // makes it share too (until p11 deletes it). api() records who shared what from the profile
    // writes the server accepted, so this does not depend on labels or on the order of the checks.
    const circleId = circleTalk?.talk_id;
    const fellowSharer = Boolean(circleId) && r.path === '/api/circles/members' && r.request?.talk_id === circleId && r.sharedTalks.includes(circleId);
    if (r.text.includes(contactMarker('C')) && !fellowSharer) hits.push(`C's contact in ${r.label}`);
    // Nobody may see the expired profile's contact.
    if (r.text.includes(contactMarker('Expired'))) hits.push(`the expired contact in ${r.label}`);
    // A non-sharer and anonymous callers see no contact details at all.
    if (['N-members', 'anon-members', 'public-counts', 'C-matches', 'recs'].includes(r.label) && /linkedin_url|contact_note/.test(r.text)) hits.push(`contact fields in ${r.label}`);
  }
  const unique = [...new Set(hits)];
  // l trusts the shared talks each accepted profile write sent; the server must have echoed
  // exactly that list and, read back through the app's own API, must have stored it.
  const l0Problems = [
    ...(echoMismatches.length ? [`different echo in ${[...new Set(echoMismatches)].slice(0, 4).join(', ')}`] : []),
    ...(storedMismatches.length ? [`stored differently: ${[...new Set(storedMismatches)].slice(0, 4).join('; ')}`] : []),
    ...(storedInconclusive.length ? [`read-back inconclusive: ${[...new Set(storedInconclusive)].slice(0, 4).join('; ')}`] : []),
    ...(echoChecked > 0 && storedChecked === 0 ? ['no stored profile was read back'] : []),
  ];
  report(l0Problems.length === 0, 'l0: every accepted profile write echoes and stores the shared talks it sent', l0Problems.length ? l0Problems.join('; ') : `${echoChecked} writes checked, ${storedChecked} talks read back`);
  report(unique.length === 0, 'l: secret_hash and other people\'s contact details never leak', unique.length ? unique.slice(0, 4).join('; ') : `${responses.length} responses checked${IS_WORKER ? `, plus ${otherResponses.length} page and admin responses` : ''}`);
}

{
  // e. The built bundle holds no credential values, credential-shaped strings or scheduling words
  // ("clash", "conflict", "Build my agenda"); the schedule views only show talks.
  const dist = join(ROOT, DIST_DIR);
  if (!existsSync(dist)) {
    if (process.env.SMOKE_SKIP_BUNDLE === '1') skip('e: bundle scan', `${DIST_DIR} does not exist and SMOKE_SKIP_BUNDLE=1`);
    else report(false, 'e: bundle scan', `${DIST_DIR} does not exist; build it or set SMOKE_SKIP_BUNDLE=1`);
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
    if (ADMIN_TOKEN && !process.env.ADMIN_TOKEN) secrets.push({ label: 'the value of ADMIN_TOKEN', bytes: Buffer.from(ADMIN_TOKEN) });
    const patterns = BUNDLE_PATTERNS.map((p) => ({ label: `"${p}"`, bytes: Buffer.from(p) }));
    const hits = [];
    for (const file of files) {
      const content = readFileSync(file);
      for (const { label, bytes } of [...secrets, ...patterns]) {
        if (content.includes(bytes)) hits.push(`${label} in ${file.slice(ROOT.length)}`);
      }
      if (/\.(js|html)$/.test(file) && /clash|conflict|build my agenda|agenda building/i.test(content.toString('utf8'))) hits.push(`scheduling wording in ${file.slice(ROOT.length)}`);
    }
    // i. The install card ships in the bundle with its Android and iOS wording.
    const js = files.filter((f) => f.endsWith('.js')).map((f) => readFileSync(f, 'utf8')).join('\n');
    // A build for another API origin has that origin baked in (VITE_API_BASE), or the app would call its own host.
    if (CROSS_ORIGIN_API && !js.includes(API_BASE)) hits.push(`the API base ${API_ORIGIN} is not in the bundle`);
    const wording = ['beforeinstallprompt', 'Add to Home screen', 'Add to Home Screen', 'caddie.install.offered.v1'].filter((w) => !js.includes(w));
    report(wording.length === 0, 'inst2: the bundle ships the install card with the Android and iOS wording', wording.length ? `missing ${wording.join(', ')}` : 'all four strings found');
    report(hits.length === 0, 'e: bundle holds no keys, key-shaped strings or scheduling wording', hits.length ? hits.join('; ') : `${files.length} files, ${secrets.length} key values and ${patterns.length} patterns checked`);
  }
}

if (process.env.SMOKE_STRICT === '1') {
  report(retried === 0, 'strict: no request answered 5xx or failed on its first attempt', retried ? `${retried} did; see the NOTE lines above` : 'none needed a retry');
}
if (retried) console.log(`NOTE ${retried} request${retried === 1 ? '' : 's'} answered 5xx or failed on the first attempt and ${retried === 1 ? 'was' : 'were'} retried; see the NOTE lines above`);
process.exit(failures ? 1 : 0);
