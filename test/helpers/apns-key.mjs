// .p8 key files for the tests that configure APNs: server/native-push.mjs reads the key from the
// file APNS_KEY_FILE names, as Cloud Run mounts it. Each key is generated for the run and written,
// readable by its owner only, to a directory of its own under the system's temporary directory,
// which is removed when the process exits. No key is ever written anywhere else.

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** A fresh .p8 key: a PKCS#8 P-256 private key as PEM text. */
export const generateP8 = () => crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey.export({ type: 'pkcs8', format: 'pem' });

let dir = null;
let count = 0;

/** Writes text (a fresh key by default) to a new file and returns its path. */
export function writeKeyFile(text = generateP8()) {
  if (!dir) {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'caddie-apns-test-'));
    process.on('exit', () => fs.rmSync(dir, { recursive: true, force: true }));
  }
  count += 1;
  const file = path.join(dir, `AuthKey_${count}.p8`);
  fs.writeFileSync(file, text, { mode: 0o600 });
  return file;
}

/** A path in the same directory with no file behind it: what an unmounted secret looks like. */
export function missingKeyFile() {
  writeKeyFile('');
  return path.join(dir, 'not-mounted', 'AuthKey.p8');
}
