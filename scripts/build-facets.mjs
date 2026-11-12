// Builds the small value-matching index, caddie-facets-v1 behind the alias caddie-facets, from the
// track, room, speaker and tag names of the talks already in caddie-talks. See server/facets.mjs
// for how the names are matched. Nothing here is embedded, so the embedding budget is not touched.
//
//   ELASTISEARCH_API_KEY=... node scripts/build-facets.mjs [--index caddie-facets-v1] [conference-slug ...]
//
// With no slug it rebuilds every conference that has talks. A rebuild writes the current names
// first and then deletes that conference's documents from earlier runs, so a search never sees an
// empty index. Run it again after ingesting a conference.
import { es, hasKey } from './lib/es.mjs';
import { esUrlOrExit } from './lib/es-url.mjs';
// Before the server module below, which refuses to load without ES_URL: print "Set ES_URL.", not a stack.
esUrlOrExit();
const { normalizeKey } = await import('../server/facets.mjs');
import { createHash } from 'node:crypto';

if (!hasKey()) {
  console.error('ELASTISEARCH_API_KEY is not set.');
  process.exit(1);
}

const args = process.argv.slice(2);
const at = args.indexOf('--index');
const INDEX = at !== -1 ? args[at + 1] : 'caddie-facets-v1';
const ALIAS = 'caddie-facets';
const slugsGiven = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--index');

function fail(message) {
  console.error(message);
  process.exit(1);
}

async function ensureIndex() {
  const exists = await es('HEAD', `/${INDEX}`);
  if (exists.status !== 200) {
    const created = await es('PUT', `/${INDEX}`, {
      settings: { number_of_shards: 1 },
      mappings: {
        dynamic: false,
        properties: {
          conference: { type: 'keyword' },
          kind: { type: 'keyword' },
          key: { type: 'keyword' },
          words: { type: 'text', analyzer: 'standard' },
          label: { type: 'keyword', index: false },
          value: { type: 'keyword', index: false },
          group: { type: 'keyword', index: false },
          talks: { type: 'integer' },
          built_at: { type: 'date' },
        },
      },
    });
    if (created.status !== 200) fail(`Creating ${INDEX} failed with status ${created.status}.`);
    console.log(`Created ${INDEX}.`);
  }
  const alias = await es('POST', '/_aliases', { actions: [{ add: { index: INDEX, alias: ALIAS } }] });
  if (alias.status !== 200) fail(`Pointing ${ALIAS} at ${INDEX} failed with status ${alias.status}.`);
}

// A room's keys: the whole string and every tail of its " | " parts, so "Hall DE" finds
// "Salt Palace | Level 1 | Hall DE". Its chip label is the last two parts.
function roomNames(room) {
  const parts = room.split('|').map((p) => p.trim()).filter(Boolean);
  const keys = new Set();
  for (let i = 0; i < parts.length; i++) keys.add(normalizeKey(parts.slice(i).join(' ')));
  return { label: parts.slice(-2).join(' · '), keys: [...keys].filter(Boolean), words: normalizeKey(parts.slice(-2).join(' ')) };
}

// Reads every talk of one conference. Only the four name fields are fetched.
async function readTalks(slug) {
  const { status, json } = await es('POST', '/caddie-talks/_search', {
    size: 10000,
    _source: ['track', 'room', 'speakers', 'tags'],
    query: { bool: { filter: [{ term: { conference: slug } }, { term: { kind: 'talk' } }] } },
  });
  if (status !== 200) fail(`Reading talks of ${slug} failed with status ${status}.`);
  return json.hits.hits.map((h) => h._source);
}

function collect(talks) {
  const names = new Map(); // "kind\0value\0group" -> doc fields
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

async function build(slug) {
  const builtAt = new Date().toISOString();
  const docs = collect(await readTalks(slug));
  const lines = [];
  for (const d of docs) {
    const id = createHash('sha1').update(`${slug}\0${d.kind}\0${d.value}\0${d.group ?? ''}`).digest('hex');
    lines.push(JSON.stringify({ index: { _index: INDEX, _id: id } }));
    lines.push(JSON.stringify({
      conference: slug, kind: d.kind, key: d.keys.filter(Boolean), words: d.words, label: d.label, value: d.value,
      ...(d.group ? { group: d.group } : {}), talks: d.talks, built_at: builtAt,
    }));
  }
  if (lines.length) {
    const bulk = await es('POST', '/_bulk?refresh=true', lines.join('\n') + '\n', { ndjson: true });
    if (bulk.status !== 200 || bulk.json?.errors) fail(`Bulk write for ${slug} failed with status ${bulk.status}.`);
  }
  const del = await es('POST', `/${INDEX}/_delete_by_query?refresh=true`, {
    query: { bool: { filter: [{ term: { conference: slug } }, { range: { built_at: { lt: builtAt } } }] } },
  });
  if (del.status !== 200) fail(`Removing old names for ${slug} failed with status ${del.status}.`);
  const by = (k) => docs.filter((d) => d.kind === k).length;
  console.log(`${slug}: ${by('track')} tracks, ${by('room')} rooms, ${by('speaker')} speakers, ${by('tag')} tags.`);
}

await ensureIndex();
let slugs = slugsGiven;
if (!slugs.length) {
  const { status, json } = await es('POST', '/caddie-talks/_search', {
    size: 0,
    query: { term: { kind: 'talk' } },
    aggs: { c: { terms: { field: 'conference', size: 500 } } },
  });
  if (status !== 200) fail(`Listing conferences failed with status ${status}.`);
  slugs = json.aggregations.c.buckets.map((b) => b.key);
}
for (const slug of slugs) await build(slug);
