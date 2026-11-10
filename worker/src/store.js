// The data layer of one ConferenceDO (PLAN section 1.6).
//
// The Store is the only way to read or write people, presence, shared talks and blocks, so the
// in-memory caches stay coherent: the Durable Object is the only writer of its database, and
// every write updates SQLite and the cached objects together. Talks, talk vectors, topics, facets
// and zones are read-only for handlers; the admin routes replace them and clear the caches.
//
// Objects returned by the Store are the cached objects themselves. Handlers must treat them as
// read-only and write through the Store methods.
//
// Positions (lat, lon, accuracy) live in memory only, so the server never stores a trail.

import { forbidden } from './lib/http.js';
import { hashSecret, secretMatches, refFor, sha256Hex } from './lib/device.js';
import { toBlob, fromBlob } from './lib/vectors.js';
import { embedPassages, semanticAvailable, EmbedUnavailable, conventionsId, documentText } from './lib/embed.js';
import { visibleUntilMs } from './lib/time.js';

// Zones a person can say they are in, besides the conference's room names.
export const FIXED_ZONES = ['Expo hall', 'Registration', 'Food and coffee', 'Hallway', 'Outside'];
const COMMON_TOPICS = 10;
const CHUNK_WORDS = 250;
const RETRY_BATCH = 25;
const DECLINED_KEEP_MS = 2 * 24 * 3600_000;

const parseArr = (s) => {
  if (typeof s !== 'string' || !s) return [];
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
};
const parseObj = (s) => {
  if (typeof s !== 'string' || !s) return {};
  try {
    const v = JSON.parse(s);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
};
const b = (v) => (v ? 1 : 0);
const arr = (v) => (Array.isArray(v) ? v : []);

// The hash that tells whether a write changes the embedded text, as server/people.mjs textHash.
export const textHashOf = (p) => sha256Hex(JSON.stringify([p.about ?? '', p.interests ?? '', p.expertise ?? '']));

// Abstract chunks of at most 250 words each.
export function chunkWords(textValue, max = CHUNK_WORDS) {
  const words = String(textValue ?? '').split(/\s+/).filter(Boolean);
  const out = [];
  for (let i = 0; i < words.length; i += max) out.push(words.slice(i, i + max).join(' '));
  return out;
}

// The columns of a people row that savePerson may change: [to the SQL value, to the cached value].
const str = (v) => String(v ?? '');
const orNull = (v) => (v ? String(v) : null);
const PERSON_COLUMNS = {
  display_name: [str, str],
  about: [str, str],
  interests: [str, str],
  expertise: [str, str],
  learn_topics: [(v) => JSON.stringify(arr(v)), arr],
  speak_topics: [(v) => JSON.stringify(arr(v)), arr],
  linkedin_url: [orNull, orNull],
  contact_note: [orNull, orNull],
  open_to_meet: [b, Boolean],
  sample: [b, Boolean],
  hidden: [b, Boolean],
  spot_hidden: [b, Boolean],
  visible_until_ms: [Number, Number],
  updated_at_ms: [Number, Number],
};
const TEXT_FIELDS = ['about', 'interests', 'expertise'];

function personFromRow(r) {
  return {
    profile_id: r.profile_id,
    ref: r.ref,
    secret_hash: r.secret_hash,
    display_name: r.display_name ?? '',
    about: r.about ?? '',
    interests: r.interests ?? '',
    expertise: r.expertise ?? '',
    learn_topics: parseArr(r.learn_topics),
    speak_topics: parseArr(r.speak_topics),
    linkedin_url: r.linkedin_url ?? null,
    contact_note: r.contact_note ?? null,
    open_to_meet: r.open_to_meet === 1,
    sample: r.sample === 1,
    hidden: r.hidden === 1,
    spot_hidden: r.spot_hidden === 1,
    visible_until_ms: r.visible_until_ms,
    updated_at_ms: r.updated_at_ms,
    text_hash: r.text_hash ?? null,
    text_pending: r.text_pending === 1,
    shared_talk_ids: [],
    vec: { about: fromBlob(r.vec_about), interests: fromBlob(r.vec_interests), expertise: fromBlob(r.vec_expertise) },
    presence: null,
    _rowid: r._rowid,
  };
}

function presenceFromRow(r, location) {
  return {
    zone: r.zone ?? null,
    spot: r.spot ?? null,
    spot_pending: r.spot_pending === 1,
    since_ms: r.since_ms ?? null,
    until_ms: r.until_ms,
    ble_token: r.ble_token ?? null,
    ble_token_until_ms: r.ble_token_until_ms ?? null,
    presence_nonce: r.presence_nonce ?? null,
    ble_master_id: r.ble_master_id ?? null,
    ble_rotated: r.ble_rotated === 1,
    location: location ?? null,
  };
}

function talkFromRow(r, slug) {
  return {
    talk_id: r.talk_id,
    conference: slug,
    kind: r.kind,
    title: r.title,
    abstract: r.abstract ?? '',
    speakers: parseArr(r.speakers),
    speaker_taglines: parseArr(r.speaker_taglines),
    speaker_profiles: parseArr(r.speaker_profiles),
    room: r.room ?? null,
    track: r.track ?? null,
    level: r.level ?? null,
    tag_keys: parseArr(r.tag_keys),
    tags: parseArr(r.tags),
    topics: parseArr(r.topics),
    sponsor: r.sponsor === 1,
    has_slides: r.has_slides === 1,
    start: r.start ?? null,
    end: r.end ?? null,
    start_ms: r.start_ms ?? null,
    end_ms: r.end_ms ?? null,
    day: r.day ?? null,
    start_minutes: r.start_minutes ?? null,
    end_minutes: r.end_minutes ?? null,
    session_id: r.session_id ?? null,
    slides_url: r.slides_url ?? null,
    url: r.url ?? null,
    content_hash: r.content_hash ?? null,
    text_hash: r.text_hash ?? null,
    ingested_at: r.ingested_at ?? null,
    generation: r.generation,
    _rowid: r._rowid,
  };
}

export class Store {
  // owner is the ConferenceDO: owner.exec (the metered SQL), owner.state, owner.env, owner.slug.
  constructor(owner) {
    this.owner = owner;
    this.locations = new Map(); // profile_id -> { lat, lon, accuracy }
    this.peopleC = null; // { byId, byRef, byRowid }
    this.blocksC = null; // { by: Map blocker -> Set blocked, of: Map blocked -> Set blocker }
    this.talksC = null; // { list, byId, byRowid }
    this.vectorsC = null; // Map talk_id -> { title, chunks }
    this.topicsC = null;
    this.facetsC = null;
    this.zonesC = null;
    // Incremented whenever talks, vectors, topics or facets change, so a route module can key its
    // own caches (lexical results, the schedule export) on it.
    this.talksEpoch = 0;
  }

  sql(query, ...bindings) {
    return this.owner.exec(query, ...bindings);
  }

  // The number of rows a statement with RETURNING produced.
  #count(query, ...bindings) {
    return this.sql(query, ...bindings).toArray().length;
  }

  tx(fn) {
    return this.owner.state.storage.transactionSync(fn);
  }

  get slug() {
    return this.owner.slug;
  }

  // ------------------------------------------------------------------------------------------
  // Talks, vectors, topics, facets and zones (read-only for handlers).

  invalidateTalks() {
    this.talksC = null;
    this.vectorsC = null;
    this.zonesC = null;
    this.talksEpoch += 1;
  }

  invalidateTopics() {
    this.topicsC = null;
    this.talksEpoch += 1;
  }

  invalidateFacets() {
    this.facetsC = null;
    this.talksEpoch += 1;
  }

  #talks() {
    if (!this.talksC) {
      const list = this.sql('SELECT rowid AS _rowid, * FROM talks ORDER BY start_ms, talk_id').toArray().map((r) => talkFromRow(r, this.slug));
      const byId = new Map();
      const byRowid = new Map();
      for (const t of list) {
        byId.set(t.talk_id, t);
        byRowid.set(t._rowid, t);
      }
      this.talksC = { list, byId, byRowid };
    }
    return this.talksC;
  }

  // All talk rows as objects (arrays parsed), sorted by start_ms, talk_id.
  talks() {
    return this.#talks().list;
  }

  talk(id) {
    return this.#talks().byId.get(id) ?? null;
  }

  // The talk whose base-table rowid (and talks_fts rowid) is rowid.
  talkByRowid(rowid) {
    return this.#talks().byRowid.get(rowid) ?? null;
  }

  // Map talk_id -> { doc: Float32Array|null, chunks: [{ text, vec }] }. doc is the vector of the
  // talk's document text (title + "\n" + abstract, the bundle's); a 'title' row from before the
  // embedding conventions stands in for it until the talk is embedded again.
  talkVectors() {
    if (!this.vectorsC) {
      const map = new Map();
      for (const r of this.sql('SELECT talk_id, part, chunk, vec FROM talk_vectors')) {
        let e = map.get(r.talk_id);
        if (!e) {
          e = { doc: null, chunks: [] };
          map.set(r.talk_id, e);
        }
        const vec = fromBlob(r.vec);
        if (r.part === 'doc' || (r.part === 'title' && !e.doc)) e.doc = vec;
        else e.chunks.push({ text: r.chunk, vec, n: Number(String(r.part).split(':')[1]) || 0 });
      }
      for (const e of map.values()) {
        e.chunks.sort((a, c) => a.n - c.n);
        for (const c of e.chunks) delete c.n;
      }
      this.vectorsC = map;
    }
    return this.vectorsC;
  }

  // { list (by rank, label_exact), byId, labels: Map id -> label, common: Set of the 10 topics
  // on the most talks }.
  topics() {
    if (!this.topicsC) {
      const list = this.sql('SELECT * FROM topics ORDER BY rank, label_exact').toArray().map((r) => ({
        topic_id: r.topic_id,
        label: r.label,
        label_exact: r.label_exact ?? r.label,
        aliases: parseArr(r.aliases),
        talk_count: r.talk_count,
        rank: r.rank,
      }));
      const byId = new Map(list.map((t) => [t.topic_id, t]));
      const labels = new Map(list.map((t) => [t.topic_id, t.label ?? t.topic_id]));
      const common = new Set(
        [...list]
          .sort((a, c) => c.talk_count - a.talk_count || (a.topic_id < c.topic_id ? -1 : a.topic_id > c.topic_id ? 1 : 0))
          .slice(0, COMMON_TOPICS)
          .map((t) => t.topic_id),
      );
      this.topicsC = { list, byId, labels, common };
    }
    return this.topicsC;
  }

  // Every facet row, with key parsed.
  facets() {
    if (!this.facetsC) {
      this.facetsC = this.sql('SELECT * FROM facets').toArray().map((r) => ({
        id: r.id,
        kind: r.kind,
        key: parseArr(r.key),
        words: r.words ?? '',
        label: r.label ?? null,
        value: r.value ?? null,
        group: r.group ?? null,
        talks: r.talks ?? 0,
        built_at: r.built_at ?? null,
      }));
    }
    return this.facetsC;
  }

  // The zones a person can be in: FIXED_ZONES, then the distinct non-empty rooms of the
  // conference's talks (kind talk) in alphabetical order. A Set, in that order.
  zones() {
    if (!this.zonesC) {
      const rooms = new Set();
      for (const t of this.talks()) {
        const r = typeof t.room === 'string' ? t.room.trim() : '';
        if (t.kind === 'talk' && r) rooms.add(r);
      }
      this.zonesC = new Set([...FIXED_ZONES, ...[...rooms].sort((a, c) => a.localeCompare(c))]);
    }
    return this.zonesC;
  }

  // ------------------------------------------------------------------------------------------
  // People.

  invalidatePeople() {
    this.peopleC = null;
    this.blocksC = null;
  }

  #people() {
    if (!this.peopleC) {
      const byId = new Map();
      const byRef = new Map();
      const byRowid = new Map();
      for (const r of this.sql('SELECT rowid AS _rowid, * FROM people')) {
        const p = personFromRow(r);
        byId.set(p.profile_id, p);
        byRef.set(p.ref, p);
        byRowid.set(p._rowid, p);
      }
      for (const r of this.sql('SELECT profile_id, talk_id FROM shared_talks')) byId.get(r.profile_id)?.shared_talk_ids.push(r.talk_id);
      for (const r of this.sql('SELECT * FROM presence')) {
        const p = byId.get(r.profile_id);
        if (p) p.presence = presenceFromRow(r, this.locations.get(r.profile_id));
      }
      this.peopleC = { byId, byRef, byRowid };
    }
    return this.peopleC;
  }

  // One person, live or not, or null.
  person(id) {
    return this.#people().byId.get(id) ?? null;
  }

  personByRef(ref) {
    return this.#people().byRef.get(ref) ?? null;
  }

  // The person whose base-table rowid (and people_fts rowid) is rowid.
  personByRowid(rowid) {
    return this.#people().byRowid.get(rowid) ?? null;
  }

  // Every person whose visible_until_ms is in the future.
  people() {
    const now = Date.now();
    const out = [];
    for (const p of this.#people().byId.values()) if (p.visible_until_ms > now) out.push(p);
    return out;
  }

  isLive(p) {
    return Boolean(p) && p.visible_until_ms > Date.now();
  }

  isAround(p) {
    return Boolean(p?.presence) && p.presence.until_ms > Date.now();
  }

  // The caller's person: null when there is no row, 403 on a wrong secret, null when the row is
  // not live.
  async authenticate(device) {
    if (!device) return null;
    const p = this.person(device.profileId);
    if (!p) return null;
    if (!(await secretMatches(device.secret, p.secret_hash))) throw forbidden();
    if (!this.isLive(p)) return null;
    return p;
  }

  // The first write of a profile: inserts a row with secret_hash when none exists. An existing
  // row with another secret gives 403; an existing row with this secret gets the fields saved
  // (an expired one is replaced by a fresh row). fields may hold any savePerson column plus
  // shared_talk_ids. Returns the Person.
  async claim(device, fields = {}) {
    const { shared_talk_ids: shared, ...patch } = fields;
    const existing = this.person(device.profileId);
    if (existing) {
      if (!(await secretMatches(device.secret, existing.secret_hash))) throw forbidden();
      if (this.isLive(existing)) return this.savePerson(device.profileId, patch, shared === undefined ? {} : { sharedTalkIds: shared });
      this.deletePersonEverywhere(device.profileId);
    }
    return this.insertPerson({
      profile_id: device.profileId,
      secret_hash: await hashSecret(device.secret),
      ...patch,
      shared_talk_ids: shared ?? [],
    });
  }

  // Inserts (or overwrites) a people row from a complete document: profile_id and secret_hash
  // are required; ref is computed; visible_until_ms defaults to the end of the conference. Used
  // by claim, the migration route and the smoke fixtures. Vectors are cleared.
  async insertPerson(doc) {
    const now = Date.now();
    const conf = this.owner.conf;
    const p = {
      profile_id: doc.profile_id,
      ref: await refFor(this.owner.env, this.slug, doc.profile_id),
      secret_hash: doc.secret_hash,
      display_name: String(doc.display_name ?? ''),
      about: String(doc.about ?? ''),
      interests: String(doc.interests ?? ''),
      expertise: String(doc.expertise ?? ''),
      learn_topics: arr(doc.learn_topics),
      speak_topics: arr(doc.speak_topics),
      linkedin_url: doc.linkedin_url || null,
      contact_note: doc.contact_note || null,
      open_to_meet: doc.open_to_meet === true || doc.open_to_meet === 1,
      sample: doc.sample === true || doc.sample === 1,
      hidden: doc.hidden === true || doc.hidden === 1,
      spot_hidden: doc.spot_hidden === true || doc.spot_hidden === 1,
      visible_until_ms: Number.isFinite(doc.visible_until_ms) ? doc.visible_until_ms : conf?.visible_until_ms ?? visibleUntilMs(conf?.end_date, conf?.time_zone),
      updated_at_ms: Number.isFinite(doc.updated_at_ms) ? doc.updated_at_ms : now,
    };
    p.text_hash = await textHashOf(p);
    p.text_pending = TEXT_FIELDS.some((f) => p[f].trim());
    const shared = [...new Set(arr(doc.shared_talk_ids))];
    let rowid;
    this.tx(() => {
      // An earlier row for this profile (an expired one, or a migration re-run) goes first, with
      // everything that hangs off it, so the insert starts clean.
      if (this.sql('SELECT 1 FROM people WHERE profile_id = ?', p.profile_id).toArray().length) this.#deleteRows(p.profile_id);
      rowid = this.sql(
        `INSERT INTO people (profile_id, ref, secret_hash, display_name, about, interests, expertise, learn_topics, speak_topics,
           linkedin_url, contact_note, open_to_meet, sample, hidden, spot_hidden, visible_until_ms, updated_at_ms, text_hash, text_pending)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(profile_id) DO UPDATE SET ref = excluded.ref, secret_hash = excluded.secret_hash, display_name = excluded.display_name,
           about = excluded.about, interests = excluded.interests, expertise = excluded.expertise, learn_topics = excluded.learn_topics,
           speak_topics = excluded.speak_topics, linkedin_url = excluded.linkedin_url, contact_note = excluded.contact_note,
           open_to_meet = excluded.open_to_meet, sample = excluded.sample, hidden = excluded.hidden, spot_hidden = excluded.spot_hidden,
           visible_until_ms = excluded.visible_until_ms, updated_at_ms = excluded.updated_at_ms, text_hash = excluded.text_hash,
           text_pending = excluded.text_pending, vec_about = NULL, vec_interests = NULL, vec_expertise = NULL
         RETURNING rowid`,
        p.profile_id, p.ref, p.secret_hash, p.display_name, p.about, p.interests, p.expertise,
        JSON.stringify(p.learn_topics), JSON.stringify(p.speak_topics), p.linkedin_url, p.contact_note,
        b(p.open_to_meet), b(p.sample), b(p.hidden), b(p.spot_hidden), p.visible_until_ms, p.updated_at_ms, p.text_hash, b(p.text_pending),
      ).one().rowid;
      this.sql('INSERT INTO people_fts (rowid, profile_id, about, expertise, interests) VALUES (?, ?, ?, ?, ?)', rowid, p.profile_id, p.about, p.expertise, p.interests);
      for (const t of shared) this.sql('INSERT OR IGNORE INTO shared_talks (profile_id, talk_id) VALUES (?, ?)', p.profile_id, t);
    });
    this.#forget(p.profile_id);
    if (this.peopleC) {
      const person = {
        ...p,
        shared_talk_ids: shared,
        vec: { about: null, interests: null, expertise: null },
        presence: null,
        _rowid: rowid,
      };
      this.peopleC.byId.set(person.profile_id, person);
      this.peopleC.byRef.set(person.ref, person);
      this.peopleC.byRowid.set(rowid, person);
      return person;
    }
    return this.person(p.profile_id);
  }

  // Updates the given columns of a person (PERSON_COLUMNS), the FTS row only when the text
  // changed, and only the added or removed shared_talks rows, in one transaction. When the text
  // hash changes, the vectors are cleared and text_pending is set while any text is non-empty.
  // updated_at_ms is set to now unless the patch gives it or { touch: false } is passed.
  async savePerson(id, patch = {}, { sharedTalkIds, touch = true } = {}) {
    const p = this.person(id);
    if (!p) return null;
    const cols = {};
    const next = { ...p };
    for (const [k, [toSql, toCache]] of Object.entries(PERSON_COLUMNS)) {
      if (!(k in patch) || patch[k] === undefined) continue;
      const stored = toSql(patch[k]);
      if (stored !== toSql(p[k])) cols[k] = stored;
      next[k] = toCache(patch[k]);
    }
    for (const f of TEXT_FIELDS) next[f] = String(next[f] ?? '');
    let textChanged = false;
    if (TEXT_FIELDS.some((f) => f in cols)) {
      const h = await textHashOf(next);
      if (h !== p.text_hash) {
        textChanged = true;
        cols.text_hash = h;
        cols.text_pending = TEXT_FIELDS.some((f) => next[f].trim()) ? 1 : 0;
        cols.vec_about = null;
        cols.vec_interests = null;
        cols.vec_expertise = null;
      }
    }
    let added = [];
    let removed = [];
    if (Array.isArray(sharedTalkIds)) {
      const want = new Set(sharedTalkIds);
      const have = new Set(p.shared_talk_ids);
      added = [...want].filter((t) => !have.has(t));
      removed = [...have].filter((t) => !want.has(t));
    }
    if (!Object.keys(cols).length && !added.length && !removed.length) return p;
    if (touch && !('updated_at_ms' in patch)) cols.updated_at_ms = Date.now();
    const keys = Object.keys(cols);
    this.tx(() => {
      if (keys.length) this.sql(`UPDATE people SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE profile_id = ?`, ...keys.map((k) => cols[k]), id);
      if (textChanged) {
        this.sql('DELETE FROM people_fts WHERE rowid = ?', p._rowid);
        this.sql('INSERT INTO people_fts (rowid, profile_id, about, expertise, interests) VALUES (?, ?, ?, ?, ?)', p._rowid, id, next.about, next.expertise, next.interests);
      }
      for (const t of removed) this.sql('DELETE FROM shared_talks WHERE profile_id = ? AND talk_id = ?', id, t);
      for (const t of added) this.sql('INSERT OR IGNORE INTO shared_talks (profile_id, talk_id) VALUES (?, ?)', id, t);
    });
    // Update the cached object in place, so every holder sees the new values.
    for (const k of Object.keys(PERSON_COLUMNS)) if (k in patch && patch[k] !== undefined) p[k] = next[k];
    if ('updated_at_ms' in cols) p.updated_at_ms = cols.updated_at_ms;
    if (textChanged) {
      p.text_hash = cols.text_hash;
      p.text_pending = cols.text_pending === 1;
      p.vec = { about: null, interests: null, expertise: null };
    }
    if (Array.isArray(sharedTalkIds)) p.shared_talk_ids = [...new Set(sharedTalkIds)];
    return p;
  }

  // Stores vectors (Float32Array or null; undefined leaves a field alone) and clears text_pending
  // once every non-empty text field has one.
  setVectors(id, vecs) {
    const p = this.person(id);
    if (!p) return null;
    const vec = { ...p.vec };
    for (const f of TEXT_FIELDS) if (vecs[f] !== undefined) vec[f] = vecs[f] ?? null;
    const pending = TEXT_FIELDS.some((f) => p[f].trim() && !vec[f]);
    this.sql(
      'UPDATE people SET vec_about = ?, vec_interests = ?, vec_expertise = ?, text_pending = ? WHERE profile_id = ?',
      toBlob(vec.about), toBlob(vec.interests), toBlob(vec.expertise), b(pending), id,
    );
    p.vec = vec;
    p.text_pending = pending;
    return p;
  }

  // Deletes the rows of one person in every table (except reports, and the blocks other people
  // made of this person). Runs inside a transaction.
  //
  // A block belongs to its blocker (server/connect.mjs, docs/contracts/people-api.md): it goes with
  // the blocker's profile, with an unblock, or with the purge once its expires_at_ms (the end of the
  // conference) has passed. The blocked person deleting their profile leaves it in place, so a
  // profile re-created from the same device is still blocked.
  #deleteRows(id) {
    this.sql('DELETE FROM presence WHERE profile_id = ?', id);
    this.sql('DELETE FROM shared_talks WHERE profile_id = ?', id);
    this.sql('DELETE FROM people_fts WHERE rowid = (SELECT rowid FROM people WHERE profile_id = ?)', id);
    this.sql('DELETE FROM blocks WHERE blocker_id = ?', id);
    this.sql('DELETE FROM ble_caps WHERE profile_id = ?', id);
    this.sql('DELETE FROM meets WHERE requester_id = ? OR recipient_id = ?', id, id);
    this.sql('DELETE FROM push_subs WHERE profile_id = ?', id);
    this.sql('DELETE FROM nudges WHERE a_id = ? OR b_id = ?', id, id);
    this.sql('DELETE FROM nudge_sends WHERE receiver_id = ?', id);
    this.sql('DELETE FROM people WHERE profile_id = ?', id);
  }

  // Drops one person from the caches.
  #forget(id) {
    this.locations.delete(id);
    if (this.peopleC) {
      const p = this.peopleC.byId.get(id);
      if (p) {
        this.peopleC.byId.delete(id);
        this.peopleC.byRef.delete(p.ref);
        this.peopleC.byRowid.delete(p._rowid);
      }
    }
    // Only the blocks this person made go; the blocks others made of them stay (#deleteRows).
    if (this.blocksC) {
      for (const other of this.blocksC.by.get(id) ?? []) this.blocksC.of.get(other)?.delete(id);
      this.blocksC.by.delete(id);
    }
  }

  // In one transaction: presence, shared talks, the FTS row, the blocks the person made, the
  // Bluetooth caps record, meets the person takes part in, push subscriptions, nudges and nudge
  // sends naming the person, then the people row. Reports and the blocks other people made of the
  // person are kept. Returns true when a row existed.
  deletePersonEverywhere(id) {
    const existed = this.sql('SELECT 1 FROM people WHERE profile_id = ?', id).toArray().length > 0;
    this.tx(() => this.#deleteRows(id));
    this.#forget(id);
    return existed;
  }

  // ------------------------------------------------------------------------------------------
  // Presence and positions.

  // Upserts the presence row, merged with the current one. fields: zone, spot, spot_pending,
  // since_ms, until_ms, ble_token, ble_token_until_ms, presence_nonce, ble_master_id, ble_rotated.
  // until_ms must end up set.
  setPresence(id, fields) {
    const p = this.person(id);
    if (!p) return null;
    const cur = p.presence ?? {};
    const n = { zone: null, spot: null, spot_pending: false, since_ms: null, until_ms: null, ble_token: null, ble_token_until_ms: null, presence_nonce: null, ble_master_id: null, ble_rotated: false };
    for (const k of Object.keys(n)) {
      if (k in fields && fields[k] !== undefined) n[k] = fields[k];
      else if (k in cur) n[k] = cur[k];
    }
    if (!Number.isFinite(n.until_ms)) throw new TypeError('setPresence needs until_ms');
    this.sql(
      `INSERT INTO presence (profile_id, zone, spot, spot_pending, since_ms, until_ms, ble_token, ble_token_until_ms, presence_nonce, ble_master_id, ble_rotated)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(profile_id) DO UPDATE SET zone = excluded.zone, spot = excluded.spot, spot_pending = excluded.spot_pending,
         since_ms = excluded.since_ms, until_ms = excluded.until_ms, ble_token = excluded.ble_token, ble_token_until_ms = excluded.ble_token_until_ms,
         presence_nonce = excluded.presence_nonce, ble_master_id = excluded.ble_master_id, ble_rotated = excluded.ble_rotated`,
      id, n.zone, n.spot, b(n.spot_pending), n.since_ms, n.until_ms, n.ble_token, n.ble_token_until_ms, n.presence_nonce, n.ble_master_id, b(n.ble_rotated),
    );
    p.presence = { ...n, spot_pending: Boolean(n.spot_pending), ble_rotated: Boolean(n.ble_rotated), location: this.locations.get(id) ?? null };
    return p.presence;
  }

  // Deletes the presence row and forgets the position.
  clearPresence(id) {
    this.sql('DELETE FROM presence WHERE profile_id = ?', id);
    this.locations.delete(id);
    const p = this.peopleC?.byId.get(id);
    if (p) p.presence = null;
  }

  // Keeps a position ({ lat, lon, accuracy }) in memory only; null forgets it. No row is written.
  setLocation(id, loc) {
    if (loc) this.locations.set(id, loc);
    else this.locations.delete(id);
    const p = this.peopleC?.byId.get(id);
    if (p?.presence) p.presence.location = loc ?? null;
  }

  // ------------------------------------------------------------------------------------------
  // Blocks.

  #blocks() {
    if (!this.blocksC) {
      const by = new Map();
      const of = new Map();
      for (const r of this.sql('SELECT blocker_id, blocked_id FROM blocks')) {
        if (!by.has(r.blocker_id)) by.set(r.blocker_id, new Set());
        by.get(r.blocker_id).add(r.blocked_id);
        if (!of.has(r.blocked_id)) of.set(r.blocked_id, new Set());
        of.get(r.blocked_id).add(r.blocker_id);
      }
      this.blocksC = { by, of };
    }
    return this.blocksC;
  }

  // The profile ids blocked by id or blocking id, as a new Set.
  blockedIds(id) {
    const c = this.#blocks();
    return new Set([...(c.by.get(id) ?? []), ...(c.of.get(id) ?? [])]);
  }

  blockedBetween(a, b2) {
    const c = this.#blocks();
    return Boolean(c.by.get(a)?.has(b2) || c.by.get(b2)?.has(a));
  }

  // Writes blocker's block of blocked, whose ref is blockedRef, running out at expiresAtMs.
  // Blocking the same person again rewrites the row, as server/connect.mjs rewrites the document.
  addBlock(blocker, blocked, blockedRef, expiresAtMs) {
    this.sql(
      `INSERT INTO blocks (blocker_id, blocked_id, created_at_ms, blocked_ref, expires_at_ms) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(blocker_id, blocked_id) DO UPDATE SET created_at_ms = excluded.created_at_ms,
         blocked_ref = excluded.blocked_ref, expires_at_ms = excluded.expires_at_ms`,
      blocker, blocked, Date.now(), blockedRef, expiresAtMs,
    );
    const c = this.#blocks();
    if (!c.by.has(blocker)) c.by.set(blocker, new Set());
    c.by.get(blocker).add(blocked);
    if (!c.of.has(blocked)) c.of.set(blocked, new Set());
    c.of.get(blocked).add(blocker);
  }

  // Removes blocker's block of the person with this ref, by the stored ref, so a block can be
  // lifted after the blocked person deleted their profile. A row written before blocks kept the
  // ref has it computed (refFor). Returns the number of rows removed.
  async removeBlockByRef(blocker, ref) {
    const gone = this.sql('DELETE FROM blocks WHERE blocker_id = ? AND blocked_ref = ? RETURNING blocked_id', blocker, ref).toArray().map((r) => r.blocked_id);
    for (const r of this.sql('SELECT blocked_id FROM blocks WHERE blocker_id = ? AND blocked_ref IS NULL', blocker).toArray()) {
      if ((await refFor(this.owner.env, this.slug, r.blocked_id)) !== ref) continue;
      gone.push(...this.sql('DELETE FROM blocks WHERE blocker_id = ? AND blocked_id = ? RETURNING blocked_id', blocker, r.blocked_id).toArray().map((x) => x.blocked_id));
    }
    const c = this.#blocks();
    for (const id of gone) {
      c.by.get(blocker)?.delete(id);
      c.of.get(id)?.delete(blocker);
    }
    return gone.length;
  }

  // [{ profile_id, ref, created_at_ms }] of the people id blocked and whose block has not run out,
  // newest first (at most 1,000). ref is null on a row written before blocks kept it.
  blocksBy(id, now = Date.now()) {
    return this.sql(
      `SELECT blocked_id AS profile_id, blocked_ref AS ref, created_at_ms FROM blocks
       WHERE blocker_id = ? AND (expires_at_ms IS NULL OR expires_at_ms > ?) ORDER BY created_at_ms DESC LIMIT 1000`,
      id, now,
    ).toArray();
  }

  // ------------------------------------------------------------------------------------------
  // The Bluetooth caps record (docs/contracts/ble-tokens.md, Phase 4 mitigation 2): whom sightings
  // answers returned to a requesting device in the last hour, as applyCaps's state.

  // An entry stamped later than now (by a request that started later but wrote first, while this
  // one waited on ranking) counts as returned at now, as server/ble.mjs capsState clamps it, so
  // concurrent requests of one device cannot together exceed the caps.
  bleCaps(id, now = Date.now()) {
    const entries = this.sql('SELECT ref, at_ms, w FROM ble_caps WHERE profile_id = ? AND at_ms > ?', id, now - 3600_000).toArray();
    return { entries: entries.map((e) => ({ id: e.ref, at: Math.min(e.at_ms, now), w: e.w })) };
  }

  // Adds the entries an answer added to the device's record ([{ id, at, w }], id being a ref) and
  // prunes the record to the last hour, in one transaction.
  addBleCaps(id, added, now = Date.now()) {
    this.tx(() => {
      this.sql('DELETE FROM ble_caps WHERE profile_id = ? AND at_ms <= ?', id, now - 3600_000);
      for (const e of added) this.sql('INSERT INTO ble_caps (profile_id, ref, at_ms, w) VALUES (?, ?, ?, ?)', id, e.id, e.at, e.w);
    });
  }

  // ------------------------------------------------------------------------------------------
  // Circles.

  // { talk_id: n } over live, not hidden people, zero-filled for every requested id.
  circleCounts(talkIds) {
    const counts = Object.fromEntries(talkIds.map((id) => [id, 0]));
    const want = new Set(talkIds);
    for (const p of this.people()) {
      if (p.hidden) continue;
      for (const t of p.shared_talk_ids) if (want.has(t)) counts[t] += 1;
    }
    return counts;
  }

  // ------------------------------------------------------------------------------------------
  // Moderation: report hides (T3) and operator actions (admin).

  #targetPerson(id, ownerId) {
    return (ownerId ? this.person(ownerId) : null) ?? this.personByRef(id);
  }

  // Hides a target. profile: the person's hidden flag; spot: the spot line is cleared and
  // spot_hidden set; meet: hidden with hidden_owner_id, the one participant who keeps seeing it.
  // id is the ref for a profile or spot and the meet id for a meet. Returns true when found.
  hideTarget(kind, id, ownerId = null) {
    if (kind === 'meet') {
      return this.#count('UPDATE meets SET hidden = 1, hidden_owner_id = ?, version = version + 1 WHERE meet_id = ? RETURNING 1', ownerId, id) > 0;
    }
    const p = this.#targetPerson(id, ownerId);
    if (!p) return false;
    if (kind === 'profile') {
      this.sql('UPDATE people SET hidden = 1 WHERE profile_id = ?', p.profile_id);
      p.hidden = true;
      return true;
    }
    if (kind === 'spot') {
      this.tx(() => {
        this.sql('UPDATE people SET spot_hidden = 1 WHERE profile_id = ?', p.profile_id);
        this.sql('UPDATE presence SET spot = NULL, spot_pending = 0 WHERE profile_id = ?', p.profile_id);
      });
      p.spot_hidden = true;
      if (p.presence) {
        p.presence.spot = null;
        p.presence.spot_pending = false;
      }
      return true;
    }
    return false;
  }

  // Clears a target's hidden flag and removes its reports, so it needs two fresh reports to be
  // hidden again. Returns { found, removed }.
  unhideTarget(kind, id) {
    let found = false;
    if (kind === 'meet') {
      found = this.#count('UPDATE meets SET hidden = 0, hidden_owner_id = NULL, version = version + 1 WHERE meet_id = ? RETURNING 1', id) > 0;
    } else {
      const p = this.personByRef(id);
      if (p) {
        found = true;
        if (kind === 'profile') {
          this.sql('UPDATE people SET hidden = 0 WHERE profile_id = ?', p.profile_id);
          p.hidden = false;
        } else if (kind === 'spot') {
          this.sql('UPDATE people SET spot_hidden = 0 WHERE profile_id = ?', p.profile_id);
          p.spot_hidden = false;
        }
      }
    }
    const removed = this.#count('DELETE FROM reports WHERE target_kind = ? AND target_id = ? RETURNING 1', kind, id);
    return { found, removed };
  }

  // Removes a target: a profile everywhere, a meet row, or the spot line (which stays hidden).
  // Returns true when found.
  deleteTarget(kind, id) {
    if (kind === 'meet') return this.#count('DELETE FROM meets WHERE meet_id = ? RETURNING 1', id) > 0;
    const p = this.personByRef(id);
    if (!p) return false;
    if (kind === 'profile') return this.deletePersonEverywhere(p.profile_id);
    if (kind === 'spot') return this.hideTarget('spot', id, p.profile_id);
    return false;
  }

  // ------------------------------------------------------------------------------------------
  // Embeddings.

  // Embeds the three text fields of the given people and stores the vectors. Returns
  // { embedded, pending }. Never throws for an AI failure: the people stay pending.
  async embedPeople(ctx, ids) {
    let embedded = 0;
    let pending = 0;
    const people = ids.map((id) => this.person(id)).filter(Boolean);
    if (!people.length) return { embedded, pending };
    let vecs;
    try {
      vecs = await embedPassages(ctx, people.flatMap((p) => TEXT_FIELDS.map((f) => p[f])));
    } catch (err) {
      if (!(err instanceof EmbedUnavailable)) throw err;
      return { embedded, pending: people.length };
    }
    people.forEach((p, i) => {
      const [about, interests, expertise] = vecs.slice(i * 3, i * 3 + 3);
      // A person whose text changed while the AI call ran keeps its pending state.
      if (this.person(p.profile_id) !== p) return;
      this.setVectors(p.profile_id, { about, interests, expertise });
      if (p.text_pending) pending += 1;
      else embedded += 1;
    });
    return { embedded, pending };
  }

  // Embeds the given talks (rows with talk_id, title, abstract, text_hash) and replaces their
  // vectors: one 'doc' vector of the document text, exactly as the talk bundles embed it
  // (lib/embed.js, Embedding conventions), plus abstract chunks of at most 250 words, which pick
  // the evidence passage. Returns { embedded, pending }. Never throws for an AI failure: those
  // talks stay pending and meta.talks_pending is set for the cron.
  async embedTalks(ctx, talks) {
    if (!talks.length) return { embedded: 0, pending: 0 };
    const parts = [];
    for (const t of talks) {
      parts.push({ t, part: 'doc', text: documentText(t) });
      chunkWords(t.abstract).forEach((c, i) => parts.push({ t, part: `chunk:${i}`, text: c }));
    }
    let vecs;
    try {
      vecs = await embedPassages(ctx, parts.map((p) => p.text));
    } catch (err) {
      if (!(err instanceof EmbedUnavailable)) throw err;
      this.sql("INSERT INTO meta (k, v) VALUES ('talks_pending', '1') ON CONFLICT(k) DO UPDATE SET v = excluded.v");
      return { embedded: 0, pending: talks.length };
    }
    const dim = vecs.find(Boolean)?.length ?? 384;
    const model = conventionsId(ctx);
    this.tx(() => {
      for (const t of talks) this.sql('DELETE FROM talk_vectors WHERE talk_id = ?', t.talk_id);
      parts.forEach((p, i) => {
        if (p.part !== 'doc' && !vecs[i]) return;
        this.sql(
          'INSERT INTO talk_vectors (talk_id, part, chunk, text_hash, model, vec) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(talk_id, part) DO UPDATE SET chunk = excluded.chunk, text_hash = excluded.text_hash, model = excluded.model, vec = excluded.vec',
          p.t.talk_id, p.part, p.text, p.t.text_hash ?? '', model, toBlob(vecs[i] ?? new Float32Array(dim)),
        );
      });
    });
    this.vectorsC = null;
    this.talksEpoch += 1;
    return { embedded: talks.length, pending: 0 };
  }

  // Marks every talk and every profile with text as pending once, when the stored vectors were
  // made under other embedding conventions than conventionsId (lib/embed.js). The old vectors
  // stay in use until the new ones replace them.
  #reembedOnConventionsChange(ctx) {
    const want = conventionsId(ctx);
    const have = this.sql("SELECT v FROM meta WHERE k = 'embed_conventions'").toArray()[0]?.v;
    if (have === want) return;
    this.tx(() => {
      this.sql("UPDATE people SET text_pending = 1 WHERE text_pending = 0 AND (about != '' OR interests != '' OR expertise != '')");
      this.sql("INSERT INTO meta (k, v) VALUES ('talks_pending', '1') ON CONFLICT(k) DO UPDATE SET v = excluded.v");
      this.sql("INSERT INTO meta (k, v) VALUES ('embed_conventions', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v", want);
    });
    if (this.peopleC) for (const p of this.peopleC.byId.values()) if (TEXT_FIELDS.some((f) => p[f].trim())) p.text_pending = true;
  }

  // The talks whose 'doc' vector is missing, stale or from other conventions (at most limit).
  #talksToEmbed(ctx, limit) {
    return this.sql(
      `SELECT t.talk_id, t.title, t.abstract, t.text_hash FROM talks t
       WHERE NOT EXISTS (SELECT 1 FROM talk_vectors v WHERE v.talk_id = t.talk_id AND v.part = 'doc' AND v.model = ? AND v.text_hash = IFNULL(t.text_hash, ''))
       LIMIT ?`,
      conventionsId(ctx), limit,
    ).toArray();
  }

  // Step 6 of the purge, also run by POST /admin/embed-pending: up to 25 people and 25 talks
  // with missing vectors, unless semantic calls are paused. Returns { embedded, pending }; while
  // paused, pending counts the waiting people and talks (talks up to 25), so a caller that drains
  // until nothing is pending does not stop early.
  async embedPending(ctx) {
    this.#reembedOnConventionsChange(ctx);
    if (!semanticAvailable(ctx)) {
      const people = this.sql('SELECT COUNT(*) AS n FROM people WHERE text_pending = 1').one().n;
      const flag = this.sql("SELECT v FROM meta WHERE k = 'talks_pending'").toArray()[0]?.v;
      const talks = flag === '1' ? this.#talksToEmbed(ctx, RETRY_BATCH).length : 0;
      return { embedded: 0, pending: people + talks, paused: true };
    }
    const ids = this.sql('SELECT profile_id FROM people WHERE text_pending = 1 LIMIT ?', RETRY_BATCH).toArray().map((r) => r.profile_id);
    const people = await this.embedPeople(ctx, ids);
    let talks = { embedded: 0, pending: 0 };
    const flag = this.sql("SELECT v FROM meta WHERE k = 'talks_pending'").toArray()[0]?.v;
    if (flag === '1') {
      const rows = this.#talksToEmbed(ctx, RETRY_BATCH);
      talks = await this.embedTalks(ctx, rows);
      if (!rows.length || (rows.length < RETRY_BATCH && !talks.pending)) {
        this.sql("INSERT INTO meta (k, v) VALUES ('talks_pending', '0') ON CONFLICT(k) DO UPDATE SET v = excluded.v");
      }
    }
    const stillPeople = this.sql('SELECT COUNT(*) AS n FROM people WHERE text_pending = 1').one().n;
    return { embedded: people.embedded + talks.embedded, pending: stillPeople + talks.pending };
  }

  // ------------------------------------------------------------------------------------------
  // Purge (PLAN section 1.10), with set-based statements so the end-of-conference purge of every
  // profile at once stays one short request. Correctness never depends on it, because every read
  // filters by time. Returns counts.
  purge(now = Date.now()) {
    const expired = this.sql('SELECT profile_id FROM people WHERE visible_until_ms <= ?', now).toArray().map((r) => r.profile_id);
    const out = { people: expired.length, presence: 0, meets: 0, scrubbed: 0, blocks: 0, ble_caps: 0, push_subs: 0, nudges: 0, nudge_sends: 0 };
    if (expired.length) {
      const sub = 'SELECT profile_id FROM people WHERE visible_until_ms <= ?';
      this.tx(() => {
        this.sql(`DELETE FROM presence WHERE profile_id IN (${sub})`, now);
        this.sql(`DELETE FROM shared_talks WHERE profile_id IN (${sub})`, now);
        this.sql('DELETE FROM people_fts WHERE rowid IN (SELECT rowid FROM people WHERE visible_until_ms <= ?)', now);
        this.sql(`DELETE FROM blocks WHERE blocker_id IN (${sub})`, now);
        this.sql(`DELETE FROM ble_caps WHERE profile_id IN (${sub})`, now);
        this.sql(`DELETE FROM meets WHERE requester_id IN (${sub}) OR recipient_id IN (${sub})`, now, now);
        this.sql(`DELETE FROM push_subs WHERE profile_id IN (${sub})`, now);
        this.sql(`DELETE FROM nudges WHERE a_id IN (${sub}) OR b_id IN (${sub})`, now, now);
        this.sql(`DELETE FROM nudge_sends WHERE receiver_id IN (${sub})`, now);
        this.sql('DELETE FROM people WHERE visible_until_ms <= ?', now);
      });
      for (const id of expired) this.#forget(id);
    }
    const gone = this.sql('SELECT profile_id FROM presence WHERE until_ms <= ?', now).toArray().map((r) => r.profile_id);
    if (gone.length) {
      out.presence = this.#count('DELETE FROM presence WHERE until_ms <= ? RETURNING 1', now);
      for (const id of gone) {
        this.locations.delete(id);
        const p = this.peopleC?.byId.get(id);
        if (p) p.presence = null;
      }
    }
    out.meets = this.#count(
      `DELETE FROM meets WHERE expires_at_ms <= ? AND (state != 'declined' OR ended_at_ms IS NULL OR ended_at_ms < ?) RETURNING 1`,
      now, now - DECLINED_KEEP_MS,
    );
    out.scrubbed = this.#count(
      `UPDATE meets SET note = NULL, rendezvous = NULL, spot_me = '{}', spot_me_pending = '{}', note_pending = 0
       WHERE state = 'declined' AND expires_at_ms <= ?
         AND (note IS NOT NULL OR rendezvous IS NOT NULL OR spot_me != '{}' OR spot_me_pending != '{}' OR note_pending != 0)
       RETURNING 1`,
      now,
    );
    // Blocks run out at their expires_at_ms (the end of the conference, or later while either
    // profile is still visible). A row from before blocks carried it gets the conference's end.
    const confEnd = this.owner.conf?.visible_until_ms;
    if (Number.isFinite(confEnd)) this.sql('UPDATE blocks SET expires_at_ms = ? WHERE expires_at_ms IS NULL', confEnd);
    out.blocks = this.#count('DELETE FROM blocks WHERE expires_at_ms <= ? RETURNING 1', now);
    if (out.blocks) this.blocksC = null;
    out.ble_caps = this.#count('DELETE FROM ble_caps WHERE at_ms <= ? RETURNING 1', now - 3600_000);
    out.push_subs = this.#count('DELETE FROM push_subs WHERE expires_at_ms <= ? RETURNING 1', now);
    out.nudges = this.#count('DELETE FROM nudges WHERE expires_at_ms <= ? RETURNING 1', now);
    out.nudge_sends = this.#count('DELETE FROM nudge_sends WHERE expires_at_ms <= ? RETURNING 1', now);
    return out;
  }
}

export { parseArr, parseObj };
