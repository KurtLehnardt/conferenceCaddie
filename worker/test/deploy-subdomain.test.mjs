// worker/scripts/deploy.sh, step 1 (W9): the workers.dev subdomain it creates when the account has
// none comes from CADDIE_WORKERS_SUBDOMAIN, and without it from the random fallback, never from a
// name built into the script. An account that already has a subdomain keeps it. Only a PUT
// answered 409 or 400 is followed by another PUT; after any other failed PUT the subdomain is read
// once more, so a PUT that went through is never followed by a second one that could rename it.
//
// The script runs with --subdomain-only, which stops after step 1, and with a stand-in for curl
// first on its PATH, so nothing reaches Cloudflare and no real token is involved (the one passed is
// a placeholder). The build and `wrangler deploy` steps are not run here: the runs without
// --subdomain-only all stop in step 1, and stand-ins for npm and npx, which record the call and
// fail, make sure that a script that got past step 1 neither builds nor deploys.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('../scripts/deploy.sh', import.meta.url));
const FAKE_TOKEN = 'placeholder-token-not-a-credential';

// curl: -o FILE, -w '%{http_code}', -X METHOD, --data BODY and the URL. The answers come from
// responses.json: { get: ANSWER | [ANSWER, ...], put: [ANSWER, ...] }, where an ANSWER is
// { code, body }, { echo: true } or { fail: true }. A list answers the calls in turn and repeats its
// last entry; echo makes the success answer carry the subdomain that was asked for; fail makes curl
// exit without an answer, which the script reads as status 000.
const CURL = `#!${process.execPath}
const fs = require('node:fs');
const dir = process.env.STUB_DIR;
const args = process.argv.slice(2);
fs.readFileSync(0);
const opt = (flag) => args[args.indexOf(flag) + 1];
const method = opt('-X') || 'GET';
const data = args.includes('--data') ? opt('--data') : null;
const url = args[args.length - 1];
fs.appendFileSync(dir + '/calls.log', JSON.stringify({ method, url, data, args }) + '\\n');
const responses = JSON.parse(fs.readFileSync(dir + '/responses.json', 'utf8'));
const next = (name, list) => {
  if (!Array.isArray(list)) return list;
  const file = dir + '/' + name + '-count';
  const n = fs.existsSync(file) ? Number(fs.readFileSync(file, 'utf8')) : 0;
  fs.writeFileSync(file, String(n + 1));
  return list[Math.min(n, list.length - 1)];
};
let answer;
if (method === 'GET') answer = next('get', responses.get);
else {
  answer = next('put', responses.put);
  if (answer.echo) answer = { code: 200, body: { success: true, result: { subdomain: JSON.parse(data).subdomain } } };
}
if (answer.fail) process.exit(7);
fs.writeFileSync(opt('-o'), JSON.stringify(answer.body));
process.stdout.write(String(answer.code));
`;

// npm and npx: record the call and fail, so that a run that gets past step 1 stops there.
const TOOL = `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
fs.appendFileSync(process.env.STUB_DIR + '/calls.log', JSON.stringify({ tool: path.basename(process.argv[1]), args: process.argv.slice(2) }) + '\\n');
process.exit(1);
`;

function world(t, responses) {
  const dir = mkdtempSync(join(tmpdir(), 'caddie-deploy-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'curl'), CURL, { mode: 0o755 });
  chmodSync(join(bin, 'curl'), 0o755);
  for (const tool of ['npm', 'npx']) writeFileSync(join(bin, tool), TOOL, { mode: 0o755 });
  writeFileSync(join(dir, 'responses.json'), JSON.stringify(responses));
  return {
    dir,
    run(env = {}, args = ['--subdomain-only']) {
      const childEnv = {
        PATH: `${bin}:${process.env.PATH}`,
        TMPDIR: dir,
        STUB_DIR: dir,
        CLOUDFLARE_API_TOKEN: FAKE_TOKEN,
        CLOUDFLARE_ACCOUNT_ID: '0'.repeat(32),
        ...env,
      };
      for (const k of Object.keys(childEnv)) if (childEnv[k] === undefined) delete childEnv[k];
      const r = spawnSync('bash', [SCRIPT, ...args], { env: childEnv, encoding: 'utf8', timeout: 60_000 });
      return { status: r.status, stdout: r.stdout, stderr: r.stderr, text: `${r.stdout}\n${r.stderr}` };
    },
    calls() {
      const path = join(dir, 'calls.log');
      return existsSync(path) ? readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
    },
  };
}

const NONE = { get: { code: 200, body: { success: true, result: { subdomain: null } } } };
const puts = (w) => w.calls().filter((c) => c.method === 'PUT').map((c) => JSON.parse(c.data).subdomain);

test('CADDIE_WORKERS_SUBDOMAIN is the name asked for when the account has none', (t) => {
  const w = world(t, { ...NONE, put: [{ echo: true }] });
  const r = w.run({ CADDIE_WORKERS_SUBDOMAIN: 'my-conf-caddie' });
  assert.equal(r.status, 0, r.text);
  assert.deepEqual(puts(w), ['my-conf-caddie']);
  assert.match(r.stdout, /^workers\.dev subdomain: my-conf-caddie$/m);
});

test('unset: straight to conference-caddie-<6 random lowercase letters>, and never a name built into the script', (t) => {
  const w = world(t, { ...NONE, put: [{ echo: true }] });
  const r = w.run({ CADDIE_WORKERS_SUBDOMAIN: undefined });
  assert.equal(r.status, 0, r.text);
  assert.equal(puts(w).length, 1);
  assert.match(puts(w)[0], /^conference-caddie-[a-z]{6}$/);
  assert.ok(!r.text.includes('kurtlehnardt'));
  // An empty value is the same as unset.
  const empty = world(t, { ...NONE, put: [{ echo: true }] });
  assert.equal(empty.run({ CADDIE_WORKERS_SUBDOMAIN: '' }).status, 0);
  assert.match(puts(empty)[0], /^conference-caddie-[a-z]{6}$/);
});

test('a name that is taken falls back to the random one, as before', (t) => {
  const w = world(t, { ...NONE, put: [{ code: 409, body: { success: false, errors: [{ code: 10000, message: 'taken' }] } }, { echo: true }] });
  const r = w.run({ CADDIE_WORKERS_SUBDOMAIN: 'taken-name' });
  assert.equal(r.status, 0, r.text);
  const asked = puts(w);
  assert.equal(asked.length, 2);
  assert.equal(asked[0], 'taken-name');
  assert.match(asked[1], /^conference-caddie-[a-z]{6}$/);
  assert.match(r.stderr, /The subdomain taken-name is not available/);
});

test('an account that already has a subdomain keeps it, whatever the variable says: the live krlehnardt comes out unchanged', (t) => {
  for (const name of [undefined, 'something-else']) {
    const w = world(t, { get: { code: 200, body: { success: true, result: { subdomain: 'krlehnardt' } } }, put: [{ echo: true }] });
    const r = w.run({ CADDIE_WORKERS_SUBDOMAIN: name });
    assert.equal(r.status, 0, r.text);
    assert.deepEqual(puts(w), [], 'nothing is created');
    assert.match(r.stdout, /^workers\.dev subdomain: krlehnardt$/m);
  }
});

test('a 404 with error code 10007 also means that the account has none, and only then is one created', (t) => {
  const w = world(t, { get: { code: 404, body: { success: false, errors: [{ code: 10007, message: 'not found' }], result: null } }, put: [{ echo: true }] });
  const r = w.run({ CADDIE_WORKERS_SUBDOMAIN: 'my-conf-caddie' });
  assert.equal(r.status, 0, r.text);
  assert.deepEqual(puts(w), ['my-conf-caddie']);
  assert.match(r.stdout, /^workers\.dev subdomain: my-conf-caddie$/m);
  // Any other answer that does not name the subdomain stops before a PUT, which could rename one
  // (deploy-secrets-guard.test.mjs covers more answers, and the full run).
  for (const get of [{ code: 200, body: null }, { code: 200, body: {} }, { code: 404, body: { success: false, errors: [{ code: 7003 }] } }]) {
    const bad = world(t, { get, put: [{ echo: true }] });
    const rb = bad.run({ CADDIE_WORKERS_SUBDOMAIN: 'my-conf-caddie' });
    assert.equal(rb.status, 1, rb.text);
    assert.deepEqual(puts(bad), [], JSON.stringify(get));
    assert.match(rb.stderr, /Could not read the workers\.dev subdomain/);
  }
});

test('error code 10007 means none at HTTP 200, 400 or 404 when it is the first code of an answer that is not a success, as wrangler reads it', (t) => {
  const cases = [
    ['400 with 10007', { code: 400, body: { success: false, errors: [{ code: 10007, message: 'workers.api.error.not_found' }], result: null } }],
    ['200 not a success, with 10007', { code: 200, body: { success: false, errors: [{ code: 10007, message: 'not found' }], result: null } }],
    ['404 with 10007 first, then another code', { code: 404, body: { success: false, errors: [{ code: 10007 }, { code: 10000 }] } }],
  ];
  for (const [why, get] of cases) {
    const w = world(t, { get, put: [{ echo: true }] });
    const r = w.run({ CADDIE_WORKERS_SUBDOMAIN: 'my-conf-caddie' });
    assert.equal(r.status, 0, `${why}: ${r.text}`);
    assert.deepEqual(puts(w), ['my-conf-caddie'], why);
    assert.match(r.stdout, /^workers\.dev subdomain: my-conf-caddie$/m, why);
  }
  // Code 10007 at any other status, after another code (wrangler's APIError carries only
  // errors[0].code), beside success true, or beside a named subdomain is not "no subdomain": no PUT.
  for (const get of [
    { code: 500, body: { success: false, errors: [{ code: 10007 }] } },
    { code: 409, body: { success: false, errors: [{ code: 10007 }] } },
    { code: 200, body: { success: true, errors: [{ code: 10007 }], result: {} } },
    { code: 404, body: { success: false, errors: [{ code: 10000 }, { code: 10007 }] } },
    { code: 200, body: { success: false, errors: [{ code: 10007 }], result: { subdomain: 'live-sub' } } },
  ]) {
    const bad = world(t, { get, put: [{ echo: true }] });
    const rb = bad.run({ CADDIE_WORKERS_SUBDOMAIN: 'my-conf-caddie' });
    assert.equal(rb.status, 1, rb.text);
    assert.deepEqual(puts(bad), [], JSON.stringify(get));
    assert.match(rb.stderr, /Could not read the workers\.dev subdomain/);
    assert.match(rb.stderr, /If it keeps failing, create the subdomain once in the dashboard \(Workers & Pages, Overview, workers\.dev subdomain\), then run this script again\./);
  }
});

test('only a PUT answered 409 or 400 leads to another PUT, with a fallback name', (t) => {
  for (const code of [409, 400]) {
    const w = world(t, { ...NONE, put: [{ code, body: { success: false, errors: [{ code: 10000, message: 'taken' }] } }, { echo: true }] });
    const r = w.run({ CADDIE_WORKERS_SUBDOMAIN: 'taken-name' });
    assert.equal(r.status, 0, r.text);
    const asked = puts(w);
    assert.equal(asked.length, 2, `${code}: two PUTs`);
    assert.equal(asked[0], 'taken-name');
    assert.match(asked[1], /^conference-caddie-[a-z]{6}$/);
    assert.match(r.stdout, new RegExp(`^workers\\.dev subdomain: ${asked[1]}$`, 'm'));
  }
});

test('any other failed PUT is never followed by a second PUT: the subdomain is read once more', (t) => {
  const gets = (w) => w.calls().filter((c) => c.method === 'GET');
  const failed = [
    ['502', { code: 502, body: { success: false, errors: [{ code: 10013, message: 'bad gateway detail' }] } }, /HTTP 502, error codes: 10013\)/],
    ['404', { code: 404, body: { success: false, errors: [{ code: 7003, message: 'Could not route' }] } }, /HTTP 404, error codes: 7003\)/],
    ['no answer', { fail: true }, /HTTP 000, error codes: none\)/],
    ['200 not a success', { code: 200, body: { success: false, errors: [{ code: 10001, message: 'odd detail' }] } }, /HTTP 200, error codes: 10001\)/],
  ];
  for (const [why, put, pattern] of failed) {
    // The PUT went through after all: the second read names the subdomain, which is used.
    const w = world(t, { get: [NONE.get, { code: 200, body: { success: true, result: { subdomain: 'my-conf-caddie' } } }], put: [put, { echo: true }] });
    const r = w.run({ CADDIE_WORKERS_SUBDOMAIN: 'my-conf-caddie' });
    assert.equal(r.status, 0, `${why}: ${r.text}`);
    assert.deepEqual(puts(w), ['my-conf-caddie'], `${why}: exactly one PUT`);
    assert.equal(gets(w).length, 2, `${why}: read once more`);
    assert.match(r.stdout, /^workers\.dev subdomain: my-conf-caddie$/m, why);

    // The second read names none: the script stops, with the statuses and the error codes only.
    for (const second of [NONE.get, { code: 500, body: 'Internal Server Error' }]) {
      const n = world(t, { get: [NONE.get, second], put: [put, { echo: true }] });
      const rn = n.run({ CADDIE_WORKERS_SUBDOMAIN: 'my-conf-caddie' });
      assert.equal(rn.status, 1, `${why}: ${rn.text}`);
      assert.deepEqual(puts(n), ['my-conf-caddie'], `${why}: exactly one PUT`);
      assert.equal(gets(n).length, 2, `${why}: read once more`);
      assert.match(rn.stderr, /Creating the workers\.dev subdomain my-conf-caddie failed/, why);
      assert.match(rn.stderr, pattern, why);
      assert.match(rn.stderr, new RegExp(`reading it again did not name one \\(HTTP ${second.code}, error codes: none\\)`), why);
      assert.doesNotMatch(rn.stderr, /bad gateway detail|Could not route|odd detail|trying a fallback/, `${why}: codes only, no fallback`);
      assert.doesNotMatch(rn.stdout, /workers\.dev subdomain:/, why);
    }
  }
});

test('four PUTs answered 409 stop the script: no fifth PUT, no subdomain printed, no build and no deploy', (t) => {
  const taken = { code: 409, body: { success: false, errors: [{ code: 10000, message: 'taken' }] } };
  for (const args of [['--subdomain-only'], []]) {
    const why = args.join(' ') || 'full run';
    const w = world(t, { ...NONE, put: [taken] });
    const r = w.run({ CADDIE_WORKERS_SUBDOMAIN: 'taken-name' }, args);
    assert.equal(r.status, 1, `${why}: ${r.text}`);
    const asked = puts(w);
    assert.equal(asked.length, 4, `${why}: exactly four PUTs`);
    assert.equal(asked[0], 'taken-name');
    for (const name of asked.slice(1)) assert.match(name, /^conference-caddie-[a-z]{6}$/, why);
    assert.match(r.stderr, /^Could not create a workers\.dev subdomain after 4 attempts\.$/m, why);
    assert.doesNotMatch(r.stdout, /workers\.dev subdomain:/, why);
    assert.deepEqual(w.calls().filter((c) => c.tool), [], `${why}: no build and no deploy`);
  }
});

test('a PUT answered 401 or 403 stops with the blocker: one PUT, no second read', (t) => {
  for (const code of [401, 403]) {
    const w = world(t, { ...NONE, put: [{ code, body: { success: false, errors: [{ code: 10000, message: 'Authentication error' }] } }, { echo: true }] });
    const r = w.run({ CADDIE_WORKERS_SUBDOMAIN: 'my-conf-caddie' });
    assert.equal(r.status, 1, `${code}: ${r.text}`);
    assert.deepEqual(puts(w), ['my-conf-caddie'], `${code}: exactly one PUT`);
    assert.equal(w.calls().filter((c) => c.method === 'GET').length, 1, `${code}: a single GET`);
    assert.match(r.stderr, new RegExp(`Creating the workers\\.dev subdomain failed with HTTP ${code}`));
    assert.match(r.stderr, /^Blocker: .*Workers & Pages, Overview, workers\.dev subdomain/m);
    assert.doesNotMatch(r.stdout, /workers\.dev subdomain:/);
  }
});

test('a refused name, then a PUT answered 502, then a read that names the subdomain: two PUTs, and the script continues', (t) => {
  const w = world(t, {
    get: [NONE.get, { code: 200, body: { success: true, result: { subdomain: 'made-by-the-502' } } }],
    put: [{ code: 409, body: { success: false, errors: [{ code: 10000, message: 'taken' }] } }, { code: 502, body: { success: false, errors: [{ code: 10013 }] } }, { echo: true }],
  });
  const r = w.run({ CADDIE_WORKERS_SUBDOMAIN: 'taken-name' });
  assert.equal(r.status, 0, r.text);
  const asked = puts(w);
  assert.equal(asked.length, 2, 'two PUTs');
  assert.equal(asked[0], 'taken-name');
  assert.match(asked[1], /^conference-caddie-[a-z]{6}$/);
  assert.equal(w.calls().filter((c) => c.method === 'GET').length, 2, 'read once more after the 502');
  assert.match(r.stdout, /^workers\.dev subdomain: made-by-the-502$/m);
});

test('a name that is not a subdomain is refused before any request is made', (t) => {
  for (const bad of ['Bad_Name', 'UPPER', 'has space', 'a"b', '-lead', 'trail-', 'ok\nsecond', 'a'.repeat(64), 'x.y']) {
    const w = world(t, { ...NONE, put: [{ echo: true }] });
    const r = w.run({ CADDIE_WORKERS_SUBDOMAIN: bad });
    assert.equal(r.status, 2, JSON.stringify(bad));
    assert.match(r.stderr, /CADDIE_WORKERS_SUBDOMAIN must be a workers\.dev subdomain/);
    assert.deepEqual(w.calls(), [], 'no request');
  }
});

test('the token is never on a command line', (t) => {
  const w = world(t, { ...NONE, put: [{ echo: true }] });
  const r = w.run({ CADDIE_WORKERS_SUBDOMAIN: 'my-conf-caddie' });
  assert.equal(r.status, 0, r.text);
  for (const c of w.calls()) assert.ok(!JSON.stringify(c).includes(FAKE_TOKEN));
  assert.ok(!r.text.includes(FAKE_TOKEN));
});
