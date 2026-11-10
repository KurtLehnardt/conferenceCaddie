// Capabilities v1 (docs/contracts/capabilities.md): negotiation, the effective feature set a
// client acts on, legacy detection, discovery against a stand-in fetch, and backend URL rules.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  LEGACY, negotiate, effectiveCapabilities, discoverCapabilities, normaliseBackendUrl, parseConnectLink,
} from '../contracts/js/capabilities.mjs';
import { validator } from '../contracts/js/schemas.mjs';

const FIX = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../contracts/fixtures/capabilities');
const fixture = (f) => JSON.parse(readFileSync(path.join(FIX, f), 'utf8'));

test('negotiation: v1 documents, a compatible v2 and a v2 that needs a newer app', () => {
  assert.deepEqual(negotiate(fixture('tier1-demo.json')), { ok: true, version: 1 });
  assert.deepEqual(negotiate(fixture('forward-compatible-v2.json')), { ok: true, version: 1 });
  assert.deepEqual(negotiate(fixture('too-new-v2.json')), { ok: false, reason: 'update_app' });
  assert.deepEqual(negotiate({}), { ok: false, reason: 'invalid' });
  assert.deepEqual(negotiate({ api_version: '1' }), { ok: false, reason: 'invalid' });
  assert.deepEqual(negotiate({ api_version: 3, min_api_version: 2 }, [1, 2]), { ok: true, version: 2 });
  // A min_api_version above api_version is nonsense; it is read as api_version.
  assert.deepEqual(negotiate({ api_version: 1, min_api_version: 5 }), { ok: true, version: 1 });
});

test('a complete v1 document is its own effective feature set', () => {
  for (const f of ['tier2-free.json', 'tier3-paid.json', 'tier3-transition.json']) {
    assert.deepEqual(effectiveCapabilities(fixture(f)), fixture(f), f);
  }
});

test('tier 1 has talk bundles and no people features', () => {
  const e = effectiveCapabilities(fixture('tier1-demo.json'));
  assert.equal(e.talks.bundle_base, 'https://kurtlehnardt.github.io/conferenceCaddie/bundles/');
  assert.equal(e.people.enabled, false);
  assert.equal(e.people.presence, false);
  assert.equal(e.people.semantic, 'off');
  assert.equal(e.ble.mode, 'none');
  assert.deepEqual(e.imports, { github: 'device', schedule: 'device' });
  assert.equal(validator('capabilities.v1')(e, { closed: true }).valid, true);
});

test('the legacy feature set is the full current server, and matches its fixture', () => {
  assert.deepEqual(structuredClone(LEGACY), fixture('legacy-effective.json'));
  assert.deepEqual(effectiveCapabilities(LEGACY), fixture('legacy-effective.json'));
  assert.equal(LEGACY.ble.mode, 'server-rotate');
  assert.equal(LEGACY.talks.bundle_base, null);
  assert.equal(LEGACY.talks.server_search, true);
});

test('unknown fields are ignored and unknown enum values fall back conservatively', () => {
  const e = effectiveCapabilities(fixture('forward-compatible-v2.json'));
  assert.equal(e.api_version, 1);
  assert.equal('operator' in e, false);
  assert.equal('chat' in e.people, false);
  assert.equal(e.people.enabled, true);
  assert.equal(e.people.semantic, 'off');
  assert.equal(e.people.live, 'poll');
  assert.equal(e.ble.mode, 'none');
  assert.equal(e.push.fcm, true);
  assert.equal('unifiedpush' in e.push, false);
  assert.equal(validator('capabilities.v1')(e, { closed: true }).valid, true);
});

test('missing fields are off; dependent features turn off with what they need', () => {
  const e = effectiveCapabilities({ api_version: 1 });
  assert.deepEqual(e.talks, { bundle_base: null, server_search: false });
  assert.equal(e.people.enabled, false);
  assert.equal(e.ble.mode, 'none');
  assert.deepEqual(e.push, { apns: false, fcm: false, webpush: false });
  assert.deepEqual(e.imports, { github: 'device', schedule: 'device' });

  const noReports = effectiveCapabilities({ ...fixture('tier2-free.json'), people: { ...fixture('tier2-free.json').people, reports: false } });
  assert.equal(noReports.people.enabled, false, 'no people features without reports');
  assert.equal(noReports.ble.mode, 'none');

  const noPresence = effectiveCapabilities({ ...fixture('tier2-free.json'), people: { ...fixture('tier2-free.json').people, presence: false } });
  assert.equal(noPresence.ble.mode, 'none', 'no Bluetooth without presence');
  assert.equal(noPresence.people.meets, false, 'asks are now-only, so they need presence');
  assert.equal(noPresence.people.circles, true);
});

test('derived-v1 always uses 600-second windows and at most half a window between reports', () => {
  const doc = fixture('tier2-free.json');
  const e = effectiveCapabilities({ ...doc, ble: { ...doc.ble, window_s: 60, sightings_min_interval_s: 900 } });
  assert.equal(e.ble.window_s, 600);
  assert.equal(e.ble.sightings_min_interval_s, 60);
  // near_rssi is clamped to [-100, -30]; a non-integer takes the default.
  assert.equal(effectiveCapabilities({ ...doc, ble: { ...doc.ble, near_rssi: -200 } }).ble.near_rssi, -100);
  assert.equal(effectiveCapabilities({ ...doc, ble: { ...doc.ble, near_rssi: -10 } }).ble.near_rssi, -30);
  assert.equal(effectiveCapabilities({ ...doc, ble: { ...doc.ble, near_rssi: 'loud' } }).ble.near_rssi, -75);
  // The co-location rule is on unless the backend says false.
  const { colocation_required: _omit, ...withoutRule } = doc.ble;
  assert.equal(effectiveCapabilities({ ...doc, ble: withoutRule }).ble.colocation_required, true);
  assert.equal(effectiveCapabilities({ ...doc, ble: { ...doc.ble, colocation_required: 'no' } }).ble.colocation_required, true);
  assert.equal(effectiveCapabilities({ ...doc, ble: { ...doc.ble, colocation_required: false } }).ble.colocation_required, false);
  assert.equal(validator('capabilities.v1')({ ...doc, ble: { ...doc.ble, near_rssi: -110 } }).valid, false);
  assert.equal(validator('capabilities.v1')({ ...doc, ble: withoutRule }, { closed: true }).valid, false, 'a derived-v1 producer states the rule');
});

test('an http or malformed bundle_base is not used', () => {
  const doc = fixture('tier1-demo.json');
  for (const bad of ['http://owner.github.io/x/', 'https://owner.github.io/x', 'https://owner.github.io/x/?a=1', 'https://user:pw@owner.github.io/x/', 'https://user@owner.github.io/x/', 'not a url', 42]) {
    assert.equal(effectiveCapabilities({ ...doc, talks: { bundle_base: bad } }).talks.bundle_base, null, String(bad));
  }
});

// A stand-in for the network: a map from URL to { status, json } or an Error to throw.
function fakeFetch(routes) {
  const calls = [];
  const fn = async (url) => {
    calls.push(url);
    const r = routes[url];
    if (r instanceof Error) throw r;
    return r ?? { status: 404, json: undefined };
  };
  fn.calls = calls;
  return fn;
}

test('discovery: a tier 2 or 3 backend answers /api/capabilities', async () => {
  const f = fakeFetch({ 'https://caddie.example/api/capabilities': { status: 200, json: fixture('tier3-paid.json') } });
  const r = await discoverCapabilities('https://caddie.example', f);
  assert.equal(r.source, 'api');
  assert.deepEqual(r.effective, fixture('tier3-paid.json'));
  assert.deepEqual(f.calls, ['https://caddie.example/api/capabilities']);
});

test('discovery: a tier 1 static site answers capabilities.json under its path', async () => {
  const base = 'https://kurtlehnardt.github.io/conferenceCaddie';
  const f = fakeFetch({ [`${base}/capabilities.json`]: { status: 200, json: fixture('tier1-demo.json') } });
  const r = await discoverCapabilities(base, f);
  assert.equal(r.source, 'static');
  assert.equal(r.effective.people.enabled, false);
  assert.deepEqual(f.calls, [`${base}/api/capabilities`, `${base}/capabilities.json`]);
});

const LEGACY_SITE = {
  'https://legacy.example/api/capabilities': { status: 404, json: { error: 'Not found' } },
  'https://legacy.example/capabilities.json': { status: 200, json: undefined },
  'https://legacy.example/api/health': { status: 200, json: { ok: true } },
};

test('discovery: the server 404 body plus its exact /api/health answer is the legacy server', async () => {
  const r = await discoverCapabilities('https://legacy.example', fakeFetch(LEGACY_SITE));
  assert.equal(r.source, 'legacy');
  assert.deepEqual(r.effective, fixture('legacy-effective.json'));
});

test('discovery: the legacy probe is strict and never applies to a backend that once had a document', async () => {
  // A backend that has served a document before is not downgraded, whatever it answers now.
  assert.deepEqual(await discoverCapabilities('https://legacy.example', fakeFetch(LEGACY_SITE), { hadDocument: true }), { source: 'none', reason: 'unreachable' });
  // A 404 with another body, or a health answer with other keys, is some other server.
  const otherNotFound = fakeFetch({ ...LEGACY_SITE, 'https://legacy.example/api/capabilities': { status: 404, json: { message: 'Not Found' } } });
  assert.equal((await discoverCapabilities('https://legacy.example', otherNotFound)).source, 'none');
  const otherHealth = fakeFetch({ ...LEGACY_SITE, 'https://legacy.example/api/health': { status: 200, json: { ok: true, version: '9' } } });
  assert.equal((await discoverCapabilities('https://legacy.example', otherHealth)).source, 'none');
  const htmlNotFound = fakeFetch({ ...LEGACY_SITE, 'https://legacy.example/api/capabilities': { status: 404, json: undefined } });
  assert.equal((await discoverCapabilities('https://legacy.example', htmlNotFound)).source, 'none');
});

test('the legacy probe matches what server/index.mjs answers', () => {
  const src = readFileSync(path.join(FIX, '../../../server/index.mjs'), 'utf8');
  assert.match(src, /sendJson\(res, 200, \{ ok: true \}\);/);
  assert.match(src, /sendJson\(res, 404, \{ error: 'Not found' \}\);/);
});

test('discovery: failures never look like legacy', async () => {
  // The capabilities route failing with 5xx, or the network failing, is not "no document".
  const down = fakeFetch({
    'https://caddie.example/api/capabilities': { status: 503, json: { error: 'down' } },
    'https://caddie.example/api/health': { status: 200, json: { ok: true } },
  });
  assert.deepEqual(await discoverCapabilities('https://caddie.example', down), { source: 'none', reason: 'unreachable' });
  const offline = fakeFetch({ 'https://caddie.example/api/capabilities': new TypeError('fetch failed'), 'https://caddie.example/capabilities.json': new TypeError('fetch failed') });
  assert.deepEqual(await discoverCapabilities('https://caddie.example', offline), { source: 'none', reason: 'unreachable' });
  // A 404 without a healthy Caddie health check is some other site.
  const other = fakeFetch({ 'https://other.example/api/health': { status: 200, json: { status: 'ok' } } });
  assert.deepEqual(await discoverCapabilities('https://other.example', other), { source: 'none', reason: 'unreachable' });
});

test('discovery: a document only a newer app can read asks for an update', async () => {
  const f = fakeFetch({ 'https://next.example/api/capabilities': { status: 200, json: fixture('too-new-v2.json') } });
  assert.deepEqual(await discoverCapabilities('https://next.example', f), { source: 'none', reason: 'update_app' });
});

test('backend URLs: https only, no credentials, query or fragment; the path is kept', () => {
  assert.deepEqual(normaliseBackendUrl('https://kurtlehnardt.github.io/conferenceCaddie/'), { ok: true, base: 'https://kurtlehnardt.github.io/conferenceCaddie', origin: 'https://kurtlehnardt.github.io' });
  assert.deepEqual(normaliseBackendUrl(' https://Caddie.Example '), { ok: true, base: 'https://caddie.example', origin: 'https://caddie.example' });
  assert.equal(normaliseBackendUrl('http://caddie.example').reason, 'https_required');
  assert.equal(normaliseBackendUrl('https://user:pw@caddie.example').reason, 'credentials_not_allowed');
  assert.equal(normaliseBackendUrl('https://caddie.example/?x=1').reason, 'query_not_allowed');
  assert.equal(normaliseBackendUrl('ftp://caddie.example').reason, 'https_required');
  assert.equal(normaliseBackendUrl('http://localhost:8081').reason, 'https_required');
  assert.equal(normaliseBackendUrl('http://localhost:8081', { allowLocalHttp: true }).ok, true);
  assert.equal(normaliseBackendUrl('http://10.0.2.2:8081', { allowLocalHttp: true }).ok, true);
  assert.equal(normaliseBackendUrl('http://caddie.example', { allowLocalHttp: true }).reason, 'https_required');
});

test('connect deep links and QR codes need https and a confirmation that names the origin', () => {
  const ok = parseConnectLink(`caddie://connect?url=${encodeURIComponent('https://caddie.example/')}`);
  assert.deepEqual(ok, { ok: true, base: 'https://caddie.example', origin: 'https://caddie.example', requiresConfirmation: true, prompt: 'Switch to the server at https://caddie.example?' });
  // Two tier 1 sites can share an origin, so the prompt and the stored state name the whole base.
  const pages = parseConnectLink(`caddie://connect?url=${encodeURIComponent('https://kurtlehnardt.github.io/conferenceCaddie/')}`);
  assert.equal(pages.base, 'https://kurtlehnardt.github.io/conferenceCaddie');
  assert.equal(pages.prompt, 'Switch to the server at https://kurtlehnardt.github.io/conferenceCaddie?');
  assert.equal(parseConnectLink(`caddie://connect?url=${encodeURIComponent('http://caddie.example')}`).reason, 'https_required');
  assert.equal(parseConnectLink(`caddie://connect?url=${encodeURIComponent('http://localhost:8081')}`).reason, 'https_required');
  assert.equal(parseConnectLink('caddie://connect').reason, 'missing_url');
  assert.equal(parseConnectLink('https://caddie.example/connect?url=https://x.example').reason, 'not_a_connect_link');
  assert.equal(parseConnectLink('caddie://other?url=https://x.example').reason, 'not_a_connect_link');
});
