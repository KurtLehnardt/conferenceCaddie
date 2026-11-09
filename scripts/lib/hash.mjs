// Hashes that let a re-run skip unchanged talks, so the semantic_text field is not re-embedded.
import { createHash } from 'node:crypto';

const sha256 = (s) => createHash('sha256').update(s, 'utf8').digest('hex');

// JSON with object keys sorted at every level; array order is kept because it is meaningful.
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

// title and abstract are the two fields copied into the semantic_text field.
export function textHash(doc) {
  return sha256(`${doc.title}\n${doc.abstract}`);
}

const NOT_HASHED = new Set(['content_hash', 'text_hash', 'ingested_at']);
export function contentHash(doc) {
  const rest = {};
  for (const [k, v] of Object.entries(doc)) if (!NOT_HASHED.has(k)) rest[k] = v;
  return sha256(canonicalJson(rest));
}
