// Bluetooth derived tokens v1 (docs/contracts/ble-tokens.md): the golden vectors, checked three
// independent ways.
//
// 1. contracts/js/ble-token.mjs (node:crypto) must reproduce every vector.
// 2. A SHA-256 and HMAC written here from FIPS 180-4 and RFC 2104, sharing no code with node:crypto
//    and checked first against the FIPS and RFC 4231 test values, must reproduce every vector.
// 3. The values the fixture records were produced by
//      openssl dgst -sha256 -mac HMAC -macopt hexkey:<key hex> <message file>
//    when the vectors were made (2026-11-10, LibreSSL 3.3.6). OPENSSL_RECORDED below copies a few of
//    those outputs verbatim, and when an openssl binary is on PATH the test runs it again over every
//    vector; without one that part is skipped.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as B from '../contracts/js/ble-token.mjs';
import { validator } from '../contracts/js/schemas.mjs';

const FIX = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../contracts/fixtures/ble');
const golden = JSON.parse(readFileSync(path.join(FIX, 'golden-vectors.v1.json'), 'utf8'));
const cases = JSON.parse(readFileSync(path.join(FIX, 'resolution-cases.v1.json'), 'utf8'));
const hex = (s) => Buffer.from(s, 'hex');
const keyOf = (name) => hex(golden.keys[name].hex);

// Outputs of the openssl command above, copied from its output when the vectors were made.
const OPENSSL_RECORDED = {
  'key-a w=0': '857f1a1bc6c00c5e828d34381afd4fd515c14ac05c98db9d38dd446fb8e30331',
  'key-a w=1': '927d621cbe27899b9c3245f30ce6ffe6039bb5a0addf7266b8b2658dab066b1f',
  'key-a w=2990520': '3a4110ed2dbfdaaa28b1951eca84da1963b43518335fa82e45df47f21406e2d7',
  'key-a w=4294967295': 'a6d23aa4824854af0f66bbded156632abd1d80fe7792a27c2e1206d33a5c6f5c',
  'ble_key AAECAwQFBgcICQoLDA0ODw': '05a7bd314db4520b2430496a9b12eff40c87396ebde1a3006edb751ceaf58a7a',
};
const OPENSSL_RECORDED_KEY_ID = { AAECAwQFBgcICQoLDA0ODw: 'Eb2uBz7W6S8' };

// ---------------------------------------------------------------------------------------------
// An independent SHA-256 (FIPS 180-4) and HMAC (RFC 2104), on Uint8Arrays.

const K256 = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function sha256(msg) {
  const m = Uint8Array.from(msg);
  const bitLen = m.length * 8;
  const padded = new Uint8Array(Math.ceil((m.length + 9) / 64) * 64);
  padded.set(m);
  padded[m.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor(bitLen / 2 ** 32));
  view.setUint32(padded.length - 4, bitLen >>> 0);
  const h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const w = new Uint32Array(64);
  const rotr = (x, n) => (x >>> n) | (x << (32 - n));
  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(off + i * 4);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, hh] = h;
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + S1 + ch + K256[i] + w[i]) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) >>> 0;
      hh = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    h[0] += a; h[1] += b; h[2] += c; h[3] += d; h[4] += e; h[5] += f; h[6] += g; h[7] += hh;
  }
  const out = new Uint8Array(32);
  const ov = new DataView(out.buffer);
  for (let i = 0; i < 8; i++) ov.setUint32(i * 4, h[i]);
  return out;
}

function hmacSha256(key, msg) {
  let k = Uint8Array.from(key);
  if (k.length > 64) k = sha256(k);
  const block = new Uint8Array(64);
  block.set(k);
  const ipad = block.map((x) => x ^ 0x36);
  const opad = block.map((x) => x ^ 0x5c);
  const inner = sha256(Uint8Array.from([...ipad, ...msg]));
  return sha256(Uint8Array.from([...opad, ...inner]));
}

const toHex = (u8) => Buffer.from(u8).toString('hex');
const ascii = (s) => Uint8Array.from(Buffer.from(s, 'ascii'));

// The messages, built here byte by byte from the spec rather than with ble-token.mjs.
function tokenMessage(w) {
  const out = new Uint8Array(13 + 8);
  out.set(ascii('caddie-ble-v1'));
  let x = BigInt(w);
  for (let i = 20; i >= 13; i--) {
    out[i] = Number(x & 0xffn);
    x >>= 8n;
  }
  return out;
}
function keyMessage(profileId, nonce) {
  const id = Uint8Array.from(Buffer.from(profileId, 'utf8'));
  return Uint8Array.from([...ascii('caddie-ble-key-v1'), id.length >> 8, id.length & 0xff, ...id, ...nonce]);
}

// ---------------------------------------------------------------------------------------------

test('the independent SHA-256 and HMAC pass their published test values', () => {
  assert.equal(toHex(sha256(ascii('abc'))), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(toHex(sha256(new Uint8Array())), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  assert.equal(toHex(sha256(ascii('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq'))), '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1');
  // RFC 4231 test cases 1 and 2.
  assert.equal(toHex(hmacSha256(new Uint8Array(20).fill(0x0b), ascii('Hi There'))), 'b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7');
  assert.equal(toHex(hmacSha256(ascii('Jefe'), ascii('what do ya want for nothing?'))), '5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843');
});

test('the fixture is the protocol: constants and windows', () => {
  const c = golden.constants;
  assert.equal(c.token_label, B.LABEL);
  assert.equal(c.key_label, B.KEY_LABEL);
  assert.equal(c.window_s, B.WINDOW_S);
  assert.deepEqual(c.accept_offsets, B.ACCEPT_OFFSETS);
  assert.equal(c.service_uuid, B.SERVICE_UUID);
  assert.equal(c.token_characteristic_uuid, B.TOKEN_CHARACTERISTIC_UUID);
  assert.notEqual(c.token_characteristic_uuid, c.service_uuid);
  for (const w of golden.windows) assert.equal(String(B.windowOf(BigInt(w.unix_seconds))), w.w, w.note);
  assert.equal(String(B.windowOf(Math.floor(Date.parse('2026-11-10T12:00:00Z') / 1000))), '2990520');
  assert.throws(() => B.windowOf(-1), RangeError);
  assert.throws(() => B.message(2n ** 64n), RangeError);
  assert.throws(() => B.message(-1n), RangeError);
});

test('token vectors: reference implementation', () => {
  for (const v of golden.tokens) {
    const key = keyOf(v.key);
    const w = BigInt(v.w);
    assert.equal(B.message(w).toString('hex'), v.message_hex, `${v.key} w=${v.w} message`);
    assert.equal(B.hmac(key, w).toString('hex'), v.hmac_sha256_hex, `${v.key} w=${v.w} hmac`);
    assert.equal(B.deriveToken(key, w).toString('hex'), v.token_hex);
    assert.equal(v.token_hex, v.hmac_sha256_hex.slice(0, 32), 'the token is the first 16 bytes');
    assert.equal(B.encodeToken(B.deriveToken(key, w)), v.token_base64url);
    assert.equal(B.encodePayload(B.deriveToken(key, w)).toString('hex'), v.payload_hex);
    assert.deepEqual(B.decodeToken(v.token_base64url), hex(v.token_hex));
  }
});

test('token vectors: independent SHA-256/HMAC over bytes built from the spec', () => {
  for (const v of golden.tokens) {
    const msg = tokenMessage(v.w);
    assert.equal(toHex(msg), v.message_hex, `${v.key} w=${v.w}`);
    assert.equal(toHex(hmacSha256(keyOf(v.key), msg)), v.hmac_sha256_hex, `${v.key} w=${v.w}`);
  }
});

test('key derivation vectors: reference and independent implementations', () => {
  const master = hex(golden.key_derivation.master_secret.hex);
  for (const c of golden.key_derivation.cases) {
    const nonce = hex(c.presence_nonce_hex);
    assert.equal(Buffer.from(c.presence_nonce_base64url, 'base64url').toString('hex'), c.presence_nonce_hex);
    assert.equal(B.keyMessage(c.profile_id, nonce).toString('hex'), c.key_message_hex);
    assert.equal(toHex(keyMessage(c.profile_id, nonce)), c.key_message_hex);
    const key = B.deriveBleKey(master, c.profile_id, nonce);
    assert.equal(key.toString('hex'), c.ble_key_hex);
    assert.equal(toHex(hmacSha256(master, keyMessage(c.profile_id, nonce))), c.ble_key_hex);
    assert.equal(B.encodeKey(key), c.ble_key_base64url);
    assert.deepEqual(B.decodeKey(c.ble_key_base64url), key);
    assert.equal(B.keyId(key), c.ble_key_id);
    assert.equal(toHex(hmacSha256(key, ascii('caddie-ble-key-id-v1'))), c.key_id_hmac_sha256_hex);
    assert.equal(Buffer.from(c.key_id_hmac_sha256_hex.slice(0, 16), 'hex').toString('base64url'), c.ble_key_id, 'the key id is the first 8 bytes');
    for (const t of c.tokens) {
      assert.equal(B.hmac(key, BigInt(t.w)).toString('hex'), t.hmac_sha256_hex);
      assert.equal(toHex(hmacSha256(key, tokenMessage(t.w))), t.hmac_sha256_hex);
      assert.equal(B.encodeToken(B.deriveToken(key, BigInt(t.w))), t.token_base64url);
      assert.equal(t.token_hex, t.hmac_sha256_hex.slice(0, 32));
    }
  }
});

test('recorded openssl outputs match the fixture', () => {
  const byName = Object.fromEntries(golden.tokens.map((v) => [`${v.key} w=${v.w}`, v.hmac_sha256_hex]));
  for (const c of golden.key_derivation.cases) byName[`ble_key ${c.profile_id}`] = c.ble_key_hex;
  for (const [name, value] of Object.entries(OPENSSL_RECORDED)) assert.equal(byName[name], value, name);
  for (const [pid, id] of Object.entries(OPENSSL_RECORDED_KEY_ID)) assert.equal(golden.key_derivation.cases.find((c) => c.profile_id === pid).ble_key_id, id);
});

function opensslAvailable() {
  try {
    execFileSync('openssl', ['version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

test('openssl, when installed, reproduces every HMAC in the fixture', { skip: !opensslAvailable() && 'no openssl on PATH' }, () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'caddie-ble-'));
  try {
    const file = path.join(dir, 'msg.bin');
    const run = (keyHex, msgHex) => {
      writeFileSync(file, hex(msgHex));
      const out = execFileSync('openssl', ['dgst', '-sha256', '-mac', 'HMAC', '-macopt', `hexkey:${keyHex}`, file]).toString().trim();
      return out.slice(out.lastIndexOf(' ') + 1);
    };
    for (const v of golden.tokens) assert.equal(run(golden.keys[v.key].hex, v.message_hex), v.hmac_sha256_hex, `${v.key} w=${v.w}`);
    for (const c of golden.key_derivation.cases) {
      assert.equal(run(golden.key_derivation.master_secret.hex, c.key_message_hex), c.ble_key_hex, c.profile_id);
      assert.equal(run(c.ble_key_hex, Buffer.from('caddie-ble-key-id-v1', 'ascii').toString('hex')), c.key_id_hmac_sha256_hex);
      for (const t of c.tokens) assert.equal(run(c.ble_key_hex, B.message(BigInt(t.w)).toString('hex')), t.hmac_sha256_hex);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the length prefix keeps profile_id and nonce apart', () => {
  const master = hex(golden.key_derivation.master_secret.hex);
  const nonce = Buffer.alloc(16, 0x41);
  // Without the prefix, "ab" + nonce and "abA" + (nonce shifted) would be the same bytes.
  const shifted = Buffer.concat([nonce.subarray(1), Buffer.from([0x41])]);
  assert.notEqual(B.deriveBleKey(master, 'ab', nonce).toString('hex'), B.deriveBleKey(master, 'abA', shifted).toString('hex'));
  assert.throws(() => B.keyMessage('ab', Buffer.alloc(15)), TypeError);
  assert.throws(() => B.keyMessage('', nonce), TypeError);
  assert.throws(() => B.deriveBleKey(Buffer.alloc(31), 'ab', nonce), RangeError);
  assert.equal(B.keyMessage('é', nonce).subarray(17, 19).readUInt16BE(0), 2, 'the length counts UTF-8 bytes');
});

test('payloads: v1 is 0x01 + token; a bare 16-byte token is the legacy format; anything else is ignored', () => {
  const token = hex(golden.tokens[0].token_hex);
  const payload = B.encodePayload(token);
  assert.equal(payload.length, 17);
  assert.deepEqual(B.decodePayload(payload), { format: 'derived-v1', token });
  assert.deepEqual(B.decodePayload(token), { format: 'server-rotate', token });
  assert.equal(B.decodePayload(Buffer.concat([Buffer.from([0x02]), token])), null);
  assert.equal(B.decodePayload(Buffer.alloc(18)), null);
  assert.equal(B.decodePayload(Buffer.alloc(0)), null);
});

test('keys and tokens decode only from canonical base64url', () => {
  assert.throws(() => B.decodeKey('A'.repeat(42)), TypeError);
  assert.throws(() => B.decodeKey(`${'A'.repeat(42)}B`), TypeError, 'non-zero spare bits');
  assert.throws(() => B.decodeToken(`${'A'.repeat(21)}B`), TypeError, 'non-zero spare bits');
  assert.throws(() => B.decodeToken('A'.repeat(22).replace('A', '+')), TypeError);
});

test('every derived token fits the unchanged sightings request', () => {
  const check = validator('people-api.v1', 'SightingsRequest');
  const sightings = golden.tokens.map((v) => ({ token: v.token_base64url, rssi: -60 }));
  for (let i = 0; i < sightings.length; i += 50) {
    const r = check({ event: 'caddie-fixture-2099', sightings: sightings.slice(i, i + 50) });
    assert.equal(r.valid, true, JSON.stringify(r.errors));
  }
});

// Runs one case of resolution-cases.v1.json the way the spec describes.
function runCase(c) {
  const masters = Object.fromEntries(Object.entries(cases.masters).filter(([id]) => !(c.retired_masters ?? []).includes(id)));
  const table = B.tokenTable(masters, c.table_people ?? cases.people, Number(c.server_unix_seconds), cases.window_s);
  const current = new Map(cases.people.map((p) => {
    const q = { ...p, ...((c.current_overrides ?? []).find((o) => o.profile_id === p.profile_id) ?? {}) };
    return [p.profile_id, { nonce_tag: B.nonceTag(Buffer.from(q.presence_nonce, 'base64url')), presence_until: Date.parse(q.presence_until), zone: q.zone, cell: q.cell }];
  }));
  return B.resolveSightings(c.sightings, table, {
    nearRssi: cases.near_rssi, requester: cases.requester, current, nowMs: Number(c.server_unix_seconds) * 1000, colocationRequired: c.colocation_required ?? true,
  }).map((r) => ({ profile_id: r.id, rssi: r.rssi }));
}

test('resolution cases: windows, the stored session, co-location and retired masters', () => {
  for (const c of cases.cases) assert.deepEqual(runCase(c), c.expected, c.name);
  // The first two people are the key-derivation vectors.
  for (const [i, d] of golden.key_derivation.cases.entries()) {
    assert.equal(cases.people[i].profile_id, d.profile_id);
    assert.equal(B.encodeKey(B.sessionKey(cases.masters, cases.people[i])), d.ble_key_base64url);
  }
});

test('the token table holds three tokens per session, a nonce tag and no key material', () => {
  const table = B.tokenTable(cases.masters, cases.people, 1794312300);
  assert.equal(table.size, cases.people.length * 3);
  const keys = new Set(golden.key_derivation.cases.map((c) => c.ble_key_base64url));
  for (const [token, entry] of table) {
    assert.match(token, /^[A-Za-z0-9_-]{22}$/);
    assert.deepEqual(Object.keys(entry).sort(), ['nonce_tag', 'profile_id']);
    assert.match(entry.nonce_tag, /^[0-9a-f]{16}$/);
    assert.ok(!keys.has(token));
  }
  // At window 0 there is no w - 1, and at w = 2^64 - 1 there is no w + 1.
  assert.equal(B.resolverAt([{ id: 'x', key: keyOf('key-a') }], 0).size, 2);
  const lastWindowStart = (2n ** 64n - 1n) * 600n;
  assert.equal(B.resolverAt([{ id: 'x', key: keyOf('key-a') }], lastWindowStart).size, 2);
  assert.equal(B.windowOf(1794312000.9), 2990520n, 'fractional seconds are floored');
  assert.equal(B.windowOf(599.999), 0n);
});

test('the caps apply to the final answer: 10 new people per window, 30 per rolling hour', () => {
  const ids = Array.from({ length: 40 }, (_, i) => `p${String(i).padStart(2, '0')}`);
  const answer = (list) => list.map((id) => ({ ref: id }));
  const t0 = 2990520 * 600 * 1000; // the start of a window, in ms
  const win = (k) => t0 + k * 600_000 + 1000; // one second into window k
  let state = { entries: [] };
  let r = B.applyCaps(answer(ids.slice(0, 15)), state, { nowMs: win(0) });
  assert.deepEqual(r.kept.map((x) => x.ref), ids.slice(0, 10), 'at most 10 new people in a window, in answer order');
  state = r.state;
  // Someone already returned in this window passes; nobody new does.
  r = B.applyCaps(answer(['p03', 'p20']), state, { nowMs: win(0) + 5000 });
  assert.deepEqual(r.kept.map((x) => x.ref), ['p03']);
  state = r.state;
  for (const k of [1, 2]) {
    r = B.applyCaps(answer(ids.slice(k * 10, k * 10 + 15)), state, { nowMs: win(k) });
    assert.equal(r.kept.length, 10, `window ${k}`);
    state = r.state;
  }
  r = B.applyCaps(answer(ids.slice(30)), state, { nowMs: win(3) });
  assert.deepEqual(r.kept, [], 'the hour is full');
  r = B.applyCaps(answer(['p00']), state, { nowMs: win(3) });
  assert.deepEqual(r.kept.map((x) => x.ref), ['p00'], 'someone returned in the last hour still passes in a new window');
  // The hour rolls: an hour after window 0, its ten people no longer count, but windows 1 and 2
  // (20 people) and p00, returned again in window 3, still do: 9 places are free.
  r = B.applyCaps(answer(ids.slice(30)), r.state, { nowMs: win(0) + 3_600_000 + 1000 });
  assert.equal(r.kept.length, 9);
  assert.ok(r.state.entries.every((e) => e.at > win(0) + 1000), 'entries older than an hour are dropped');
});

test('resolution refuses to skip the co-location rule silently', () => {
  assert.throws(() => B.resolveSightings([], new Map()), /current/);
  assert.deepEqual(B.resolveSightings([], new Map(), { colocationRequired: false }), []);
});

test('co-location: the same zone, or the same or a neighbouring ~100 m cell', () => {
  const cell = { lat: 40.767, lon: -111.89 };
  const step = 0.001 / Math.cos((40.767 * Math.PI) / 180);
  assert.equal(B.colocated({ zone: 'Hall A', cell: null }, { zone: 'Hall A', cell: null }), true);
  assert.equal(B.colocated({ zone: 'Hall A', cell }, { zone: 'Expo hall', cell: { ...cell } }), true);
  assert.equal(B.colocated({ zone: 'Hall A', cell }, { zone: 'Expo hall', cell: { lat: 40.768, lon: -111.89 } }), true, 'north neighbour');
  assert.equal(B.colocated({ zone: 'Hall A', cell }, { zone: 'Expo hall', cell: { lat: 40.766, lon: Number((-111.89 + step).toFixed(6)) } }), true, 'diagonal neighbour');
  assert.equal(B.colocated({ zone: 'Hall A', cell }, { zone: 'Expo hall', cell: { lat: 40.769, lon: -111.89 } }), false, 'two cells north');
  assert.equal(B.colocated({ zone: 'Hall A', cell }, { zone: 'Expo hall', cell: { lat: 40.767, lon: Number((-111.89 + 2 * step).toFixed(6)) } }), false, 'two cells east');
  assert.equal(B.colocated({ zone: null, cell: null }, { zone: null, cell: null }), false);
  assert.equal(B.neighbouringCells({ lat: 0, lon: 179.9995 }, { lat: 0, lon: -179.9995 }), true, 'across the antimeridian');
});

test('fresh keys and nonces have the right sizes and differ', () => {
  const a = B.newPresenceNonce();
  const b = B.newPresenceNonce();
  assert.equal(a.length, 16);
  assert.notDeepEqual(a, b);
});
