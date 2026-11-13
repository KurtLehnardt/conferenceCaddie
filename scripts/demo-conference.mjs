// The demo conference's workflow steps (config/demo-conference.json, scripts/lib/demo-conference.mjs).
//
// Usage:
//   node scripts/demo-conference.mjs status [--live <bundle base>]
//   node scripts/demo-conference.mjs prepare [--data <dir>] [--staged <slug,slug>]
//   node scripts/demo-conference.mjs es-check
//   node scripts/demo-conference.mjs worker-check
//
// status   says whether the demo is switched on and active (on, and neither hidden nor removed in
//          data/conference-operator.json), its slug and today's window in its zone. With --live (an
//          https bundle base ending in "/", or a local directory) it reads the live conferences.json
//          and says whether the live site is stale: an active demo that is missing there, has no
//          bundle or other dates, or an inactive one that is still listed. An unreadable live index
//          counts as stale only while the demo is active (any later build drops an inactive one).
//          .github/workflows/demo-conference.yml publishes the bundles only when it is stale.
// prepare  makes data/<slug>/ in this checkout hold exactly what the bundle build should publish
//          for the demo: it removes the folder (generated files only; the repository ignores it),
//          then, when the demo is on, runs scripts/ingest.mjs --event <slug> --dry-run --skip-topics
//          for today, which writes the files and honours the operator file (a hidden demo is written
//          unavailable, a removed one is skipped). A slug in --staged (laid over data/ from an
//          ingest run's artifact) is left as the ingest wrote it. pages.yml runs it before every
//          build and passes the slug in --fresh, so the live bundle follows the switch.
// es-check reads the demo's conference document from Elasticsearch (ES_URL and ES_API_KEY, the
//          scheduled job's narrow key) while the demo is switched off, and warns (a GitHub
//          ::warning:: line) when the backend still lists it as searchable: switching it off on
//          tier 3 needs `caddie-admin conferences hide` or `remove` too.
// worker-check is the same for the Worker (tier 2): while the demo is switched off, it reads the
//          Worker's public GET <CADDIE_API_BASE>/api/conferences, with no token, and warns when the
//          Worker still lists the demo as searchable (the Worker leaves a hidden demo out).
// A configuration that does not parse or validate makes status and prepare warn and treat the demo
// as off, so a mistake in it never stops the bundle build of the real conferences; the ingest itself
// refuses it only when the demo is asked for. Every command prints key=value lines for the workflow
// and appends them to GITHUB_OUTPUT when it is set; a value with a line break is refused. Exit codes:
// 0 success, 1 on a failed ingest, Elasticsearch read or Worker read, 2 on bad arguments. Node
// built-ins only.

import { appendFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readDemoConfig, buildDemo, demoToday, isCivilDay } from './lib/demo-conference.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LIVE_MAX_BYTES = 5_000_000;
const COMMANDS = ['status', 'prepare', 'es-check', 'worker-check'];
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,119}$/;

class UsageError extends Error {}

export function parseArgs(argv) {
  const [command, ...rest] = argv;
  if (!COMMANDS.includes(command)) throw new UsageError(`Choose ${COMMANDS.join(', ')}.`);
  const opts = { command, live: null, data: path.join(ROOT, 'data'), staged: [] };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    const v = rest[i + 1];
    if (v === undefined || v.startsWith('--')) throw new UsageError(`${a} needs a value.`);
    if (a === '--live' && command === 'status') opts.live = rest[++i];
    else if (a === '--data' && command === 'prepare') opts.data = path.resolve(rest[++i]);
    else if (a === '--staged' && command === 'prepare') opts.staged = rest[++i].split(',').map((s) => s.trim()).filter(Boolean);
    else throw new UsageError(`Unknown argument for ${command}: ${a}`);
  }
  return opts;
}

// The configuration, or null with a warning when it does not parse or validate.
function configOrWarn(root, env, log) {
  try {
    return readDemoConfig(root, env);
  } catch (err) {
    log(`::warning::The demo conference is treated as off: ${err.message}`);
    return null;
  }
}

// The operator file's verdict on the slug: 'removed', 'hidden' or null.
export function operatorState(dataDir, slug) {
  const file = path.join(dataDir, 'conference-operator.json');
  if (!existsSync(file)) return null;
  const doc = JSON.parse(readFileSync(file, 'utf8'));
  if (doc?.removed && Object.hasOwn(doc.removed, slug)) return 'removed';
  if (doc?.hidden && Object.hasOwn(doc.hidden, slug)) return 'hidden';
  return null;
}

/**
 * What the live conferences.json says about the slug: { readable, listed, status, start_date,
 * end_date, bundle }. Only well-formed values are taken (a status of the schema, real days), so
 * nothing the live site holds reaches a workflow's outputs unchecked.
 */
export async function liveEntry(source, slug, { fetchFn = globalThis.fetch } = {}) {
  try {
    let text;
    if (/^https:\/\//.test(source)) {
      const res = await fetchFn(new URL('conferences.json', source), { redirect: 'error', signal: AbortSignal.timeout(60_000) });
      if (res.status === 404) return { readable: true, listed: false };
      if (!res.ok) return { readable: false, why: `HTTP ${res.status}` };
      text = await res.text();
    } else {
      let file = path.join(path.resolve(source), 'conferences.json');
      if (existsSync(path.join(path.resolve(source), 'bundles', 'conferences.json'))) file = path.join(path.resolve(source), 'bundles', 'conferences.json');
      if (!existsSync(file)) return { readable: true, listed: false };
      text = readFileSync(file, 'utf8');
    }
    if (text.length > LIVE_MAX_BYTES) return { readable: false, why: 'too large' };
    const list = JSON.parse(text).conferences;
    if (!Array.isArray(list)) return { readable: false, why: 'no conferences list' };
    const entry = list.find((c) => c?.slug === slug);
    if (!entry) return { readable: true, listed: false };
    const status = entry.status === 'searchable' || entry.status === 'unavailable' ? entry.status : 'malformed';
    const day = (d) => (isCivilDay(d) ? d : null);
    return { readable: true, listed: true, status, start_date: day(entry.start_date), end_date: day(entry.end_date), bundle: Boolean(entry.bundle) };
  } catch (err) {
    return { readable: false, why: err?.name ?? 'error' };
  }
}

/** The status lines: { enabled, active, operator, slug, today, start_date, end_date, live?, stale? }. */
export async function status({ live = null, root = ROOT, dataDir = path.join(ROOT, 'data'), env = process.env, nowMs = Date.now(), fetchFn, log = (m) => console.log(m) } = {}) {
  const config = configOrWarn(root, env, log);
  if (!config) return { enabled: false, active: false, slug: '', ...(live !== null ? { stale: false } : {}) };
  const state = operatorState(dataDir, config.slug);
  const active = config.enabled && state === null;
  const today = demoToday(config, { env, nowMs });
  const { conference } = buildDemo(config, today);
  const out = { enabled: config.enabled, active, operator: state ?? 'none', slug: config.slug, today, start_date: conference.start_date, end_date: conference.end_date };
  if (live !== null) {
    const seen = await liveEntry(live, config.slug, { fetchFn });
    const current = seen.listed && seen.status === 'searchable' && seen.bundle && seen.start_date === conference.start_date && seen.end_date === conference.end_date;
    out.live = !seen.readable ? 'unreadable' : !seen.listed ? 'absent' : `${seen.status} ${seen.start_date ?? '?'}..${seen.end_date ?? '?'}${seen.bundle ? '' : ' without a bundle'}`;
    if (!seen.readable) log(`demo: the live conferences.json could not be read (${seen.why})`);
    out.stale = active ? !current : seen.readable && seen.listed === true;
  }
  return out;
}

/** Prepares data/<slug>/ for the bundle build. Returns the output lines' values. */
export function prepare({ dataDir, staged = [], root = ROOT, env = process.env, log = (m) => console.log(m), spawn = spawnSync }) {
  const config = configOrWarn(root, env, log);
  if (!config) return { enabled: false, slug: '' };
  const dir = path.join(dataDir, config.slug);
  const out = { enabled: config.enabled, slug: config.slug };
  if (staged.includes(config.slug)) {
    log(`demo: ${config.slug} was staged by this ingest run; its files are kept as the ingest wrote them`);
    return out;
  }
  if (existsSync(dir)) {
    rmSync(dir, { recursive: true, force: true });
    log(`demo: removed the generated folder ${path.relative(root, dir) || dir} from this checkout`);
  }
  if (!config.enabled) {
    log(`demo: ${config.slug} is switched off (config/demo-conference.json); the build leaves it out`);
    return out;
  }
  // A minimal environment: no key of any kind reaches the ingest, which needs none for --dry-run.
  const childEnv = { PATH: env.PATH ?? '', CADDIE_DATA_DIR: dataDir };
  for (const k of ['CADDIE_DEMO_CONFIG', 'CADDIE_DEMO_TODAY', 'HOME', 'TMPDIR']) if (env[k] !== undefined) childEnv[k] = env[k];
  const res = spawn(process.execPath, [path.join(root, 'scripts', 'ingest.mjs'), '--event', config.slug, '--dry-run', '--skip-topics'], { cwd: root, env: childEnv, encoding: 'utf8' });
  for (const line of `${res.stdout ?? ''}${res.stderr ?? ''}`.split('\n').filter(Boolean)) log(line);
  if (res.status !== 0) throw new Error(`scripts/ingest.mjs exited with ${res.status ?? res.signal} for ${config.slug}`);
  return out;
}

/**
 * While the demo is off, warns when Elasticsearch still holds it as searchable. Returns
 * { enabled, slug, backend } where backend is 'absent', '<status>' or 'not checked'.
 */
export async function esCheck({ root = ROOT, env = process.env, fetchFn = globalThis.fetch, log = (m) => console.log(m) } = {}) {
  const config = configOrWarn(root, env, log);
  if (!config) return { enabled: false, slug: '', backend: 'not checked' };
  if (config.enabled) return { enabled: true, slug: config.slug, backend: 'not checked' };
  const url = String(env.ES_URL ?? '').trim().replace(/\/+$/, '');
  const key = env.ES_API_KEY ?? '';
  if (!url || !key) throw new Error('es-check needs ES_URL and ES_API_KEY.');
  const index = env.ES_CONFERENCES_INDEX || 'caddie-conferences';
  const res = await fetchFn(`${url}/${encodeURIComponent(index)}/_doc/${encodeURIComponent(config.slug)}?_source_includes=status`, {
    headers: { Authorization: `ApiKey ${key}` },
    redirect: 'error',
    signal: AbortSignal.timeout(60_000),
  });
  if (res.status === 404) return { enabled: false, slug: config.slug, backend: 'absent' };
  if (!res.ok) throw new Error(`reading the demo conference document failed with status ${res.status}`);
  const doc = await res.json();
  const held = doc?.found ? (doc._source?.status === 'searchable' ? 'searchable' : 'unavailable') : 'absent';
  if (held === 'searchable') {
    log(`::warning::The demo conference is switched off in config/demo-conference.json, but Elasticsearch still holds ${config.slug} as searchable, so the tier 3 server lists it with frozen dates. Run caddie-admin conferences hide or remove for it (docs/ADMIN_CLI.md, "The demo conference").`);
  }
  return { enabled: false, slug: config.slug, backend: held };
}

// The Worker's origin from CADDIE_API_BASE: https, or http only for a loopback host, with no user
// name, password, path, query or fragment beyond a final "/". Throws otherwise.
function workerOrigin(value) {
  let u;
  try {
    u = new URL(String(value ?? '').trim());
  } catch {
    throw new Error('worker-check needs CADDIE_API_BASE, the Worker\'s https origin.');
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  if (!(u.protocol === 'https:' || (u.protocol === 'http:' && loopback)) || u.username || u.password || (u.pathname !== '/' && u.pathname !== '') || u.search || u.hash) {
    throw new Error('worker-check needs CADDIE_API_BASE to be the Worker\'s https origin, with no path.');
  }
  return u.origin;
}

/**
 * While the demo is off, warns when the Worker (tier 2) still lists it as searchable in its public
 * GET /api/conferences (no token is sent). Returns { enabled, slug, worker } where worker is
 * 'absent', 'searchable', 'unavailable' or 'not checked'.
 */
export async function workerCheck({ root = ROOT, env = process.env, fetchFn = globalThis.fetch, log = (m) => console.log(m) } = {}) {
  const config = configOrWarn(root, env, log);
  if (!config) return { enabled: false, slug: '', worker: 'not checked' };
  if (config.enabled) return { enabled: true, slug: config.slug, worker: 'not checked' };
  const origin = workerOrigin(env.CADDIE_API_BASE);
  const res = await fetchFn(`${origin}/api/conferences`, { redirect: 'error', signal: AbortSignal.timeout(60_000) });
  if (res.status !== 200) throw new Error(`reading the Worker's conference list failed with status ${res.status}`);
  const list = (await res.json())?.conferences;
  if (!Array.isArray(list)) throw new Error('the Worker\'s conference list holds no conferences');
  const entry = list.find((c) => c?.slug === config.slug);
  const held = !entry ? 'absent' : entry.status === 'searchable' ? 'searchable' : 'unavailable';
  if (held === 'searchable') {
    log(`::warning::The demo conference is switched off in config/demo-conference.json, but the Worker still lists ${config.slug} as searchable, with frozen dates. Run caddie-admin conferences hide or remove for it (docs/ADMIN_CLI.md, "The demo conference").`);
  }
  return { enabled: false, slug: config.slug, worker: held };
}

/** The key=value lines of a result; a key or value that could break the GITHUB_OUTPUT format is refused. */
export function outputLines(values) {
  return Object.entries(values).map(([k, v]) => {
    const value = String(v);
    if (!/^[a-z_]+$/.test(k) || /[\r\n]/.test(value) || value.length > 200) throw new Error(`refusing an output that is not one plain line: ${k}`);
    if (k === 'slug' && value && !SLUG_RE.test(value)) throw new Error('refusing a slug output that is not a slug');
    return `${k}=${value}`;
  });
}

function emit(values, env = process.env) {
  const lines = outputLines(values);
  for (const l of lines) console.log(l);
  if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `${lines.join('\n')}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err.message);
    console.error('Usage: node scripts/demo-conference.mjs status [--live <bundle base>] | prepare [--data <dir>] [--staged <slug,...>] | es-check | worker-check');
    process.exit(2);
  }
  try {
    if (opts.command === 'status') emit(await status({ live: opts.live }));
    else if (opts.command === 'prepare') emit(prepare({ dataDir: opts.data, staged: opts.staged }));
    else if (opts.command === 'worker-check') emit(await workerCheck());
    else emit(await esCheck());
  } catch (err) {
    console.error(`demo-conference: ${err.message}`);
    process.exit(1);
  }
}
