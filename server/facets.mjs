// Value matching: the search sentence is compared with the track, room, speaker and tag names of
// the conference, and the names it contains become suggested chips ("Did you mean track: Security?").
// A suggestion is only ever offered; the client applies it when the person taps it.
//
// The names live in a small keyword index, caddie-facets-v1 behind the alias caddie-facets, built by
// scripts/build-facets.mjs from caddie-talks. Elasticsearch does the matching with plain terms and
// match queries; no model is involved and nothing is embedded.
//
// - Every name is stored with one or more normalised keys (lowercase, accents folded, anything that
//   is not a letter or digit turned into a space). A room such as "Salt Palace | Level 1 | Hall DE"
//   gets a key for the whole string and one for each tail of its parts, so "Hall DE" finds it.
// - The sentence is normalised the same way, cut into every run of one to six words, and sent as a
//   terms query on the keys, so a name found inside a longer sentence is found.
// - For a short sentence of up to four words, a match query with every word required also finds
//   tracks, rooms and tags that merely contain the words ("security" finds "Security + Identity").
//   Speakers are matched only by their whole name, because one first name would match many people.
// - A suggestion for a value that is already selected is left out.
// - A failure, or a missing facets index, gives no suggestions; the search itself is never affected.

import { esRequest, UpstreamError } from './search.mjs';
import { conferencePreference, withPreference } from './preference.mjs';

const ES_FACETS_INDEX = process.env.ES_FACETS_INDEX || 'caddie-facets';
const MAX_WORDS = 6;
const MAX_WINDOWS = 150;
const PARTIAL_MAX_WORDS = 4;
const MAX_SUGGESTIONS = 4;
const MAX_PER_KIND = 2;

// The one normaliser, shared by the index builder and the search, so both sides agree on a key.
export function normalizeKey(text) {
  return String(text)
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

// Every run of one to MAX_WORDS consecutive words, as a normalised string. Runs of a single
// character are left out, and the number of runs is capped.
function windows(words) {
  const seen = new Set();
  for (let i = 0; i < words.length && seen.size < MAX_WINDOWS; i++) {
    for (let n = 1; n <= MAX_WORDS && i + n <= words.length; n++) {
      const run = words.slice(i, i + n).join(' ');
      if (run.length >= 2) seen.add(run);
    }
  }
  return [...seen].slice(0, MAX_WINDOWS);
}

function selectedValues(filters) {
  return {
    track: new Set(filters.track),
    room: new Set(filters.room),
    speaker: new Set(filters.speaker),
    tag: new Set([...filters.tags.values()].flat().map((key) => key.split('\u001F')[1])),
  };
}

// Returns at most four { kind, label, value, group?, talks } suggestions for the sentence.
// kind is track, room, speaker or tag; value is what the matching filter takes.
export async function suggestChips(conference, text, filters) {
  const normal = normalizeKey(text);
  if (normal.length < 2) return [];
  const words = normal.split(' ');
  const should = [{ terms: { key: windows(words), boost: 3 } }];
  if (words.length <= PARTIAL_MAX_WORDS) {
    should.push({
      bool: {
        filter: [{ terms: { kind: ['track', 'room', 'tag'] } }, { match: { words: { query: normal, operator: 'and' } } }],
      },
    });
  }
  let json;
  try {
    json = await esRequest(withPreference(`/${encodeURIComponent(ES_FACETS_INDEX)}/_search?ignore_unavailable=true`, conferencePreference(conference)), {
      size: 20,
      _source: ['kind', 'label', 'value', 'group', 'talks'],
      query: { bool: { filter: [{ term: { conference } }], should, minimum_should_match: 1 } },
      sort: [{ _score: 'desc' }, { talks: 'desc' }],
    });
  } catch (err) {
    if (!(err instanceof UpstreamError)) console.error('Value matching failed.');
    return [];
  }
  const selected = selectedValues(filters);
  const perKind = new Map();
  const out = [];
  for (const h of json.hits?.hits ?? []) {
    const s = h._source;
    if (!s || selected[s.kind]?.has(s.value)) continue;
    if ((perKind.get(s.kind) ?? 0) >= MAX_PER_KIND) continue;
    perKind.set(s.kind, (perKind.get(s.kind) ?? 0) + 1);
    out.push({ kind: s.kind, label: s.label, value: s.value, ...(s.group ? { group: s.group } : {}), talks: s.talks ?? 0 });
    if (out.length >= MAX_SUGGESTIONS) break;
  }
  return out;
}
