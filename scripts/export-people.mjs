// Exports one conference's people documents to data/exports/people-{slug}.ndjson.
//
// Usage: node scripts/export-people.mjs --event <slug>
// Env:   ES_URL; ES_PEOPLE_API_KEY (or ELASTISEARCH_API_KEY); ES_PEOPLE_INDEX (default caddie-people).
//
// The export leaves out secret_hash, text_hash, the embeddings, the presence fields (zone, spot,
// times, position) and the Bluetooth token: presence is transient and a position never leaves
// Elasticsearch as such. It also leaves out every profile whose owner asked to delete it and whose
// delete has not finished yet (hidden, sharing nothing and not visible conference-wide; the
// server's hourly purge finishes those deletes). data/exports/ is git-ignored, because the file
// holds personal data; delete it when you no longer need it.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// A profile whose delete hid it and has not finished (server/people-shared.mjs says why that
// state marks a pending delete).
import { PENDING_DELETE_QUERY } from '../server/people-shared.mjs';

const ES_URL = (process.env.ES_URL || 'https://fc875c88f9f44f159f1a359ee724d82b.us-west1.gcp.cloud.es.io:443').replace(/\/$/, '');
const API_KEY = process.env.ES_PEOPLE_API_KEY || process.env.ELASTISEARCH_API_KEY;
const PEOPLE_INDEX = process.env.ES_PEOPLE_INDEX || 'caddie-people';
const PAGE = 1000;

if (!API_KEY) {
  console.error('Set ES_PEOPLE_API_KEY or ELASTISEARCH_API_KEY.');
  process.exit(1);
}
const args = process.argv.slice(2);
const slug = args[0] === '--event' ? args[1] : null;
if (!slug || !/^[a-z0-9][a-z0-9-]{0,119}$/.test(slug) || args.length !== 2) {
  console.error('Usage: node scripts/export-people.mjs --event <slug>');
  process.exit(1);
}

async function search(body) {
  const res = await fetch(`${ES_URL}/${PEOPLE_INDEX}/_search`, {
    method: 'POST',
    headers: { Authorization: `ApiKey ${API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error(`Search failed with status ${res.status}: ${json.error?.type ?? ''}`);
    process.exit(1);
  }
  return json;
}

const outDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data', 'exports');
fs.mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, `people-${slug}.ndjson`);
const lines = [];
let after;
for (;;) {
  const body = {
    size: PAGE,
    _source: { excludes: ['secret_hash', 'text_hash', '*_semantic', 'presence_*', 'ble_*'] },
    query: { bool: { filter: [{ term: { event_id: slug } }], must_not: [PENDING_DELETE_QUERY] } },
    sort: [{ updated_at: 'asc' }, { profile_id: 'asc' }],
  };
  if (after) body.search_after = after;
  const json = await search(body);
  const hits = json.hits?.hits ?? [];
  for (const h of hits) lines.push(JSON.stringify(h._source));
  if (hits.length < PAGE) break;
  after = hits[hits.length - 1].sort;
}
fs.writeFileSync(outFile, lines.length ? `${lines.join('\n')}\n` : '');
console.log(`Wrote ${lines.length} profiles to ${path.relative(process.cwd(), outFile)}.`);
