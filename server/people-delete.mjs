// The profile delete: the steps that remove a person's document and everything that connects
// them to others at one conference, in the order that keeps every failure safe to retry. This is
// the one implementation of "Delete my profile": server/people.mjs runs it for
// DELETE /api/people/profile and for a profile write with both visibility choices off, and the
// caddie-admin CLI (scripts/caddie-admin.mjs, `attendees delete` and
// `moderation delete profile:<ref>`) runs the same code with the operator's admin key, so an
// operator delete and a person's own delete leave the same state. test/delete-profile.test.mjs is
// the oracle for the order and the retry safety; the CLI test only checks that its run makes the
// same calls.
//
// Importing this module has no side effect: it reads no environment, starts no timer and makes
// no request. Everything it needs is injected through createProfileDelete:
//   people(method, path, body, { ndjson, okStatuses })  the Elasticsearch transport, answering
//                                 { status, json } and throwing UpstreamError on any other status
//   bulkOne(action, doc)          one Bulk action on the people index with refresh=wait_for,
//                                 answering the item status (built from `people` when absent)
//   deleteDoc(id)                 DELETE of one people document with refresh=wait_for, answering
//                                 the status, 404 included (built from `people` when absent)
//   withPreference, peoplePreference   server/preference.mjs
//   indices                       { people, meets, push, nudges, blocks } alias names
//   UpstreamError                 the error class a failed step throws (server/people.mjs's, so
//                                 the routes answer 502; the CLI passes its own)
//   log(message)                  where the second pass's failure goes (console.error by default)

import { PRESENCE_OFF, isPendingDelete } from './people-shared.mjs';

const DELETE_BATCH = 1000;
const DELETE_ROUNDS = 20;

// The partial update that hides a profile while it is being deleted. Matches, the Around view,
// nudges and Bluetooth sightings require open_to_meet; circle members, circle counts and For
// you's circle counts require a shared talk; asks (personByRef) require either. Presence and the
// Bluetooth token are cleared as a presence delete clears them. The result is the state
// isPendingDelete recognises. visible_until is left alone, so the hourly purge does not take the
// document for an expired one; it finishes the delete instead (finishPendingDeletes).
export const HIDE_FOR_DELETE = { open_to_meet: false, shared_talk_ids: [], ...PRESENCE_OFF };
// A presence write or a report landing on the document at the same moment is a version conflict
// that Elasticsearch retries itself, instead of failing the delete with a 502.
export const HIDE_RETRIES = 3;

const idx = (name) => `/${encodeURIComponent(name)}`;
const docId = (eventId, profileId) => `${eventId}:${profileId}`;

// The blocks a person made at one conference. Blocks other people made of them are not touched.
export const ownBlocksQuery = (eventId, profileId) => ({ bool: { filter: [{ term: { event_id: eventId } }, { term: { blocker_id: profileId } }] } });

export function createProfileDelete({ people, bulkOne, deleteDoc, withPreference, peoplePreference, indices, UpstreamError, log = (message) => console.error(message) }) {
  if (typeof people !== 'function') throw new TypeError('createProfileDelete needs a people transport');
  for (const name of ['people', 'meets', 'push', 'nudges', 'blocks']) {
    if (typeof indices?.[name] !== 'string' || !indices[name]) throw new TypeError(`createProfileDelete needs indices.${name}`);
  }
  const Failure = UpstreamError ?? Error;
  const errorText = (err) => (err instanceof Failure ? err.message : (err?.name ?? 'error'));

  // The server's bulkOne and deleteDoc, when the caller has none: the same requests, byte for byte.
  const bulk = bulkOne ?? (async (action, doc) => {
    const body = `${JSON.stringify(action)}\n${JSON.stringify(doc)}\n`;
    const { json } = await people('POST', `${idx(indices.people)}/_bulk?refresh=wait_for`, body, { ndjson: true });
    const item = json.items?.[0] ?? {};
    const result = Object.values(item)[0] ?? {};
    return result.status ?? 500;
  });
  const removeDoc = deleteDoc ?? (async (id) => {
    const { status } = await people('DELETE', `${idx(indices.people)}/_doc/${encodeURIComponent(id)}?refresh=wait_for`, undefined, { okStatuses: [404] });
    return status;
  });

  // Deletes every document of one event's index that matches the query, so the next request
  // already sees them gone. The people key holds read and write but not the refresh privilege that
  // _delete_by_query?refresh=true needs (it answers 403 after deleting), so the ids are searched
  // for and removed with a Bulk delete and refresh=wait_for, which write covers. The admin key
  // could refresh, but the CLI runs this same path so that one test is the oracle for both.
  async function deleteWhere(index, eventId, query) {
    for (let round = 0; round < DELETE_ROUNDS; round++) {
      const { json } = await people('POST', withPreference(`${idx(index)}/_search?ignore_unavailable=true`, peoplePreference(eventId)), {
        size: DELETE_BATCH,
        _source: false,
        query,
      });
      const ids = (json.hits?.hits ?? []).map((h) => h._id);
      if (!ids.length) return;
      const body = ids.map((id) => `${JSON.stringify({ delete: { _id: id } })}\n`).join('');
      const { json: result } = await people('POST', `${idx(index)}/_bulk?refresh=wait_for`, body, { ndjson: true });
      for (const item of result.items ?? []) {
        const status = item.delete?.status ?? 500;
        if (status !== 404 && (status < 200 || status > 299)) throw new Failure(`bulk item status ${status}`);
      }
      if (ids.length < DELETE_BATCH) return;
    }
    throw new Failure('too many documents to delete');
  }

  // Every meet a person takes part in, their push subscriptions and native push registrations,
  // and the nudge records they were part of, at one conference. The three indices are cleared
  // concurrently; a failure is thrown only once all three have finished, so nothing is still
  // deleting when the caller answers or retries.
  async function deleteMeetsPushAndNudges(eventId, profileId) {
    const results = await Promise.allSettled([
      deleteWhere(indices.meets, eventId, { bool: { filter: [{ term: { event_id: eventId } }, { term: { participants: profileId } }] } }),
      deleteWhere(indices.push, eventId, { bool: { filter: [{ term: { event_id: eventId } }, { term: { profile_id: profileId } }] } }),
      deleteWhere(indices.nudges, eventId, { bool: { filter: [{ term: { event_id: eventId } }, { term: { profile_ids: profileId } }] } }),
    ]);
    const failed = results.find((r) => r.status === 'rejected');
    if (failed) throw failed.reason;
  }

  const deleteOwnBlocks = (eventId, profileId) => deleteWhere(indices.blocks, eventId, ownBlocksQuery(eventId, profileId));

  // Everything that connects a person to others at one conference and goes with their profile:
  // meets, push subscriptions and nudge records, then the blocks they made
  // (deleteProfileAndConnections says why those go last). Blocks others made of this person stay
  // until the conference ends, so deleting and re-creating the profile from the same device never
  // lifts them. Runs when the profile is deleted, and the next request already sees them gone.
  async function deleteConnections(eventId, profileId) {
    await deleteMeetsPushAndNudges(eventId, profileId);
    await deleteOwnBlocks(eventId, profileId);
  }

  // Deletes a profile and everything that connects it to others, in an order that keeps every
  // failure safe to retry:
  // 1. One partial update hides the profile and waits for the refresh, so from then on no match,
  //    circle, ask, nudge or Bluetooth sighting finds the person, whatever happens next. A 404 means
  //    the document went between the caller's read and this write, and the delete answers 200 as
  //    it does when the read finds no document. It is a plain update (no upsert), so it never
  //    creates a document.
  // 2. Meets, push subscriptions and nudge records are deleted concurrently, and then the blocks
  //    this person made. Blocks go last because a delete that fails part-way leaves a hidden
  //    profile that its owner can make visible again with a profile write, and it must still carry
  //    every block when that happens.
  // 3. The document is deleted last. Until then, any failed step answers 502, and trying again
  //    authenticates against the document and runs the whole delete again. A delete that is never
  //    tried again is finished by the hourly purge (finishPendingDeletes); until then the hidden
  //    document is found by nothing, every route but this one and the profile write treat it as no
  //    profile (authenticated), and the export leaves it out.
  // The hide stops new lookups, not requests already under way: an ask that passed personByRef just
  // before the hide, a nudge that was already ranking, or the owner's own device blocking someone
  // or subscribing to push, can still write a meet, a nudge record, a block or a push subscription
  // after step 2 has finished with that index. The second pass, after the document is gone, removes
  // what has landed by then. It is best effort: a failure there is logged and the delete still
  // answers 200, because trying again would find no profile and change nothing. A write that lands
  // even later stays: the purge removes such a meet once it runs out, and a push subscription, a
  // nudge record or a block once the conference ends.
  // Returns 'gone' when the hide finds no document and 'deleted' otherwise. With `guard` it runs the
  // guarded delete below instead.
  async function deleteProfileAndConnections(eventId, profileId, { guard = null } = {}) {
    if (guard) return deleteGuarded(eventId, profileId, guard);
    const id = docId(eventId, profileId);
    const status = await bulk({ update: { _id: id, retry_on_conflict: HIDE_RETRIES } }, { doc: HIDE_FOR_DELETE });
    if (status === 404) return 'gone';
    if (status < 200 || status > 299) throw new Failure(`bulk item status ${status}`);
    await deleteConnections(eventId, profileId);
    await removeDoc(id);
    try {
      await deleteConnections(eventId, profileId);
    } catch (err) {
      log(`Deleting a deleted profile's connections again failed: ${errorText(err)}`);
    }
    return 'deleted';
  }

  // A realtime read of the fields that decide a pending delete: { source, seqNo, primaryTerm }, or
  // null when the document is gone.
  async function readOwn(id) {
    const { status, json } = await people('GET', `${idx(indices.people)}/_doc/${encodeURIComponent(id)}?_source_includes=open_to_meet,shared_talk_ids`, undefined, { okStatuses: [404] });
    if (status === 404 || !json?.found) return null;
    return { source: json._source ?? {}, seqNo: json._seq_no, primaryTerm: json._primary_term };
  }

  // The delete of a profile its owner did not ask to delete: the ingest's cleanup of a profile left
  // with neither choice after a talk was deleted (scripts/lib/dropped-talks.mjs). guard is the
  // { seqNo, primaryTerm } of the caller's own realtime read, which found the profile in the
  // pending-delete state. The owner may make the profile visible again at any moment, and such a
  // write must win, so every step that could undo it is a compare-and-write, in the order the
  // purge finishes a pending delete (finishPendingDelete in server/people.mjs):
  // 1. The hide, guarded by that read (if_seq_no instead of retry_on_conflict; Elasticsearch takes
  //    one or the other). A write since the read answers 409: 'kept', nothing deleted.
  // 2. A realtime read for the sequence number the hide left. A profile that is no longer a pending
  //    delete is 'kept', nothing deleted.
  // 3. Meets, push subscriptions and registrations, and nudge records.
  // 4. The document, guarded by the read of step 2. A write since then answers 409, and the read
  //    after it finds the profile: 'kept', with its blocks. It loses the meets, push and nudge
  //    records of step 3, as a pending delete the purge finishes does; the app registers for push
  //    again on its own.
  // 5. The blocks the person made, only once a read finds the document gone, then the second pass
  //    over the connections (best effort, as above).
  // Returns 'deleted', 'kept' or 'gone' (the document went before step 1).
  async function deleteGuarded(eventId, profileId, guard) {
    if (!Number.isInteger(guard?.seqNo) || !Number.isInteger(guard?.primaryTerm)) throw new TypeError('the guard needs an integer seqNo and primaryTerm');
    const id = docId(eventId, profileId);
    const status = await bulk({ update: { _id: id, if_seq_no: guard.seqNo, if_primary_term: guard.primaryTerm } }, { doc: HIDE_FOR_DELETE });
    if (status === 404) return 'gone';
    if (status === 409) return 'kept';
    if (status < 200 || status > 299) throw new Failure(`bulk item status ${status}`);
    const hidden = await readOwn(id);
    if (!hidden) return 'gone';
    if (!isPendingDelete(hidden.source)) return 'kept';
    await deleteMeetsPushAndNudges(eventId, profileId);
    await people('DELETE', `${idx(indices.people)}/_doc/${encodeURIComponent(id)}?if_seq_no=${hidden.seqNo}&if_primary_term=${hidden.primaryTerm}&refresh=wait_for`, undefined, { okStatuses: [404, 409] });
    if (await readOwn(id)) return 'kept';
    await deleteOwnBlocks(eventId, profileId);
    try {
      await deleteConnections(eventId, profileId);
    } catch (err) {
      log(`Deleting a deleted profile's connections again failed: ${errorText(err)}`);
    }
    return 'deleted';
  }

  return { deleteWhere, deleteMeetsPushAndNudges, deleteOwnBlocks, deleteConnections, deleteProfileAndConnections };
}
