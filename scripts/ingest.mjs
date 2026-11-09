// Bulk-indexes an NDJSON file of talk documents into an index or alias, using talk_id as _id.
//
// Usage: node scripts/ingest.mjs [path] [--index name]
// Env:   ES_URL (default: the Elastic Cloud deployment), ES_API_KEY or ELASTISEARCH_API_KEY,
//        ES_INDEX (default caddie-talks).
//
// Batches are small (50 documents) because semantic_text runs inference at index time.
// A 429 response, for the whole request or for single items, is retried with backoff.

import fs from 'node:fs';

const ES_URL = (process.env.ES_URL || 'https://fc875c88f9f44f159f1a359ee724d82b.us-west1.gcp.cloud.es.io:443').replace(/\/$/, '');
const API_KEY = process.env.ES_API_KEY || process.env.ELASTISEARCH_API_KEY;
if (!API_KEY) {
  console.error('Set ES_API_KEY or ELASTISEARCH_API_KEY.');
  process.exit(1);
}

const args = process.argv.slice(2);
let target = process.env.ES_INDEX || 'caddie-talks';
const i = args.indexOf('--index');
if (i !== -1) {
  target = args[i + 1];
  args.splice(i, 2);
}
const path = args[0] || 'data/talks.ndjson';
const BATCH = 50;
const MAX_TRIES = 6;

const docs = fs.readFileSync(path, 'utf8').split('\n').filter((l) => l.trim()).map((l, n) => {
  try {
    return JSON.parse(l);
  } catch {
    console.error(`Line ${n + 1} of ${path} is not valid JSON.`);
    process.exit(1);
  }
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function bulk(batch) {
  const body = batch.flatMap((d) => [JSON.stringify({ index: { _index: target, _id: String(d.talk_id) } }), JSON.stringify(d)]).join('\n') + '\n';
  const res = await fetch(`${ES_URL}/_bulk`, {
    method: 'POST',
    headers: { Authorization: `ApiKey ${API_KEY}`, 'Content-Type': 'application/x-ndjson' },
    body,
    signal: AbortSignal.timeout(300_000),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* handled below */ }
  return { status: res.status, json };
}

let indexed = 0;
const errors = [];
for (let start = 0; start < docs.length; start += BATCH) {
  let pending = docs.slice(start, start + BATCH);
  for (let attempt = 1; pending.length && attempt <= MAX_TRIES; attempt++) {
    const { status, json } = await bulk(pending);
    if (status === 429 || !json) {
      if (attempt === MAX_TRIES) {
        for (const d of pending) errors.push({ talk_id: d.talk_id, status, reason: 'request failed' });
        pending = [];
        break;
      }
      await sleep(1000 * 2 ** attempt);
      continue;
    }
    if (status >= 400 && !json.items) {
      console.error(`Bulk request failed with status ${status}: ${json.error?.type ?? ''} ${json.error?.reason ?? ''}`);
      process.exit(1);
    }
    const retry = [];
    json.items.forEach((item, n) => {
      const r = item.index;
      if (r.status < 300) indexed++;
      else if (r.status === 429 && attempt < MAX_TRIES) retry.push(pending[n]);
      else errors.push({ talk_id: pending[n].talk_id, status: r.status, reason: `${r.error?.type ?? ''}: ${r.error?.reason ?? ''}`.slice(0, 300) });
    });
    pending = retry;
    if (pending.length) await sleep(1000 * 2 ** attempt);
  }
  process.stdout.write(`Indexed ${indexed} of ${docs.length}\r`);
}
process.stdout.write('\n');

await fetch(`${ES_URL}/${target}/_refresh`, {
  method: 'POST',
  headers: { Authorization: `ApiKey ${API_KEY}` },
  signal: AbortSignal.timeout(60_000),
});

const countRes = await fetch(`${ES_URL}/${target}/_search`, {
  method: 'POST',
  headers: { Authorization: `ApiKey ${API_KEY}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ size: 0, track_total_hits: true, aggs: { kind: { terms: { field: 'kind', size: 10 } } } }),
  signal: AbortSignal.timeout(60_000),
});
const counts = await countRes.json();
console.log(`Read ${docs.length} documents from ${path}; indexed ${indexed} into ${target}.`);
console.log(`Index now holds ${counts.hits?.total?.value ?? '?'} documents:`);
for (const b of counts.aggregations?.kind?.buckets ?? []) console.log(`  ${b.key}: ${b.doc_count}`);
if (errors.length) {
  console.error(`${errors.length} documents failed:`);
  for (const e of errors.slice(0, 20)) console.error(`  ${e.talk_id} (${e.status}) ${e.reason}`);
  process.exit(1);
}
