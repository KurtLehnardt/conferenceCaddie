#!/usr/bin/env node
// Writes worker/.dev.vars (git-ignored) with development-only values for `wrangler dev`:
// a random ADMIN_TOKEN and REF_SALT, a fresh VAPID P-256 pair, and EMBED_FAKE=1 unless
// --real-ai is given. An existing file is kept unless --force is given, so the admin token stays
// stable between runs. The file is created with mode 0600. Only names are printed, never values.
//
// Usage: node scripts/dev-vars.mjs [--force] [--real-ai] [--set NAME=VALUE ...]
//   --set adds or overrides one plain variable (for example DAILY_REQUEST_BUDGET=10) in the file.
//   --real-ai removes EMBED_FAKE. `wrangler dev --local` cannot reach Workers AI, and on
//   2026-11-10 a remote dev session could not be authenticated with the account token, so this is
//   only useful once such a session works.

import { existsSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const file = join(dirname(fileURLToPath(import.meta.url)), '..', '.dev.vars');
const args = process.argv.slice(2);
const force = args.includes('--force');
const realAi = args.includes('--real-ai');
const sets = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--set' && args[i + 1]) sets.push(args[++i]);
}

const b64url = (buf) => Buffer.from(buf).toString('base64url');
const randomHex = (n) => Buffer.from(crypto.getRandomValues(new Uint8Array(n))).toString('hex');

function parse(textValue) {
  const out = new Map();
  for (const line of textValue.split('\n')) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m) out.set(m[1], m[2]);
  }
  return out;
}

let vars = existsSync(file) && !force ? parse(readFileSync(file, 'utf8')) : new Map();
const created = [];

if (!vars.has('ADMIN_TOKEN')) {
  vars.set('ADMIN_TOKEN', randomHex(32));
  created.push('ADMIN_TOKEN');
}
if (!vars.has('REF_SALT')) {
  vars.set('REF_SALT', randomHex(32));
  created.push('REF_SALT');
}
if (!vars.has('VAPID_PUBLIC_KEY') || !vars.has('VAPID_PRIVATE_KEY')) {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const pub = await crypto.subtle.exportKey('raw', pair.publicKey);
  const jwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
  vars.set('VAPID_PUBLIC_KEY', b64url(pub));
  vars.set('VAPID_PRIVATE_KEY', jwk.d);
  created.push('VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY');
}
if (realAi) vars.delete('EMBED_FAKE');
else if (!vars.has('EMBED_FAKE')) {
  vars.set('EMBED_FAKE', '1');
  created.push('EMBED_FAKE');
}
for (const s of sets) {
  const eq = s.indexOf('=');
  if (eq < 1 || !/^[A-Z0-9_]+$/.test(s.slice(0, eq))) {
    console.error('--set needs NAME=VALUE');
    process.exit(2);
  }
  vars.set(s.slice(0, eq), s.slice(eq + 1));
  created.push(s.slice(0, eq));
}

writeFileSync(file, [...vars].map(([k, v]) => `${k}=${v}`).join('\n') + '\n', { mode: 0o600 });
chmodSync(file, 0o600);
console.log(`.dev.vars holds ${[...vars.keys()].join(', ')}${created.length ? ` (set now: ${created.join(', ')})` : ''}.`);
