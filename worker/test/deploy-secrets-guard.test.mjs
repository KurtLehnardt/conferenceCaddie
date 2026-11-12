// worker/scripts/deploy.sh, step 3: the script refuses to deploy while ADMIN_SIG_MIN or ADMIN_ORIGIN
// is a secret of the Worker (DECISIONS.md, "Admin signature v2", step d), because a secret survives
// every deploy and would override the source default, for example keeping v1 open. It reads the
// secrets' names through the Cloudflare API, passes a first deploy (404 with error code 10007) and
// refuses on any other answer, so a check that could not run never passes.
//
// The script runs from a copy in a temporary tree (worker/scripts/deploy.sh, the real
// worker/wrangler.toml, empty node_modules directories), so the real web app is never built, with
// stand-ins for curl, npm and npx first on its PATH: nothing reaches Cloudflare, nothing is
// deployed, and the token passed is a placeholder.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('../scripts/deploy.sh', import.meta.url));
const WRANGLER_TOML = fileURLToPath(new URL('../wrangler.toml', import.meta.url));
const FAKE_TOKEN = 'placeholder-token-not-a-credential-4f1c';
const ACCOUNT = 'a'.repeat(32);
const WORKER_NAME = readFileSync(WRANGLER_TOML, 'utf8').match(/^name *= *"([^"]*)"/m)[1];
// A value that must never be printed, were Cloudflare ever to return one beside a name.
const CANARY = 'canary-secret-value-never-printed';

// curl: -K - (the token on standard input), -o FILE, -w '%{http_code}', -X METHOD and the URL. The
// health check after the deploy has none of the API options and is answered with success. The API
// answers come from responses.json: { subdomain: { code, body }, secrets: { code, body } | { fail: true } }
// (fail: curl exits without an answer, which the script reads as status 000).
const CURL = `#!${process.execPath}
const fs = require('node:fs');
const dir = process.env.STUB_DIR;
const args = process.argv.slice(2);
const stdin = fs.readFileSync(0, 'utf8');
const opt = (flag) => args[args.indexOf(flag) + 1];
const url = args[args.length - 1];
const kind = !args.includes('-K') ? 'health' : url.endsWith('/workers/subdomain') ? 'subdomain' : /\\/workers\\/scripts\\/[^/]+\\/secrets$/.test(url) ? 'secrets' : 'other';
fs.appendFileSync(dir + '/calls.log', JSON.stringify({ tool: 'curl', kind, method: opt('-X') || 'GET', url, args, stdinAuth: stdin === 'header = "Authorization: Bearer ' + process.env.CLOUDFLARE_API_TOKEN + '"\\n' }) + '\\n');
if (kind === 'health') process.exit(0);
const answer = JSON.parse(fs.readFileSync(dir + '/responses.json', 'utf8'))[kind];
if (!answer || answer.fail) process.exit(7);
fs.writeFileSync(opt('-o'), typeof answer.body === 'string' ? answer.body : JSON.stringify(answer.body));
process.stdout.write(String(answer.code));
`;

// npm: run build:worker writes the two files the script checks for; anything else is recorded only.
const NPM = `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.STUB_DIR + '/calls.log', JSON.stringify({ tool: 'npm', args }) + '\\n');
const prefix = args[args.indexOf('--prefix') + 1];
if (args.includes('build:worker')) {
  fs.mkdirSync(prefix + '/dist-worker', { recursive: true });
  fs.writeFileSync(prefix + '/dist-worker/index.html', '<!doctype html>');
  fs.writeFileSync(prefix + '/dist-worker/_headers', '/*');
}
`;

// npx: records the call and answers like a successful wrangler deploy.
const NPX = `#!${process.execPath}
const fs = require('node:fs');
fs.appendFileSync(process.env.STUB_DIR + '/calls.log', JSON.stringify({ tool: 'npx', args: process.argv.slice(2) }) + '\\n');
process.stdout.write('Deployed ${WORKER_NAME}\\n  https://${WORKER_NAME}.stub-sub.workers.dev\\n');
`;

function world(t, secrets) {
  const dir = mkdtempSync(join(tmpdir(), 'caddie-deploy-guard-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bin = join(dir, 'bin');
  const repo = join(dir, 'repo');
  for (const d of [bin, join(repo, 'worker', 'scripts'), join(repo, 'worker', 'node_modules'), join(repo, 'web', 'node_modules')]) mkdirSync(d, { recursive: true });
  copyFileSync(SCRIPT, join(repo, 'worker', 'scripts', 'deploy.sh'));
  copyFileSync(WRANGLER_TOML, join(repo, 'worker', 'wrangler.toml'));
  for (const [name, text] of [['curl', CURL], ['npm', NPM], ['npx', NPX]]) writeFileSync(join(bin, name), text, { mode: 0o755 });
  writeFileSync(join(dir, 'responses.json'), JSON.stringify({ subdomain: { code: 200, body: { success: true, result: { subdomain: 'stub-sub' } } }, secrets }));
  return {
    run(extra = []) {
      const env = { PATH: `${bin}:${process.env.PATH}`, TMPDIR: dir, STUB_DIR: dir, CLOUDFLARE_API_TOKEN: FAKE_TOKEN, CLOUDFLARE_ACCOUNT_ID: ACCOUNT, HOME: dir };
      const r = spawnSync('bash', [join(repo, 'worker', 'scripts', 'deploy.sh'), ...extra], { env, encoding: 'utf8', timeout: 60_000 });
      return { status: r.status, stdout: r.stdout, stderr: r.stderr, text: `${r.stdout}\n${r.stderr}` };
    },
    calls() {
      const path = join(dir, 'calls.log');
      return existsSync(path) ? readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
    },
  };
}

const ok = (result) => ({ code: 200, body: { success: true, errors: [], messages: [], result } });
const named = (...names) => ok(names.map((name) => ({ name, type: 'secret_text', text: CANARY })));
const deployCalls = (w) => w.calls().filter((c) => c.tool === 'npx');
const secretsCalls = (w) => w.calls().filter((c) => c.kind === 'secrets');

// What every run must show: the secrets were asked for this Worker on this account, with the token
// on curl's standard input; the token is in no stand-in's arguments and in none of the output, and
// no value Cloudflare might return is printed.
function checkHygiene(w, r) {
  const asked = secretsCalls(w);
  assert.equal(asked.length, 1, r.text);
  assert.equal(asked[0].url, `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/workers/scripts/${WORKER_NAME}/secrets`);
  assert.equal(asked[0].method, 'GET');
  for (const c of w.calls().filter((x) => x.tool === 'curl' && x.kind !== 'health')) assert.equal(c.stdinAuth, true, `the token reached curl on stdin (${c.kind})`);
  for (const c of w.calls()) assert.ok(!JSON.stringify(c.args).includes(FAKE_TOKEN), `the token is not in the arguments of ${c.tool}`);
  assert.ok(!r.text.includes(FAKE_TOKEN), 'the token is not printed');
  assert.ok(!r.text.includes(CANARY), 'no secret value is printed');
}

function assertDeployed(w, r) {
  assert.equal(r.status, 0, r.text);
  const deploys = deployCalls(w);
  assert.deepEqual(deploys.map((c) => c.args), [['--yes', 'wrangler', 'deploy']]);
  // The check ran before the deploy.
  const calls = w.calls();
  assert.ok(calls.findIndex((c) => c.kind === 'secrets') < calls.findIndex((c) => c.tool === 'npx'));
  assert.match(r.stdout, new RegExp(`App URL .*: https://${WORKER_NAME}\\.stub-sub\\.workers\\.dev$`, 'm'));
  checkHygiene(w, r);
}

function assertRefused(w, r, pattern) {
  assert.equal(r.status, 1, r.text);
  assert.deepEqual(deployCalls(w), [], 'wrangler deploy never ran');
  assert.match(r.stderr, pattern);
  assert.doesNotMatch(r.stdout, /App URL/);
  checkHygiene(w, r);
}

test('neither ADMIN_SIG_MIN nor ADMIN_ORIGIN is a secret: the deploy goes ahead', (t) => {
  for (const secrets of [named('ADMIN_TOKEN', 'ES_API_KEY', 'ADMIN_TOKEN_NEXT'), ok([]), named('ADMIN_SIG_MIN_OLD', 'X_ADMIN_ORIGIN', 'admin_sig_min')]) {
    const w = world(t, secrets);
    const r = w.run();
    assertDeployed(w, r);
    assert.doesNotMatch(r.stderr, /Refusing/);
  }
});

test('an ADMIN_SIG_MIN secret refuses the deploy before wrangler runs, naming the setting and the remedy', (t) => {
  const w = world(t, named('ADMIN_TOKEN', 'ADMIN_SIG_MIN'));
  const r = w.run();
  assertRefused(w, r, /Refusing to deploy: ADMIN_SIG_MIN is set as a secret on the Worker /);
  assert.match(r.stderr, /survives every deploy/);
  assert.match(r.stderr, /v1 admin signature/);
  assert.match(r.stderr, /cd worker && npx wrangler secret delete ADMIN_SIG_MIN$/m);
  assert.match(r.stderr, /\[vars\] of worker\/wrangler\.toml/);
  assert.doesNotMatch(r.stderr, /delete ADMIN_ORIGIN/);
});

test('an ADMIN_ORIGIN secret refuses the deploy, and with both secrets both are named', (t) => {
  const w = world(t, named('ADMIN_ORIGIN', 'ADMIN_TOKEN'));
  const r = w.run();
  assertRefused(w, r, /Refusing to deploy: ADMIN_ORIGIN is set as a secret on the Worker /);
  assert.match(r.stderr, /npx wrangler secret delete ADMIN_ORIGIN$/m);
  assert.doesNotMatch(r.stderr, /ADMIN_SIG_MIN is set/);

  const both = world(t, named('ADMIN_SIG_MIN', 'ADMIN_ORIGIN', 'ADMIN_SIG_MIN'));
  const rb = both.run();
  assertRefused(both, rb, /ADMIN_ORIGIN is set as a secret/);
  assert.match(rb.stderr, /ADMIN_SIG_MIN is set as a secret/);
  assert.equal(rb.stderr.match(/npx wrangler secret delete ADMIN_SIG_MIN/g).length, 1, 'a name listed twice is named once');
});

test('a first deploy (404 with error code 10007, the Worker does not exist yet) goes ahead', (t) => {
  const w = world(t, { code: 404, body: { success: false, errors: [{ code: 10007, message: 'This Worker does not exist on your account.' }], result: null } });
  const r = w.run();
  assertDeployed(w, r);
  assert.match(r.stderr, /does not exist yet \(a first deploy\)/);
});

test('any other answer refuses the deploy with the status and the error codes only: the check fails closed', (t) => {
  const cases = [
    ['403', { code: 403, body: { success: false, errors: [{ code: 10000, message: `Authentication error ${CANARY}` }] } }, /HTTP 403, Cloudflare error codes: 10000\)/],
    ['404 without 10007', { code: 404, body: { success: false, errors: [{ code: 7003, message: 'Could not route' }] } }, /HTTP 404, Cloudflare error codes: 7003\)/],
    ['500', { code: 500, body: 'Internal Server Error' }, /HTTP 500, Cloudflare error codes: none\)/],
    ['no answer', { fail: true }, /HTTP 000, Cloudflare error codes: none\)/],
    ['200 not JSON', { code: 200, body: '<html>' }, /could not be read \(HTTP 200/],
    ['200 not a success', { code: 200, body: { success: false, errors: [{ code: 10013, message: 'x' }], result: [] } }, /could not be read \(HTTP 200, Cloudflare error codes: 10013\)/],
    ['200 without a list', { code: 200, body: { success: true, result: { name: 'ADMIN_TOKEN' } } }, /could not be read/],
    ['200 with an entry without a name', { code: 200, body: { success: true, result: [{ type: 'secret_text', text: CANARY }] } }, /could not be read/],
  ];
  for (const [why, secrets, pattern] of cases) {
    const w = world(t, secrets);
    const r = w.run();
    assertRefused(w, r, pattern);
    assert.match(r.stderr, /neither ADMIN_SIG_MIN nor ADMIN_ORIGIN is a secret did not run/, why);
    assert.doesNotMatch(r.stderr, /Authentication error|Could not route/, `${why}: only codes, no messages`);
  }
  // The permission hint comes with a failed request.
  const w = world(t, cases[0][1]);
  assert.match(w.run().stderr, /"Workers Scripts: Edit"/);
});

test('--subdomain-only stops before the check and the deploy', (t) => {
  const w = world(t, named('ADMIN_SIG_MIN'));
  const r = w.run(['--subdomain-only']);
  assert.equal(r.status, 0, r.text);
  assert.deepEqual(secretsCalls(w), []);
  assert.deepEqual(deployCalls(w), []);
  assert.ok(!r.text.includes(FAKE_TOKEN));
});
