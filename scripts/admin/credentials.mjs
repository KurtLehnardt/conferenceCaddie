// Credential lookup for the caddie-admin CLI. The environment variable wins; otherwise a file that
// only its owner can read. The value is handed to the adapter factory and nowhere else: error
// messages name the variable or file and the file mode, never the value.

import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { configDir } from './config.mjs';
import { AdminError } from './errors.mjs';

// Where each tier keeps its credential.
export const CREDENTIAL_SOURCES = {
  3: { envName: 'ELASTISEARCH_API_KEY', fileEnvName: 'ES_ADMIN_KEY_FILE', defaultFile: 'es-admin-key' },
  2: { envName: 'ADMIN_TOKEN', fileEnvName: 'ADMIN_TOKEN_FILE', defaultFile: 'admin-token' },
};

export function readCredential({ env, envName, fileEnvName, defaultFile }) {
  const fromEnv = (env[envName] ?? '').trim();
  if (fromEnv) return fromEnv;

  const file = env[fileEnvName] || resolve(configDir(env), defaultFile);
  let st;
  try {
    st = statSync(file);
  } catch {
    throw new AdminError(`no credential: set ${envName}, or put it in ${file} (mode 0600; ${fileEnvName} changes the path)`);
  }
  if ((st.mode & 0o177) !== 0) {
    const mode = (st.mode & 0o777).toString(8).padStart(4, '0');
    throw new AdminError(`credential file ${file} has mode ${mode}; only the owner may read it, run chmod 600 on it`);
  }
  let value;
  try {
    value = readFileSync(file, 'utf8').trim();
  } catch {
    throw new AdminError(`credential file ${file} is not readable`);
  }
  if (!value) throw new AdminError(`credential file ${file} is empty`);
  return value;
}

// Returns a function that replaces every credential value in a string with [REDACTED].
export function redactor(values) {
  const secrets = values.filter((v) => typeof v === 'string' && v.length > 0);
  return (text) => secrets.reduce((out, secret) => out.split(secret).join('[REDACTED]'), String(text));
}
