// Finishes profile deletes that hid a profile and then failed, deletes every people profile whose
// conference has ended, in every conference, clears presence that has run out and Bluetooth caps
// records whose newest entry is more than an hour old, deletes meets that
// have run out (a declined one once its day is over), scrubs declined meets that have run out,
// and deletes push subscriptions, nudge records and blocks whose conference has ended.
//
// Usage: node scripts/purge-expired-people.mjs
// Env:   ES_URL; ES_PEOPLE_API_KEY (or ELASTISEARCH_API_KEY); ES_PEOPLE_INDEX (default caddie-people);
//        ES_PEOPLE_MEETS_INDEX (default caddie-people-meets); ES_PEOPLE_PUSH_INDEX (default
//        caddie-people-push); ES_PEOPLE_NUDGES_INDEX (default caddie-people-nudges);
//        ES_PEOPLE_BLOCKS_INDEX (default caddie-people-blocks).
//
// The server runs the same steps when it starts and once an hour. This is the operator's
// step for after a conference, when no instance may be running. It prints only counts. A block
// is deleted with the profile that made it and, once its conference has ended, here; a block
// without expires_at is never deleted here (npm run people:setup gives one to every block of a
// conference it can find).

import { PRESENCE_OFF, BLE_CAPS_OFF, EXPIRED_CAPS_QUERY, PENDING_DELETE_QUERY, isPendingDelete } from '../server/people-shared.mjs';

const ES_URL = (process.env.ES_URL || 'https://fc875c88f9f44f159f1a359ee724d82b.us-west1.gcp.cloud.es.io:443').replace(/\/$/, '');
const API_KEY = process.env.ES_PEOPLE_API_KEY || process.env.ELASTISEARCH_API_KEY;
const PEOPLE_INDEX = process.env.ES_PEOPLE_INDEX || 'caddie-people';
const MEETS_INDEX = process.env.ES_PEOPLE_MEETS_INDEX || 'caddie-people-meets';
const PUSH_INDEX = process.env.ES_PEOPLE_PUSH_INDEX || 'caddie-people-push';
const NUDGES_INDEX = process.env.ES_PEOPLE_NUDGES_INDEX || 'caddie-people-nudges';
const BLOCKS_INDEX = process.env.ES_PEOPLE_BLOCKS_INDEX || 'caddie-people-blocks';
const PRESENCE_PAGE = 500;
const PENDING_PAGE = 1000;
const enc = encodeURIComponent;

if (!API_KEY) {
  console.error('Set ES_PEOPLE_API_KEY or ELASTISEARCH_API_KEY.');
  process.exit(1);
}

async function es(method, path, body, ndjson = false) {
  const res = await fetch(`${ES_URL}${path}`, {
    method,
    headers: { Authorization: `ApiKey ${API_KEY}`, 'Content-Type': ndjson ? 'application/x-ndjson' : 'application/json' },
    body: body === undefined ? undefined : ndjson ? body : JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error(`${method} ${path.split('?')[0]} failed with status ${res.status}: ${json.error?.type ?? ''}`);
    process.exit(1);
  }
  return json;
}

// A realtime read of one people document (GET, so the search's refresh interval does not delay
// it): { found, source, seqNo, primaryTerm }.
async function getProfile(id) {
  const res = await fetch(`${ES_URL}/${enc(PEOPLE_INDEX)}/_doc/${enc(id)}?_source_includes=open_to_meet,shared_talk_ids`, {
    headers: { Authorization: `ApiKey ${API_KEY}` },
    signal: AbortSignal.timeout(60_000),
  });
  const json = await res.json().catch(() => ({}));
  if (res.status === 404) return { found: false };
  if (!res.ok) {
    console.error(`Reading a pending profile failed with status ${res.status}.`);
    process.exit(1);
  }
  return json.found ? { found: true, source: json._source ?? {}, seqNo: json._seq_no, primaryTerm: json._primary_term } : { found: false };
}

// Profile deletes that hid the profile (open_to_meet false, no shared talk) and then failed, and
// were never tried again: the same steps as finishPendingDelete in server/people.mjs, which says
// why each is there, with the same query (PENDING_DELETE_QUERY). For each one, in pages sorted by
// updated_at and profile_id: a realtime read, and nothing is touched unless the document is
// still a pending delete with the sequence number the search returned; then its meets, push
// subscriptions and nudge records; then the document, guarded by the sequence number of the read
// (a 409 means it changed, or that it is gone, which a second read tells apart); then the blocks
// it made, unless that second read finds a profile re-created from the same device. This runs
// first, so a pending delete whose conference has also ended loses its connections too.
let finished = 0;
let kept = 0;
let after;
for (;;) {
  const page = { size: PENDING_PAGE, _source: ['event_id', 'profile_id'], query: PENDING_DELETE_QUERY, sort: [{ updated_at: 'asc' }, { profile_id: 'asc' }] };
  if (after) page.search_after = after;
  const pending = await es('POST', `/${enc(PEOPLE_INDEX)}/_search?seq_no_primary_term=true`, page);
  const hits = pending.hits?.hits ?? [];
  for (const h of hits) {
    const { event_id: eventId, profile_id: profileId } = h._source ?? {};
    if (typeof eventId !== 'string' || typeof profileId !== 'string' || h._id !== `${eventId}:${profileId}`) continue;
    const own = await getProfile(h._id);
    if (!own.found || !isPendingDelete(own.source) || own.seqNo !== h._seq_no || own.primaryTerm !== h._primary_term) {
      kept++;
      continue;
    }
    const of = (field) => ({ bool: { filter: [{ term: { event_id: eventId } }, { term: { [field]: profileId } }] } });
    for (const [name, field] of [[MEETS_INDEX, 'participants'], [PUSH_INDEX, 'profile_id'], [NUDGES_INDEX, 'profile_ids']]) {
      await es('POST', `/${enc(name)}/_delete_by_query?conflicts=proceed&ignore_unavailable=true`, { query: of(field) });
    }
    const res = await fetch(`${ES_URL}/${enc(PEOPLE_INDEX)}/_doc/${enc(h._id)}?if_seq_no=${own.seqNo}&if_primary_term=${own.primaryTerm}&refresh=wait_for`, {
      method: 'DELETE',
      headers: { Authorization: `ApiKey ${API_KEY}` },
      signal: AbortSignal.timeout(60_000),
    });
    await res.body?.cancel();
    if (!res.ok && res.status !== 404 && res.status !== 409) {
      console.error(`Deleting a pending profile failed with status ${res.status}.`);
      process.exit(1);
    }
    if ((await getProfile(h._id)).found) {
      if (res.status === 409) kept++;
      else finished++;
      continue;
    }
    await es('POST', `/${enc(BLOCKS_INDEX)}/_delete_by_query?conflicts=proceed&ignore_unavailable=true`, { query: of('blocker_id') });
    finished++;
  }
  if (hits.length < PENDING_PAGE || !Array.isArray(hits[hits.length - 1].sort)) break;
  after = hits[hits.length - 1].sort;
}
console.log(`Finished ${finished} pending profile deletes${kept ? `; kept ${kept} that changed since they were found` : ''}.`);

// A profile is expired once visible_until has passed. A document without visible_until is never
// shown, so it is deleted as well.
const expiredProfiles = {
  bool: {
    should: [{ range: { visible_until: { lt: 'now' } } }, { bool: { must_not: { exists: { field: 'visible_until' } } } }],
    minimum_should_match: 1,
  },
};
const profiles = await es('POST', `/${encodeURIComponent(PEOPLE_INDEX)}/_delete_by_query?conflicts=proceed`, { query: expiredProfiles });
console.log(`Deleted ${profiles.deleted ?? 0} expired profiles.`);

// Presence that has run out is cleared with a Bulk partial update of the presence fields (the
// position, its cell and its time, the held flag and the Bluetooth token among them,
// PRESENCE_OFF), the same write the server uses, so nothing is re-embedded.
let cleared = 0;
for (;;) {
  const found = await es('POST', `/${encodeURIComponent(PEOPLE_INDEX)}/_search`, {
    size: PRESENCE_PAGE,
    _source: false,
    query: { range: { presence_until: { lt: 'now' } } },
  });
  const ids = (found.hits?.hits ?? []).map((h) => h._id);
  if (!ids.length) break;
  const body = ids.map((id) => `${JSON.stringify({ update: { _id: id } })}\n${JSON.stringify({ doc: PRESENCE_OFF })}\n`).join('');
  const res = await es('POST', `/${encodeURIComponent(PEOPLE_INDEX)}/_bulk?refresh=wait_for`, body, true);
  const ok = (res.items ?? []).filter((i) => i.update?.status >= 200 && i.update?.status < 300).length;
  cleared += ok;
  if (ok < ids.length) break;
}
console.log(`Cleared ${cleared} expired presence entries.`);

// Bluetooth caps records (server/ble.mjs) whose newest entry has left the rolling hour: they no
// longer count for anything. Each clear is guarded by the sequence number the search returned, so
// a record that a sightings answer wrote meanwhile is kept, as the server's hourly purge does.
let capsCleared = 0;
for (;;) {
  const found = await es('POST', `/${encodeURIComponent(PEOPLE_INDEX)}/_search?seq_no_primary_term=true`, {
    size: PRESENCE_PAGE,
    _source: false,
    query: EXPIRED_CAPS_QUERY,
  });
  const hits = (found.hits?.hits ?? []).filter((h) => Number.isInteger(h._seq_no) && Number.isInteger(h._primary_term));
  if (!hits.length) break;
  const body = hits.map((h) => `${JSON.stringify({ update: { _id: h._id, if_seq_no: h._seq_no, if_primary_term: h._primary_term } })}\n${JSON.stringify({ doc: BLE_CAPS_OFF })}\n`).join('');
  const res = await es('POST', `/${encodeURIComponent(PEOPLE_INDEX)}/_bulk?refresh=wait_for`, body, true);
  const ok = (res.items ?? []).filter((i) => i.update?.status >= 200 && i.update?.status < 300).length;
  capsCleared += ok;
  if (ok < hits.length) break;
}
console.log(`Cleared ${capsCleared} run-out Bluetooth caps records.`);

// A declined meet is the evidence for the daily "Not now" pause, so it is kept until its day is
// over (two days after ended_at, which covers a 25-hour day). These queries and the script are
// the same as EXPIRED_MEETS_QUERY, RUN_OUT_DECLINED_QUERY and SCRUB_MEET_SCRIPT in
// server/people.mjs.
const meets = await es('POST', `/${encodeURIComponent(MEETS_INDEX)}/_delete_by_query?conflicts=proceed&ignore_unavailable=true`, {
  query: {
    bool: {
      should: [
        { bool: { filter: [{ range: { expires_at: { lt: 'now' } } }], must_not: [{ term: { state: 'declined' } }] } },
        { bool: { filter: [{ term: { state: 'declined' } }, { range: { expires_at: { lt: 'now' } } }], must_not: [{ range: { ended_at: { gte: 'now-2d' } } }] } },
      ],
      minimum_should_match: 1,
    },
  },
});
console.log(`Deleted ${meets.deleted ?? 0} expired meets.`);

// A declined meet that has run out keeps no note, meeting point or spot-me line.
const scrubbed = await es('POST', `/${encodeURIComponent(MEETS_INDEX)}/_update_by_query?conflicts=proceed&ignore_unavailable=true`, {
  query: { bool: { filter: [{ term: { state: 'declined' } }, { range: { expires_at: { lt: 'now' } } }] } },
  script: {
    lang: 'painless',
    source: "if (ctx._source.note == null && ctx._source.rendezvous == null && (ctx._source.spot_me == null || ctx._source.spot_me.isEmpty()) && (ctx._source.spot_me_pending == null || ctx._source.spot_me_pending.isEmpty()) && ctx._source.note_pending != true) { ctx.op = 'noop'; } else { ctx._source.note = null; ctx._source.rendezvous = null; ctx._source.spot_me = [:]; ctx._source.spot_me_pending = [:]; ctx._source.note_pending = false; }",
  },
});
console.log(`Scrubbed ${scrubbed.updated ?? 0} run-out declined meets.`);

// Push subscriptions, nudge records and blocks expire with their conference (expires_at =
// visible_until).
for (const [name, what] of [[PUSH_INDEX, 'push subscriptions'], [NUDGES_INDEX, 'nudge records'], [BLOCKS_INDEX, 'blocks']]) {
  const r = await es('POST', `/${encodeURIComponent(name)}/_delete_by_query?conflicts=proceed&ignore_unavailable=true`, {
    query: { range: { expires_at: { lt: 'now' } } },
  });
  console.log(`Deleted ${r.deleted ?? 0} expired ${what}.`);
}
