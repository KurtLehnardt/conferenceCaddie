// The demo conference: an invented, clearly labelled conference whose talks are always yesterday,
// today and tomorrow in its time zone, so a demonstration of the apps has a live schedule, "For you",
// presence and meet-ups on any day. It is off unless the operator switches it on in
// config/demo-conference.json (docs/ADMIN_CLI.md, "The demo conference").
//
// buildDemo(config, today) is a pure function of the configuration and a civil date (YYYY-MM-DD in
// the conference's zone): the same inputs always give the same conference document and the same talk
// documents, in the shape scripts/lib/classify.mjs gives a Sessionize feed, so the ingest
// (scripts/ingest.mjs), the talk bundles and every backend take them like any other conference.
//
// Talk ids are relative to the three-day window, not to the calendar: "<slug>:d1-a10" is always
// today's 10:00 talk in the main hall. A daily regeneration therefore changes only the times (the
// content_hash) of the same ids, never the set of ids or any title or abstract (the text_hash), so
// the ingest sends partial updates without re-embedding, deletes nothing, never trips the shrink
// guard and never runs the dropped-talk cleanup that takes talks out of people's shares.
//
// Everything in it is invented: the talks, the speakers (names such as "Avery Example" at "Example
// Corp") and the organisations. Every abstract says so, the conference name must contain "Demo", the
// conference document carries demo: true, and the apps show a Demo label wherever its data appears.
// Node built-ins only.

import { readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { makeLocalTime } from './zones.mjs';
import { textHash, contentHash } from './hash.mjs';

export const DEMO_CONFIG_FILE = 'config/demo-conference.json';
export const DEMO_SOURCE = 'demo';
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,119}$/;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const CONFIG_KEYS = new Set(['$comment', 'enabled', 'slug', 'name', 'time_zone', 'location']);
const LOCATION_KEYS = ['city', 'region', 'country', 'virtual'];

/** The configuration used when config/demo-conference.json is missing: off. */
export const DEFAULT_DEMO_CONFIG = Object.freeze({
  enabled: false,
  slug: 'caddie-demo-conference',
  name: 'Caddie Demo Conference',
  time_zone: 'America/Denver',
  location: Object.freeze({ city: 'Demo City', region: '', country: '', virtual: false }),
});

const plain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function validZone(zone) {
  if (typeof zone !== 'string' || !zone) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/**
 * Checks a parsed config/demo-conference.json and returns it with defaults for the keys it leaves
 * out. Throws an Error naming the first problem. The slug must contain "demo" and the name "Demo",
 * so the generator can never write over a real conference and its name always says what it is.
 */
export function validateDemoConfig(doc) {
  if (!plain(doc)) throw new Error(`${DEMO_CONFIG_FILE} must be a JSON object.`);
  for (const k of Object.keys(doc)) if (!CONFIG_KEYS.has(k)) throw new Error(`${DEMO_CONFIG_FILE}: unknown key "${k}".`);
  const c = { ...DEFAULT_DEMO_CONFIG, ...doc, location: { ...DEFAULT_DEMO_CONFIG.location, ...(doc.location ?? {}) } };
  delete c.$comment;
  if (typeof c.enabled !== 'boolean') throw new Error(`${DEMO_CONFIG_FILE}: "enabled" must be true or false.`);
  if (typeof c.slug !== 'string' || !SLUG_RE.test(c.slug) || !c.slug.includes('demo')) {
    throw new Error(`${DEMO_CONFIG_FILE}: "slug" must be a conference slug (lower-case letters, digits and dashes) that contains "demo".`);
  }
  if (typeof c.name !== 'string' || !c.name.trim() || !/\bDemo\b/.test(c.name) || c.name.length > 200) {
    throw new Error(`${DEMO_CONFIG_FILE}: "name" must contain the word "Demo" (at most 200 characters).`);
  }
  if (!validZone(c.time_zone)) throw new Error(`${DEMO_CONFIG_FILE}: "time_zone" must be an IANA time zone, for example "America/Denver".`);
  if (doc.location !== undefined && !plain(doc.location)) throw new Error(`${DEMO_CONFIG_FILE}: "location" must be an object.`);
  for (const k of Object.keys(c.location)) if (!LOCATION_KEYS.includes(k)) throw new Error(`${DEMO_CONFIG_FILE}: unknown key "location.${k}".`);
  for (const k of ['city', 'region', 'country']) {
    if (typeof c.location[k] !== 'string' || c.location[k].length > 100) throw new Error(`${DEMO_CONFIG_FILE}: "location.${k}" must be a string of at most 100 characters.`);
  }
  if (typeof c.location.virtual !== 'boolean') throw new Error(`${DEMO_CONFIG_FILE}: "location.virtual" must be true or false.`);
  return c;
}

/**
 * Reads the demo configuration: CADDIE_DEMO_CONFIG names another file (the tests use it), else
 * config/demo-conference.json under root. A missing file is the default, which is off; a file that
 * does not parse or validate throws.
 */
export function readDemoConfig(root, env = process.env) {
  const file = env.CADDIE_DEMO_CONFIG ? resolve(env.CADDIE_DEMO_CONFIG) : join(root, DEMO_CONFIG_FILE);
  if (!existsSync(file)) return validateDemoConfig({});
  let doc;
  try {
    doc = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    throw new Error(`${DEMO_CONFIG_FILE} is not valid JSON: ${e.message}`);
  }
  return validateDemoConfig(doc);
}

/** The civil date (YYYY-MM-DD) at the instant nowMs in the zone. */
export function todayIn(timeZone, nowMs = Date.now()) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(nowMs));
  const get = (t) => parts.find((p) => p.type === t).value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/** True when s is a real calendar day written YYYY-MM-DD. */
export function isCivilDay(s) {
  if (typeof s !== 'string' || !DAY_RE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/** The civil date n days after day (negative n: before). Calendar arithmetic, no zone involved. */
export function addDays(day, n) {
  if (!isCivilDay(day)) throw new Error(`not a day: ${day}`);
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/**
 * The day the demo is generated for. CADDIE_DEMO_TODAY (YYYY-MM-DD) pins it, for tests and for
 * previewing another day; otherwise it is today in the demo's zone.
 */
export function demoToday(config, { env = process.env, nowMs = Date.now() } = {}) {
  const pinned = env.CADDIE_DEMO_TODAY;
  if (pinned !== undefined && pinned !== '') {
    if (!isCivilDay(pinned)) throw new Error('CADDIE_DEMO_TODAY must be a day written YYYY-MM-DD.');
    return pinned;
  }
  return todayIn(config.time_zone, nowMs);
}

/** The three days of the window: [yesterday, today, tomorrow]. */
export const demoDays = (today) => [addDays(today, -1), today, addDays(today, 1)];

// ---------- The invented programme ----------

const TRACKS = Object.freeze({ cn: 'Cloud Native', sec: 'Security', obs: 'Observability', ai: 'AI and Data', dx: 'Developer Experience', com: 'Community' });

// One subject per talk slot of a day (rooms A and B, 16 slots each). Each day takes them in its own
// order with its own kind of title, so the 96 talk titles of the window are all different.
const SUBJECTS = Object.freeze([
  ['container scheduling', 'cn', 'How a scheduler decides where each workload runs, and how to steer it with priorities, affinities and quotas.'],
  ['service meshes', 'cn', 'Sidecars, ambient proxies and the traffic rules between them, explained with one small shop application.'],
  ['GitOps workflows', 'dx', 'Keeping every environment in a repository and letting a controller make the cluster match it.'],
  ['platform engineering', 'dx', 'Building an internal platform that product teams choose to use rather than have to use.'],
  ['infrastructure as code', 'dx', 'Describing networks, databases and clusters in reviewed, versioned files instead of console clicks.'],
  ['serverless functions', 'cn', 'Short-lived functions that scale to zero, and what that does to cold starts, costs and debugging.'],
  ['WebAssembly on the server', 'cn', 'Small, sandboxed modules that start in microseconds and run next to (or instead of) containers.'],
  ['edge computing', 'cn', 'Running workloads in hundreds of small sites close to users, with patchy links and no one on site.'],
  ['multi-cluster networking', 'cn', 'Connecting services across clusters and regions without turning the network into a puzzle.'],
  ['stateful workloads', 'cn', 'Databases and queues on an orchestrator: volumes, backups, failover and the operators that run them.'],
  ['supply chain security', 'sec', 'Signing what you build, checking what you run and knowing where every dependency came from.'],
  ['zero-trust networking', 'sec', 'Authenticating every connection, inside the perimeter as much as outside it.'],
  ['secrets management', 'sec', 'Where keys and tokens live, who can read them, and how to rotate them without an outage.'],
  ['policy as code', 'sec', 'Writing the rules for what may be deployed as tested code that runs at admission time.'],
  ['runtime threat detection', 'sec', 'Spotting a compromised workload from its system calls and network traffic while it runs.'],
  ['software bills of materials', 'sec', 'Listing what is inside every artifact and putting that list to work when the next vulnerability lands.'],
  ['distributed tracing', 'obs', 'Following one request across dozens of services to find where the time really goes.'],
  ['metrics at scale', 'obs', 'Collecting, storing and querying millions of time series without drowning in cardinality.'],
  ['log pipelines', 'obs', 'Shipping, parsing, sampling and keeping logs at a cost the finance team can live with.'],
  ['incident response', 'obs', 'What happens between the first alert and the last follow-up: roles, runbooks and calm.'],
  ['service level objectives', 'obs', 'Choosing the few numbers that say whether users are happy, and spending the error budget wisely.'],
  ['chaos engineering', 'obs', 'Breaking things on purpose, in small and controlled ways, to learn how the system really fails.'],
  ['model serving', 'ai', 'Putting a trained model behind an API with batching, autoscaling and a rollback plan.'],
  ['retrieval-augmented generation', 'ai', 'Grounding a language model in your own documents, and measuring whether the answers improved.'],
  ['vector search', 'ai', 'Embeddings, approximate nearest neighbours and hybrid ranking with plain keyword search.'],
  ['GPU scheduling', 'ai', 'Sharing scarce accelerators between training and inference jobs without leaving them idle.'],
  ['data pipelines', 'ai', 'Moving and cleaning data reliably on a schedule, with lineage you can actually follow.'],
  ['AI agents', 'ai', 'Letting a model call tools on your behalf, with the guard rails, logs and limits that requires.'],
  ['open source maintainership', 'com', 'Triaging issues, reviewing pull requests and saying no kindly, without burning out.'],
  ['inclusive community events', 'com', 'Running meetups and conferences where newcomers feel welcome and come back.'],
  ['developer onboarding', 'dx', 'Getting a new engineer from laptop to first merged change on their first day.'],
  ['continuous delivery', 'dx', 'Small, frequent, boring releases, with feature flags and automatic rollbacks.'],
]);

// The title, level and angle of each day: introductions yesterday, production stories today, deep
// dives tomorrow. A template's "{s}" is the subject, "{S}" the subject with a capital letter.
const DAY_STYLES = Object.freeze([
  {
    level: 'Beginner',
    angle: 'It starts from zero and ends with a working setup you can try at home.',
    titles: ['Getting started with {s}', '{S} for beginners', 'A practical introduction to {s}', '{S}: the first ninety days'],
  },
  {
    level: 'Intermediate',
    angle: 'The speakers share what broke, what they changed and the numbers that convinced them.',
    titles: ['{S} in production: lessons learned', 'Scaling {s} without losing sleep', 'What we got wrong about {s}', 'Running {s} at Example Corp'],
  },
  {
    level: 'Advanced',
    angle: 'Expect diagrams, trade-offs and a frank look at what is still unsolved.',
    titles: ['Deep dive: how {s} works under the hood', 'The future of {s}', 'Advanced patterns for {s}', '{S} beyond the basics'],
  },
]);

// Three hands-on workshops a day, 90 minutes each, in their own room.
const WORKSHOPS = Object.freeze([
  [['Build your first container image', 'cn'], ['Write your first admission policy', 'sec'], ['Instrument a service with tracing', 'obs']],
  [['Deploy a model behind an API', 'ai'], ['Set up GitOps for a small team', 'dx'], ['Harden a cluster in an afternoon', 'sec']],
  [['Build a small AI agent safely', 'ai'], ['Design service level objectives for a real service', 'obs'], ['Run your first chaos experiment', 'obs']],
]);
const WORKSHOP_TIMES = Object.freeze([['09:00', '10:30'], ['13:30', '15:00'], ['16:00', '17:30']]);

// Invented speakers. The surnames say they are not real people, and so do their organisations.
const SPEAKERS = Object.freeze([
  ['Avery Example', 'Staff Engineer, Example Corp'],
  ['Blake Sample', 'Developer Advocate, Notacompany Systems'],
  ['Casey Placeholder', 'Site Reliability Lead, Placeholder Labs'],
  ['Dana Mockwell', 'Security Engineer, Demo Industries'],
  ['Eli Nobody', 'Platform Architect, Notreal Networks'],
  ['Frankie Fixture', 'Engineering Manager, Imaginary Cloud Co.'],
  ['Gray Prototype', 'Principal Engineer, Example Corp'],
  ['Harper Testwell', 'Open Source Maintainer, Notacompany Systems'],
  ['Indy Nemo', 'Data Engineer, Placeholder Labs'],
  ['Jordan Draftly', 'Machine Learning Engineer, Demo Industries'],
  ['Kai Sandbox', 'Product Manager, Notreal Networks'],
  ['Lee Lorem', 'Staff Engineer, Imaginary Cloud Co.'],
  ['Morgan Ipsum', 'Security Researcher, Example Corp'],
  ['Noor Pretend', 'Developer Advocate, Placeholder Labs'],
  ['Oakley Notreal', 'Site Reliability Engineer, Notacompany Systems'],
  ['Parker Madeup', 'Community Manager, Demo Industries'],
  ['Quinn Fictional', 'Platform Engineer, Notreal Networks'],
  ['Riley Invented', 'Chief Architect, Imaginary Cloud Co.'],
  ['Sam Imaginary', 'Software Engineer, Example Corp'],
  ['Taylor Hypothetical', 'Engineering Director, Notacompany Systems'],
  ['Uma Specimen', 'Researcher, Placeholder Labs'],
  ['Val Template', 'Solutions Engineer, Demo Industries'],
  ['Wren Dryrun', 'Release Manager, Notreal Networks'],
  ['Yael Staging', 'Observability Lead, Imaginary Cloud Co.'],
]);

const ROOMS = Object.freeze({ a: 'Main Hall', b: 'Room 2', w: 'Workshop Lab', lobby: 'Lobby' });
const FORMAT = 'Format';
/** The category mapping of the demo conference, as classify.mjs reports one for a Sessionize feed. */
export const DEMO_MAPPING = Object.freeze({ track_group: 'Track', level_group: 'Audience Level', tag_groups: Object.freeze([FORMAT]), hidden_groups: Object.freeze([]), slides_question: null });

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const fill = (template, subject) => template.replaceAll('{S}', cap(subject)).replaceAll('{s}', subject);
const pad = (n) => String(n).padStart(2, '0');
const hhmm = (minutes) => `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;
const minutesOf = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));

/** The sentence every demo abstract ends with. */
export const inventedNote = (name) => `Invented for the ${name}: this session and its speakers are fictional.`;

/**
 * The conference document and the talk documents of the demo for the window around `today`:
 * { conference, docs, counts, mapping }. `conference` has the fields scripts/ingest.mjs writes for any
 * conference, with status "searchable", source "demo" and demo: true; raw_fetched_at and ingested_at
 * are null for the caller to set. `docs` are sorted by start, then talk_id.
 */
export function buildDemo(config, today) {
  const c = validateDemoConfig(config);
  if (!isCivilDay(today)) throw new Error(`not a day: ${today}`);
  const days = demoDays(today);
  const local = makeLocalTime(c.time_zone);
  const note = inventedNote(c.name);
  const docs = [];

  const add = ({ session, kind, title, abstract, speakers = [], room, track, level = 'Not specified', format = null, day, from, to }) => {
    const start = local(`${day}T${from}:00`);
    const end = local(`${day}T${to}:00`);
    const tags = format ? [{ group: FORMAT, value: format }] : [];
    const doc = {
      talk_id: `${c.slug}:${session}`,
      conference: c.slug,
      session_id: session,
      kind,
      title,
      abstract,
      speakers: speakers.map(([name]) => name),
      speaker_taglines: speakers.map(([, tagline]) => tagline),
      speaker_profiles: speakers.map(([name, tagline]) => ({ name, tagline, links: [] })),
      room,
      track,
      level,
      tags,
      tag_keys: tags.map((t) => `${t.group}\u001f${t.value}`),
      sponsor: false,
      has_slides: false,
      slides_url: null,
      url: null,
      start: start.iso,
      end: end.iso,
      day: start.day,
      start_minutes: start.minutes,
      end_minutes: end.day === start.day ? end.minutes : end.minutes + 1440,
    };
    doc.text_hash = textHash(doc);
    doc.content_hash = contentHash(doc);
    docs.push(doc);
  };

  days.forEach((day, k) => {
    const style = DAY_STYLES[k];
    // Rooms A and B: a 45-minute talk every hour from 07:00, B half an hour after A, so from 07:00 to
    // 23:15 a talk is always running and the next one is never more than 30 minutes away.
    for (let slot = 0; slot < 32; slot++) {
      const room = slot < 16 ? 'a' : 'b';
      const hour = 7 + (slot % 16);
      const startMin = hour * 60 + (room === 'b' ? 30 : 0);
      const [subject, track, detail] = SUBJECTS[(slot + 11 * k) % SUBJECTS.length];
      const n = slot + 32 * k;
      const first = SPEAKERS[(n * 5) % SPEAKERS.length];
      const second = SPEAKERS[(n * 5 + 7) % SPEAKERS.length];
      add({
        session: `d${k}-${room}${pad(hour)}`,
        kind: 'talk',
        title: fill(style.titles[slot % style.titles.length], subject),
        abstract: `${detail} ${style.angle} ${note}`,
        speakers: n % 3 === 2 ? [first, second] : [first],
        room: ROOMS[room],
        track: TRACKS[track],
        level: style.level,
        format: 'Talk',
        day,
        from: hhmm(startMin),
        to: hhmm(startMin + 45),
      });
    }
    WORKSHOPS[k].forEach(([title, track], w) => {
      const n = 96 + 3 * k + w;
      add({
        session: `d${k}-w${w + 1}`,
        kind: 'talk',
        title: `Workshop: ${title}`,
        abstract: `A hands-on session: bring a laptop and leave with something that works. ${style.angle} ${note}`,
        speakers: [SPEAKERS[(n * 5) % SPEAKERS.length], SPEAKERS[(n * 5 + 11) % SPEAKERS.length]],
        room: ROOMS.w,
        track: TRACKS[track],
        level: style.level,
        format: 'Workshop',
        day,
        from: WORKSHOP_TIMES[w][0],
        to: WORKSHOP_TIMES[w][1],
      });
    });
    add({ session: `d${k}-registration`, kind: 'break', title: 'Registration and badge pick-up', abstract: `Pick up your badge at the front desk. ${note}`, room: ROOMS.lobby, track: 'Registration', day, from: '07:00', to: '18:00' });
    add({ session: `d${k}-lunch`, kind: 'break', title: 'Lunch', abstract: '', room: ROOMS.lobby, track: 'Breaks', day, from: '12:00', to: '13:00' });
    add({ session: `d${k}-coffee`, kind: 'break', title: 'Coffee break', abstract: '', room: ROOMS.lobby, track: 'Breaks', day, from: '15:00', to: '15:30' });
    add({ session: `d${k}-hallway`, kind: 'ambient', title: 'Hallway track', abstract: `Unscheduled conversations in the lobby, for everyone who would rather talk than listen. ${note}`, room: ROOMS.lobby, track: TRACKS.com, day, from: '10:00', to: '17:00' });
  });
  add({ session: 'd0-opening', kind: 'housekeeping', title: 'Opening remarks', abstract: '', room: ROOMS.a, track: TRACKS.com, day: days[0], from: '06:45', to: '07:00' });
  add({ session: 'd2-closing', kind: 'housekeeping', title: 'Closing remarks', abstract: '', room: ROOMS.a, track: TRACKS.com, day: days[2], from: '23:15', to: '23:30' });

  docs.sort((x, y) => Date.parse(x.start) - Date.parse(y.start) || (x.talk_id < y.talk_id ? -1 : x.talk_id > y.talk_id ? 1 : 0));
  const counts = { sessions: docs.length, talk: 0, ambient: 0, break: 0, housekeeping: 0, with_slides: 0, sponsor: 0 };
  for (const d of docs) counts[d.kind]++;
  const mapping = { ...DEMO_MAPPING, tag_groups: [...DEMO_MAPPING.tag_groups], hidden_groups: [] };
  const conference = {
    slug: c.slug,
    name: c.name,
    status: 'searchable',
    status_reason: null,
    source: DEMO_SOURCE,
    demo: true,
    start_date: days[0],
    end_date: days[2],
    time_zone: c.time_zone,
    time_zone_windows: null,
    location: { ...c.location },
    sessionize_api_code: null,
    sessionize_public_slug: null,
    sessionize_site_published: false,
    lf_event_id: null,
    lf_url: null,
    official_schedule_url: null,
    parent_slug: null,
    category_mapping: mapping,
    counts,
    ingested_at: null,
    raw_fetched_at: null,
  };
  return { conference, docs, counts, mapping };
}

/** True for a conference document (or public entry) that is the demo: exactly demo === true. */
export const isDemoConference = (doc) => doc?.demo === true;
