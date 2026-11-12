// What the tier 3 ingest (scripts/ingest.mjs) does around the talks it deletes, as the Worker's
// finalize does (worker/src/admin.js finalizeTalks):
//
// - The shrink guard. People's sharing is not restored when a deleted talk comes back, so a run
//   that would delete more than MAX_DELETE talks and more than MAX_DELETE_SHARE of a conference's
//   talks is refused unless the operator passes --allow-shrink (the Worker's FINALIZE_MAX_DELETE
//   and FINALIZE_MAX_DELETE_SHARE, and its allow_shrink). The Worker counts after its upsert, so
//   its total is the stored talks plus the new ones; the ingest passes the same number. A feed
//   that came back short for a moment (a Sessionize outage, a wrong group filter) then leaves the
//   talks and the people as they were.
// - The people who shared for a deleted talk (a cancelled session, a takedown, a talk that left the
//   feed). The talk leaves every profile's shared_talk_ids at that conference, so no circle is left
//   for a talk that no longer exists, and a profile that is then neither open to meet nor sharing
//   for any talk is deleted with everything that connects it to others, through the same delete a
//   person's own "Delete my profile" runs (server/people-delete.mjs deleteProfileAndConnections:
//   meets, push subscriptions and native push registrations, nudge records, then the blocks the
//   person made, then the document). docs/CONTRACT.md: a profile exists only while one of the two
//   choices holds.
//
// Every people request is one the people key may send. That key holds read, write and
// view_index_metadata on caddie-people* and no refresh privilege (DECISIONS.md, "Deletes without
// the refresh privilege"), so writes use Bulk with refresh=wait_for and deletes go through
// deleteWhere (a search, then a Bulk delete); nothing sends _refresh, refresh=true or
// _delete_by_query.
//
// Importing this module has no side effect: it reads no environment and makes no request.

import { createProfileDelete } from '../../server/people-delete.mjs';
import { isPendingDelete } from '../../server/people-shared.mjs';
import { peoplePreference, withPreference } from '../../server/preference.mjs';

export const MAX_DELETE = 10;
export const MAX_DELETE_SHARE = 0.1;

/**
 * Why deleting `stale` of a conference's `all` talks (the stored ones plus the ones this run adds,
 * as the Worker counts them) needs --allow-shrink, or null when it does not. The Worker's rule:
 * stale > FINALIZE_MAX_DELETE && stale > all * FINALIZE_MAX_DELETE_SHARE.
 */
export function shrinkRefusal(stale, all) {
  if (stale > MAX_DELETE && stale > all * MAX_DELETE_SHARE) {
    return `the run would delete ${stale} of ${all} talks, more than ${MAX_DELETE} and more than ${MAX_DELETE_SHARE * 100}%`;
  }
  return null;
}

/** A people request that failed. The message names the method, the index and a status, never a key or a document id. */
export class PeopleError extends Error {}

const PEOPLE_TIMEOUT_MS = 60_000;
// "POST /caddie-people/_search": the path without its query and without a document id, which
// holds a profile id.
const where = (method, path) => {
  const [index, op] = path.split('?')[0].split('/').filter(Boolean);
  return `${method} /${index ?? ''}${op ? `/${op}` : ''}`;
};

/**
 * The transport server/people-delete.mjs expects, people(method, path, body, { ndjson, okStatuses }),
 * built on request(method, path, body, { ndjson, timeout }) answering { status, json } (scripts/lib/es.mjs
 * es() with the people key). It answers { status, json } and throws PeopleError on a status outside
 * 2xx and okStatuses, on a network failure or timeout, and on a body that is not JSON.
 */
export function peopleTransport(request) {
  return async function people(method, path, body, { ndjson = false, okStatuses = [] } = {}) {
    let res;
    try {
      res = await request(method, path, body, { ndjson, timeout: PEOPLE_TIMEOUT_MS });
    } catch (err) {
      throw new PeopleError(`${where(method, path)}: ${err?.name === 'TimeoutError' ? 'timeout' : 'network error'}`);
    }
    if ((res.status < 200 || res.status > 299) && !okStatuses.includes(res.status)) throw new PeopleError(`${where(method, path)} failed with status ${res.status}`);
    if (!res.json) throw new PeopleError(`${where(method, path)}: invalid response`);
    return res;
  };
}

const PAGE = 500;
const MAX_PAGES = 200;
// Failures in a row after which the cleanup stops instead of trying every remaining profile, each
// up to the request timeout, against a cluster that is not answering.
const MAX_FAILURES_IN_A_ROW = 5;
// A guarded write that meets a concurrent one (a presence write, a profile write) reads the
// profile again and tries again, at most this many times in all.
const UNSHARE_ATTEMPTS = 3;
const idx = (name) => `/${encodeURIComponent(name)}`;
const list = (v) => (Array.isArray(v) ? v : v === undefined || v === null ? [] : [v]);

/**
 * people   the transport above
 * indices  { people, meets, push, nudges, blocks }, the index names (scripts/admin/backends/es.mjs indicesFrom)
 * log      where a profile's failure goes; its lines carry no profile id
 * Returns { unshareDeletedTalks(slug, talkIds) }.
 */
export function createDeletedTalkCleanup({ people, indices, log = (message) => console.error(message) }) {
  const profileDelete = createProfileDelete({ people, withPreference, peoplePreference, indices, UpstreamError: PeopleError, log });
  const errorText = (err) => (err instanceof PeopleError ? err.message : (err?.name ?? 'error'));

  // One Bulk action on the people index with refresh=wait_for; answers the item's status.
  async function bulkOne(action, doc) {
    const body = `${JSON.stringify(action)}\n${JSON.stringify(doc)}\n`;
    const { json } = await people('POST', `${idx(indices.people)}/_bulk?refresh=wait_for`, body, { ndjson: true });
    const item = json.items?.[0] ?? {};
    return (Object.values(item)[0] ?? {}).status ?? 500;
  }

  // A realtime read of one profile: { source, seqNo, primaryTerm }, or null when it is gone.
  async function readProfile(id) {
    const { status, json } = await people('GET', `${idx(indices.people)}/_doc/${encodeURIComponent(id)}?_source_includes=profile_id,open_to_meet,shared_talk_ids`, undefined, { okStatuses: [404] });
    if (status === 404 || !json.found) return null;
    return { source: json._source ?? {}, seqNo: json._seq_no, primaryTerm: json._primary_term };
  }

  // Takes the deleted talks out of one profile's shared_talk_ids with a partial update guarded by
  // the sequence number it was read with, so a concurrent write is never overwritten: on a
  // conflict the profile is read again and the update rebuilt from what is stored now. Returns
  // 'unshared', 'unchanged' (it no longer shares a deleted talk) or 'gone'.
  async function unshare(id, state, gone) {
    for (let attempt = 1; ; attempt++) {
      const shared = list(state.source.shared_talk_ids);
      const kept = shared.filter((t) => !gone.has(t));
      if (kept.length === shared.length) return 'unchanged';
      const status = await bulkOne({ update: { _id: id, if_seq_no: state.seqNo, if_primary_term: state.primaryTerm } }, { doc: { shared_talk_ids: kept } });
      if (status === 404) return 'gone';
      if (status >= 200 && status <= 299) return 'unshared';
      if (status !== 409 || attempt >= UNSHARE_ATTEMPTS) throw new PeopleError(`bulk item status ${status}`);
      state = await readProfile(id);
      if (!state) return 'gone';
    }
  }

  // One profile that shares for a deleted talk. Returns 'unshared', 'deleted', 'unchanged',
  // 'gone' or 'skipped' (a hit that is not a profile of this conference).
  async function cleanOne(slug, hit, gone) {
    const profileId = hit._source?.profile_id;
    if (typeof profileId !== 'string' || hit._id !== `${slug}:${profileId}`) return 'skipped';
    const outcome = await unshare(hit._id, { source: hit._source, seqNo: hit._seq_no, primaryTerm: hit._primary_term }, gone);
    if (outcome !== 'unshared') return outcome;
    // Neither open to meet nor sharing for any talk now: the profile goes, as a profile write with
    // both choices off deletes it. The unshare above left exactly the state of a pending delete
    // (open_to_meet false, no shared_talk_ids), which every route and the export already treat as
    // gone and the hourly purge would finish. A realtime read first, and the delete's hide is
    // guarded by that read: a profile its owner made visible or shared again in the meantime, even
    // in the moment between the read and the hide, is kept with everything it has.
    const now = await readProfile(hit._id);
    if (!now || !isPendingDelete(now.source)) return 'unshared';
    const deleted = await profileDelete.deleteProfileAndConnections(slug, profileId, { guard: { seqNo: now.seqNo, primaryTerm: now.primaryTerm } });
    return deleted === 'deleted' ? 'deleted' : 'unshared';
  }

  /**
   * Takes talkIds (talks of the conference `slug` that the talks index no longer holds) out of every
   * profile of that conference that shares for one of them, and deletes the profiles left with
   * neither choice. Returns { unshared, profilesDeleted, failed }: profiles that stopped sharing for
   * a deleted talk (the deleted ones among them), profiles deleted, and profiles whose cleanup
   * failed (each logged). Throws PeopleError when the people search itself fails, or after
   * MAX_FAILURES_IN_A_ROW profiles in a row failed.
   */
  async function unshareDeletedTalks(slug, talkIds) {
    const result = { unshared: 0, profilesDeleted: 0, failed: 0 };
    const ids = [...new Set(talkIds)].filter((id) => typeof id === 'string' && id.startsWith(`${slug}:`));
    if (!ids.length) return result;
    const gone = new Set(ids);
    let after;
    let inARow = 0;
    for (let page = 0; page < MAX_PAGES; page++) {
      const body = {
        size: PAGE,
        _source: ['profile_id', 'open_to_meet', 'shared_talk_ids'],
        query: { bool: { filter: [{ term: { event_id: slug } }, { terms: { shared_talk_ids: ids } }] } },
        sort: [{ profile_id: 'asc' }],
      };
      if (after) body.search_after = after;
      // ignore_unavailable: a deployment that never set up the people indices has nobody to clean up.
      const { json } = await people('POST', withPreference(`${idx(indices.people)}/_search?seq_no_primary_term=true&ignore_unavailable=true`, peoplePreference(slug)), body);
      const hits = json.hits?.hits ?? [];
      for (const hit of hits) {
        try {
          const outcome = await cleanOne(slug, hit, gone);
          inARow = 0;
          if (outcome === 'unshared' || outcome === 'deleted') result.unshared++;
          if (outcome === 'deleted') result.profilesDeleted++;
        } catch (err) {
          result.failed++;
          log(`A profile that shared for a deleted talk could not be updated: ${errorText(err)}`);
          if (++inARow >= MAX_FAILURES_IN_A_ROW) throw new PeopleError(`stopped after ${inARow} profiles in a row failed`);
        }
      }
      if (hits.length < PAGE) return result;
      after = hits[hits.length - 1].sort;
      if (!Array.isArray(after)) throw new PeopleError('the people search answered without sort values');
    }
    throw new PeopleError(`more than ${PAGE * MAX_PAGES} profiles share for the deleted talks`);
  }

  return { unshareDeletedTalks };
}
