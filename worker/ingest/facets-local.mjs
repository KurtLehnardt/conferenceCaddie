// Builds the facet documents of one conference (the track, room, speaker and tag names that the
// search matches against a typed sentence) from its talk file, without Elasticsearch. It is the
// local counterpart of scripts/build-facets.mjs, which read the same four fields from the index.
//
// Usage: node worker/ingest/facets-local.mjs --event <slug>
// It prints counts only. push-ingest.mjs imports buildFacets and sends the result to
// PUT /admin/facets.
//
// A document looks like a caddie-facets-v1 document with its _id carried as `id`:
// { id, conference, kind, key: [normalised names], words, label, value, group?, talks, built_at }.
// A room is stored under the whole string and every tail of its " | " parts, so "Hall DE" finds
// "Salt Palace | Level 1 | Hall DE". The sentence side (cutting a search into windows of one to
// six words) lives in the Worker.

import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT, UsageError, isSlug, parseArgs, readNdjson } from './lib.mjs';

// The one normaliser, the same as normalizeKey in server/facets.mjs: lowercase, accents folded,
// anything that is not a letter or digit turned into a space.
export function normalizeKey(text) {
  return String(text)
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function roomNames(room) {
  const parts = room.split('|').map((p) => p.trim()).filter(Boolean);
  const keys = new Set();
  for (let i = 0; i < parts.length; i++) keys.add(normalizeKey(parts.slice(i).join(' ')));
  return { label: parts.slice(-2).join(' · '), keys: [...keys].filter(Boolean), words: normalizeKey(parts.slice(-2).join(' ')) };
}

function collect(talks) {
  const names = new Map(); // "kind\0value\0group" -> fields
  const add = (kind, value, label, keys, words, group) => {
    if (!value) return;
    const id = [kind, value, group ?? ''].join('\0');
    const entry = names.get(id) ?? { kind, value, label, keys, words, group, talks: 0 };
    entry.talks++;
    names.set(id, entry);
  };
  for (const t of talks) {
    if (t.track) add('track', t.track, t.track.replace(/^[^\p{L}\p{N}]+/u, ''), [normalizeKey(t.track)], normalizeKey(t.track));
    if (t.room) {
      const r = roomNames(t.room);
      add('room', t.room, r.label, r.keys, r.words);
    }
    for (const s of new Set(t.speakers ?? [])) add('speaker', s, s, [normalizeKey(s)], normalizeKey(s));
    for (const tag of t.tags ?? []) add('tag', tag.value, tag.value, [normalizeKey(tag.value)], normalizeKey(tag.value), tag.group);
  }
  return [...names.values()].filter((e) => e.keys.some(Boolean));
}

// `talks` are the talk documents of one conference; only kind talk counts, as in the index build.
export function buildFacets(slug, talks, builtAt = new Date().toISOString()) {
  return collect(talks.filter((t) => t.kind === 'talk')).map((d) => ({
    id: createHash('sha1').update(`${slug}\0${d.kind}\0${d.value}\0${d.group ?? ''}`).digest('hex'),
    conference: slug,
    kind: d.kind,
    key: d.keys.filter(Boolean),
    words: d.words,
    label: d.label,
    value: d.value,
    ...(d.group ? { group: d.group } : {}),
    talks: d.talks,
    built_at: builtAt,
  }));
}

export function countByKind(facets) {
  const by = (k) => facets.filter((d) => d.kind === k).length;
  return { track: by('track'), room: by('room'), speaker: by('speaker'), tag: by('tag') };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = parseArgs(process.argv.slice(2), { values: ['event'] });
    if (!isSlug(args.event)) throw new UsageError('Usage: node worker/ingest/facets-local.mjs --event <slug>');
    const facets = buildFacets(args.event, readNdjson(join(ROOT, 'data', args.event, 'talks.ndjson')));
    const c = countByKind(facets);
    console.log(`${args.event}: ${facets.length} facets (${c.track} tracks, ${c.room} rooms, ${c.speaker} speakers, ${c.tag} tags).`);
  } catch (e) {
    console.error(e.message);
    process.exit(e instanceof UsageError ? 1 : 2);
  }
}
