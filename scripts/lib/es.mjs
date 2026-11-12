// Elasticsearch calls for the ingestion CLI. The key is read from the environment and never printed.

const ES_URL = (process.env.ES_URL || 'https://fc875c88f9f44f159f1a359ee724d82b.us-west1.gcp.cloud.es.io:443').replace(/\/$/, '');
const API_KEY = process.env.ES_API_KEY || process.env.ELASTISEARCH_API_KEY || '';

export const hasKey = () => Boolean(API_KEY);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// key: another API key for this one request (the people key for the people indices); by default the
// ingest key above.
export async function es(method, path, body, { ndjson = false, timeout = 120_000, key = API_KEY } = {}) {
  const res = await fetch(ES_URL + path, {
    method,
    headers: {
      Authorization: `ApiKey ${key}`,
      'Content-Type': ndjson ? 'application/x-ndjson' : 'application/json',
    },
    body: body === undefined ? undefined : ndjson ? body : JSON.stringify(body),
    signal: AbortSignal.timeout(timeout),
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : {}; } catch { /* left null */ }
  return { status: res.status, json };
}

// Returns a Map of talk_id to { content_hash, text_hash } for one conference, or null when the
// index does not exist. Throws on any other failure, and when the event is too large to read in one page.
export async function existingHashes(index, slug) {
  const { status, json } = await es('POST', `/${encodeURIComponent(index)}/_search`, {
    _source: ['content_hash', 'text_hash'],
    size: 10000,
    track_total_hits: true,
    query: { term: { conference: slug } },
  });
  if (status === 404) return null;
  if (status !== 200 || !json) throw new Error(`Reading existing hashes from ${index} failed with status ${status}: ${json?.error?.type ?? ''}`);
  if (json.hits.total.value > 10000) throw new Error(`${index} holds more than 10000 documents for ${slug}; aborting the event.`);
  const map = new Map();
  for (const h of json.hits.hits) map.set(h._id, { content_hash: h._source?.content_hash ?? null, text_hash: h._source?.text_hash ?? null });
  return map;
}

const BATCH = 50;
const MAX_TRIES = 6;
// ASSUMPTION about the trial's error shape when model usage runs out; the integrator records the real one.
const LIMIT_RE = /inference|rate|limit|quota/i;

function lines(op, index) {
  const meta = { _index: index, _id: op.id };
  if (op.action === 'delete') return [JSON.stringify({ delete: meta })];
  if (op.action === 'update') return [JSON.stringify({ update: meta }), JSON.stringify({ doc: op.doc })];
  return [JSON.stringify({ index: meta }), JSON.stringify(op.doc)];
}

// Runs index, update and delete operations through the Bulk API in batches of 50. The Update API is
// never used, because it re-runs inference on semantic_text fields even when they are omitted.
// Returns { ok: { index, update, delete }, failures: [{ id, action, status, reason }], limit: string|null }.
// When limit is set, the run hit what looks like the embedding limit and stopped early.
export async function runBulk(index, ops) {
  const ok = { index: 0, update: 0, delete: 0 };
  const failures = [];
  for (let start = 0; start < ops.length; start += BATCH) {
    let pending = ops.slice(start, start + BATCH);
    for (let attempt = 1; pending.length && attempt <= MAX_TRIES; attempt++) {
      const body = pending.flatMap((op) => lines(op, index)).join('\n') + '\n';
      const { status, json } = await es('POST', '/_bulk', body, { ndjson: true, timeout: 300_000 });
      if (status === 429 || !json) {
        if (attempt === MAX_TRIES) return { ok, failures, limit: `bulk request returned ${status || 'no JSON'} after ${MAX_TRIES} tries` };
        await sleep(1000 * 2 ** attempt);
        continue;
      }
      if (status >= 400 && !json.items) {
        const reason = `${json.error?.type ?? ''}: ${json.error?.reason ?? ''}`.slice(0, 300);
        if (LIMIT_RE.test(reason)) return { ok, failures, limit: `bulk request failed with ${status} (${reason})` };
        throw new Error(`Bulk request failed with status ${status}: ${reason}`);
      }
      const retry = [];
      let limit = null;
      json.items.forEach((item, n) => {
        const op = pending[n];
        const r = item[op.action];
        if (r.status < 300 || (op.action === 'delete' && r.status === 404)) { ok[op.action]++; return; }
        const reason = `${r.error?.type ?? ''}: ${r.error?.reason ?? ''}`.slice(0, 300);
        if (r.status === 429 && attempt < MAX_TRIES) { retry.push(op); return; }
        failures.push({ id: op.id, action: op.action, status: r.status, reason });
        if (r.status === 429 || LIMIT_RE.test(reason)) limit = `${op.action} ${op.id}: ${r.status} ${reason}`;
      });
      if (limit) return { ok, failures, limit };
      pending = retry;
      if (pending.length) await sleep(1000 * 2 ** attempt);
    }
  }
  return { ok, failures, limit: null };
}
