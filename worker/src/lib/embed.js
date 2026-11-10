// Embeddings through Workers AI (bge-small by default, from env.EMBED_MODEL).
//
// - Passages (talk titles and chunks, profile fields) are embedded at write time and stored.
// - Query vectors are cached in memory only, in an LRU of 2,000 per Durable Object, keyed by the
//   model and the lowercased, whitespace-collapsed text. Nothing is persisted, so a new query
//   costs no row write.
// - Any AI error (including the daily neuron cap) throws EmbedUnavailable and pauses semantic
//   calls in this object for 10 minutes, so callers fall back to keyword legs.
// - With env.EMBED_FAKE === '1' (local runs only) vectors are feature-hashed: each lowercased word
//   adds +1 or -1 to bucket hash(word) mod dim, then the vector is normalised. Similar wording
//   gives similar vectors, and the AI binding is never called. The query instruction is not added
//   to fake vectors, because its words would only add the same noise to every query.
//
// Embedding conventions (docs/contracts/talk-bundle.md, Embedding conventions; the model block of
// every v1 bundle, contracts/js/bundle.mjs MODEL). The bundle builder, the phones and this Worker
// must embed the same way, or query vectors do not match bundle vectors:
// - BAAI/bge-small-en-v1.5, 384 dimensions, as Workers AI @cf/baai/bge-small-en-v1.5;
// - CLS pooling (Workers AI is called with pooling: "cls"; its default, mean, does not match);
// - every vector L2-normalised; Workers AI truncates at the model's 512 tokens;
// - documents with no instruction: a talk is title + "\n" + abstract (store.js embedTalks);
// - talk search queries prefixed with the query instruction (embedQuery's default).
// People vectors are compared with each other (one person's interests against another's
// expertise) and with a typed people query, so both sides of a people comparison are embedded as
// documents, with no instruction (rank.js passes instruction: false); the people semantic floor in
// rank.js is measured that way.
// CONVENTIONS_ID names this set. It is stored with every talk vector and, for people, in
// meta.embed_conventions, and a stored vector from another set is embedded again
// (Store.embedPending), so a change here re-embeds the conference through the cron and
// POST /admin/embed-pending.

import { normalize } from './vectors.js';

export const DEFAULT_MODEL = '@cf/baai/bge-small-en-v1.5';
export const QUERY_INSTRUCTION = 'Represent this sentence for searching relevant passages: ';
// The model block this Worker embeds under, in the shape of contracts/js/bundle.mjs MODEL.
// worker/ingest/push-ingest.mjs refuses to push when it differs from the contract's.
export const CONVENTIONS = Object.freeze({
  id: 'BAAI/bge-small-en-v1.5',
  workers_ai_model: DEFAULT_MODEL,
  dims: 384,
  pooling: 'cls',
  normalize: true,
  max_tokens: 512,
  truncation: 'end',
  document_instruction: '',
  document_text: 'title + "\\n" + abstract',
  query_instruction: QUERY_INSTRUCTION,
});
export const CONVENTIONS_ID = 'bge-small-en-v1.5/cls/v1';
// The id stored with vectors: the conventions' id, or a fake one for EMBED_FAKE's feature-hashed
// vectors, so a local run that switches between them embeds everything again.
export const conventionsId = (ctx) => (ctx?.env?.EMBED_FAKE === '1' ? 'fake-feature-hash/v1' : CONVENTIONS_ID);
// A talk's document text under the conventions.
export const documentText = (t) => `${t.title ?? ''}\n${t.abstract ?? ''}`;
const BATCH = 50;
const LRU_MAX = 2000;
const PAUSE_MS = 10 * 60_000;
const FAKE_DIM = 384;

export class EmbedUnavailable extends Error {
  constructor(message = 'embeddings unavailable') {
    super(message);
    this.name = 'EmbedUnavailable';
  }
}

// Per-object state (the LRU and the pause). ConferenceDO puts one on ctx.embedState; a module
// fallback keeps standalone calls working.
const fallbackState = { lru: new Map(), pausedUntil: 0 };
const stateOf = (ctx) => ctx?.embedState ?? fallbackState;
export const newEmbedState = () => ({ lru: new Map(), pausedUntil: 0 });

export const modelOf = (ctx) => ctx?.env?.EMBED_MODEL || DEFAULT_MODEL;
const isFake = (ctx) => ctx?.env?.EMBED_FAKE === '1';

// Throws EmbedUnavailable when env.EMBED_MODEL names another model than the conventions', so no
// vector of another model is ever stored or compared with bundle vectors.
export function assertConventions(ctx) {
  if (isFake(ctx)) return;
  if (modelOf(ctx) !== CONVENTIONS.workers_ai_model) throw new EmbedUnavailable('EMBED_MODEL is not the conventions model');
}

// False while semantic calls are paused after an AI error.
export function semanticAvailable(ctx) {
  if (isFake(ctx)) return true;
  return Date.now() >= stateOf(ctx).pausedUntil;
}

function fnv1a(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

function fakeVector(textValue, dim = FAKE_DIM) {
  const v = new Float32Array(dim);
  for (const w of String(textValue).toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (!w) continue;
    const h = fnv1a(w);
    v[h % dim] += h & 0x80000000 ? -1 : 1;
  }
  return normalize(v);
}

// Local runs only: `wrangler dev --local` cannot reach the AI binding with an account token, so
// env.EMBED_PROXY (set in .dev.vars by `dev-vars.mjs --real-ai`, never in wrangler.toml) points at
// worker/scripts/dev-ai-proxy.mjs, which forwards the call to the Workers AI REST API.
async function runModel(ctx, texts) {
  const proxy = ctx.env.EMBED_PROXY;
  if (!proxy) return ctx.env.AI.run(modelOf(ctx), { text: texts, pooling: CONVENTIONS.pooling });
  const res = await fetch(proxy, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: modelOf(ctx), text: texts, pooling: CONVENTIONS.pooling }),
  });
  if (!res.ok) throw new Error(`proxy ${res.status}`);
  return res.json();
}

async function callAi(ctx, texts) {
  assertConventions(ctx);
  let out;
  try {
    out = await runModel(ctx, texts);
  } catch (err) {
    stateOf(ctx).pausedUntil = Date.now() + PAUSE_MS;
    throw new EmbedUnavailable(err?.name ?? 'Error');
  }
  const data = out?.data;
  if (!Array.isArray(data) || data.length !== texts.length || data.some((row) => !Array.isArray(row) || row.length !== CONVENTIONS.dims)) {
    stateOf(ctx).pausedUntil = Date.now() + PAUSE_MS;
    throw new EmbedUnavailable('invalid response');
  }
  return data.map((row) => normalize(Float32Array.from(row)));
}

// One normalised vector per text, in order, sent to Workers AI in calls of at most 50 texts. An
// empty or whitespace-only text gives null and is not sent. Throws EmbedUnavailable.
export async function embedPassages(ctx, texts) {
  const out = new Array(texts.length).fill(null);
  const todo = [];
  texts.forEach((t, i) => {
    if (typeof t === 'string' && t.trim()) todo.push(i);
  });
  if (!todo.length) return out;
  if (isFake(ctx)) {
    for (const i of todo) out[i] = fakeVector(texts[i]);
    return out;
  }
  if (!semanticAvailable(ctx)) throw new EmbedUnavailable('paused');
  for (let s = 0; s < todo.length; s += BATCH) {
    const idx = todo.slice(s, s + BATCH);
    const vecs = await callAi(ctx, idx.map((i) => texts[i]));
    idx.forEach((i, j) => {
      out[i] = vecs[j];
    });
  }
  return out;
}

const queryKey = (ctx, textValue, instruction) => `${modelOf(ctx)}\n${instruction ? 'q' : 'd'}\n${String(textValue).toLowerCase().replace(/\s+/g, ' ').trim()}`;

// The vector of a search query, from the memory LRU or one Workers AI call. A talk search query is
// embedded with the query instruction (the default); instruction: false embeds the text as a
// document, as people queries are. Throws EmbedUnavailable (also for an empty query).
export async function embedQuery(ctx, textValue, { instruction = true } = {}) {
  const key = queryKey(ctx, textValue, instruction);
  const st = stateOf(ctx);
  const hit = st.lru.get(key);
  if (hit) {
    st.lru.delete(key);
    st.lru.set(key, hit);
    return hit;
  }
  const clean = String(textValue ?? '').trim();
  if (!clean) throw new EmbedUnavailable('empty query');
  let vec;
  if (isFake(ctx)) {
    vec = fakeVector(clean);
  } else {
    if (!semanticAvailable(ctx)) throw new EmbedUnavailable('paused');
    [vec] = await callAi(ctx, [instruction ? `${QUERY_INSTRUCTION}${clean}` : clean]);
  }
  st.lru.set(key, vec);
  if (st.lru.size > LRU_MAX) st.lru.delete(st.lru.keys().next().value);
  return vec;
}
