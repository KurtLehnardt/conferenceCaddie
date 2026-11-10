// GET /api/related?event=&talk_id=: up to five talks of the same conference closest in meaning to
// one talk (PLAN section 1.7). The query vector is the normalised centroid of the talk's title and
// chunk vectors; every other talk of kind talk scores the best cosine of its own vectors, as the
// knn query on the chunked semantic field did. Computed from cached vectors on request, then kept
// in memory per talk until the talks change. Nothing is stored and the talk id is never logged.

import { bad } from '../lib/http.js';
import { normalize } from '../lib/vectors.js';
import { memo, talkOnly, talkVecs } from './cache.js';
import { semanticTop } from './search.js';
import { cleanTags } from './shape.js';

const RELATED_MAX = 5;
const TALK_ID_RE = /^[a-z0-9][a-z0-9-]{0,119}:[A-Za-z0-9_-]{1,64}$/;
const KEYS = new Set(['event', 'talk_id']);

export function validate(url) {
  for (const k of url.searchParams.keys()) if (!KEYS.has(k)) throw bad(`Unknown parameter: ${k.slice(0, 40)}`);
  const talkId = url.searchParams.get('talk_id');
  if (typeof talkId !== 'string' || !TALK_ID_RE.test(talkId)) throw bad('talk_id is not valid');
  return talkId;
}

// The results for a talk, or null when it is not a talk of this conference.
export function related(store, talkId) {
  const talk = store.talk(talkId);
  if (!talk || talk.kind !== 'talk') return null;
  const cache = memo(store, 'related', () => new Map());
  if (cache.has(talkId)) return cache.get(talkId);
  const e = talkVecs(store).get(talkId);
  let results = [];
  if (e) {
    const dim = e.all[0].length;
    const c = new Float32Array(dim);
    for (const v of e.all) for (let i = 0; i < dim; i++) c[i] += v[i];
    normalize(c);
    const others = talkOnly(store).filter((t) => t.talk_id !== talkId);
    results = semanticTop(store, c, others, RELATED_MAX).map(({ talk: t }) => ({
      talk_id: t.talk_id,
      conference: t.conference,
      title: t.title ?? '',
      speakers: t.speakers ?? [],
      room: t.room ?? null,
      start: t.start,
      end: t.end,
      track: t.track,
      level: t.level ?? null,
      tags: cleanTags(t.tags),
      slides_url: t.slides_url ?? null,
      url: t.url,
    }));
  }
  cache.set(talkId, results);
  return results;
}
