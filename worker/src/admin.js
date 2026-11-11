// Admin routes served by a ConferenceDO (PLAN section 2). The Worker has already checked the
// signed X-Caddie-Admin header, refused any request with an Origin header, and resolved ?event= to
// a conference the directory knows; the object has recorded the request's nonce. Ingest,
// migration, moderation, stats, the operator's CLI and the smoke fixtures use these routes; the
// web app never does. Responses carry counts, never document contents, except the people search
// and view the operator asks for, which carry names and, on request, profile text; never an
// internal id. Nothing here logs.

import { HttpError, bad, json, readJson, isPlainObject, REF_RE, MEET_ID_RE } from './lib/http.js';
import { sha256Hex } from './lib/device.js';
import { visibleUntilMs } from './lib/time.js';

const MAX_TALKS = 50;
const MAX_PEOPLE = 25;
const PAGE = 1000;
const KINDS = new Set(['profile', 'spot', 'meet']);

const iso = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString() : null);
const msOf = (v) => {
  if (Number.isFinite(v)) return v;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
};
const strOrNull = (v) => (typeof v === 'string' && v ? v : null);
const arr = (v) => (Array.isArray(v) ? v : []);

function setMeta(ctx, k, v) {
  ctx.sql.exec('INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v', k, String(v));
}

// ---------------------------------------------------------------------------------------------
// Talks.

const TALK_COLUMNS = [
  'talk_id', 'kind', 'title', 'abstract', 'speakers', 'speaker_taglines', 'speaker_profiles', 'room', 'track', 'level',
  'tag_keys', 'tags', 'topics', 'sponsor', 'has_slides', 'start', 'end', 'start_ms', 'end_ms', 'day', 'start_minutes',
  'end_minutes', 'session_id', 'slides_url', 'url', 'content_hash', 'text_hash', 'ingested_at', 'generation',
];
const quoted = (c) => (c === 'end' ? '"end"' : c);
const UPSERT_TALK = `INSERT INTO talks (${TALK_COLUMNS.map(quoted).join(', ')}) VALUES (${TALK_COLUMNS.map(() => '?').join(', ')})
  ON CONFLICT(talk_id) DO UPDATE SET ${TALK_COLUMNS.slice(1).map((c) => `${quoted(c)} = excluded.${quoted(c)}`).join(', ')}
  RETURNING rowid`;

async function talkRow(slug, doc, generation) {
  const talkId = doc.talk_id ?? doc._id;
  if (typeof talkId !== 'string' || !talkId.startsWith(`${slug}:`)) return null;
  if (doc.conference !== undefined && doc.conference !== slug) return null;
  const title = String(doc.title ?? '');
  const abstract = String(doc.abstract ?? '');
  const r = {
    talk_id: talkId,
    kind: typeof doc.kind === 'string' && doc.kind ? doc.kind : 'talk',
    title,
    abstract,
    speakers: JSON.stringify(arr(doc.speakers)),
    speaker_taglines: JSON.stringify(arr(doc.speaker_taglines)),
    speaker_profiles: JSON.stringify(arr(doc.speaker_profiles)),
    room: strOrNull(doc.room),
    track: strOrNull(doc.track),
    level: strOrNull(doc.level),
    tag_keys: JSON.stringify(arr(doc.tag_keys)),
    tags: JSON.stringify(arr(doc.tags)),
    topics: JSON.stringify(arr(doc.topics)),
    sponsor: doc.sponsor ? 1 : 0,
    has_slides: doc.has_slides ? 1 : 0,
    start: strOrNull(doc.start),
    end: strOrNull(doc.end),
    start_ms: msOf(doc.start),
    end_ms: msOf(doc.end),
    day: strOrNull(doc.day),
    start_minutes: Number.isFinite(doc.start_minutes) ? doc.start_minutes : null,
    end_minutes: Number.isFinite(doc.end_minutes) ? doc.end_minutes : null,
    session_id: doc.session_id == null ? null : String(doc.session_id),
    slides_url: strOrNull(doc.slides_url),
    url: strOrNull(doc.url),
    content_hash: strOrNull(doc.content_hash),
    text_hash: strOrNull(doc.text_hash) ?? (await sha256Hex(JSON.stringify([title, abstract]))),
    ingested_at: strOrNull(doc.ingested_at),
    generation,
  };
  if (!r.content_hash) {
    const { _id, ingested_at, content_hash, ...rest } = doc;
    r.content_hash = await sha256Hex(JSON.stringify(rest));
  }
  return r;
}

const ftsText = (r) => [r.title, r.abstract, JSON.parse(r.speakers).join(', '), JSON.parse(r.speaker_taglines).join(', ')];

// POST /admin/talks?event= {generation, talks: [<= 50]}: upserts rows and FTS. A talk whose
// content_hash is unchanged only gets its generation updated. Talks whose text_hash changed are
// embedded (title plus abstract chunks of at most 250 words).
async function postTalks(ctx, req) {
  const body = await readJson(req, new Set(['generation', 'talks']));
  const generation = Number(body.generation);
  if (!Number.isSafeInteger(generation)) throw bad('generation must be an integer');
  if (!Array.isArray(body.talks) || body.talks.length > MAX_TALKS) throw bad(`talks must be an array of at most ${MAX_TALKS}`);
  const rows = [];
  let skipped = 0;
  for (const doc of body.talks) {
    const r = isPlainObject(doc) ? await talkRow(ctx.slug, doc, generation) : null;
    if (r) rows.push(r);
    else skipped += 1;
  }
  const existing = new Map();
  if (rows.length) {
    const cur = ctx.sql.exec(
      'SELECT rowid AS _rowid, talk_id, content_hash, text_hash, title, abstract, speakers, speaker_taglines, generation FROM talks WHERE talk_id IN (SELECT value FROM json_each(?))',
      JSON.stringify(rows.map((r) => r.talk_id)),
    );
    for (const e of cur) existing.set(e.talk_id, e);
  }
  let upserted = 0;
  let unchanged = 0;
  const toEmbed = [];
  ctx.store.tx(() => {
    for (const r of rows) {
      const prev = existing.get(r.talk_id);
      if (prev && prev.content_hash === r.content_hash) {
        unchanged += 1;
        if (prev.generation !== generation) ctx.sql.exec('UPDATE talks SET generation = ? WHERE talk_id = ?', generation, r.talk_id);
        continue;
      }
      upserted += 1;
      const rowid = ctx.sql.exec(UPSERT_TALK, ...TALK_COLUMNS.map((c) => r[c])).one().rowid;
      const next = ftsText(r);
      const before = prev ? ftsText(prev) : null;
      if (!before || before.some((v, i) => v !== next[i])) {
        if (prev) ctx.sql.exec('DELETE FROM talks_fts WHERE rowid = ?', rowid);
        ctx.sql.exec('INSERT INTO talks_fts (rowid, talk_id, title, abstract, speakers, speaker_taglines) VALUES (?, ?, ?, ?, ?, ?)', rowid, r.talk_id, ...next);
      }
      if (!prev || prev.text_hash !== r.text_hash) toEmbed.push(r);
    }
  });
  if (upserted) ctx.store.invalidateTalks();
  const { embedded, pending } = await ctx.store.embedTalks(ctx, toEmbed);
  return json(200, { upserted, unchanged, skipped, embedded, pending });
}

const FINALIZE_MAX_DELETE = 10;
const FINALIZE_MAX_DELETE_SHARE = 0.1;

// POST /admin/talks/finalize?event= {generation, allow_shrink?}: deletes talks of other generations with their
// FTS rows and vectors, and bumps talks_version.
//
// People who shared for a deleted talk (a cancelled session, a takedown) stop sharing for it, so no
// circle is left for a talk that no longer exists: its shared_talks rows go. A profile that is then
// neither open to meet nor sharing for any talk is deleted, as a profile write with both choices off
// would delete it (docs/CONTRACT.md: a profile exists only while one of them holds). The app then
// learns it on its next write, which drops the unknown talk (people/routes.js checkSharedTalks).
//
// Because people's sharing is not restored when a talk comes back, a finalize that would delete
// more than FINALIZE_MAX_DELETE talks and more than FINALIZE_MAX_DELETE_SHARE of the conference's
// talks is refused with 409, and nothing is deleted. A feed that came back short for a moment
// (a Sessionize outage, a wrong group filter) therefore leaves both the talks and the people as
// they were. An operator who means it passes allow_shrink: true (push-ingest.mjs --allow-shrink).
// Returns { talks, deleted, unshared, profiles_deleted }.
async function finalizeTalks(ctx, req) {
  const body = await readJson(req, new Set(['generation', 'allow_shrink']));
  const generation = Number(body.generation);
  if (!Number.isSafeInteger(generation)) throw bad('generation must be an integer');
  if (body.allow_shrink !== undefined && typeof body.allow_shrink !== 'boolean') throw bad('allow_shrink must be a boolean');
  if (!body.allow_shrink) {
    const stale = Number(ctx.sql.exec('SELECT COUNT(*) AS n FROM talks WHERE generation != ?', generation).one().n);
    const all = Number(ctx.sql.exec('SELECT COUNT(*) AS n FROM talks').one().n);
    if (stale > FINALIZE_MAX_DELETE && stale > all * FINALIZE_MAX_DELETE_SHARE) {
      throw new HttpError(409, { error: `finalize would delete ${stale} of ${all} talks; nothing was deleted. Re-run with allow_shrink if the schedule really shrank.` });
    }
  }
  let deleted = 0;
  let unshared = 0;
  let orphans = [];
  ctx.store.tx(() => {
    ctx.sql.exec('DELETE FROM talks_fts WHERE rowid IN (SELECT rowid FROM talks WHERE generation != ?)', generation);
    ctx.sql.exec('DELETE FROM talk_vectors WHERE talk_id IN (SELECT talk_id FROM talks WHERE generation != ?)', generation);
    deleted = ctx.sql.exec('DELETE FROM talks WHERE generation != ? RETURNING 1', generation).toArray().length;
    if (deleted) {
      orphans = ctx.sql.exec(
        'SELECT DISTINCT s.profile_id AS id FROM shared_talks s JOIN people p ON p.profile_id = s.profile_id WHERE p.open_to_meet = 0 AND s.talk_id NOT IN (SELECT talk_id FROM talks) AND NOT EXISTS (SELECT 1 FROM shared_talks k WHERE k.profile_id = s.profile_id AND k.talk_id IN (SELECT talk_id FROM talks))',
      ).toArray().map((r) => r.id);
      unshared = ctx.sql.exec('DELETE FROM shared_talks WHERE talk_id NOT IN (SELECT talk_id FROM talks) RETURNING 1').toArray().length;
    }
    const v = Number(ctx.sql.exec("SELECT v FROM meta WHERE k = 'talks_version'").toArray()[0]?.v ?? 0);
    setMeta(ctx, 'talks_version', v + 1);
  });
  ctx.store.invalidateTalks();
  if (unshared) ctx.store.invalidatePeople();
  for (const id of orphans) ctx.store.deletePersonEverywhere(id);
  const talks = ctx.sql.exec('SELECT COUNT(*) AS n FROM talks').one().n;
  return json(200, { talks, deleted, unshared, profiles_deleted: orphans.length });
}

// ---------------------------------------------------------------------------------------------
// Topics and facets.

function getTopics(ctx) {
  const topics = ctx.store.topics().list.map((t) => ({ ...t }));
  return json(200, { topics });
}

async function putTopics(ctx, req) {
  const body = await readJson(req, new Set(['topics', 'allow_empty']));
  if (!Array.isArray(body.topics) || body.topics.length > 5000) throw bad('topics must be an array');
  if (body.allow_empty !== undefined && typeof body.allow_empty !== 'boolean') throw bad('allow_empty must be a boolean');
  const rows = body.topics.filter((t) => isPlainObject(t) && typeof t.topic_id === 'string' && t.topic_id && (t.conference === undefined || t.conference === ctx.slug));
  // Topic ids live in people's profiles and every talk is tagged with them, so an empty list never
  // replaces a stored one by accident (a rebuild from a broken feed); allow_empty says it is meant.
  if (rows.length === 0 && !body.allow_empty) {
    const stored = Number(ctx.sql.exec('SELECT COUNT(*) AS n FROM topics').one().n);
    if (stored > 0) throw new HttpError(409, { error: `this would replace the ${stored} stored topics with none; nothing was changed. Re-send with allow_empty if the conference really has no topics.` });
  }
  ctx.store.tx(() => {
    ctx.sql.exec('DELETE FROM topics');
    for (const t of rows) {
      ctx.sql.exec(
        'INSERT INTO topics (topic_id, label, label_exact, aliases, talk_count, rank) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(topic_id) DO UPDATE SET label = excluded.label, label_exact = excluded.label_exact, aliases = excluded.aliases, talk_count = excluded.talk_count, rank = excluded.rank',
        t.topic_id, String(t.label ?? t.topic_id), strOrNull(t.label_exact) ?? String(t.label ?? t.topic_id), JSON.stringify(arr(t.aliases)),
        Number.isFinite(t.talk_count) ? t.talk_count : 0, Number.isFinite(t.rank) ? t.rank : 0,
      );
    }
    const v = Number(ctx.sql.exec("SELECT v FROM meta WHERE k = 'topics_version'").toArray()[0]?.v ?? 0);
    setMeta(ctx, 'topics_version', v + 1);
  });
  ctx.store.invalidateTopics();
  return json(200, { topics: rows.length });
}

async function putFacets(ctx, req) {
  const body = await readJson(req, new Set(['facets']));
  if (!Array.isArray(body.facets) || body.facets.length > 20000) throw bad('facets must be an array');
  const rows = body.facets.filter((f) => isPlainObject(f) && typeof (f.id ?? f._id) === 'string' && typeof f.kind === 'string' && (f.conference === undefined || f.conference === ctx.slug));
  ctx.store.tx(() => {
    ctx.sql.exec('DELETE FROM facets');
    for (const f of rows) {
      ctx.sql.exec(
        'INSERT INTO facets (id, kind, key, words, label, value, "group", talks, built_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING',
        f.id ?? f._id, f.kind, JSON.stringify(arr(f.key)), String(f.words ?? ''), strOrNull(f.label), strOrNull(f.value), strOrNull(f.group),
        Number.isFinite(f.talks) ? f.talks : 0, strOrNull(f.built_at),
      );
    }
  });
  ctx.store.invalidateFacets();
  return json(200, { facets: rows.length });
}

// ---------------------------------------------------------------------------------------------
// People migration and reports.

const PROFILE_ID_RE = /^[A-Za-z0-9_-]{22}$/;
const HASH_RE = /^[0-9a-f]{64}$/;

// POST /admin/people?event= {people: [<= 25]}: migration only. Skips expired rows and rows of
// another conference; recomputes ref with REF_SALT; keeps secret_hash; drops every presence,
// location and BLE field; embeds the text.
async function postPeople(ctx, req) {
  const body = await readJson(req, new Set(['people']));
  if (!Array.isArray(body.people) || body.people.length > MAX_PEOPLE) throw bad(`people must be an array of at most ${MAX_PEOPLE}`);
  let upserted = 0;
  let skipped = 0;
  const ids = [];
  for (const d of body.people) {
    const visible = isPlainObject(d) ? msOf(d.visible_until) ?? msOf(d.visible_until_ms) : null;
    if (
      !isPlainObject(d) || !PROFILE_ID_RE.test(d.profile_id ?? '') || !HASH_RE.test(d.secret_hash ?? '')
      || (d.event_id !== undefined && d.event_id !== ctx.slug) || !visible || visible <= ctx.now
    ) {
      skipped += 1;
      continue;
    }
    await ctx.store.insertPerson({
      profile_id: d.profile_id,
      secret_hash: d.secret_hash,
      display_name: d.display_name,
      about: d.about,
      interests: d.interests,
      expertise: d.expertise,
      learn_topics: d.learn_topics,
      speak_topics: d.speak_topics,
      linkedin_url: d.linkedin_url,
      contact_note: d.contact_note,
      open_to_meet: d.open_to_meet === true,
      sample: d.sample === true,
      hidden: d.hidden === true,
      spot_hidden: d.spot_hidden === true,
      visible_until_ms: visible,
      updated_at_ms: msOf(d.updated_at) ?? ctx.now,
      shared_talk_ids: arr(d.shared_talk_ids).filter((t) => typeof t === 'string' && t.startsWith(`${ctx.slug}:`)),
    });
    upserted += 1;
    ids.push(d.profile_id);
  }
  const { embedded, pending } = await ctx.store.embedPeople(ctx, ids);
  return json(200, { upserted, skipped, embedded, pending });
}

// POST /admin/reports?event= {reports}: inserts, ignoring duplicates. Profile and spot reports
// are re-keyed to the new ref of target_profile_id; a report whose target is not here, and every
// meet report, is skipped.
async function postReports(ctx, req) {
  const body = await readJson(req, new Set(['reports']));
  if (!Array.isArray(body.reports) || body.reports.length > 1000) throw bad('reports must be an array');
  let inserted = 0;
  let skipped = 0;
  for (const r of body.reports) {
    const target = isPlainObject(r) && (r.target_kind === 'profile' || r.target_kind === 'spot') ? ctx.store.person(r.target_profile_id) : null;
    if (!target || typeof r.reporter_id !== 'string' || !r.reporter_id || (r.event_id !== undefined && r.event_id !== ctx.slug)) {
      skipped += 1;
      continue;
    }
    const id = `${r.target_kind}:${target.ref}:${r.reporter_id}`;
    const n = ctx.sql.exec(
      'INSERT INTO reports (id, target_kind, target_id, target_profile_id, reporter_id, reason, created_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING RETURNING 1',
      id, r.target_kind, target.ref, target.profile_id, r.reporter_id, String(r.reason ?? 'other'), msOf(r.created_at) ?? ctx.now,
    ).toArray().length;
    if (n) inserted += 1;
    else skipped += 1;
  }
  return json(200, { inserted, skipped });
}

// ---------------------------------------------------------------------------------------------
// Moderation (port of scripts/moderation.mjs). People appear by display_name and ref only.

function reportSummary(ctx) {
  const map = new Map();
  for (const r of ctx.sql.exec('SELECT target_kind, target_id, reason, COUNT(*) AS n FROM reports GROUP BY target_kind, target_id, reason')) {
    const key = `${r.target_kind}:${r.target_id}`;
    const e = map.get(key) ?? { reports: 0, reasons: {} };
    e.reports += r.n;
    e.reasons[r.reason] = r.n;
    map.set(key, e);
  }
  return map;
}

const nameOf = (ctx, id) => ctx.store.person(id)?.display_name ?? '(profile deleted)';

function meetView(ctx, m) {
  return { kind: 'meet', meet_id: m.meet_id, state: m.state, between: [nameOf(ctx, m.requester_id), nameOf(ctx, m.recipient_id)] };
}

function getModeration(ctx, req) {
  const url = new URL(req.url);
  const summary = reportSummary(ctx);
  const withCounts = (key, v) => ({ ...v, reports: summary.get(key)?.reports ?? 0, reasons: summary.get(key)?.reasons ?? {} });
  const hidden = [];
  const people = [...ctx.sql.exec('SELECT profile_id FROM people WHERE hidden = 1 OR spot_hidden = 1')].map((r) => ctx.store.person(r.profile_id)).filter(Boolean);
  people.sort((a, c) => a.display_name.localeCompare(c.display_name));
  for (const p of people) {
    if (p.hidden) hidden.push(withCounts(`profile:${p.ref}`, { kind: 'profile', display_name: p.display_name, ref: p.ref }));
    if (p.spot_hidden) hidden.push(withCounts(`spot:${p.ref}`, { kind: 'spot', display_name: p.display_name, ref: p.ref }));
  }
  for (const m of ctx.sql.exec('SELECT meet_id, state, requester_id, recipient_id FROM meets WHERE hidden = 1 ORDER BY created_at_ms DESC LIMIT ?', PAGE)) {
    hidden.push(withCounts(`meet:${m.meet_id}`, meetView(ctx, m)));
  }
  const sinceRaw = url.searchParams.get('since');
  let sinceMs = 0;
  if (sinceRaw !== null) {
    sinceMs = Date.parse(sinceRaw);
    if (!Number.isFinite(sinceMs)) throw bad('since must be an ISO 8601 instant');
  }
  const reports = [];
  for (const r of ctx.sql.exec('SELECT target_kind, target_id, reason, created_at_ms FROM reports WHERE created_at_ms >= ? ORDER BY created_at_ms LIMIT ?', sinceMs, PAGE)) {
    let target;
    if (r.target_kind === 'meet') {
      const m = ctx.sql.exec('SELECT meet_id, state, requester_id, recipient_id FROM meets WHERE meet_id = ?', r.target_id).toArray()[0];
      target = m ? meetView(ctx, m) : { kind: 'meet', meet_id: r.target_id, deleted: true };
    } else {
      const p = ctx.store.personByRef(r.target_id);
      target = { kind: r.target_kind, ref: r.target_id, display_name: p?.display_name ?? '(profile deleted)' };
    }
    reports.push({ created_at: iso(r.created_at_ms), kind: r.target_kind, reason: r.reason, target });
  }
  return json(200, { hidden, reports });
}

// POST /admin/moderation?event= {action, kind?, id?}:
//   purge   deletes the reports of a conference that has ended;
//   hide    (profile or spot) hides the target and files the operator's report, so the hide
//           survives a profile write and a re-creation from the same device: {ok}; 404 for an
//           unknown ref; kind meet is 400. Idempotent;
//   unhide  clears the hidden flag and deletes the target's reports, the operator's included:
//           {ok, found, removed}. A target that is gone but still has reports gets them deleted
//           (found false); one with neither is 404;
//   delete  removes the target (a profile everywhere): {ok}; 404 when it is already gone.
async function postModeration(ctx, req) {
  const body = await readJson(req, new Set(['action', 'kind', 'id']));
  const { action, kind, id } = body;
  if (action === 'purge') {
    const conf = ctx.conf;
    if (!conf?.end_date) throw bad('the conference has no end date');
    const endMs = visibleUntilMs(conf.end_date, conf.time_zone);
    if (ctx.now <= endMs) return json(200, { ok: true, purged: 0, ends_at: iso(endMs) });
    const purged = ctx.sql.exec('DELETE FROM reports WHERE created_at_ms < ? RETURNING 1', endMs).toArray().length;
    return json(200, { ok: true, purged });
  }
  if (action !== 'hide' && action !== 'unhide' && action !== 'delete') throw bad("action must be 'hide', 'unhide', 'delete' or 'purge'");
  if (!KINDS.has(kind)) throw bad("kind must be 'profile', 'spot' or 'meet'");
  if (action === 'hide' && kind === 'meet') throw bad("kind must be 'profile' or 'spot' to hide");
  if (typeof id !== 'string' || !(kind === 'meet' ? MEET_ID_RE : REF_RE).test(id)) throw bad(kind === 'meet' ? 'id must be a meet id' : 'id must be a ref');
  if (action === 'hide') {
    const p = ctx.store.personByRef(id);
    if (!p) throw new HttpError(404, { error: 'not_found' });
    ctx.store.operatorHide(kind, p);
    return json(200, { ok: true });
  }
  if (action === 'unhide') {
    const { found, removed } = ctx.store.unhideTarget(kind, id);
    if (!found && !removed) throw new HttpError(404, { error: 'not_found' });
    return json(200, { ok: true, found, removed });
  }
  if (!ctx.store.deleteTarget(kind, id)) throw new HttpError(404, { error: 'not_found' });
  return json(200, { ok: true });
}

// ---------------------------------------------------------------------------------------------
// People: search, view and the operator's block. The operator finds people by display name or
// ref only. No answer here ever carries a profile_id, a secret hash, a reporter id, a push
// endpoint or key, a zone, a position, a cell or a Bluetooth field.

const SEARCH_DEFAULT = 50;
const SEARCH_MAX = 200;
const Q64_MAX_BYTES = 200;
const VIEW_TEXT_MAX = 300;
const VIEW_FIELDS = new Set(['text', 'contact']);

// The query of an admin GET as a Map: only the keys the route reads (event included), each at most
// once, so a misspelt or repeated parameter is a 400 instead of being ignored.
function queryOf(req, allowed) {
  const out = new Map();
  for (const [k, v] of new URL(req.url).searchParams) {
    if (!allowed.has(k)) throw bad(`Unknown parameter: ${k.slice(0, 40)}`);
    if (out.has(k)) throw bad(`${k} must be given once`);
    out.set(k, v);
  }
  return out;
}

// q64: base64url without padding of 1 to 200 bytes of UTF-8 (the signer's query charset has no
// room for free text). Anything else is a 400.
function decodeQ64(value) {
  const fail = () => bad(`q64 must be base64url without padding of 1 to ${Q64_MAX_BYTES} bytes of UTF-8`);
  if (!/^[A-Za-z0-9_-]+$/.test(value) || value.length % 4 === 1 || value.length > Math.ceil((Q64_MAX_BYTES * 4) / 3)) throw fail();
  let bin;
  try {
    bin = atob(value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (value.length % 4)) % 4));
  } catch {
    throw fail();
  }
  if (bin.length === 0 || bin.length > Q64_MAX_BYTES) throw fail();
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
  } catch {
    throw fail();
  }
}

const flag = (v) => v === 1 || v === true;

// One search row: the person's ref, name, flags and visibility end. Nothing else.
const searchRow = (r) => ({
  ref: r.ref,
  display_name: r.display_name,
  hidden: flag(r.hidden),
  spot_hidden: flag(r.spot_hidden),
  open_to_meet: flag(r.open_to_meet),
  sample: flag(r.sample),
  visible_until: iso(r.visible_until_ms),
});
const SEARCH_COLUMNS = 'ref, display_name, hidden, spot_hidden, open_to_meet, sample, visible_until_ms';

// GET /admin/people/search?event=&q64=<base64url>|&ref=<ref>[&limit=<n>][&include_hidden=1]:
// {people: [rows], matched}. With ref, the one person with that ref, hidden or not (404 when there
// is none). With q64, the people whose display_name holds the decoded text as a substring,
// case-insensitive for ASCII letters (SQLite's LIKE), hidden ones only with include_hidden=1,
// ordered by display_name, at most limit (default 50, at most 200); matched counts every match
// before the limit. A % or _ in the text matches itself (LIKE ... ESCAPE '\').
function searchPeople(ctx, req) {
  const q = queryOf(req, new Set(['event', 'q64', 'ref', 'limit', 'include_hidden']));
  if (q.has('q64') === q.has('ref')) throw bad('give exactly one of q64 and ref');
  if (q.has('ref')) {
    const ref = q.get('ref');
    if (!REF_RE.test(ref)) throw bad('ref must be a ref');
    const row = ctx.sql.exec(`SELECT ${SEARCH_COLUMNS} FROM people WHERE ref = ?`, ref).toArray()[0];
    if (!row) throw new HttpError(404, { error: 'not_found' });
    return json(200, { people: [searchRow(row)], matched: 1 });
  }
  const text = decodeQ64(q.get('q64'));
  let limit = SEARCH_DEFAULT;
  if (q.has('limit')) {
    if (!/^[1-9][0-9]{0,2}$/.test(q.get('limit')) || Number(q.get('limit')) > SEARCH_MAX) throw bad(`limit must be an integer from 1 to ${SEARCH_MAX}`);
    limit = Number(q.get('limit'));
  }
  const inc = q.get('include_hidden');
  if (inc !== undefined && inc !== '0' && inc !== '1') throw bad('include_hidden must be 0 or 1');
  const pattern = `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  const rows = ctx.sql.exec(
    `SELECT ${SEARCH_COLUMNS}, COUNT(*) OVER () AS matched FROM people
     WHERE display_name LIKE ? ESCAPE '\\'${inc === '1' ? '' : ' AND hidden = 0'}
     ORDER BY display_name, ref LIMIT ?`,
    pattern, limit,
  ).toArray();
  return json(200, { people: rows.map(searchRow), matched: Number(rows[0]?.matched ?? 0) });
}

// A text cut to at most 300 UTF-16 units, without leaving half of a surrogate pair; null stays null.
function cut(value) {
  if (typeof value !== 'string') return null;
  if (value.length <= VIEW_TEXT_MAX) return value;
  const end = /[\uD800-\uDBFF]/.test(value[VIEW_TEXT_MAX - 1]) ? VIEW_TEXT_MAX - 1 : VIEW_TEXT_MAX;
  return value.slice(0, end);
}

// The meets of a person by state, as the operator reads them: requested; accepted (an accepted
// meet is stored as active); declined; ended (cancelled or expired, and an open meet whose time
// ran out, which its participants already see as expired); other (any other stored state).
function meetCounts(ctx, profileId) {
  const out = { requested: 0, accepted: 0, declined: 0, ended: 0, other: 0 };
  const rows = ctx.sql.exec(
    `SELECT CASE WHEN state IN ('requested', 'active') AND expires_at_ms <= ? THEN 'expired' ELSE state END AS s, COUNT(*) AS n
     FROM meets WHERE requester_id = ? OR recipient_id = ? GROUP BY s`,
    ctx.now, profileId, profileId,
  );
  const bucket = { requested: 'requested', active: 'accepted', declined: 'declined', cancelled: 'ended', expired: 'ended' };
  for (const r of rows) out[bucket[r.s] ?? 'other'] += Number(r.n);
  return out;
}

const countOf = (ctx, q, ...b) => Number(ctx.sql.exec(q, ...b).one()?.n ?? 0);

// GET /admin/people/view?event=&ref=<ref>[&fields=text,contact]: {person}. Always the ref, name,
// flags, visibility, updated_at, presence (on or off, nothing about where) and counts: shared
// talks; meets by state; blocks made and received that have not run out; live push subscriptions
// (Web Push is the only channel here); reports against the person (of the profile, the spot line
// and the meets they took part in) by reason, the operator's included. fields=text adds about,
// interests, expertise, contact_note, the current spot line and the held lines (pending), each cut
// to 300 characters; fields=contact adds linkedin_url. 404 not_found for an unknown ref.
function viewPerson(ctx, req) {
  const q = queryOf(req, new Set(['event', 'ref', 'fields']));
  const ref = q.get('ref') ?? '';
  if (!REF_RE.test(ref)) throw bad('ref must be a ref');
  const fields = new Set();
  for (const f of (q.get('fields') ?? '').split(',')) {
    if (!f) continue;
    if (!VIEW_FIELDS.has(f)) throw bad("fields must be a comma list of 'text' and 'contact'");
    fields.add(f);
  }
  const p = ctx.store.personByRef(ref);
  if (!p) throw new HttpError(404, { error: 'not_found' });
  const id = p.profile_id;
  const around = ctx.store.isAround(p);
  const reasons = ctx.sql.exec(
    `SELECT reason, COUNT(*) AS n FROM reports
     WHERE (target_kind IN ('profile', 'spot') AND target_id = ?) OR (target_kind = 'meet' AND target_profile_id = ?)
     GROUP BY reason ORDER BY reason`,
    p.ref, id,
  ).toArray();
  const person = {
    ref: p.ref,
    display_name: p.display_name,
    hidden: p.hidden === true,
    spot_hidden: p.spot_hidden === true,
    open_to_meet: p.open_to_meet === true,
    sample: p.sample === true,
    visible_until: iso(p.visible_until_ms),
    updated_at: iso(p.updated_at_ms),
    presence: around ? 'on' : 'off',
    counts: {
      shared_talks: p.shared_talk_ids.length,
      meets: meetCounts(ctx, id),
      blocks_made: countOf(ctx, 'SELECT COUNT(*) AS n FROM blocks WHERE blocker_id = ? AND (expires_at_ms IS NULL OR expires_at_ms > ?)', id, ctx.now),
      blocks_received: countOf(ctx, 'SELECT COUNT(*) AS n FROM blocks WHERE blocked_id = ? AND (expires_at_ms IS NULL OR expires_at_ms > ?)', id, ctx.now),
      push: { web: countOf(ctx, 'SELECT COUNT(*) AS n FROM push_subs WHERE profile_id = ? AND expires_at_ms > ?', id, ctx.now) },
      reports: {
        total: reasons.reduce((sum, r) => sum + Number(r.n), 0),
        // fromEntries makes own keys, so a stored reason of any spelling stays a plain key.
        reasons: Object.fromEntries(reasons.map((r) => [String(r.reason), Number(r.n)])),
      },
    },
  };
  if (fields.has('text')) {
    // A spot line is shown only while the person is around; one held back for moderation
    // (spot_pending) goes under pending instead.
    const spot = around && p.presence.spot ? p.presence.spot : null;
    const held = around && p.presence.spot_pending === true;
    Object.assign(person, {
      about: cut(p.about),
      interests: cut(p.interests),
      expertise: cut(p.expertise),
      contact_note: cut(p.contact_note),
      spot: held ? null : cut(spot),
      pending: held && spot ? { spot: cut(spot) } : {},
    });
  }
  if (fields.has('contact')) person.linkedin_url = p.linkedin_url ?? null;
  return json(200, { person });
}

// POST /admin/people/block?event= {ref, action: "block" | "unblock"}: {ok, hidden}.
//   block    files the operator's report on the profile (id profile:<ref>:operator, reporter and
//            reason 'operator') with ON CONFLICT DO NOTHING and hides the profile. The report
//            reaches HIDE_AT on its own, and reports outlive the profile row, so the hide survives
//            a profile write and a re-creation from the same device (store.reportFlags and
//            insertPerson). A new device is a new person and is not covered.
//   unblock  deletes that report and sets hidden to what the remaining reports say (two other
//            distinct reporters keep the profile hidden). Without an operator's report nothing
//            changes, and the answer is the current flag.
// 404 not_found when no person has the ref (to lift the block of a profile that was deleted
// since, unhide profile:<ref> through POST /admin/moderation, which deletes its reports).
async function blockPerson(ctx, req) {
  const body = await readJson(req, new Set(['ref', 'action']));
  if (typeof body.ref !== 'string' || !REF_RE.test(body.ref)) throw bad('ref must be a ref');
  if (body.action !== 'block' && body.action !== 'unblock') throw bad("action must be 'block' or 'unblock'");
  const p = ctx.store.personByRef(body.ref);
  if (!p) throw new HttpError(404, { error: 'not_found' });
  if (body.action === 'block') {
    ctx.store.operatorHide('profile', p);
    return json(200, { ok: true, hidden: true });
  }
  return json(200, { ok: true, hidden: ctx.store.operatorUnhide(p) });
}

// ---------------------------------------------------------------------------------------------
// Embeddings, stats and smoke fixtures.

async function embedPending(ctx, req) {
  await readJson(req, new Set());
  const { embedded, pending } = await ctx.store.embedPending(ctx);
  return json(200, { embedded, pending });
}

const STAT_TABLES = ['talks', 'topics', 'facets', 'people', 'shared_talks', 'presence', 'blocks', 'meets', 'reports', 'push_subs', 'nudges'];

function stats(ctx) {
  const out = {};
  for (const t of STAT_TABLES) out[t] = ctx.sql.exec(`SELECT COUNT(*) AS n FROM ${t}`).one().n;
  out.vectors = ctx.sql.exec('SELECT COUNT(*) AS n FROM talk_vectors').one().n;
  out.usage = ctx.usage();
  return json(200, out);
}

async function testProfile(ctx, req) {
  const body = await readJson(req, new Set(['profile_id', 'secret_hash', 'display_name', 'visible_until_ms', 'open_to_meet', 'shared_talk_ids', 'hidden']));
  if (!PROFILE_ID_RE.test(body.profile_id ?? '')) throw bad('profile_id must be 22 base64url characters');
  if (!HASH_RE.test(body.secret_hash ?? '')) throw bad('secret_hash must be 64 hex characters');
  if (!Number.isFinite(body.visible_until_ms)) throw bad('visible_until_ms must be a number');
  const p = await ctx.store.insertPerson({
    profile_id: body.profile_id,
    secret_hash: body.secret_hash,
    display_name: typeof body.display_name === 'string' ? body.display_name.slice(0, 60) : 'Smoke fixture',
    visible_until_ms: body.visible_until_ms,
    open_to_meet: body.open_to_meet === true,
    shared_talk_ids: arr(body.shared_talk_ids).filter((t) => typeof t === 'string'),
  });
  // The fixture's hidden flag goes through the store, as a report hide would.
  if (body.hidden === true) ctx.store.hideTarget('profile', p.ref, p.profile_id);
  return json(200, { ok: true });
}

async function agePresence(ctx, req) {
  const body = await readJson(req, new Set(['profile_id', 'until_ms']));
  if (!PROFILE_ID_RE.test(body.profile_id ?? '')) throw bad('profile_id must be 22 base64url characters');
  if (!Number.isFinite(body.until_ms)) throw bad('until_ms must be a number');
  const p = ctx.store.person(body.profile_id);
  if (!p?.presence) throw new HttpError(404, { error: 'not_found' });
  ctx.store.setPresence(p.profile_id, { until_ms: body.until_ms });
  return json(200, { ok: true });
}

function deleteTestProfile(ctx, req) {
  const id = new URL(req.url).searchParams.get('profile_id') ?? '';
  if (!PROFILE_ID_RE.test(id)) throw bad('profile_id must be 22 base64url characters');
  ctx.store.deletePersonEverywhere(id);
  return json(200, { ok: true });
}

// The smoke's meter check (meter1): starts a new usage meter from the stored totals, as a new
// instance of the object would after an eviction, and drops the old meter's unwritten counts
// (at most 100 requests or 15 seconds of them). Nothing else in the object is touched.
async function restartMeter(ctx, req) {
  await readJson(req, new Set());
  ctx.restartMeter();
  return json(200, { ok: true });
}

const FAIL = 'Admin request failed';
export default [
  { method: 'POST', path: '/admin/talks', fail: FAIL, handler: postTalks },
  { method: 'POST', path: '/admin/talks/finalize', fail: FAIL, handler: finalizeTalks },
  { method: 'GET', path: '/admin/topics', fail: FAIL, handler: getTopics },
  { method: 'PUT', path: '/admin/topics', fail: FAIL, handler: putTopics },
  { method: 'PUT', path: '/admin/facets', fail: FAIL, handler: putFacets },
  { method: 'POST', path: '/admin/people', fail: FAIL, handler: postPeople },
  { method: 'POST', path: '/admin/reports', fail: FAIL, handler: postReports },
  { method: 'GET', path: '/admin/moderation', fail: FAIL, handler: getModeration },
  { method: 'POST', path: '/admin/moderation', fail: FAIL, handler: postModeration },
  { method: 'GET', path: '/admin/people/search', fail: FAIL, handler: searchPeople },
  { method: 'GET', path: '/admin/people/view', fail: FAIL, handler: viewPerson },
  { method: 'POST', path: '/admin/people/block', fail: FAIL, handler: blockPerson },
  { method: 'POST', path: '/admin/embed-pending', fail: FAIL, handler: embedPending },
  { method: 'GET', path: '/admin/stats', fail: FAIL, handler: stats },
  { method: 'POST', path: '/admin/test/profile', fail: FAIL, handler: testProfile },
  { method: 'DELETE', path: '/admin/test/profile', fail: FAIL, handler: deleteTestProfile },
  { method: 'POST', path: '/admin/test/age-presence', fail: FAIL, handler: agePresence },
  { method: 'POST', path: '/admin/test/meter-restart', fail: FAIL, handler: restartMeter },
];

// The admin paths the Worker may forward to a ConferenceDO (PUT /admin/conferences goes to the
// DirectoryDO instead).
// GET /admin/stats without event goes to the DirectoryDO too, and DELETE /admin/conference is
// served by the Worker itself (src/index.js), through the object's /internal/wipe.
export const CONFERENCE_ADMIN_PATHS = new Set([
  '/admin/talks', '/admin/talks/finalize', '/admin/topics', '/admin/facets', '/admin/people', '/admin/reports',
  '/admin/moderation', '/admin/embed-pending', '/admin/stats', '/admin/test/profile', '/admin/test/age-presence',
  '/admin/test/meter-restart', '/admin/people/search', '/admin/people/view', '/admin/people/block',
]);
