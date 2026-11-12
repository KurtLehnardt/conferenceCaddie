// The demo conference's two workflow steps (config/demo-conference.json, scripts/lib/demo-conference.mjs).
//
// Usage:
//   node scripts/demo-conference.mjs status [--live <bundle base>]
//   node scripts/demo-conference.mjs prepare [--data <dir>] [--staged <slug,slug>]
//
// status   says whether the demo is switched on and active (on, and neither hidden nor removed in
//          data/conference-operator.json), its slug and today's window in its zone. With --live (an
//          https bundle base ending in "/", or a local directory) it reads the live conferences.json
//          and says whether the live site is stale: an active demo that is missing there, has no
//          bundle or other dates, or an inactive one that is still listed. An unreadable live index
//          counts as stale. .github/workflows/demo-conference.yml publishes the bundles only then.
// prepare  makes data/<slug>/ in this checkout hold exactly what the bundle build should publish
//          for the demo: it removes the folder (generated files only; the repository ignores it),
//          then, when the demo is on, runs scripts/ingest.mjs --event <slug> --dry-run --skip-topics
//          for today, which writes the files and honours the operator file (a hidden demo is written
//          unavailable, a removed one is skipped). A slug in --staged (laid over data/ from an
//          ingest run's artifact) is left as the ingest wrote it. pages.yml runs it before every
//          build and passes the slug in --fresh, so the live bundle follows the switch.
// Both print key=value lines for the workflow (enabled, active, slug, ...) and append them to
// GITHUB_OUTPUT when it is set. Exit codes: 0 success, 1 on a bad configuration or a failed ingest,
// 2 on bad arguments. Node built-ins only; no key is read or needed.

import { appendFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readDemoConfig, buildDemo, demoToday } from './lib/demo-conference.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LIVE_MAX_BYTES = 5_000_000;

class UsageError extends Error {}

export function parseArgs(argv) {
  const [command, ...rest] = argv;
  if (command !== 'status' && command !== 'prepare') throw new UsageError('Choose status or prepare.');
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

// The operator file's verdict on the slug: 'removed', 'hidden' or null.
export function operatorState(dataDir, slug) {
  const file = path.join(dataDir, 'conference-operator.json');
  if (!existsSync(file)) return null;
  const doc = JSON.parse(readFileSync(file, 'utf8'));
  if (doc?.removed && Object.hasOwn(doc.removed, slug)) return 'removed';
  if (doc?.hidden && Object.hasOwn(doc.hidden, slug)) return 'hidden';
  return null;
}

/** What the live conferences.json says about the slug: { readable, listed, start_date, end_date, bundle }. */
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
    const entry = (JSON.parse(text).conferences ?? []).find((c) => c?.slug === slug);
    if (!entry) return { readable: true, listed: false };
    return { readable: true, listed: true, status: entry.status, start_date: entry.start_date, end_date: entry.end_date, bundle: Boolean(entry.bundle) };
  } catch (err) {
    return { readable: false, why: err?.name ?? 'error' };
  }
}

/** The status lines: { enabled, active, slug, today, start_date, end_date, stale? }. */
export async function status({ live = null, root = ROOT, dataDir = path.join(ROOT, 'data'), env = process.env, nowMs = Date.now(), fetchFn } = {}) {
  const config = readDemoConfig(root, env);
  const state = operatorState(dataDir, config.slug);
  const active = config.enabled && state === null;
  const { conference } = buildDemo(config, demoToday(config, { env, nowMs }));
  const out = { enabled: config.enabled, active, operator: state ?? 'none', slug: config.slug, today: demoToday(config, { env, nowMs }), start_date: conference.start_date, end_date: conference.end_date };
  if (live !== null) {
    const seen = await liveEntry(live, config.slug, { fetchFn });
    const current = seen.listed && seen.status === 'searchable' && seen.bundle && seen.start_date === conference.start_date && seen.end_date === conference.end_date;
    out.live = !seen.readable ? `unreadable (${seen.why})` : !seen.listed ? 'absent' : `${seen.status} ${seen.start_date}..${seen.end_date}${seen.bundle ? '' : ' without a bundle'}`;
    out.stale = !seen.readable || (active ? !current : seen.listed === true);
  }
  return out;
}

/** Prepares data/<slug>/ for the bundle build. Returns the output lines' values. */
export function prepare({ dataDir, staged = [], root = ROOT, env = process.env, log = (m) => console.log(m), spawn = spawnSync }) {
  const config = readDemoConfig(root, env);
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

function emit(values, env = process.env) {
  const lines = Object.entries(values).map(([k, v]) => `${k}=${v}`);
  for (const l of lines) console.log(l);
  if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `${lines.join('\n')}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err.message);
    console.error('Usage: node scripts/demo-conference.mjs status [--live <bundle base>] | prepare [--data <dir>] [--staged <slug,...>]');
    process.exit(2);
  }
  try {
    if (opts.command === 'status') emit(await status({ live: opts.live }));
    else emit(prepare({ dataDir: opts.data, staged: opts.staged }));
  } catch (err) {
    console.error(`demo-conference: ${err.message}`);
    process.exit(1);
  }
}
