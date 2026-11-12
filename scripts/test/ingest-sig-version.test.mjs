// .github/workflows/ingest.yml no longer carries the admin signature rollback switch: step e of
// DECISIONS.md, "Admin signature v2", removed it, so no step receives the repository variable
// CADDIE_ADMIN_SIG_VERSION and the push step always signs v2. The one place the workflow still names
// the variable is the condition of a step that warns a fork to delete it: that condition only checks
// whether the variable is set, and the step neither maps the value into an environment nor prints
// it. The configuration check still decides whether the run goes ahead from the token and the API
// base alone. The secrets stay in the environment of the two steps that need them, never the job's
// or the workflow's. The workflow is read as text, line by line, since the repository has no YAML
// parser.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const LINES = readFileSync(path.join(ROOT, '.github/workflows/ingest.yml'), 'utf8').split('\n');
const TEXT = LINES.join('\n');

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

// The step named `name` of the ingest job: its keys, its env lines and its run script, with the
// line numbers of each.
function step(name) {
  const at = LINES.findIndex((l) => l.trim() === `- name: ${name}`);
  assert.ok(at >= 0, `the step "${name}"`);
  const body = block(at);
  const envAt = body.find((b) => b.line.trim() === 'env:');
  const runAt = body.find((b) => b.line.trim() === 'run: |');
  const runLines = runAt ? block(runAt.i) : [];
  return {
    at,
    // The keys after `- name:`, which is on the step's own line.
    keys: body.filter((b) => b.line.trim() !== '' && !b.line.trimStart().startsWith('#') && indent(b.line) === indent(LINES[at]) + 2).map((b) => b.line.trim().split(':')[0]),
    env: envAt ? block(envAt.i).map((b) => b.line.trim()).filter((l) => l && !l.startsWith('#')) : [],
    envLines: envAt ? block(envAt.i).map((b) => b.i) : [],
    run: runLines.map((b) => b.line.slice(indent(LINES[runAt.i]) + 2)).join('\n'),
    runLines: runLines.map((b) => b.i),
  };
}

const VAR = 'CADDIE_ADMIN_SIG_VERSION';
const WARN_STEP = 'Warn about the removed signature variable';
const WARN_IF = `if: vars.${VAR} != ''`;

test('the workflow names CADDIE_ADMIN_SIG_VERSION only to warn that it was removed, and never passes its value on', () => {
  const warn = step(WARN_STEP);
  // The repository variable is read in exactly one place, the condition of the warning step,
  // which only checks whether it is set.
  const reads = LINES.flatMap((l, i) => (l.includes(`vars.${VAR}`) ? [i] : []));
  assert.deepEqual(reads.map((i) => LINES[i].trim()), [WARN_IF], 'vars.CADDIE_ADMIN_SIG_VERSION outside the condition of the warning step');
  assert.ok(reads[0] > warn.at && reads[0] < (warn.runLines[0] ?? Infinity), 'the condition belongs to the warning step');
  // No expression interpolates it: not into an env, a run script, a with or anything else.
  for (const [i, line] of LINES.entries()) {
    for (const m of line.matchAll(/\$\{\{([\s\S]*?)\}\}/g)) assert.ok(!m[1].includes(VAR), `line ${i + 1} interpolates the variable: ${line.trim()}`);
  }
  // No env maps it, at any level, and no script reads it from the environment.
  for (const [i, line] of LINES.entries()) {
    assert.ok(!new RegExp(`^\\s*${VAR}\\s*:`).test(line), `line ${i + 1} maps the variable into an environment`);
    assert.ok(!line.includes(`$${VAR}`) && !line.includes(`\${${VAR}`), `line ${i + 1} reads the variable in a script`);
  }
  for (const name of ['Check the configuration', 'Push to the Worker']) {
    assert.ok(!step(name).env.some((l) => l.includes(VAR)), name);
  }
  // Apart from comments, the variable is named only by the condition and the warning's text.
  const allowed = new Set([reads[0], ...warn.runLines]);
  for (const [i, line] of LINES.entries()) {
    if (!line.includes(VAR) || line.trimStart().startsWith('#')) continue;
    assert.ok(allowed.has(i), `line ${i + 1} names the variable outside the warning step: ${line.trim()}`);
  }
  // Besides its name, the warning step has a condition and a run script and nothing else: no
  // environment, no action and no inputs.
  assert.deepEqual(warn.keys, ['if', 'run'], 'the keys of the warning step');
  assert.deepEqual(warn.env, []);
});

test('the warning step prints one GitHub warning that asks to delete the variable, without its value', () => {
  const warn = step(WARN_STEP);
  const r = spawnSync('bash', ['-c', warn.run], { encoding: 'utf8', env: { PATH: process.env.PATH, [VAR]: 'fake-stale-sig-version' } });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stderr, '');
  assert.equal(
    r.stdout,
    '::warning::The repository variable CADDIE_ADMIN_SIG_VERSION was removed in step e of the admin signature migration (DECISIONS.md, "Admin signature v2") and is ignored: every admin request is signed with v2. Delete the repository variable.\n',
  );
  assert.ok(!r.stdout.includes('fake-stale-sig-version'));
});

test('the push step gets its secrets and runs push-ingest.mjs against the API base', () => {
  const push = step('Push to the Worker');
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

test('the configuration check goes ahead with the token and the API base, and ignores a stale CADDIE_ADMIN_SIG_VERSION', () => {
  const check = step('Check the configuration');
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
    // A value the removed check used to refuse no longer stops the run, and is never printed.
    for (const env of [{}, { CADDIE_ADMIN_SIG_VERSION: '' }, { CADDIE_ADMIN_SIG_VERSION: '1' }, { CADDIE_ADMIN_SIG_VERSION: 'fake-stale-sig-version' }]) {
      const r = run(env);
      assert.equal(r.status, 0, `${JSON.stringify(env)}: ${r.stdout}${r.stderr}`);
      assert.equal(r.out, 'ready=true\n');
      assert.ok(!r.stdout.includes('fake-stale-sig-version') && !r.stderr.includes('fake-stale-sig-version'));
    }
    // Without the token or the base, a scheduled run logs a notice and succeeds without going
    // ahead, and a manual run fails naming what is missing.
    const scheduled = run({ ADMIN_TOKEN: '', CADDIE_API_BASE: '' });
    assert.equal(scheduled.status, 0, scheduled.stdout + scheduled.stderr);
    assert.match(scheduled.stdout, /::notice::Skipping the ingest: the CADDIE_ADMIN_TOKEN secret and the CADDIE_API_BASE variable is not set/);
    assert.equal(scheduled.out, 'ready=false\n');
    const manual = run({ GITHUB_EVENT_NAME: 'workflow_dispatch', CADDIE_API_BASE: '' });
    assert.equal(manual.status, 1);
    assert.match(manual.stdout, /::error::the CADDIE_API_BASE variable is not set\./);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
