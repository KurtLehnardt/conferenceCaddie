// Stages the conference files that an ingest run has pushed to the Worker, so that the same run can
// build the talk bundles from exactly that data (ingest.yml, then pages.yml called with the staged
// directory as an artifact).
//
// Usage:
//   node scripts/stage-ingest-data.mjs --report <push-report.json> --out <dir> [--data data]
// The report is the one worker/ingest/push-ingest.mjs --report writes. For every conference whose
// document reached the Worker (report.upserted):
//   - searchable, and its talks were pushed (report.pushed): conference.json and talks.ndjson;
//   - not searchable (unavailable for a reason other than a failed fetch): conference.json only, so
//     the bundle build leaves it out of the index as the Worker now does;
//   - searchable but its talk push failed or was not attempted: nothing, so the live bundle (or the
//     committed seed) stays, as the Worker keeps the talks it had.
// Conferences whose document was held back (report.kept, a failed schedule fetch) are not staged.
// Writes <out>/<slug>/conference.json and <out>/<slug>/talks.ndjson, prints the count, and, when
// GITHUB_OUTPUT is set, appends "staged=<count>" to it. Exit codes: 0 success (also when nothing is
// staged), 1 on a bad report or a missing file.

import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,119}$/;

export function parseArgs(argv) {
  const opts = { report: null, out: null, data: path.join(ROOT, 'data') };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) throw new Error(`${a} needs a value.`);
    if (a === '--report') opts.report = argv[++i];
    else if (a === '--out') opts.out = argv[++i];
    else if (a === '--data') opts.data = argv[++i];
    else throw new Error(`Unknown argument: ${a}`);
  }
  if (!opts.report || !opts.out) throw new Error('--report and --out are required.');
  return opts;
}

/** Which files of which conferences to stage: [{ slug, files: ['conference.json'] or ['conference.json', 'talks.ndjson'] }]. */
export function stagePlan(report, readConference) {
  const list = (k) => {
    const v = report?.[k] ?? [];
    if (!Array.isArray(v) || v.some((s) => typeof s !== 'string' || !SLUG_RE.test(s))) throw new Error(`report.${k} must be a list of slugs.`);
    return v;
  };
  const pushed = new Set(list('pushed'));
  const kept = new Set(list('kept'));
  const plan = [];
  for (const slug of [...new Set(list('upserted'))].sort()) {
    if (kept.has(slug)) continue;
    const doc = readConference(slug);
    if (!doc) throw new Error(`${slug}: no conference.json to stage.`);
    if (doc.status === 'searchable') {
      if (pushed.has(slug)) plan.push({ slug, files: ['conference.json', 'talks.ndjson'] });
    } else {
      plan.push({ slug, files: ['conference.json'] });
    }
  }
  return plan;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const report = JSON.parse(readFileSync(opts.report, 'utf8'));
  const readConference = (slug) => {
    const file = path.join(opts.data, slug, 'conference.json');
    return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null;
  };
  const plan = stagePlan(report, readConference);
  for (const { slug, files } of plan) {
    mkdirSync(path.join(opts.out, slug), { recursive: true });
    for (const name of files) {
      const from = path.join(opts.data, slug, name);
      if (!existsSync(from)) throw new Error(`${slug}: ${name} is missing.`);
      copyFileSync(from, path.join(opts.out, slug, name));
    }
  }
  const withTalks = plan.filter((p) => p.files.includes('talks.ndjson')).length;
  console.log(`Staged ${plan.length} conference(s) for the talk bundles: ${withTalks} with talks, ${plan.length - withTalks} no longer searchable.`);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `staged=${plan.length}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
  }
}
