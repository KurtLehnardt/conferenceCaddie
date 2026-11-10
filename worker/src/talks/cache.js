// Data derived from the cached talks, vectors, topics and facets of one ConferenceDO, built
// lazily and kept until the Store's talksEpoch changes (an ingest, a topics or a facets write).
// Every structure here lives in memory only, so building it reads no SQLite rows beyond the
// Store's own one-time loads.

const caches = new WeakMap(); // Store -> { epoch, values: Map }

function entry(store) {
  let c = caches.get(store);
  if (!c || c.epoch !== store.talksEpoch) {
    c = { epoch: store.talksEpoch, values: new Map() };
    caches.set(store, c);
  }
  return c;
}

// The value of name for this store and epoch, built once with build().
export function memo(store, name, build) {
  const c = entry(store);
  if (!c.values.has(name)) c.values.set(name, build());
  return c.values.get(name);
}

// A small least-recently-used map, cleared with the epoch because it lives in memo().
export class Lru {
  constructor(max) {
    this.max = max;
    this.map = new Map();
  }

  get(key) {
    const v = this.map.get(key);
    if (v === undefined) return undefined;
    this.map.delete(key);
    this.map.set(key, v);
    return v;
  }

  set(key, value) {
    this.map.delete(key);
    this.map.set(key, value);
    if (this.map.size > this.max) this.map.delete(this.map.keys().next().value);
  }
}

// Talks of kind talk or ambient (what search can return), and of kind talk only.
export const searchableTalks = (store) => memo(store, 'searchable', () => store.talks().filter((t) => t.kind === 'talk' || t.kind === 'ambient'));
export const talkOnly = (store) => memo(store, 'talkOnly', () => store.talks().filter((t) => t.kind === 'talk'));

// Every vector of a talk (title first, then the abstract chunks) and the chunk texts, by talk_id.
export const talkVecs = (store) => memo(store, 'vecs', () => {
  const out = new Map();
  for (const [id, e] of store.talkVectors()) {
    const list = [];
    if (e.title) list.push(e.title);
    const chunks = [];
    for (const c of e.chunks) {
      if (!c.vec) continue;
      list.push(c.vec);
      chunks.push(c);
    }
    if (list.length) out.set(id, { all: list, chunks });
  }
  return out;
});

// The values a filter may name: days, tracks, levels and tag keys of talks and ambient items.
export const knownValues = (store) => memo(store, 'known', () => {
  const day = new Set();
  const track = new Set();
  const level = new Set();
  const tagKeys = new Set();
  for (const t of searchableTalks(store)) {
    if (t.day) day.add(t.day);
    if (t.track) track.add(t.track);
    if (t.level) level.add(t.level);
    for (const k of t.tag_keys) if (typeof k === 'string') tagKeys.add(k);
  }
  return { day, track, level, tagKeys };
});

// The schedule's shape for time phrases: the days that have talks, and each day's lunch window
// from the break items whose title names lunch (the earliest start and the latest end).
export const scheduleShape = (store) => memo(store, 'shape', () => {
  const talkDays = [...new Set(talkOnly(store).map((t) => t.day).filter(Boolean))].sort();
  const lunch = new Map();
  for (const t of store.talks()) {
    if (t.kind !== 'break' || !t.day || !/\blunch(?:es)?\b/i.test(t.title)) continue;
    if (!Number.isFinite(t.start_minutes) || !Number.isFinite(t.end_minutes)) continue;
    const w = lunch.get(t.day);
    if (!w) lunch.set(t.day, { start: t.start_minutes, end: t.end_minutes });
    else {
      w.start = Math.min(w.start, t.start_minutes);
      w.end = Math.max(w.end, t.end_minutes);
    }
  }
  return { talkDays, lunch };
});

// The calendar date of an instant in a time zone, as YYYY-MM-DD.
export function localDate(ms, timeZone) {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: timeZone || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
  } catch {
    return new Date(ms).toISOString().slice(0, 10);
  }
}

// The local dates on which some talk starts, in the conference's time zone.
export const talkStartDates = (store, timeZone) => memo(store, `startDates:${timeZone}`, () => {
  const out = new Set();
  for (const t of talkOnly(store)) if (Number.isFinite(t.start_ms)) out.add(localDate(t.start_ms, timeZone));
  return out;
});
