// worker/scripts/deploy.sh, step 3: the script refuses to deploy while ADMIN_SIG_MIN, ADMIN_ORIGIN or
// ADMIN_TEST_ROUTES is a secret of the Worker (DECISIONS.md, "Admin signature v2", step d), because a
// secret survives every deploy and would override the source default, for example keeping v1 open or
// the /admin/test/* fixture routes on. It reads the secrets' names through the Cloudflare API,
// passes a first deploy (404 with error code 10007) and refuses on any other answer, so a check that
// could not run never passes. Step 1 fails closed the same way: a subdomain answer it cannot read
// stops the script without a PUT and before wrangler runs.
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

function world(t, secrets, subdomain = { code: 200, body: { success: true, result: { subdomain: 'stub-sub' } } }) {
  const dir = mkdtempSync(join(tmpdir(), 'caddie-deploy-guard-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bin = join(dir, 'bin');
  const repo = join(dir, 'repo');
  for (const d of [bin, join(repo, 'worker', 'scripts'), join(repo, 'worker', 'node_modules'), join(repo, 'web', 'node_modules')]) mkdirSync(d, { recursive: true });
  copyFileSync(SCRIPT, join(repo, 'worker', 'scripts', 'deploy.sh'));
  copyFileSync(WRANGLER_TOML, join(repo, 'worker', 'wrangler.toml'));
  for (const [name, text] of [['curl', CURL], ['npm', NPM], ['npx', NPX]]) writeFileSync(join(bin, name), text, { mode: 0o755 });
  writeFileSync(join(dir, 'responses.json'), JSON.stringify({ subdomain, secrets }));
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

// What every run must show: the token reached curl on its standard input for every API call; it is
// in no stand-in's arguments and in none of the output, and no value Cloudflare might return is
// printed.
function checkTokenHygiene(w, r) {
  assert.ok(w.calls().some((c) => c.tool === 'curl' && c.kind === 'subdomain'), 'the subdomain was read');
  for (const c of w.calls().filter((x) => x.tool === 'curl' && x.kind !== 'health')) assert.equal(c.stdinAuth, true, `the token reached curl on stdin (${c.kind})`);
  for (const c of w.calls()) assert.ok(!JSON.stringify(c.args).includes(FAKE_TOKEN), `the token is not in the arguments of ${c.tool}`);
  assert.ok(!r.text.includes(FAKE_TOKEN), 'the token is not printed');
  assert.ok(!r.text.includes(CANARY), 'no secret value is printed');
}

// What every run past the subdomain step must show as well: the secrets were asked for this Worker
// on this account, once.
function checkHygiene(w, r) {
  const asked = secretsCalls(w);
  assert.equal(asked.length, 1, r.text);
  assert.equal(asked[0].url, `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/workers/scripts/${WORKER_NAME}/secrets`);
  assert.equal(asked[0].method, 'GET');
  checkTokenHygiene(w, r);
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

test('none of ADMIN_SIG_MIN, ADMIN_ORIGIN and ADMIN_TEST_ROUTES is a secret: the deploy goes ahead', (t) => {
  for (const secrets of [named('ADMIN_TOKEN', 'ES_API_KEY', 'ADMIN_TOKEN_NEXT'), ok([]), named('ADMIN_SIG_MIN_OLD', 'X_ADMIN_ORIGIN', 'admin_sig_min', 'ADMIN_TEST_ROUTES_OLD', 'admin_test_routes')]) {
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
  assert.doesNotMatch(r.stderr, /ADMIN_TEST_ROUTES/);
});

test('an ADMIN_TEST_ROUTES secret refuses the deploy, naming the setting and the remedy', (t) => {
  const w = world(t, named('ADMIN_TEST_ROUTES', 'ADMIN_TOKEN'));
  const r = w.run();
  assertRefused(w, r, /Refusing to deploy: ADMIN_TEST_ROUTES is set as a secret on the Worker /);
  assert.match(r.stderr, /survives every deploy/);
  assert.match(r.stderr, /\/admin\/test\/\* fixture routes on after every deploy/);
  assert.match(r.stderr, /cd worker && npx wrangler secret delete ADMIN_TEST_ROUTES$/m);
  assert.match(r.stderr, /only for a fixture smoke, with npx wrangler deploy --var ADMIN_TEST_ROUTES:1/);
  // The remedy for the two signature settings is not given for this one.
  assert.doesNotMatch(r.stderr, /ADMIN_SIG_MIN|ADMIN_ORIGIN|v1 admin signature/);

  const all = world(t, named('ADMIN_TEST_ROUTES', 'ADMIN_SIG_MIN'));
  const ra = all.run();
  assertRefused(all, ra, /ADMIN_TEST_ROUTES is set as a secret/);
  assert.match(ra.stderr, /ADMIN_SIG_MIN is set as a secret/);
  assert.match(ra.stderr, /npx wrangler secret delete ADMIN_SIG_MIN$/m);
  assert.match(ra.stderr, /npx wrangler secret delete ADMIN_TEST_ROUTES$/m);
  assert.match(ra.stderr, /\[vars\] of worker\/wrangler\.toml/);
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
    // A body that parses to null or to something other than an object is read as {}: the readable
    // message, not a Node error.
    ['200 with body null', { code: 200, body: 'null' }, /could not be read \(HTTP 200, Cloudflare error codes: none\)/],
    ['200 with a number', { code: 200, body: '5' }, /could not be read \(HTTP 200, Cloudflare error codes: none\)/],
    ['200 with an array', { code: 200, body: '[{"name":"ADMIN_SIG_MIN"}]' }, /could not be read \(HTTP 200, Cloudflare error codes: none\)/],
    ['404 with body null', { code: 404, body: 'null' }, /HTTP 404, Cloudflare error codes: none\)/],
  ];
  for (const [why, secrets, pattern] of cases) {
    const w = world(t, secrets);
    const r = w.run();
    assertRefused(w, r, pattern);
    assert.match(r.stderr, /none of ADMIN_SIG_MIN, ADMIN_ORIGIN and ADMIN_TEST_ROUTES is a secret did not run/, why);
    assert.doesNotMatch(r.stderr, /Authentication error|Could not route/, `${why}: only codes, no messages`);
    assert.doesNotMatch(r.stderr, /TypeError|SyntaxError|^\s+at |node:internal/m, `${why}: no Node error`);
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
  checkTokenHygiene(w, r);
});

test('a subdomain answer that cannot be read stops the script: no PUT, no build, no deploy', (t) => {
  // Only a successful answer with a null subdomain, or an answer that is not a success and carries
  // error code 10007 at HTTP 200, 400 or 404, means that the account has no subdomain yet
  // (deploy-subdomain.test.mjs). Anything else that does not name the subdomain must not lead to a
  // PUT, which could rename an existing subdomain.
  const cases = [
    ['200 with body null', { code: 200, body: 'null' }, /HTTP 200, error codes: none\)/],
    ['200 with body {}', { code: 200, body: {} }, /HTTP 200, error codes: none\)/],
    ['200 not JSON', { code: 200, body: '<html>' }, /HTTP 200, error codes: none\)/],
    ['200 without result.subdomain', { code: 200, body: { success: true, result: {} } }, /HTTP 200, error codes: none\)/],
    ['200 with an empty subdomain', { code: 200, body: { success: true, result: { subdomain: '' } } }, /HTTP 200, error codes: none\)/],
    ['200 with a number as the subdomain', { code: 200, body: { success: true, result: { subdomain: 5 } } }, /HTTP 200, error codes: none\)/],
    ['200 not a success', { code: 200, body: { success: false, errors: [{ code: 10013, message: `x ${CANARY}` }], result: { subdomain: null } } }, /HTTP 200, error codes: 10013\)/],
    ['200 with result null', { code: 200, body: { success: true, result: null } }, /HTTP 200, error codes: none\)/],
    ['404 without 10007', { code: 404, body: { success: false, errors: [{ code: 7003, message: 'Could not route' }] } }, /HTTP 404, error codes: 7003\)/],
    ['500', { code: 500, body: 'Internal Server Error' }, /HTTP 500, error codes: none\)/],
  ];
  for (const [why, subdomain, pattern] of cases) {
    for (const extra of [[], ['--subdomain-only']]) {
      const w = world(t, ok([]), subdomain);
      const r = w.run(extra);
      assert.equal(r.status, 1, `${why} ${extra}: ${r.text}`);
      assert.match(r.stderr, /Could not read the workers\.dev subdomain/, why);
      assert.match(r.stderr, pattern, why);
      assert.match(r.stderr, /If it keeps failing, create the subdomain once in the dashboard \(Workers & Pages, Overview, workers\.dev subdomain\)/, why);
      assert.deepEqual(w.calls().filter((c) => c.tool === 'curl' && c.method === 'PUT'), [], `${why}: no PUT`);
      assert.deepEqual(w.calls().filter((c) => c.tool === 'npm' || c.tool === 'npx'), [], `${why}: no build and no deploy`);
      assert.deepEqual(secretsCalls(w), [], `${why}: stopped in step 1`);
      assert.doesNotMatch(r.stdout, /App URL|workers\.dev subdomain:/, why);
      assert.doesNotMatch(r.stderr, /Could not route|TypeError|SyntaxError|^\s+at |node:internal/m, `${why}: codes only, no Node error`);
      checkTokenHygiene(w, r);
    }
  }
});

test('a subdomain answer of 401 or 403 never leads to a PUT: the deploy goes ahead, and --subdomain-only stops', (t) => {
  const puts = (w) => w.calls().filter((c) => c.tool === 'curl' && c.method === 'PUT');
  for (const code of [401, 403]) {
    const subdomain = { code, body: { success: false, errors: [{ code: 10000, message: 'Authentication error' }] } };
    // Without --subdomain-only the script carries on without creating one, since wrangler deploy
    // works when the subdomain was created in the dashboard.
    const w = world(t, ok([]), subdomain);
    const r = w.run();
    assertDeployed(w, r);
    assert.deepEqual(puts(w), [], `${code}: no PUT`);
    assert.match(r.stderr, new RegExp(`the token cannot read the workers\\.dev subdomain \\(HTTP ${code}\\); deploying anyway`));
    assert.match(r.stdout, /^workers\.dev subdomain: stub-sub$/m);

    // With --subdomain-only it stops with the blocker, before the check and the deploy.
    const only = world(t, ok([]), subdomain);
    const ro = only.run(['--subdomain-only']);
    assert.equal(ro.status, 1, ro.text);
    assert.deepEqual(puts(only), [], `${code} --subdomain-only: no PUT`);
    assert.match(ro.stderr, new RegExp(`Reading the workers\\.dev subdomain failed with HTTP ${code}`));
    assert.match(ro.stderr, /^Blocker: .*Workers & Pages, Overview, workers\.dev subdomain/m);
    assert.deepEqual(only.calls().filter((c) => c.tool === 'npm' || c.tool === 'npx'), [], `${code}: no build and no deploy`);
    assert.deepEqual(secretsCalls(only), []);
    checkTokenHygiene(only, ro);
  }
});

test('no answer to the subdomain read stops the script: no PUT, no build, no deploy', (t) => {
  for (const extra of [[], ['--subdomain-only']]) {
    const w = world(t, ok([]), { fail: true });
    const r = w.run(extra);
    assert.equal(r.status, 1, `${extra}: ${r.text}`);
    assert.match(r.stderr, /^Could not reach api\.cloudflare\.com\.$/m);
    assert.deepEqual(w.calls().filter((c) => c.tool === 'curl' && c.method === 'PUT'), [], `${extra}: no PUT`);
    assert.deepEqual(w.calls().filter((c) => c.tool === 'npm' || c.tool === 'npx'), [], `${extra}: no build and no deploy`);
    assert.deepEqual(secretsCalls(w), []);
    assert.doesNotMatch(r.stdout, /App URL|workers\.dev subdomain:/);
    checkTokenHygiene(w, r);
  }
});
