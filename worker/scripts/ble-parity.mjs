#!/usr/bin/env node
// Parity of the Worker's Bluetooth derived tokens v1 (src/lib/ble.js) with the contract fixtures:
//   contracts/fixtures/ble/golden-vectors.v1.json   key derivation, key ids and tokens
//   contracts/fixtures/ble/resolution-cases.v1.json  steps 1 to 4 of sightings resolution
// It runs the Worker's own code paths: parseKeyring and bleConfig, keyOfSession (the key a stored
// session derives), tableFor (the token table) and resolveTokens (what the sightings route runs).
// Fixture values are fake. Prints one PASS or FAIL line per check and exits 1 on any failure.
//
// Usage: node worker/scripts/ble-parity.mjs

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { bleConfig, keyOfSession, keyId, tableFor, resolveTokens, derivedSession } from '../src/lib/ble.js';
import { deriveToken, encodeToken, encodeKey } from '../../contracts/js/ble-token.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const golden = JSON.parse(readFileSync(`${root}contracts/fixtures/ble/golden-vectors.v1.json`, 'utf8'));
const cases = JSON.parse(readFileSync(`${root}contracts/fixtures/ble/resolution-cases.v1.json`, 'utf8'));

let failed = 0;
let passed = 0;
function check(name, ok, detail = '') {
  if (ok) passed += 1;
  else failed += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${!ok && detail ? ` -- ${detail}` : ''}`);
}

// A keyring as BLE_MASTER_KEYRING holds it: { current, keys: id -> base64url secret }.
const keyringText = (masters, current) => JSON.stringify({ current, keys: Object.fromEntries(Object.entries(masters).map(([id, hex]) => [id, Buffer.from(hex, 'hex').toString('base64url')])) });

// 1. Key derivation, key ids and tokens, through a stored session's key (keyOfSession).
{
  const m = golden.key_derivation.master_secret;
  const config = bleConfig({ BLE_MASTER_KEYRING: keyringText({ [m.id]: m.hex }, m.id) });
  check('golden keyring parses and gives derived-v1', config.mode === 'derived-v1');
  for (const c of golden.key_derivation.cases) {
    const person = { profile_id: c.profile_id, presence: { presence_nonce: c.presence_nonce_base64url, ble_master_id: m.id } };
    const key = keyOfSession(config, derivedSession(person));
    check(`ble_key of ${c.profile_id}`, key && encodeKey(key) === c.ble_key_base64url);
    check(`ble_key_id of ${c.profile_id}`, key && keyId(key) === c.ble_key_id);
    for (const t of c.tokens) check(`token of ${c.profile_id} at w=${t.w}`, key && encodeToken(deriveToken(key, BigInt(t.w))) === t.token_base64url);
  }
}

// 2. Resolution steps 1 to 4 (resolveTokens) over every case.
const ms = (iso) => Date.parse(iso);
for (const c of cases.cases) {
  const masters = { ...cases.masters };
  for (const id of c.retired_masters ?? []) delete masters[id];
  const config = {
    ...bleConfig({ BLE_MASTER_KEYRING: keyringText(masters, Object.keys(masters)[0]), BLE_NEAR_RSSI: String(cases.near_rssi) }),
    colocationRequired: c.colocation_required !== false,
  };
  const nowMs = Number(c.server_unix_seconds) * 1000;
  const toSession = (p) => derivedSession({ profile_id: p.profile_id, presence: { presence_nonce: p.presence_nonce, ble_master_id: p.ble_master_id } });
  const tablePeople = c.table_people ?? cases.people;
  const holder = {};
  const table = tableFor(holder, config, () => tablePeople.map(toSession).filter(Boolean), nowMs);
  const overrides = new Map((c.current_overrides ?? []).map((o) => [o.profile_id, o]));
  const current = new Map();
  for (const p0 of cases.people) {
    const p = { ...p0, ...(overrides.get(p0.profile_id) ?? {}) };
    current.set(p.profile_id, { session: toSession(p), ble_token: null, ble_token_until_ms: null, presence_until_ms: ms(p.presence_until), zone: p.zone ?? null, cell: p.cell ?? null });
  }
  const heard = new Map();
  for (const s of c.sightings) if (!heard.has(s.token) || s.rssi > heard.get(s.token)) heard.set(s.token, s.rssi);
  const got = resolveTokens(config, { heard, table, current, requester: cases.requester, nowMs }).map((h) => ({ profile_id: h.id, rssi: h.rssi }));
  check(`resolution: ${c.name}`, JSON.stringify(got) === JSON.stringify(c.expected), `got ${JSON.stringify(got)}, expected ${JSON.stringify(c.expected)}`);
}

console.log(`\n${passed} PASS, ${failed} FAIL`);
process.exitCode = failed ? 1 : 0;
