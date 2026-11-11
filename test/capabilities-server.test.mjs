// GET /api/capabilities on the tier 3 server (server/capabilities.mjs): the document it computes
// from its configuration, checked against the capabilities fixtures and the schema in producer
// (closed) mode; the route's headers; the Bluetooth settings it advertises (server/ble-config.mjs);
// the native push flags (server/native-push.mjs); and the server refusing to start with an
// unusable master keyring or bundle base.
//
// Run with `npm test`. Nothing reaches the network; the Bluetooth keys below are the fake fixed
// ones of contracts/fixtures/ble, and the APNs key is generated for this run (FCM needs no key).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const NATIVE_SETTINGS = ['APNS_KEY_ID', 'APNS_TEAM_ID', 'APNS_KEY_P8', 'APNS_BUNDLE_ID', 'FCM_PROJECT_ID', 'PUSH_TRANSPORT', 'PUSH_STUB_URL'];
for (const k of ['BLE_MASTER_KEYRING', 'BLE_NEAR_RSSI', 'TALKS_BUNDLE_BASE', 'VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY', 'VAPID_SUBJECT', ...NATIVE_SETTINGS]) delete process.env[k];

const { capabilitiesDocument, bundleBaseFrom, webPushConfigured, handleCapabilities, currentCapabilities, DEFAULT_BUNDLE_BASE } = await import('../server/capabilities.mjs');
const { nearRssiFrom, keyringFrom } = await import('../server/ble-config.mjs');
const { parseKeyring, serializeKeyring } = await import('../server/ble-keyring.mjs');
const { validator } = await import('../contracts/js/schemas.mjs');
const { formatErrors } = await import('../contracts/js/validate.mjs');
const { effectiveCapabilities, SERVICE_UUID } = await import('../contracts/js/capabilities.mjs');
const CAPABILITIES = currentCapabilities();

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixture = (f) => JSON.parse(readFileSync(path.join(ROOT, 'contracts/fixtures/capabilities', f), 'utf8'));
const golden = JSON.parse(readFileSync(path.join(ROOT, 'contracts/fixtures/ble/golden-vectors.v1.json'), 'utf8'));
// The fake master secret of the golden vectors.
const FAKE_MASTER = golden.key_derivation.master_secret.base64url;
const keyringText = (current = 'm1', keys = { m1: FAKE_MASTER }) => JSON.stringify({ current, keys });

const closed = validator('capabilities.v1');
const assertValid = (doc) => {
  const r = closed(doc, { closed: true });
  assert.equal(r.valid, true, formatErrors(r.errors));
};
const config = (over = {}) => ({ bleMode: 'derived-v1', nearRssi: -75, webpush: true, bundleBase: DEFAULT_BUNDLE_BASE, ...over });

test('with the master keyring and VAPID: the tier3-paid fixture, without native push', () => {
  const doc = capabilitiesDocument(config());
  assertValid(doc);
  const want = fixture('tier3-paid.json');
  want.push = { apns: false, fcm: false, webpush: true };
  assert.deepEqual(doc, want);
  assert.deepEqual(effectiveCapabilities(doc), doc, 'a complete document is its own effective feature set');
});

test('with the keyring, VAPID, an APNs key and an FCM project: exactly the tier3-paid fixture', () => {
  const doc = capabilitiesDocument(config({ apns: true, fcm: true }));
  assertValid(doc);
  assert.deepEqual(doc, fixture('tier3-paid.json'));
  for (const [apns, fcm] of [[true, false], [false, true]]) {
    const one = capabilitiesDocument(config({ apns, fcm }));
    assertValid(one);
    assert.deepEqual(one.push, { apns, fcm, webpush: true });
  }
});

test('without the keyring: the tier3-transition fixture, with the mitigations advertised', () => {
  const doc = capabilitiesDocument(config({ bleMode: 'server-rotate' }));
  assertValid(doc);
  const want = fixture('tier3-transition.json');
  // This server applies the co-location rule to legacy tokens too, and says so.
  want.ble.colocation_required = true;
  assert.deepEqual(doc, want);
  assert.deepEqual(effectiveCapabilities(doc), doc);
});

test('Web Push is advertised only when all three VAPID settings are present', () => {
  assert.equal(webPushConfigured({ VAPID_PUBLIC_KEY: 'p', VAPID_PRIVATE_KEY: 's', VAPID_SUBJECT: 'mailto:x@example.org' }), true);
  for (const missing of ['VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY', 'VAPID_SUBJECT']) {
    const env = { VAPID_PUBLIC_KEY: 'p', VAPID_PRIVATE_KEY: 's', VAPID_SUBJECT: 'mailto:x@example.org' };
    delete env[missing];
    assert.equal(webPushConfigured(env), false, missing);
  }
  const doc = capabilitiesDocument(config({ webpush: false }));
  assertValid(doc);
  assert.deepEqual(doc.push, { apns: false, fcm: false, webpush: false });
});

test('this process (no keyring, no VAPID, no APNs or FCM settings): server-rotate, no push at all, the default bundle base', () => {
  assertValid(CAPABILITIES);
  assert.equal(CAPABILITIES.ble.mode, 'server-rotate');
  assert.deepEqual(CAPABILITIES.push, { apns: false, fcm: false, webpush: false });
  assert.equal(CAPABILITIES.talks.bundle_base, 'https://kurtlehnardt.github.io/conferenceCaddie/bundles/');
  assert.equal(CAPABILITIES.ble.service_uuid, SERVICE_UUID);
  assert.match(readFileSync(path.join(ROOT, 'server/ble.mjs'), 'utf8'), new RegExp(`BLE_SERVICE_UUID = '${SERVICE_UUID}'`), 'server/ble.mjs uses the contract UUID');
});

test('TALKS_BUNDLE_BASE: the default, an operator value, and values the schema refuses', () => {
  assert.equal(bundleBaseFrom(undefined), DEFAULT_BUNDLE_BASE);
  assert.equal(bundleBaseFrom(''), DEFAULT_BUNDLE_BASE);
  const own = 'https://example.github.io/caddie-fork/bundles/';
  assert.equal(bundleBaseFrom(own), own);
  assertValid(capabilitiesDocument(config({ bundleBase: own })));
  for (const bad of ['http://example.org/bundles/', 'https://example.org/bundles', 'https://example.org/b/?x=1', 'https://u:p@example.org/b/', 'https://example.org/b/#f', 'not a url/']) {
    assert.throws(() => bundleBaseFrom(bad), /TALKS_BUNDLE_BASE/, bad);
  }
});

test('BLE_NEAR_RSSI is advertised as an integer clamped to -100..-30', () => {
  assert.equal(nearRssiFrom(undefined), -75);
  assert.equal(nearRssiFrom(''), -75);
  assert.equal(nearRssiFrom('abc'), -75);
  assert.equal(nearRssiFrom('-80'), -80);
  assert.equal(nearRssiFrom('-80.6'), -81);
  assert.equal(nearRssiFrom('-20'), -30);
  assert.equal(nearRssiFrom('-130'), -100);
  for (const v of [-100, -30, -81]) assertValid(capabilitiesDocument(config({ nearRssi: v })));
});

test('the keyring: parsed, written back unchanged, and refused without quoting the secret', () => {
  assert.equal(keyringFrom(undefined), null);
  assert.equal(keyringFrom(''), null);
  const ring = keyringFrom(keyringText('m1', { m1: FAKE_MASTER, m0: Buffer.from('606162636465666768696a6b6c6d6e6f707172737475767778797a7b7c7d7e7f', 'hex').toString('base64url') }));
  assert.equal(ring.current, 'm1');
  assert.deepEqual([...ring.masters.keys()], ['m1', 'm0']);
  assert.equal(ring.masters.get('m1').toString('hex'), golden.key_derivation.master_secret.hex);
  assert.deepEqual(parseKeyring(serializeKeyring(ring)), ring);

  const refused = [
    ['not json', `{"current":"m1","keys":{"m1":"${FAKE_MASTER}"`],
    ['current not in the keyring', keyringText('m2')],
    ['no current', JSON.stringify({ keys: { m1: FAKE_MASTER } })],
    ['a short secret', keyringText('m1', { m1: FAKE_MASTER.slice(0, 20) })],
    ['padding', keyringText('m1', { m1: `${FAKE_MASTER}=` })],
    ['an unknown field', JSON.stringify({ current: 'm1', keys: { m1: FAKE_MASTER }, note: FAKE_MASTER })],
    ['a bad id', `{"current":"__proto__","keys":{"__proto__":"${FAKE_MASTER}"}}`],
    ['no keys', JSON.stringify({ current: 'm1', keys: {} })],
    ['an array', JSON.stringify([FAKE_MASTER])],
  ];
  for (const [name, text] of refused) {
    let message = '';
    assert.throws(() => {
      try {
        keyringFrom(text);
      } catch (err) {
        message = err.message;
        throw err;
      }
    }, /BLE_MASTER_KEYRING is unusable/, name);
    assert.ok(!message.includes(FAKE_MASTER.slice(0, 12)), `${name}: the message never quotes the secret`);
    assert.equal(err(text)?.cause, undefined, `${name}: no cause that could carry the parser's quote`);
  }
});
const err = (text) => {
  try {
    keyringFrom(text);
    return null;
  } catch (e) {
    return e;
  }
};

// One request through handleCapabilities with a stand-in response.
function call(method, ip = '10.7.0.1') {
  const req = Readable.from([]);
  req.method = method;
  req.headers = { host: 'caddie.test' };
  req.socket = { remoteAddress: ip };
  const res = {
    status: 0, headers: {}, text: '',
    writeHead(status, h) { this.status = status; this.headers = h; },
    end(chunk) { this.text = chunk === undefined ? '' : String(chunk); },
  };
  handleCapabilities(req, res);
  return { status: res.status, headers: res.headers, body: res.text ? JSON.parse(res.text) : null };
}

test('GET /api/capabilities: public, cacheable for five minutes, readable from any origin', () => {
  const r = call('GET');
  assert.equal(r.status, 200);
  assert.equal(r.headers['Cache-Control'], 'public, max-age=300');
  assert.equal(r.headers['Access-Control-Allow-Origin'], '*');
  assert.match(r.headers['Content-Type'], /^application\/json/);
  assert.deepEqual(r.body, CAPABILITIES);
  assertValid(r.body);
  assert.equal(call('HEAD').status, 200);
  const post = call('POST');
  assert.equal(post.status, 405);
  assert.equal(post.headers.Allow, 'GET, HEAD');
  assert.equal(post.headers['Cache-Control'], 'no-store');
});

test('every module the server imports from outside server/ is copied into the runtime image', () => {
  const dockerfile = readFileSync(path.join(ROOT, 'Dockerfile'), 'utf8');
  const copied = [...dockerfile.matchAll(/^COPY (?!--from)(\S+) /gm)].map((m) => m[1]);
  const outside = new Set();
  for (const f of readdirSync(path.join(ROOT, 'server')).filter((name) => name.endsWith('.mjs'))) {
    const src = readFileSync(path.join(ROOT, 'server', f), 'utf8');
    for (const m of src.matchAll(/from '(\.\.\/[^']+)'/g)) outside.add(path.posix.normalize(path.posix.join('server', m[1])));
  }
  assert.ok(outside.has('contracts/js/ble-token.mjs'));
  for (const file of outside) {
    assert.ok(copied.some((c) => file === c || file.startsWith(c.endsWith('/') ? c : `${c}/`)), `${file} is imported by server/ but not copied by the Dockerfile`);
  }
});

// The real entry point, in a child process: an unusable keyring or bundle base stops it before
// anything else runs (capabilities.mjs is its first import), with a message that never quotes the
// keyring. ES_URL points nowhere and no Elasticsearch key is set, so nothing could be reached.
function start(env) {
  return spawnSync(process.execPath, [path.join(ROOT, 'server/index.mjs')], {
    env: { PATH: process.env.PATH, PORT: '0', ES_URL: 'https://es.invalid.test', ...env },
    encoding: 'utf8',
    timeout: 30_000,
  });
}

// The push flags the server computes at start for an environment, read in a child process so each
// configuration is a fresh import. Returns { push, output }.
function pushFlags(env) {
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', `const m = await import(${JSON.stringify(path.join(ROOT, 'server/capabilities.mjs'))}); console.log(JSON.stringify(m.currentCapabilities().push));`], {
    env: { PATH: process.env.PATH, ...env },
    encoding: 'utf8',
    timeout: 30_000,
  });
  assert.equal(r.status, 0, r.stderr);
  const lines = r.stdout.trim().split('\n');
  return { push: JSON.parse(lines.at(-1)), output: `${r.stdout}${r.stderr}` };
}

test('push.apns and push.fcm follow the APNs and FCM settings, and a broken one stays off without quoting it', () => {
  const p8 = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey.export({ type: 'pkcs8', format: 'pem' });
  const apns = { APNS_KEY_ID: 'ABCDE12345', APNS_TEAM_ID: 'TEAM123456', APNS_KEY_P8: p8 };
  const fcm = { FCM_PROJECT_ID: 'caddie-test-project' };
  const vapid = { VAPID_PUBLIC_KEY: 'p', VAPID_PRIVATE_KEY: 's', VAPID_SUBJECT: 'mailto:x@example.org' };

  const none = pushFlags({});
  assert.deepEqual(none.push, { apns: false, fcm: false, webpush: false }, 'no new secrets: what the live server answers today');
  assert.doesNotMatch(none.output, /push is off/, 'nothing set is not a problem');
  assert.deepEqual(pushFlags(vapid).push, { apns: false, fcm: false, webpush: true });
  assert.deepEqual(pushFlags(apns).push, { apns: true, fcm: false, webpush: false });
  assert.deepEqual(pushFlags(fcm).push, { apns: false, fcm: true, webpush: false });
  assert.deepEqual(pushFlags({ ...apns, ...fcm, ...vapid }).push, { apns: true, fcm: true, webpush: true });

  const broken = pushFlags({ ...apns, APNS_KEY_P8: p8.slice(0, 100), FCM_PROJECT_ID: 'Not A Project' });
  assert.deepEqual(broken.push, { apns: false, fcm: false, webpush: false });
  assert.match(broken.output, /APNs push is off: APNS_KEY_P8 is not the text of a \.p8 key/);
  assert.match(broken.output, /FCM push is off: FCM_PROJECT_ID is not a project id/);
  assert.doesNotMatch(broken.output, /Not A Project/, 'the value is never quoted');
  for (const secret of [p8]) {
    for (const line of secret.split('\n').filter((l) => l.length > 20 && !l.startsWith('-----'))) {
      assert.ok(!broken.output.includes(line.slice(0, 20)), 'the output never quotes a key');
    }
  }
});

test('the server refuses to start when the current key id is not in the keyring, or the keyring is unusable', () => {
  for (const text of [keyringText('m2'), `{"current":"m1","keys":{"m1":"${FAKE_MASTER}"`, keyringText('m1', { m1: FAKE_MASTER.slice(0, 30) })]) {
    const r = start({ BLE_MASTER_KEYRING: text });
    assert.notEqual(r.status, 0, 'the process exits with an error');
    assert.match(r.stderr, /BLE_MASTER_KEYRING is unusable/);
    assert.doesNotMatch(`${r.stdout}${r.stderr}`, /Listening on port/);
    assert.ok(!`${r.stdout}${r.stderr}`.includes(FAKE_MASTER.slice(0, 12)), 'the output never quotes the keyring');
  }
  const bad = start({ TALKS_BUNDLE_BASE: 'http://example.org/bundles/' });
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /TALKS_BUNDLE_BASE/);
});
