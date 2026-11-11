// A fork must not silently reach the maintainer's resources. This test greps the non-test code of
// the repository for the maintainer's own identifiers and fails when one appears in a file that is
// not on the allow-list below: the maintainer's recorded facts (docs, decisions, review notes),
// CI configuration that names the official deployment, and the official app's compiled-in server
// constants. Everything else (scripts, server, tools, worker code, the web app) takes these values
// from the environment (ES_URL, GC_PROJECT, CADDIE_APP_URL, CADDIE_BUNDLE_BASE, ...).
//
// To allow a new file, add it to ALLOWED with a reason. To stop a fork from reaching the maintainer
// through a new file, move the value into configuration instead.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const IDENTIFIERS = [
  ['Elastic Cloud cluster id', /fc875c88f9f44f159f1a359ee724d82b/],
  ['Google Cloud project id', /project-9205d6eb-366e-4844-b77/],
  ['Cloud Run service address or project number', /265846417372/],
  ['workers.dev host', /krlehnardt\.workers\.dev/],
];

// Path prefixes (ending in "/") and exact files. Each is a place that records or configures the
// maintainer's deployment on purpose.
const ALLOWED = [
  // Recorded facts and documentation.
  'DECISIONS.md',
  'README.md',
  'REVIEW_NOTES.md',
  'REVIEW_NOTES_FREE.md',
  'docs/',
  'native/README.md',
  'worker/README.md',
  // Captured responses of the live service, kept as test fixtures.
  'contracts/fixtures/topics-live/',
  // CI configuration of the official build (repository variables override the fallbacks).
  '.github/workflows/android-apk.yml',
  '.github/workflows/native.yml',
  // The official apps ship with the official server compiled in.
  'native/shared/src/commonMain/kotlin/app/conferencecaddie/shared/core/CaddieCore.kt',
  'native/composeApp/src/commonMain/kotlin/app/conferencecaddie/ui/shell/StandaloneShell.kt',
];

const isTest = (f) => /(^|\/)[A-Za-z]*[Tt]ests?[A-Za-z]*\//.test(f) || /\.test\.[cm]?[jt]sx?$/.test(f) || /Test\.kt$/.test(f);
const isData = (f) => f.startsWith('data/') || /(^|\/)package-lock\.json$/.test(f);
const allowed = (f) => ALLOWED.some((a) => (a.endsWith('/') ? f.startsWith(a) : f === a));

const tracked = () => {
  try {
    return execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 << 20 }).split('\0').filter(Boolean);
  } catch {
    return null;
  }
};

test('no maintainer-specific identifier outside the allow-list, in non-test code', (t) => {
  const files = tracked();
  if (!files) return t.skip('not a git checkout');
  const hits = [];
  let scanned = 0;
  for (const f of files) {
    if (isTest(f) || isData(f) || allowed(f)) continue;
    let text;
    try {
      const buf = fs.readFileSync(path.join(ROOT, f));
      if (buf.includes(0)) continue;
      text = buf.toString('utf8');
    } catch {
      continue;
    }
    scanned++;
    for (const [name, re] of IDENTIFIERS) {
      if (re.test(text)) hits.push(`${f}: ${name}`);
    }
  }
  assert.ok(scanned > 100, `scanned only ${scanned} files`);
  assert.deepEqual(hits, [], `maintainer-specific values outside the allow-list; read them from the environment instead:\n${hits.join('\n')}`);
});

test('the allow-list names files that exist and still need it', () => {
  const files = tracked();
  if (!files) return;
  for (const a of ALLOWED) {
    const matches = files.filter((f) => (a.endsWith('/') ? f.startsWith(a) : f === a));
    assert.ok(matches.length > 0, `${a} is on the allow-list but is not a tracked file`);
  }
});

test('the test itself finds the identifiers it looks for', () => {
  assert.ok(IDENTIFIERS.every(([, re]) => re.test(re.source.replaceAll('\\', ''))));
});
