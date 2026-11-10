// Report: POST /api/people/report, the one route of the "Then" phase's Report item.
//
// Env: as people.mjs; ES_PEOPLE_REPORTS_INDEX (default caddie-people-reports) holds the reports.
// The people key covers it, because every index of Find & connect is named caddie-people-*.
//
// Rules this module keeps:
// - The route needs the device header and a live profile of the reporter at that conference, the
//   same as a block. One report per reporter per target: the report's _id is
//   {kind}:{target_id}:{reporter_id} and it is written with op_type create, so sending the same
//   report twice is harmless and answers 200 both times.
// - A target is a person's profile (kind profile, named by their ref), their presence spot line
//   (kind spot, the same ref) or a meet (kind meet, named by its meet_id; the reporter must be a
//   participant and ref must name the other one). Reporting oneself is a 404, like blocking.
// - The reports outlive the people document: when a profile is created again or fully reindexed,
//   people.mjs counts them (reportCountsFor) and sets hidden and spot_hidden again at HIDE_AT, so
//   deleting and re-making a profile does not undo a hide. Only the operator's --unhide (which
//   deletes the reports) or --purge does.
// - Two distinct reporters hide the target. A profile gets hidden: true, a meet gets hidden: true
//   and hidden_owner_id (the reported participant, who alone keeps seeing it), a spot gets its
//   presence_spot cleared and spot_hidden: true. The hide is a Bulk partial update
//   (or an _update on the meet), so it never re-runs the embedding model. people.mjs and
//   connect.mjs read the flags (see "Reports and moderation" in docs/CONTRACT.md); the operator
//   CLI is scripts/moderation.mjs.
// - 20 reports per device per hour, on top of the shared per-address write limit.
// - The response is { ok, hidden }. The reporter never learns who else reported, and no
//   profile_id, reporter_id or report _id leaves the server. Nothing from the body is logged.
// - The text filter (server/moderation.mjs, through connect.mjs) writes a report too when it holds
//   a line: reporter_id 'classifier', reason 'classifier', on the author, so a held line counts
//   as one of the two reports and shows up in the operator CLI. Repeated holds by the same
//   author of the same target collapse into one report.

import { clientIp } from './ratelimit.mjs';
import { refFor } from './device.mjs';
import { peoplePreference, withPreference } from './preference.mjs';
// people.mjs imports reportCountsFor and HIDE_AT from here in turn; neither module uses the other's
// bindings while it is being evaluated, so the cycle is safe.
import {
  people, idx, docId, MEETS_INDEX, LIMITS, REF_RE,
  HttpError, UpstreamError, bad, sendJson, limit, jsonBody, requireDevice, isPlainObject,
  conferenceFor, authenticated, docByRef, bulkOne, dispatch,
} from './people.mjs';

export const REPORTS_INDEX = process.env.ES_PEOPLE_REPORTS_INDEX || 'caddie-people-reports';

const HOUR_MS = 60 * 60_000;
const REPORTS_PER_HOUR = 20;
// Distinct reporters at which a target is hidden from everyone but its owner.
export const HIDE_AT = 2;

const KINDS = new Set(['profile', 'meet', 'spot']);
const REASONS = new Set(['harassment', 'hate', 'sexual', 'spam', 'other']);
const REPORT_KEYS = new Set(['event', 'ref', 'context', 'reason']);
const CONTEXT_KEYS = new Set(['kind', 'id']);
const MEET_ID_RE = /^[A-Za-z0-9_-]{22}$/;

const notFound = () => new HttpError(404, { error: 'not_found' });

// Validates the body and returns { ref, kind, id, reason }. Unknown keys and values are 400.
function validate(body) {
  if (typeof body.ref !== 'string' || !REF_RE.test(body.ref)) throw bad('ref must be a result reference');
  if (!isPlainObject(body.context)) throw bad('context must be an object');
  for (const k of Object.keys(body.context)) if (!CONTEXT_KEYS.has(k)) throw bad(`Unknown key: context.${k.slice(0, 40)}`);
  const { kind, id } = body.context;
  if (typeof kind !== 'string' || !KINDS.has(kind)) throw bad("context.kind must be 'profile', 'meet' or 'spot'");
  if (typeof id !== 'string') throw bad('context.id must be a string');
  if (kind === 'meet') {
    if (!MEET_ID_RE.test(id)) throw bad('context.id must be a meet id');
  } else if (id !== body.ref) {
    throw bad("context.id must be the reported person's ref");
  }
  if (typeof body.reason !== 'string' || !REASONS.has(body.reason)) throw bad("reason must be 'harassment', 'hate', 'sexual', 'spam' or 'other'");
  return { ref: body.ref, kind, id, reason: body.reason };
}

async function loadMeet(id) {
  const { status, json } = await people('GET', `${idx(MEETS_INDEX)}/_doc/${encodeURIComponent(id)}`, undefined, { okStatuses: [404] });
  if (status === 404 || !json.found) return null;
  return json._source ?? {};
}

// The profile_id of the person a report is about. A profile or spot report names them by ref; a
// meet report names a meet the reporter takes part in, whose other participant the ref must be.
async function targetProfileId(me, slug, { ref, kind, id }) {
  if (kind === 'meet') {
    const meet = await loadMeet(id);
    const participants = Array.isArray(meet?.participants) ? meet.participants : [];
    if (!meet || meet.event_id !== slug || !participants.includes(me.profile_id)) throw notFound();
    const other = participants.find((p) => p !== me.profile_id);
    if (!other || refFor(slug, other) !== ref) throw bad('ref must name the other participant of the meet');
    return other;
  }
  const them = await docByRef(slug, ref);
  if (!them || them.profile_id === me.profile_id) throw notFound();
  return them.profile_id;
}

// Distinct reporters of one target. Every report document is one reporter, by its _id.
async function reporterCount(slug, kind, id) {
  const { json } = await people('POST', `${idx(REPORTS_INDEX)}/_count?ignore_unavailable=true`, {
    query: { bool: { filter: [{ term: { event_id: slug } }, { term: { target_kind: kind } }, { term: { target_id: id } }] } },
  });
  return json.count ?? 0;
}

// The distinct reporters of one person's profile and of their spot line, as { profile, spot }:
// one small search (size 0) with a terms aggregation on target_kind, since both kinds are named by
// the person's ref. people.mjs reads it whenever it creates or fully reindexes a profile document,
// because the reports outlive the document: a profile hidden after reports whose owner turns both
// visibility choices off (which deletes the document) and on again is hidden again. A missing
// reports index counts as none. Throws the transport's UpstreamError when the search fails, and
// the caller fails closed.
export async function reportCountsFor(slug, ref) {
  const { json } = await people('POST', withPreference(`${idx(REPORTS_INDEX)}/_search?ignore_unavailable=true`, peoplePreference(slug)), {
    size: 0,
    query: { bool: { filter: [{ term: { event_id: slug } }, { terms: { target_kind: ['profile', 'spot'] } }, { term: { target_id: ref } }] } },
    aggs: { kinds: { terms: { field: 'target_kind', size: 2 } } },
  });
  const counts = { profile: 0, spot: 0 };
  for (const b of json.aggregations?.kinds?.buckets ?? []) if (b.key === 'profile' || b.key === 'spot') counts[b.key] = b.doc_count ?? 0;
  return counts;
}

// Marks a target hidden. A target that is already gone (404) needs nothing. A meet also records
// whose content was reported (hidden_owner_id), the one participant who keeps seeing it.
async function hide(slug, kind, id, profileId) {
  if (kind === 'meet') {
    await people('POST', `${idx(MEETS_INDEX)}/_update/${encodeURIComponent(id)}?refresh=wait_for`, { doc: { hidden: true, hidden_owner_id: profileId } }, { okStatuses: [404] });
    return;
  }
  const doc = kind === 'profile' ? { hidden: true } : { presence_spot: null, spot_hidden: true };
  const status = await bulkOne({ update: { _id: docId(slug, profileId) } }, { doc });
  if (status !== 404 && (status < 200 || status > 299)) throw new UpstreamError(`bulk item status ${status}`);
}

// The automatic report the filter files when it holds a line. The _id's reporter is the fixed
// 'classifier', so repeated holds of the same target are one report, and the usual hide rule
// applies: one human report plus a classifier hold hides the target. Never throws, so a report
// that could not be written does not fail the write that was held.
export async function classifierReport(slug, kind, id, profileId) {
  try {
    await people('PUT', `${idx(REPORTS_INDEX)}/_create/${encodeURIComponent(`${kind}:${id}:classifier`)}?refresh=wait_for`, {
      event_id: slug,
      target_kind: kind,
      target_id: id,
      target_profile_id: profileId,
      reporter_id: 'classifier',
      reason: 'classifier',
      created_at: new Date().toISOString(),
    }, { okStatuses: [409] });
    if ((await reporterCount(slug, kind, id)) >= HIDE_AT) await hide(slug, kind, id, profileId);
  } catch (err) {
    console.error(`classifier report failed: ${err?.message ?? 'error'}`);
  }
}

async function report(req, res) {
  limit(`people-write:ip:${clientIp(req)}`, LIMITS.writeIp);
  const device = requireDevice(req);
  limit(`report:dev:${device.profileId}`, REPORTS_PER_HOUR, HOUR_MS);

  const body = await jsonBody(req, REPORT_KEYS);
  const r = validate(body);
  const conf = await conferenceFor(body.event);
  const me = await authenticated(device, conf.slug);
  if (!me) throw new HttpError(403, { error: 'profile_required' });
  const profileId = await targetProfileId(me, conf.slug, r);

  // op_type create: the same reporter's second report of the same target is a 409 and changes
  // nothing, so the route is idempotent.
  const reportId = `${r.kind}:${r.id}:${me.profile_id}`;
  await people('PUT', `${idx(REPORTS_INDEX)}/_create/${encodeURIComponent(reportId)}?refresh=wait_for`, {
    event_id: conf.slug,
    target_kind: r.kind,
    target_id: r.id,
    target_profile_id: profileId,
    reporter_id: me.profile_id,
    reason: r.reason,
    created_at: new Date().toISOString(),
  }, { okStatuses: [409] });

  const hidden = (await reporterCount(conf.slug, r.kind, r.id)) >= HIDE_AT;
  if (hidden) await hide(conf.slug, r.kind, r.id, profileId);
  sendJson(res, 200, { ok: true, hidden });
}

// ---------------------------------------------------------------------------------------------

const ROUTES = {
  '/api/people/report': { POST: report },
};

// Handles the report route. Resolves to true when the request was handled.
export async function handleReportApi(req, res, url) {
  const route = ROUTES[url.pathname];
  if (!route) return false;
  await dispatch(route, req, res, url);
  return true;
}
