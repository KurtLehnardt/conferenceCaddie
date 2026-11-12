// worker/scripts/deploy.sh, step 1 (W9): the workers.dev subdomain it creates when the account has
// none comes from CADDIE_WORKERS_SUBDOMAIN, and without it from the random fallback, never from a
// name built into the script. An account that already has a subdomain keeps it.
//
// The script runs with --subdomain-only, which stops after step 1, and with a stand-in for curl
// first on its PATH, so nothing reaches Cloudflare and no real token is involved (the one passed is
// a placeholder). The build and `wrangler deploy` steps are not run here.

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
// responses.json: { get: { code, body }, put: [{ code, body | echo }, ...] } (echo makes the
// success answer carry the subdomain that was asked for).
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
let answer;
if (method === 'GET') answer = responses.get;
else {
  const n = fs.existsSync(dir + '/put-count') ? Number(fs.readFileSync(dir + '/put-count', 'utf8')) : 0;
  fs.writeFileSync(dir + '/put-count', String(n + 1));
  answer = responses.put[Math.min(n, responses.put.length - 1)];
  if (answer.echo) answer = { code: 200, body: { success: true, result: { subdomain: JSON.parse(data).subdomain } } };
}
fs.writeFileSync(opt('-o'), JSON.stringify(answer.body));
process.stdout.write(String(answer.code));
`;

function world(t, responses) {
  const dir = mkdtempSync(join(tmpdir(), 'caddie-deploy-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'curl'), CURL, { mode: 0o755 });
  chmodSync(join(bin, 'curl'), 0o755);
  writeFileSync(join(dir, 'responses.json'), JSON.stringify(responses));
  return {
    dir,
    run(env = {}) {
      const childEnv = {
        PATH: `${bin}:${process.env.PATH}`,
        TMPDIR: dir,
        STUB_DIR: dir,
        CLOUDFLARE_API_TOKEN: FAKE_TOKEN,
        CLOUDFLARE_ACCOUNT_ID: '0'.repeat(32),
        ...env,
      };
      for (const k of Object.keys(childEnv)) if (childEnv[k] === undefined) delete childEnv[k];
      const r = spawnSync('bash', [SCRIPT, '--subdomain-only'], { env: childEnv, encoding: 'utf8', timeout: 60_000 });
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
