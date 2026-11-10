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
//   gives similar vectors, and the AI binding is never called.

import { normalize } from './vectors.js';

export const DEFAULT_MODEL = '@cf/baai/bge-small-en-v1.5';
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
  if (!proxy) return ctx.env.AI.run(modelOf(ctx), { text: texts });
  const res = await fetch(proxy, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: modelOf(ctx), text: texts }),
  });
  if (!res.ok) throw new Error(`proxy ${res.status}`);
  return res.json();
}

async function callAi(ctx, texts) {
  let out;
  try {
    out = await runModel(ctx, texts);
  } catch (err) {
    stateOf(ctx).pausedUntil = Date.now() + PAUSE_MS;
    throw new EmbedUnavailable(err?.name ?? 'Error');
  }
  const data = out?.data;
  if (!Array.isArray(data) || data.length !== texts.length) {
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

const queryKey = (ctx, textValue) => `${modelOf(ctx)}\n${String(textValue).toLowerCase().replace(/\s+/g, ' ').trim()}`;

// The vector of a search query, from the memory LRU or one Workers AI call. Throws
// EmbedUnavailable (also for an empty query).
export async function embedQuery(ctx, textValue) {
  const key = queryKey(ctx, textValue);
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
    [vec] = await callAi(ctx, [clean]);
  }
  st.lru.set(key, vec);
  if (st.lru.size > LRU_MAX) st.lru.delete(st.lru.keys().next().value);
  return vec;
}
