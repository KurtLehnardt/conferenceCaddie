// Response shapes shared by the talks routes, identical to the ones server/search.mjs,
// server/recommend.mjs and server/related.mjs produce. No raw topic id reaches a client: a topic
// without a label is left out.

import { escapeHtml } from '../lib/text.js';

const asArray = (v) => (Array.isArray(v) ? v : []);

// Collapses whitespace and cuts at a word boundary with an ellipsis, as trimText in the server.
export function trimText(textValue, max) {
  const t = String(textValue ?? '').replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const space = cut.lastIndexOf(' ');
  return `${space > max * 0.6 ? cut.slice(0, space) : cut}…`;
}

// The first max characters of a text, cut back to a word boundary without an ellipsis, as
// Elasticsearch's no_match_size gives for a field without a highlight.
export function textStart(textValue, max) {
  const t = String(textValue ?? '').replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const space = cut.lastIndexOf(' ');
  return space > max * 0.6 ? cut.slice(0, space) : cut;
}

export const cleanTags = (tags) => asArray(tags)
  .filter((t) => t && typeof t.group === 'string' && typeof t.value === 'string')
  .map((t) => ({ group: t.group, value: t.value }));

export const labelledTopics = (ids, labels) => asArray(ids).filter((id) => labels.has(id)).map((id) => ({ topic_id: id, label: labels.get(id) }));

// One talk in the search result shape (toResult in server/search.mjs).
export function toResult(t, labels, evidence) {
  return {
    talk_id: t.talk_id,
    conference: t.conference,
    kind: t.kind === 'ambient' ? 'ambient' : 'talk',
    title: t.title ?? '',
    speakers: asArray(t.speakers),
    room: t.room ?? null,
    start: t.start,
    end: t.end,
    track: t.track,
    level: t.level ?? null,
    tags: cleanTags(t.tags),
    topics: labelledTopics(t.topics, labels),
    speaker_profiles: asArray(t.speaker_profiles),
    slides_url: t.slides_url ?? null,
    url: t.url,
    evidence: evidence ?? escapeHtml(t.title ?? ''),
  };
}
