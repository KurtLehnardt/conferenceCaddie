// Generates the VAPID key pair that signs Web Push nudges and writes it to two files, then prints
// the operator's steps to store both in Secret Manager. Neither key value is ever printed.
//
// Usage: node scripts/vapid-keys.mjs [--dir path]
//
// The files are vapid-public.key and vapid-private.key in --dir (default: the current directory).
// *.key is git-ignored. The public key is not a secret (every browser receives it), but keeping it
// in Secret Manager too means deploy.sh can read it without anyone pasting it. Delete both files
// once they are uploaded; the keys live in Secret Manager from then on and VAPID_PRIVATE_KEY is
// mounted from caddie-vapid-private at deploy time.

import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const dirIndex = args.indexOf('--dir');
const dir = path.resolve(dirIndex === -1 ? '.' : args[dirIndex + 1] || '.');
const publicFile = path.join(dir, 'vapid-public.key');
const privateFile = path.join(dir, 'vapid-private.key');

for (const file of [publicFile, privateFile]) {
  if (fs.existsSync(file)) {
    console.error(`${file} already exists. Move or delete it first; this script never overwrites a key.`);
    process.exit(1);
  }
}

let webpush;
try {
  const mod = await import('web-push');
  webpush = mod.default ?? mod;
} catch {
  console.error('web-push is not installed. Run npm ci in the repository root first.');
  process.exit(1);
}

const keys = webpush.generateVAPIDKeys();
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(publicFile, keys.publicKey, { mode: 0o600 });
fs.writeFileSync(privateFile, keys.privateKey, { mode: 0o600 });

const project = 'project-9205d6eb-366e-4844-b77';
console.log(`Wrote the VAPID key pair to:
  ${publicFile}
  ${privateFile}

Store both in Secret Manager (first time; use "versions add" to rotate):

  gcloud secrets create caddie-vapid-public  --project ${project} --replication-policy automatic --data-file "${publicFile}"
  gcloud secrets create caddie-vapid-private --project ${project} --replication-policy automatic --data-file "${privateFile}"

  # Rotating later:
  # gcloud secrets versions add caddie-vapid-public  --project ${project} --data-file "${publicFile}"
  # gcloud secrets versions add caddie-vapid-private --project ${project} --data-file "${privateFile}"

Then delete both files:

  rm "${publicFile}" "${privateFile}"

scripts/deploy.sh reads the public key from caddie-vapid-public into VAPID_PUBLIC_KEY (an env var,
not a secret), mounts caddie-vapid-private as VAPID_PRIVATE_KEY and sets VAPID_SUBJECT. Set
VAPID_SUBJECT in your shell before deploying to use a mailto: address instead of the repository URL.
Rotating the keys invalidates every existing browser subscription; people turn nudges on again.`);
