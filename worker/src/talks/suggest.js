// Value matching, ported from server/facets.mjs: the search sentence is compared with the track,
// room, speaker and tag names of the conference (store.facets(), built at ingest), and the names it
// contains come back as suggested chips. A suggestion is only offered; the client applies it.
//
// - Every name has one or more normalised keys. The sentence is normalised the same way and cut
//   into every run of one to six words; a name whose key equals one of those runs matches (score 3,
//   the boost of the terms query in Elasticsearch).
// - For a sentence of up to four words, a track, room or tag whose words contain every word of the
//   sentence also matches ("security" finds "Security + Identity"). Its score is below 1 and
//   favours shorter names, as BM25 length normalisation did. Speakers match by whole name only.
// - Ordered by score, then by the number of talks, then by label; at most two per kind and four
//   in all; a value that is already selected is left out.

import { memo } from './cache.js';
import { normalizeKey } from './analyze.js';

const MAX_WORDS = 6;
const MAX_WINDOWS = 150;
const PARTIAL_MAX_WORDS = 4;
const MAX_SUGGESTIONS = 4;
const MAX_PER_KIND = 2;
const CANDIDATES = 20;

function windows(ws) {
  const seen = new Set();
  for (let i = 0; i < ws.length && seen.size < MAX_WINDOWS; i++) {
    for (let n = 1; n <= MAX_WORDS && i + n <= ws.length; n++) {
      const run = ws.slice(i, i + n).join(' ');
      if (run.length >= 2) seen.add(run);
    }
  }
  return new Set([...seen].slice(0, MAX_WINDOWS));
}

const compiled = (store) => memo(store, 'facetIndex', () => store.facets()
  .filter((f) => ['track', 'room', 'speaker', 'tag'].includes(f.kind) && typeof f.value === 'string')
  .map((f) => {
    const ws = normalizeKey(f.words || f.label || f.value).split(' ').filter(Boolean);
    return { f, keys: f.key.filter((k) => typeof k === 'string'), words: new Set(ws), wordCount: Math.max(1, ws.length) };
  }));

function selectedValues(filters) {
  return {
    track: new Set(filters.track),
    room: new Set(filters.room),
    speaker: new Set(filters.speaker),
    tag: new Set([...filters.tags.values()].flat().map((key) => key.split('\u001f')[1])),
  };
}

// At most four { kind, label, value, group?, talks } suggestions for the sentence.
export function suggestChips(store, textValue, filters) {
  const normal = normalizeKey(textValue);
  if (normal.length < 2) return [];
  const ws = normal.split(' ');
  const wins = windows(ws);
  const partial = ws.length <= PARTIAL_MAX_WORDS;
  const scored = [];
  for (const e of compiled(store)) {
    let score = 0;
    if (e.keys.some((k) => wins.has(k))) score += 3;
    if (partial && e.f.kind !== 'speaker' && ws.every((w) => e.words.has(w))) score += ws.length / (ws.length + e.wordCount);
    if (score > 0) scored.push({ e, score });
  }
  scored.sort((a, b) => b.score - a.score || (b.e.f.talks ?? 0) - (a.e.f.talks ?? 0)
    || String(a.e.f.label ?? '').localeCompare(String(b.e.f.label ?? '')) || (a.e.f.id < b.e.f.id ? -1 : 1));
  const selected = selectedValues(filters);
  const perKind = new Map();
  const out = [];
  for (const { e } of scored.slice(0, CANDIDATES)) {
    const s = e.f;
    if (selected[s.kind]?.has(s.value)) continue;
    if ((perKind.get(s.kind) ?? 0) >= MAX_PER_KIND) continue;
    perKind.set(s.kind, (perKind.get(s.kind) ?? 0) + 1);
    out.push({ kind: s.kind, label: s.label, value: s.value, ...(s.group ? { group: s.group } : {}), talks: s.talks ?? 0 });
    if (out.length >= MAX_SUGGESTIONS) break;
  }
  return out;
}
