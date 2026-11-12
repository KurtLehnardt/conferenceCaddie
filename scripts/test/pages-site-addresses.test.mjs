// .github/workflows/pages.yml, step "Work out the site addresses" (W9): SITE_URL, BUNDLE_BASE and
// TAKEDOWN follow the repository the workflow runs in, the repository variables CADDIE_SITE_URL,
// CADDIE_BUNDLE_BASE and CADDIE_TAKEDOWN_URL override them, and for KurtLehnardt/conferenceCaddie the
// values are the ones the file used to hold. The step's script is cut out of the workflow and run
// with bash as the runner would, with the values a `${{ }}` expression would have put in its env.
// No YAML parser is needed: the workflow's layout is fixed, and the test fails if it moves.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const WORKFLOW = readFileSync(new URL('../../.github/workflows/pages.yml', import.meta.url), 'utf8');
const LINES = WORKFLOW.split('\n');

const indentOf = (line) => line.length - line.trimStart().length;

// The text of every `run:` in the workflow, with the line it starts on (single-line or block).
function runBlocks() {
  const out = [];
  for (let i = 0; i < LINES.length; i++) {
    const m = /^(\s*)(?:- )?run:\s*(.*)$/.exec(LINES[i]);
    if (!m) continue;
    const base = m[1].length;
    if (m[2] === '|' || m[2] === '>' || m[2] === '|-') {
      const body = [];
      for (let j = i + 1; j < LINES.length && (LINES[j].trim() === '' || indentOf(LINES[j]) > base); j++) body.push(LINES[j]);
      out.push({ line: i + 1, text: body.join('\n'), step: stepName(i) });
    } else {
      out.push({ line: i + 1, text: m[2], step: stepName(i) });
    }
  }
  return out;
}

function stepName(i) {
  for (let j = i; j >= 0; j--) {
    const m = /^\s*- (?:name|id|uses): (.*)$/.exec(LINES[j]);
    if (m) return m[1];
  }
  return '(unknown)';
}

const STEP = 'Work out the site addresses';
const SCRIPT = (() => {
  const block = runBlocks().find((b) => b.step === STEP);
  assert.ok(block, `the step "${STEP}" is in pages.yml`);
  const body = block.text.split('\n');
  const indent = indentOf(body.find((l) => l.trim() !== ''));
  return body.map((l) => l.slice(indent)).join('\n');
})();

const OLD = {
  SITE_URL: 'https://kurtlehnardt.github.io/conferenceCaddie/',
  BUNDLE_BASE: 'https://kurtlehnardt.github.io/conferenceCaddie/bundles/',
  TAKEDOWN: 'https://github.com/KurtLehnardt/conferenceCaddie/issues',
};

// Runs the step. env holds what the step's env: block would carry; the result has what it appended
// to GITHUB_ENV (null when nothing) and its status and output.
function step(env) {
  const dir = mkdtempSync(join(tmpdir(), 'caddie-pages-'));
  try {
    const githubEnv = join(dir, 'github-env');
    writeFileSync(githubEnv, '');
    const r = spawnSync('bash', ['-e', '-c', SCRIPT], {
      env: { PATH: process.env.PATH, GITHUB_ENV: githubEnv, SITE_URL_OVERRIDE: '', BUNDLE_BASE_OVERRIDE: '', TAKEDOWN_OVERRIDE: '', ...env },
      encoding: 'utf8',
    });
    const appended = readFileSync(githubEnv, 'utf8');
    const vars = appended ? Object.fromEntries(appended.trimEnd().split('\n').map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)])) : null;
    return { status: r.status, stdout: r.stdout, stderr: r.stderr, text: `${r.stdout}\n${r.stderr}`, vars, appended };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const LIVE = { REPOSITORY: 'KurtLehnardt/conferenceCaddie', OWNER: 'KurtLehnardt' };

test('for KurtLehnardt/conferenceCaddie the three values are exactly what the workflow held before', () => {
  const r = step(LIVE);
  assert.equal(r.status, 0, r.text);
  assert.deepEqual(r.vars, OLD);
});

test('the same values with empty variables, which is what an unset repository variable gives', () => {
  const r = step({ ...LIVE, SITE_URL_OVERRIDE: '', BUNDLE_BASE_OVERRIDE: '', TAKEDOWN_OVERRIDE: '' });
  assert.deepEqual(r.vars, OLD);
});

test('a fork gets its own owner (lowercased) and repository name, with no edit to the file', () => {
  const r = step({ REPOSITORY: 'Some-Org/My.Fork_2', OWNER: 'Some-Org' });
  assert.equal(r.status, 0, r.text);
  assert.deepEqual(r.vars, {
    SITE_URL: 'https://some-org.github.io/My.Fork_2/',
    BUNDLE_BASE: 'https://some-org.github.io/My.Fork_2/bundles/',
    TAKEDOWN: 'https://github.com/Some-Org/My.Fork_2/issues',
  });
});

test('each repository variable overrides its own value and only that one', () => {
  const site = step({ ...LIVE, SITE_URL_OVERRIDE: 'https://example.org/caddie/' });
  assert.deepEqual(site.vars, { SITE_URL: 'https://example.org/caddie/', BUNDLE_BASE: 'https://example.org/caddie/bundles/', TAKEDOWN: OLD.TAKEDOWN });
  const bundles = step({ ...LIVE, BUNDLE_BASE_OVERRIDE: 'https://cdn.example.org/b/' });
  assert.deepEqual(bundles.vars, { SITE_URL: OLD.SITE_URL, BUNDLE_BASE: 'https://cdn.example.org/b/', TAKEDOWN: OLD.TAKEDOWN });
  const takedown = step({ ...LIVE, TAKEDOWN_OVERRIDE: 'mailto:takedown@example.org' });
  assert.deepEqual(takedown.vars, { ...OLD, TAKEDOWN: 'mailto:takedown@example.org' });
  const all = step({ ...LIVE, SITE_URL_OVERRIDE: 'https://a.example/', BUNDLE_BASE_OVERRIDE: 'https://b.example/x/', TAKEDOWN_OVERRIDE: 'https://c.example/report' });
  assert.deepEqual(all.vars, { SITE_URL: 'https://a.example/', BUNDLE_BASE: 'https://b.example/x/', TAKEDOWN: 'https://c.example/report' });
});

test('a user site (<owner>.github.io lives at the root) is set with CADDIE_SITE_URL, and the bundles follow it', () => {
  const r = step({ REPOSITORY: 'Octo/octo.github.io', OWNER: 'Octo', SITE_URL_OVERRIDE: 'https://octo.github.io/' });
  assert.equal(r.status, 0, r.text);
  assert.deepEqual(r.vars, { SITE_URL: 'https://octo.github.io/', BUNDLE_BASE: 'https://octo.github.io/bundles/', TAKEDOWN: 'https://github.com/Octo/octo.github.io/issues' });
});

test('a site or bundle override without its trailing slash gets one', () => {
  const r = step({ ...LIVE, SITE_URL_OVERRIDE: 'https://example.org/caddie', BUNDLE_BASE_OVERRIDE: 'https://cdn.example.org/b' });
  assert.deepEqual(r.vars, { SITE_URL: 'https://example.org/caddie/', BUNDLE_BASE: 'https://cdn.example.org/b/', TAKEDOWN: OLD.TAKEDOWN });
});

test('an address the build scripts would refuse fails the step, names the variable, and does not echo the value or write the environment', () => {
  const bad = [
    ['SITE_URL_OVERRIDE', 'http://example.org/', /SITE_URL .*CADDIE_SITE_URL/],
    ['SITE_URL_OVERRIDE', 'https://example.org/with space/', /SITE_URL/],
    ['SITE_URL_OVERRIDE', 'https://example.org/?q=1', /SITE_URL/],
    ['SITE_URL_OVERRIDE', 'https://example.org/#top', /SITE_URL/],
    ['BUNDLE_BASE_OVERRIDE', 'ftp://example.org/b/', /BUNDLE_BASE .*CADDIE_BUNDLE_BASE/],
    ['TAKEDOWN_OVERRIDE', 'javascript:alert(1)', /TAKEDOWN .*CADDIE_TAKEDOWN_URL/],
    ['TAKEDOWN_OVERRIDE', 'https://example.org/a b', /TAKEDOWN/],
    ['TAKEDOWN_OVERRIDE', 'mailto:ops @example.org', /TAKEDOWN/],
  ];
  for (const [name, value, message] of bad) {
    const r = step({ ...LIVE, [name]: value });
    assert.equal(r.status, 1, `${name}=${value}\n${r.text}`);
    assert.match(r.text, message);
    assert.match(r.text, /::error::/);
    assert.equal(r.appended, '', 'nothing reaches GITHUB_ENV');
    assert.ok(!r.text.includes(value), `${name} value echoed`);
  }
});

test('a value with a line break cannot add a variable to the job environment', () => {
  for (const name of ['SITE_URL_OVERRIDE', 'BUNDLE_BASE_OVERRIDE', 'TAKEDOWN_OVERRIDE']) {
    const r = step({ ...LIVE, [name]: 'https://example.org/\nEVIL=1\n' });
    assert.equal(r.status, 1, name);
    assert.equal(r.appended, '');
  }
  const r = step({ REPOSITORY: 'Owner/name', OWNER: 'Owner\nEVIL=1' });
  assert.equal(r.status, 1);
  assert.ok(!r.appended.includes('EVIL'));
});

test('no run script in the workflow holds a ${{ }} expression: each goes through env', () => {
  const blocks = runBlocks();
  assert.ok(blocks.length >= 8, 'the run scripts were found');
  for (const b of blocks) assert.ok(!b.text.includes('${{'), `line ${b.line} (${b.step}) has an expression inside run`);
});

test('the later steps still read SITE_URL, BUNDLE_BASE and TAKEDOWN, and the workflow-level env no longer sets them', () => {
  const later = runBlocks().filter((b) => b.step !== STEP).map((b) => b.text).join('\n');
  for (const name of ['SITE_URL', 'BUNDLE_BASE', 'TAKEDOWN']) assert.match(later, new RegExp(`"\\$${name}"`), name);
  const start = LINES.findIndex((l) => l === 'env:');
  assert.ok(start >= 0, 'a workflow-level env block');
  const block = [];
  for (let i = start + 1; i < LINES.length && (LINES[i].trim() === '' || indentOf(LINES[i]) > 0); i++) block.push(LINES[i]);
  const keys = block.map((l) => /^\s+([A-Z_]+):/.exec(l)?.[1]).filter(Boolean);
  assert.deepEqual(keys, ['PUBLISHER']);
  // The step runs before the first one that uses an address.
  const order = LINES.findIndex((l) => l.includes(`name: ${STEP}`));
  const firstUse = LINES.findIndex((l, i) => i > order && /\$(SITE_URL|BUNDLE_BASE|TAKEDOWN)\b|"\$(SITE_URL|BUNDLE_BASE|TAKEDOWN)"/.test(l) && !l.trim().startsWith('#'));
  assert.ok(order > 0 && firstUse > order);
});
