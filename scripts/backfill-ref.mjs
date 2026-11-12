// Writes the ref field on every people document that does not have one yet.
//
// Usage: node scripts/backfill-ref.mjs [--dry-run]
// Env:   ES_URL; ES_PEOPLE_API_KEY (or ELASTISEARCH_API_KEY); ES_PEOPLE_INDEX (default caddie-people);
//        REF_SALT, which must be the same value the server runs with (it is unset in the current
//        deploy, so the default salt applies). Its value is never printed.
//
// The server stores ref on every profile write since Find & connect, and blocks and meets resolve
// a result's ref back to its document through this field. Documents written before that release
// get it here, computed by the same refFor as the server, with a Bulk partial update that carries
// only the ref field, so nothing is re-embedded. Run npm run people:setup first, so the mapping
// has the field. Safe to re-run: a document that already has a ref is skipped.

import { refFor } from '../server/device.mjs';

import { esUrlOrExit } from './lib/es-url.mjs';
const API_KEY = process.env.ES_PEOPLE_API_KEY || process.env.ELASTISEARCH_API_KEY;
const PEOPLE_INDEX = process.env.ES_PEOPLE_INDEX || 'caddie-people';
const PAGE = 100;
const dryRun = process.argv.includes('--dry-run');

if (!API_KEY) {
  console.error('Set ES_PEOPLE_API_KEY or ELASTISEARCH_API_KEY.');
  process.exit(1);
}

async function es(method, path, body, ndjson = false) {
  const res = await fetch(esUrlOrExit() + path, {
    method,
    headers: { Authorization: `ApiKey ${API_KEY}`, 'Content-Type': ndjson ? 'application/x-ndjson' : 'application/json' },
    body: body === undefined ? undefined : ndjson ? body : JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error(`${method} ${path.split('?')[0]} failed with status ${res.status}: ${json.error?.type ?? ''}`);
    process.exit(1);
  }
  return json;
}

const missing = () => es('POST', `/${encodeURIComponent(PEOPLE_INDEX)}/_search`, {
  size: PAGE,
  _source: ['event_id', 'profile_id'],
  query: { bool: { must_not: [{ exists: { field: 'ref' } }] } },
  track_total_hits: true,
});

if (dryRun) {
  const json = await missing();
  console.log(`${json.hits?.total?.value ?? 0} documents would get a ref.`);
  process.exit(0);
}

// Each pass updates one page with refresh=wait_for, after which those documents no longer match,
// so the loop ends when a page comes back empty. A pass that writes nothing stops it as well.
let written = 0;
let skipped = 0;
for (;;) {
  const hits = (await missing()).hits?.hits ?? [];
  if (!hits.length) break;
  const lines = [];
  for (const h of hits) {
    const s = h._source ?? {};
    if (typeof s.event_id === 'string' && typeof s.profile_id === 'string') {
      lines.push(`${JSON.stringify({ update: { _id: h._id } })}\n${JSON.stringify({ doc: { ref: refFor(s.event_id, s.profile_id) } })}\n`);
    } else {
      skipped++;
    }
  }
  if (!lines.length) break;
  const res = await es('POST', `/${encodeURIComponent(PEOPLE_INDEX)}/_bulk?refresh=wait_for`, lines.join(''), true);
  let ok = 0;
  for (const item of res.items ?? []) {
    const r = item.update ?? {};
    if (r.status >= 200 && r.status < 300) ok++;
    else console.error(`A document failed to update: ${r.error?.type ?? r.status}`);
  }
  written += ok;
  if (!ok) break;
}
console.log(`Wrote ref on ${written} documents.${skipped ? ` Skipped ${skipped} without event_id and profile_id.` : ''}`);
