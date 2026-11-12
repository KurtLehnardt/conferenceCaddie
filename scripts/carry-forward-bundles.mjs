// Carries forward the bundle directories that the currently live conferences.json names into the
// Pages artifact before it is uploaded (docs/BUNDLES.md, Carrying bundles forward).
//
// A Pages deploy replaces the whole site, but bundle directories are immutable and the talk bundle
// contract keeps an earlier directory available for at least a day after the index stops naming
// it: a client that fetched the index a moment ago may still be downloading the directory it
// named. So, before the upload, this script reads the live index, and for every bundle entry whose
// directory the new build does not already hold it downloads each file the entry lists into
// <out>/bundles/<path>, checking its size and SHA-256 against the entry. A file that does not match
// stops the run (exit 1), so nothing unverified is republished.
//
// Usage: node scripts/carry-forward-bundles.mjs [--out dist-pages]
//                                               [--base-url https://kurtlehnardt.github.io/conferenceCaddie/bundles/]
// Without --base-url the base is the environment variable CADDIE_BUNDLE_BASE, else the official one.
// The variable is read when the arguments are parsed, not when the module is imported, as
// build-bundles.mjs reads its environment. The live index is <base-url>conferences.json. A 404 there (the first deploy) is not an error:
// there is nothing to carry forward. Any other failure to read it is an error, because deploying
// without the previous directories could break clients mid-download.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readConferenceIndex } from '../contracts/js/bundle.mjs';

const OFFICIAL_BASE = 'https://kurtlehnardt.github.io/conferenceCaddie/bundles/';
const PATH_RE = /^[a-z0-9][a-z0-9-]{0,99}\/[0-9a-f]{16}\/$/;
const FILE_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const TIMEOUT_MS = 60_000;

export function parseArgs(argv) {
  const opts = { out: 'dist-pages', baseUrl: process.env.CADDIE_BUNDLE_BASE || OFFICIAL_BASE };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const v = argv[i + 1];
    if (a === '--out' && v) opts.out = argv[++i];
    else if (a === '--base-url' && v) opts.baseUrl = argv[++i];
    else throw new Error(`Unknown or incomplete argument: ${a}`);
  }
  // https, or plain http to this machine for a local test.
  const local = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/[^\s?#]*)?\/$/.test(opts.baseUrl);
  if (!local && !/^https:\/\/[^\s?#]+\/$/.test(opts.baseUrl)) throw new Error('--base-url must be an https URL that ends in "/".');
  return opts;
}

async function get(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS), redirect: 'follow' });
  return res;
}

async function main() {
  const { out, baseUrl } = parseArgs(process.argv.slice(2));
  const indexUrl = `${baseUrl}conferences.json`;
  const res = await get(indexUrl);
  if (res.status === 404) {
    console.log('No live conferences.json (first deploy): nothing to carry forward.');
    return 0;
  }
  if (!res.ok) throw new Error(`Reading the live conferences.json failed with HTTP ${res.status}.`);
  const index = readConferenceIndex(await res.json());
  if (!index.ok) throw new Error(`The live conferences.json is not a usable index (${index.reason}).`);

  let carried = 0;
  let present = 0;
  for (const { conference, bundle } of index.conferences) {
    if (!bundle) continue;
    if (!PATH_RE.test(bundle.path)) throw new Error(`The live index names an unexpected bundle path for ${conference.slug}.`);
    const dir = path.join(out, 'bundles', bundle.path);
    for (const [name, meta] of Object.entries(bundle.files)) {
      if (!FILE_RE.test(name)) throw new Error(`The live index names an unexpected file in ${bundle.path}.`);
      const target = path.join(dir, name);
      if (existsSync(target)) {
        present++;
        continue;
      }
      const r = await get(`${baseUrl}${bundle.path}${name}`);
      if (!r.ok) throw new Error(`Fetching ${bundle.path}${name} failed with HTTP ${r.status}.`);
      const bytes = Buffer.from(await r.arrayBuffer());
      const sha = createHash('sha256').update(bytes).digest('hex');
      if (bytes.length !== meta.bytes || sha !== meta.sha256) throw new Error(`${bundle.path}${name} does not match the size and SHA-256 the live index gives.`);
      mkdirSync(dir, { recursive: true });
      writeFileSync(target, bytes);
      carried++;
    }
  }
  console.log(`Carried forward ${carried} file(s) from the live index; ${present} already in this build.`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(
    (code) => { process.exitCode = code; },
    (err) => {
      console.error(err.message);
      process.exitCode = 1;
    },
  );
}
