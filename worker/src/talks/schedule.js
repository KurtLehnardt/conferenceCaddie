// GET /api/schedule?event=: the conference's talks for the app's offline mode, ported from
// server/schedule.mjs. Only kind talk, sorted by start then talk_id, with public feed fields, topic
// labels and the abstract trimmed to about 400 characters. No people field ever appears. The
// serialised JSON is kept in memory until the talks change.

import { bad } from '../lib/http.js';
import { memo, talkOnly } from './cache.js';
import { cleanTags, labelledTopics, trimText } from './shape.js';

const ABSTRACT_MAX = 400;

export function validate(url) {
  for (const key of url.searchParams.keys()) if (key !== 'event') throw bad(`Unknown parameter: ${key.slice(0, 40)}`);
}

export const scheduleJson = (store, slug) => memo(store, 'schedule', () => {
  const labels = store.topics().labels;
  const talks = talkOnly(store).map((t) => ({
    talk_id: t.talk_id,
    conference: slug,
    title: t.title ?? '',
    speakers: (t.speakers ?? []).filter((x) => typeof x === 'string'),
    room: t.room ?? null,
    start: t.start,
    end: t.end,
    track: t.track ?? '',
    level: t.level ?? null,
    tags: cleanTags(t.tags),
    topics: labelledTopics(t.topics, labels),
    url: t.url,
    slides_url: t.slides_url ?? null,
    abstract: trimText(t.abstract, ABSTRACT_MAX),
  }));
  return JSON.stringify({ conference: slug, talks });
});
