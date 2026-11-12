// scripts/deploy.sh with a fake gcloud on PATH: what it passes to `gcloud run deploy`, how it reads
// deploy.env, and that a bad value stops it before any gcloud call. No real gcloud, no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASH = fs.existsSync('/bin/bash') ? '/bin/bash' : 'bash';
const ES = 'https://es.example.invalid:443';
const BUNDLES = 'https://bundles.example.invalid/caddie/bundles/';
const GOOD = { GC_PROJECT: 'proj-test-12345', ES_URL: ES, CADDIE_BUNDLE_BASE: BUNDLES, VAPID_SUBJECT: 'mailto:ops@example.org' };

function sandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'caddie-deploy-'));
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  const log = path.join(dir, 'gcloud.log');
  fs.writeFileSync(path.join(bin, 'gcloud'), `#!/bin/bash
printf '%s\\n' "$*" >> "${log}"
case "$1 $2" in
  "secrets describe") exit 1 ;;
  "run services") echo https://fake.invalid/ ;;
esac
exit 0
`, { mode: 0o755 });
  const calls = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean) : []);
  return { dir, bin, calls, file: path.join(dir, 'deploy.env') };
}

function deploy(sb, { file, env = {}, extra = {}, noVapid = false } = {}) {
  if (file !== undefined) fs.writeFileSync(sb.file, file);
  const r = spawnSync(BASH, ['scripts/deploy.sh'], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 60_000,
    env: { PATH: `${sb.bin}:/usr/bin:/bin`, HOME: sb.dir, CADDIE_DEPLOY_ENV: sb.file, ...(noVapid ? {} : { VAPID_SUBJECT: 'mailto:ops@example.org' }), ...extra, ...env },
  });
  const deployCall = sb.calls().find((c) => c.startsWith('run deploy'));
  const envVars = deployCall?.match(/--set-env-vars (\S+)/)?.[1];
  return { ...r, deployCall, envVars };
}

const EXPECTED_ENV = (es = ES, bundles = BUNDLES) => [
  `ES_URL=${es}`, 'ES_INDEX=caddie-talks', 'ES_RULES_INDEX=caddie-people-rules', 'MOD_CLASSIFIER=off', 'MOD_REJECT=0.8',
  'MOD_HOLD=0.5', 'MOD_TIMEOUT_MS=3000', 'BLE_NEAR_RSSI=-75', 'PEOPLE_SEMANTIC_MIN_SIMILARITY=',
  'PEOPLE_SEMANTIC_PROFILE_MIN_SIMILARITY=', 'PEOPLE_SEMANTIC_PUSH_MIN_SIMILARITY=', `TALKS_BUNDLE_BASE=${bundles}`,
].join(',');

const withSandbox = (fn) => () => {
  const sb = sandbox();
  try { fn(sb); } finally { fs.rmSync(sb.dir, { recursive: true, force: true }); }
};

test('environment only: the deploy argv and the env string', withSandbox((sb) => {
  const r = deploy(sb, { env: { ...GOOD, GC_REGION: 'europe-west4' } });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.envVars, EXPECTED_ENV());
  assert.match(r.deployCall, /^run deploy conference-caddie --source \. --region europe-west4 --project proj-test-12345 --allow-unauthenticated /);
  assert.match(r.deployCall, /--service-account caddie-runtime@proj-test-12345\.iam\.gserviceaccount\.com/);
  assert.match(r.stderr, /Deploying conference-caddie to proj-test-12345 \(europe-west4\), ES_URL=https:\/\/es\.example\.invalid:443, bundles=https:\/\/bundles\.example\.invalid\/caddie\/bundles\/ \(from: environment\)/);
}));

test('the file: plain, quoted, CRLF, export prefix, leading spaces, a repeated key', withSandbox((sb) => {
  const cases = {
    plain: `GC_PROJECT=proj-test-12345\nES_URL=${ES}\nCADDIE_BUNDLE_BASE=${BUNDLES}\n`,
    single: `GC_PROJECT='proj-test-12345'\nES_URL='${ES}'\nCADDIE_BUNDLE_BASE='${BUNDLES}'\n`,
    double: `GC_PROJECT="proj-test-12345"\nES_URL="${ES}"\nCADDIE_BUNDLE_BASE="${BUNDLES}"\n`,
    crlf: `GC_PROJECT=proj-test-12345\r\nES_URL=${ES}\r\nCADDIE_BUNDLE_BASE=${BUNDLES}\r\n`,
    export: `export GC_PROJECT=proj-test-12345\n  export ES_URL="${ES}"\n   CADDIE_BUNDLE_BASE=${BUNDLES}\n`,
    repeated: `GC_PROJECT=proj-test-12345\nES_URL=https://old.example.invalid:443\nES_URL=${ES}\nCADDIE_BUNDLE_BASE=${BUNDLES}\n# ignored\nOTHER=1\n`,
    trailing: `GC_PROJECT=proj-test-12345 \nES_URL=${ES}/\nCADDIE_BUNDLE_BASE=${BUNDLES}\n`,
  };
  for (const [name, file] of Object.entries(cases)) {
    fs.rmSync(path.join(sb.dir, 'gcloud.log'), { force: true });
    const r = deploy(sb, { file: `${file}VAPID_SUBJECT=mailto:ops@example.org\n`, noVapid: true });
    assert.equal(r.status, 0, `${name}: ${r.stderr}`);
    assert.equal(r.envVars, EXPECTED_ENV(), name);
    assert.match(r.stderr, new RegExp(`\\(from: ${sb.file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\)`), name);
  }
}));

test('the environment wins over the file, and the log line says both were used', withSandbox((sb) => {
  const file = `GC_PROJECT=proj-from-file-1\nES_URL=https://file.example.invalid:443\nCADDIE_BUNDLE_BASE=${BUNDLES}\n`;
  const r = deploy(sb, { file, env: { ES_URL: ES, GC_PROJECT: 'proj-test-12345' } });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.envVars, EXPECTED_ENV());
  assert.match(r.deployCall, /--project proj-test-12345 /);
  assert.match(r.stderr, /\(from: environment and /);
}));

test('a bad or missing value stops the script before any gcloud call', withSandbox((sb) => {
  const bad = [
    [{ ES_URL: `'${ES}'` }, /ES_URL must be/],
    [{ ES_URL: `${ES}/path` }, /ES_URL must be/],
    [{ ES_URL: 'http://es.example.invalid:443' }, /ES_URL must be/],
    [{ ES_URL: 'https://es.example.invalid:443 ' }, /ES_URL must be/],
    [{ GC_PROJECT: 'Bad_Project' }, /GC_PROJECT must be/],
    [{ GC_REGION: 'us_west1' }, /GC_REGION must be/],
    [{ CADDIE_BUNDLE_BASE: 'http://bundles.example.invalid/' }, /CADDIE_BUNDLE_BASE must be/],
    [{ CADDIE_BUNDLE_BASE: 'https://bundles.example.invalid/no-slash' }, /CADDIE_BUNDLE_BASE must be/],
    [{ CADDIE_BUNDLE_BASE: 'https://u:p@bundles.example.invalid/' }, /CADDIE_BUNDLE_BASE must be/],
    [{ CADDIE_BUNDLE_BASE: 'https://bundles.example.invalid/?q=1/' }, /CADDIE_BUNDLE_BASE must be/],
    // A comma or = must not reach the comma-separated --set-env-vars list.
    [{ CADDIE_BUNDLE_BASE: 'https://bundles.example.invalid/x,ES_URL=https://evil.invalid:443/' }, /CADDIE_BUNDLE_BASE must be/],
    [{ CADDIE_BUNDLE_BASE: 'https://bundles.example.invalid/a=b/' }, /CADDIE_BUNDLE_BASE must be/],
    [{ ES_URL: 'https://es.example.invalid:443,ES_INDEX=x' }, /ES_URL must be/],
    [{ ES_URL: 'https://es.example.invalid:443/,X=1' }, /ES_URL must be/],
    [{ GC_PROJECT: 'proj-test-12345,ES_URL=x' }, /GC_PROJECT must be/],
    [{ GC_REGION: 'us-west1,X=1' }, /GC_REGION must be/],
  ];
  for (const [over, re] of bad) {
    const r = deploy(sb, { env: { ...GOOD, ...over } });
    assert.equal(r.status, 1, JSON.stringify(over));
    assert.match(r.stderr, re, JSON.stringify(over));
    assert.deepEqual(sb.calls(), [], JSON.stringify(over));
  }
  for (const missing of ['GC_PROJECT', 'ES_URL', 'CADDIE_BUNDLE_BASE']) {
    const env = { ...GOOD };
    delete env[missing];
    const r = deploy(sb, { env });
    assert.equal(r.status, 1, missing);
    assert.match(r.stderr, new RegExp(`Set ${missing}`), missing);
    assert.deepEqual(sb.calls(), [], missing);
  }
}));

test('a byte order mark, a blank before the =, an unset HOME and FCM_PROJECT_ID from the file', withSandbox((sb) => {
  const base = `GC_PROJECT=proj-test-12345\nES_URL=${ES}\nCADDIE_BUNDLE_BASE=${BUNDLES}\n`;
  // BOM on the first line.
  let r = deploy(sb, { file: `\uFEFF${base}` });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.envVars, EXPECTED_ENV());
  // A known key with a blank before the = is reported by key name only and not read.
  fs.rmSync(path.join(sb.dir, 'gcloud.log'), { force: true });
  r = deploy(sb, { file: `${base}GC_REGION =europe-west4\n` });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /Ignoring the line of GC_REGION .*no blanks are allowed before the =/);
  assert.match(r.deployCall, /--region us-west1 /);
  // FCM_PROJECT_ID from the file reaches the env only with NATIVE_PUSH_FCM=1, and is validated.
  fs.rmSync(path.join(sb.dir, 'gcloud.log'), { force: true });
  r = deploy(sb, { file: `${base}FCM_PROJECT_ID='fcm-proj-12345'\n`, env: { NATIVE_PUSH_FCM: '1' } });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.envVars.endsWith(',FCM_PROJECT_ID=fcm-proj-12345'), r.envVars);
  r = deploy(sb, { file: `${base}FCM_PROJECT_ID=bad,ES_URL=x\n`, env: { NATIVE_PUSH_FCM: '1' } });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /FCM_PROJECT_ID must be/);
  // HOME unset and no override: a clear message, not an unbound-variable error.
  const env = { PATH: `${sb.bin}:/usr/bin:/bin` };
  const bare = spawnSync(BASH, ['scripts/deploy.sh'], { cwd: ROOT, encoding: 'utf8', env, timeout: 60_000 });
  assert.equal(bare.status, 1);
  assert.match(bare.stderr, /Set GC_PROJECT .*HOME is unset/);
  assert.doesNotMatch(bare.stderr, /unbound variable/);
}));

test('VAPID_SUBJECT is required, has no default, and must be an https URL or a mailto: address', withSandbox((sb) => {
  const { VAPID_SUBJECT, ...without } = GOOD;
  const missing = deploy(sb, { env: without, noVapid: true });
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /Set VAPID_SUBJECT/);
  assert.doesNotMatch(missing.stderr + (missing.deployCall ?? ''), /github\.com\/[A-Za-z]/);
  assert.deepEqual(sb.calls(), []);
  const bad = deploy(sb, { env: { ...GOOD, VAPID_SUBJECT: 'ops at example.org' } });
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /VAPID_SUBJECT must be/);
  assert.deepEqual(sb.calls(), []);
  const fromFile = deploy(sb, { env: without, noVapid: true, file: 'VAPID_SUBJECT=https://example.org/contact\n' + Object.entries(without).map(([k, v]) => `${k}=${v}`).join('\n') + '\n' });
  assert.equal(fromFile.status, 0, fromFile.stderr);
}));
