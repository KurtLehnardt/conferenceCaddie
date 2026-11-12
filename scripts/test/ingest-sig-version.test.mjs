// .github/workflows/ingest.yml carries the admin signature rollback switch (step c of
// DECISIONS.md, "Admin signature v2"): the repository variable CADDIE_ADMIN_SIG_VERSION reaches the
// push step's environment, which is the only way push-ingest.mjs sees it in CI, and the first step
// refuses a value other than unset, 1 or 2 before anything is fetched, without printing it. The
// secrets stay in the environment of the two steps that need them, never the job's or the
// workflow's. The workflow is read as text, line by line, since the repository has no YAML parser.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const LINES = readFileSync(path.join(ROOT, '.github/workflows/ingest.yml'), 'utf8').split('\n');
const SWITCH = 'CADDIE_ADMIN_SIG_VERSION: ${{ vars.CADDIE_ADMIN_SIG_VERSION }}';

const indent = (line) => line.length - line.trimStart().length;

// The lines of the block that `key:` opens at line `from` (the more indented lines after it).
function block(from) {
  const own = indent(LINES[from]);
  const out = [];
  for (let i = from + 1; i < LINES.length; i++) {
    if (LINES[i].trim() !== '' && indent(LINES[i]) <= own) break;
    out.push({ i, line: LINES[i] });
  }
  return out;
}

// The step named `name` of the ingest job: its env lines and its run script.
function step(name) {
  const at = LINES.findIndex((l) => l.trim() === `- name: ${name}`);
  assert.ok(at >= 0, `the step "${name}"`);
  const body = block(at);
  const envAt = body.find((b) => b.line.trim() === 'env:');
  const runAt = body.find((b) => b.line.trim() === 'run: |');
  return {
    env: envAt ? block(envAt.i).map((b) => b.line.trim()).filter((l) => l && !l.startsWith('#')) : [],
    envLines: envAt ? block(envAt.i).map((b) => b.i) : [],
    run: runAt ? block(runAt.i).map((b) => b.line.slice(indent(LINES[runAt.i]) + 2)).join('\n') : '',
  };
}

test('the push step maps CADDIE_ADMIN_SIG_VERSION to the repository variable, beside its secrets', () => {
  const push = step('Push to the Worker');
  assert.ok(push.env.includes(SWITCH), push.env.join('\n'));
  assert.ok(push.env.includes('ADMIN_TOKEN: ${{ secrets.CADDIE_ADMIN_TOKEN }}'));
  assert.match(push.run, /node worker\/ingest\/push-ingest\.mjs --api "\$CADDIE_API_BASE"/);
});

test('no secret sits in the job\'s or the workflow\'s environment: only the configuration check and the push step get one', () => {
  const allowed = new Set([...step('Check the configuration').envLines, ...step('Push to the Worker').envLines]);
  for (const [i, line] of LINES.entries()) {
    if (!line.includes('secrets.') || line.trimStart().startsWith('#')) continue;
    assert.ok(allowed.has(i), `line ${i + 1} reads a secret outside the two steps: ${line.trim()}`);
  }
  // No workflow-level env at all, and the job-level env holds no secret.
  assert.ok(!LINES.some((l) => l === 'env:'), 'a workflow-level env');
  const jobEnv = LINES.findIndex((l, i) => l === '    env:' && LINES.slice(0, i).some((p) => p === '  ingest:'));
  assert.ok(jobEnv >= 0);
  for (const { line } of block(jobEnv)) assert.ok(!line.includes('secrets.'), line);
});

test('the header documents CADDIE_ADMIN_SIG_VERSION as the rollback switch', () => {
  const header = LINES.filter((l) => l.startsWith('#')).join('\n');
  assert.match(header, /variable CADDIE_ADMIN_SIG_VERSION\s+optional rollback switch/);
});

test('the configuration check refuses a CADDIE_ADMIN_SIG_VERSION other than unset, 1 or 2 first, and never prints it', () => {
  const check = step('Check the configuration');
  assert.ok(check.env.includes(SWITCH), check.env.join('\n'));
  const dir = mkdtempSync(path.join(tmpdir(), 'caddie-ingest-check-'));
  try {
    const run = (env) => {
      const output = path.join(dir, `out-${Math.random().toString(36).slice(2)}`);
      const r = spawnSync('bash', ['-c', check.run], { encoding: 'utf8', env: { PATH: process.env.PATH, GITHUB_OUTPUT: output, GITHUB_EVENT_NAME: 'schedule', ADMIN_TOKEN: 'fake-admin-token', CADDIE_API_BASE: 'https://caddie.example.org', ...env } });
      let out = '';
      try {
        out = readFileSync(output, 'utf8');
      } catch {}
      return { ...r, out };
    };
    for (const value of ['', '1', '2']) {
      const r = run({ CADDIE_ADMIN_SIG_VERSION: value });
      assert.equal(r.status, 0, `${JSON.stringify(value)}: ${r.stdout}${r.stderr}`);
      assert.equal(r.out, 'ready=true\n');
    }
    for (const value of ['3', '0', 'v2', ' 2', '2 ', '1\n', '01', 'fake-invalid-sig-version']) {
      const r = run({ CADDIE_ADMIN_SIG_VERSION: value });
      assert.equal(r.status, 1, JSON.stringify(value));
      assert.match(r.stdout, /::error::The CADDIE_ADMIN_SIG_VERSION variable must be unset, 1 or 2\./);
      if (value.trim().length > 1) assert.ok(!r.stdout.includes(value.trim()) && !r.stderr.includes(value.trim()), r.stdout);
      assert.equal(r.out, '', 'no ready output');
    }
    // It is checked before the missing token and base: a scheduled run that would only log a
    // notice still fails on a bad value.
    const early = run({ CADDIE_ADMIN_SIG_VERSION: 'fake-invalid-sig-version', ADMIN_TOKEN: '', CADDIE_API_BASE: '' });
    assert.equal(early.status, 1);
    // An unset variable behaves like the empty one.
    const unset = run({});
    assert.equal(unset.status, 0, unset.stdout + unset.stderr);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
