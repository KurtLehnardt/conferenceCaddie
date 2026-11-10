// Loads the contract schemas from contracts/schema/ and builds validators for them, for the tests
// and for any tool (the Phase 1 bundle pipeline, a tier 2 backend's tests) that checks its output.
//
//   const check = validator('capabilities.v1');                       // the whole document
//   const check = validator('people-api.v1', 'PresencePutResponse');  // one $defs entry
//   check(value, { closed: true })  -> { valid, errors }

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { compile } from './validate.mjs';

export const SCHEMA_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../schema');

let cache = null;

/** Every schema, keyed by file name without .schema.json (for example 'people-api.v1'). */
export function loadSchemas() {
  if (cache) return cache;
  cache = new Map();
  for (const f of readdirSync(SCHEMA_DIR).filter((f) => f.endsWith('.schema.json')).sort()) {
    cache.set(f.replace(/\.schema\.json$/, ''), JSON.parse(readFileSync(path.join(SCHEMA_DIR, f), 'utf8')));
  }
  return cache;
}

const compiled = new Map();

/**
 * A validator for a schema, or for one of its $defs entries. The returned function takes the
 * value and { closed } (producer mode, default false) and returns { valid, errors }.
 */
export function validator(name, def = null) {
  const schemas = loadSchemas();
  const root = schemas.get(name);
  if (!root) throw new Error(`no schema ${name}`);
  const others = [...schemas.values()].filter((s) => s !== root);
  return (value, { closed = false } = {}) => {
    const key = `${name}#${def ?? ''}#${closed}`;
    if (!compiled.has(key)) {
      const schema = def ? { $ref: `${root.$id}#/$defs/${def}` } : root;
      compiled.set(key, compile(schema, { schemas: def ? [root, ...others] : others, closed }));
    }
    return compiled.get(key)(value);
  };
}
