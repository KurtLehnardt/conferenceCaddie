// The moderation actions of scripts/moderation.mjs against Elasticsearch, as functions over an
// injected transport, so the caddie-admin CLI (scripts/admin/backends/es.mjs) and the old script
// (now a thin shell) run the same code. Nothing here prints, reads the environment or exits: every
// function returns what it found, and a missing target throws NotFoundError (exit 4 in the CLI).
//
// createModeration({ es, slug, indices, now }) where
//   es(method, path, body, { ndjson, okStatuses })  answers { status, json } and throws on any
//                                                   other status (the caller's transport)
//   slug                                            the conference
//   indices                                         { people, meets, reports, conferences }
//   now()                                           the current time (Date.now by default)
//
// Output names people by display name and ref only. profile_id, reporter ids and secrets are never
// returned in a row; the hide and unhide writes are Bulk partial updates of the flag fields, so
// nothing is re-embedded.

import { NotFoundError, UsageError } from '../errors.mjs';

export const PAGE = 1000;
const KINDS = ['profile', 'spot', 'meet'];
const idx = (name) => `/${encodeURIComponent(name)}`;
const quote = (s) => JSON.stringify(String(s ?? ''));

export function createModeration({ es, slug, indices, now = () => Date.now() }) {
  const PEOPLE_INDEX = indices.people;
  const MEETS_INDEX = indices.meets;
  const REPORTS_INDEX = indices.reports;
  const CONFERENCES_INDEX = indices.conferences;
  const eventFilter = { term: { event_id: slug } };

  // -------------------------------------------------------------------------------------------
  // Lookups.

  // People documents of this conference by ref: Map ref -> { _id, display_name, ... }. profile_id
  // is read for the hide write (an operator report names the target's profile id) and never
  // leaves this module in a row.
  async function peopleByRefs(refs) {
    const wanted = [...new Set(refs)].filter(Boolean);
    if (!wanted.length) return new Map();
    const { json } = await es('POST', `${idx(PEOPLE_INDEX)}/_search`, {
      size: wanted.length,
      _source: ['ref', 'display_name', 'hidden', 'spot_hidden', 'presence_spot', 'profile_id'],
      query: { bool: { filter: [eventFilter, { terms: { ref: wanted } }] } },
    });
    const map = new Map();
    for (const h of json.hits?.hits ?? []) if (h._source?.ref) map.set(h._source.ref, { _id: h._id, ...h._source });
    return map;
  }

  // Display names of the people a meet is between, by profile id, without returning the ids.
  async function namesById(profileIds) {
    const ids = [...new Set(profileIds)].filter(Boolean);
    if (!ids.length) return new Map();
    // _source per document, the one form the Multi get API takes for a field list.
    const { json } = await es('POST', `${idx(PEOPLE_INDEX)}/_mget`, {
      docs: ids.map((id) => ({ _id: `${slug}:${id}`, _source: ['profile_id', 'display_name', 'ref'] })),
    });
    const map = new Map();
    for (const d of json.docs ?? []) if (d.found && d._source?.profile_id) map.set(d._source.profile_id, d._source);
    return map;
  }

  // Report counts per target: Map "kind:id" -> { reporters, reasons: { reason: n } }, from one
  // search of the event's reports aggregated here. One report document is one reporter, so the
  // document count is the distinct reporter count. Reporter ids are not read.
  async function reportSummary() {
    const { json } = await es('POST', `${idx(REPORTS_INDEX)}/_search?ignore_unavailable=true`, {
      size: PAGE,
      _source: ['target_kind', 'target_id', 'reason'],
      query: eventFilter,
    });
    const map = new Map();
    for (const h of json.hits?.hits ?? []) {
      const s = h._source ?? {};
      const key = `${s.target_kind}:${s.target_id}`;
      const entry = map.get(key) ?? { reporters: 0, reasons: {} };
      entry.reporters += 1;
      entry.reasons[s.reason] = (entry.reasons[s.reason] ?? 0) + 1;
      map.set(key, entry);
    }
    return map;
  }

  const reasonsText = (summary) => (summary ? Object.entries(summary.reasons).sort((a, b) => b[1] - a[1]).map(([r, n]) => `${r} x${n}`).join(', ') : '');
  const countText = (summary) => `${summary?.reporters ?? 0} report${summary?.reporters === 1 ? '' : 's'}`;
  const personText = (p, ref) => `${quote(p?.display_name ?? '(profile deleted)')} ref ${ref}`;

  async function meetText(s) {
    const names = await namesById(s.participants ?? []);
    const who = (s.participants ?? []).map((p) => quote(names.get(p)?.display_name ?? '(profile deleted)')).join(' and ');
    return `meet ${s.meet_id} between ${who}, state ${s.state ?? '?'}`;
  }

  // -------------------------------------------------------------------------------------------
  // Actions. Each returns { rows, lines }: the rows as data for the CLI and the lines the old
  // script prints.

  async function listHidden() {
    const summary = await reportSummary();
    const peopleHits = await es('POST', `${idx(PEOPLE_INDEX)}/_search`, {
      size: PAGE,
      _source: ['ref', 'display_name', 'hidden', 'spot_hidden'],
      sort: [{ 'display_name.keyword': 'asc' }],
      query: { bool: { filter: [eventFilter], should: [{ term: { hidden: true } }, { term: { spot_hidden: true } }], minimum_should_match: 1 } },
    });
    const meetHits = await es('POST', `${idx(MEETS_INDEX)}/_search?ignore_unavailable=true`, {
      size: PAGE,
      sort: [{ created_at: 'desc' }],
      query: { bool: { filter: [eventFilter, { term: { hidden: true } }] } },
    });
    const rows = [];
    const lines = [];
    const row = (kind, id, displayName, sm) => {
      rows.push({ kind, id, display_name: displayName ?? null, reports: sm?.reporters ?? 0, reasons: sm?.reasons ?? {} });
    };
    for (const h of peopleHits.json.hits?.hits ?? []) {
      const s = h._source ?? {};
      if (s.hidden === true) {
        const sm = summary.get(`profile:${s.ref}`);
        row('profile', s.ref, s.display_name, sm);
        lines.push(`profile  ${personText(s, s.ref)}  ${countText(sm)}${sm ? `: ${reasonsText(sm)}` : ''}`);
      }
      if (s.spot_hidden === true) {
        const sm = summary.get(`spot:${s.ref}`);
        row('spot', s.ref, s.display_name, sm);
        lines.push(`spot     ${personText(s, s.ref)}  ${countText(sm)}${sm ? `: ${reasonsText(sm)}` : ''}`);
      }
    }
    for (const h of meetHits.json.hits?.hits ?? []) {
      const s = h._source ?? {};
      const sm = summary.get(`meet:${s.meet_id}`);
      const text = await meetText(s);
      row('meet', s.meet_id, text, sm);
      lines.push(`meet     ${text}  ${countText(sm)}${sm ? `: ${reasonsText(sm)}` : ''}`);
    }
    const n = rows.length;
    lines.push(n ? `${n} hidden target${n === 1 ? '' : 's'} at ${slug}.` : `Nothing is hidden at ${slug}.`);
    return { rows, lines };
  }

  async function listSince(iso) {
    const sinceMs = Date.parse(iso);
    if (!Number.isFinite(sinceMs)) throw new UsageError('--since needs an ISO 8601 instant, for example 2026-11-10T08:00:00Z.');
    const { json } = await es('POST', `${idx(REPORTS_INDEX)}/_search?ignore_unavailable=true`, {
      size: PAGE,
      _source: ['target_kind', 'target_id', 'reason', 'created_at'],
      sort: [{ created_at: 'asc' }],
      query: { bool: { filter: [eventFilter, { range: { created_at: { gte: new Date(sinceMs).toISOString() } } }] } },
    });
    const reports = (json.hits?.hits ?? []).map((h) => h._source ?? {});
    const people = await peopleByRefs(reports.filter((r) => r.target_kind !== 'meet').map((r) => r.target_id));
    const meetIds = [...new Set(reports.filter((r) => r.target_kind === 'meet').map((r) => r.target_id))];
    const meets = new Map();
    if (meetIds.length) {
      const found = await es('POST', `${idx(MEETS_INDEX)}/_mget`, { docs: meetIds.map((id) => ({ _id: id })) }, { okStatuses: [404] });
      for (const d of found.json.docs ?? []) if (d.found) meets.set(d._id, d._source ?? {});
    }
    const rows = [];
    const lines = [];
    for (const r of reports) {
      const isMeet = r.target_kind === 'meet';
      const target = isMeet
        ? (meets.has(r.target_id) ? await meetText(meets.get(r.target_id)) : `meet ${r.target_id} (deleted)`)
        : personText(people.get(r.target_id), r.target_id);
      const displayName = isMeet ? (meets.has(r.target_id) ? target : null) : (people.get(r.target_id)?.display_name ?? null);
      rows.push({ created_at: r.created_at, kind: r.target_kind, id: r.target_id, reason: r.reason, display_name: displayName });
      lines.push(`${r.created_at}  ${String(r.target_kind).padEnd(7)}  ${String(r.reason).padEnd(10)}  ${target}`);
    }
    lines.push(`${reports.length} report${reports.length === 1 ? '' : 's'} since ${new Date(sinceMs).toISOString()} at ${slug}${reports.length === PAGE ? ' (more exist; narrow --since)' : ''}.`);
    return { rows, lines, since: new Date(sinceMs).toISOString() };
  }

  // One Bulk partial update on a people document. Returns the item status.
  async function updatePerson(id, doc) {
    const body = `${JSON.stringify({ update: { _id: id } })}\n${JSON.stringify({ doc })}\n`;
    const { json } = await es('POST', `${idx(PEOPLE_INDEX)}/_bulk?refresh=wait_for`, body, { ndjson: true });
    return json.items?.[0]?.update?.status ?? 500;
  }

  async function deleteReports(kind, id) {
    const { json } = await es('POST', `${idx(REPORTS_INDEX)}/_delete_by_query?refresh=true&conflicts=proceed&ignore_unavailable=true`, {
      query: { bool: { filter: [eventFilter, { term: { target_kind: kind } }, { term: { target_id: id } }] } },
    });
    return json.deleted ?? 0;
  }

  // The number of reports of one target (one document per reporter).
  async function countReports(kind, id) {
    const { json } = await es('POST', `${idx(REPORTS_INDEX)}/_count?ignore_unavailable=true`, {
      query: { bool: { filter: [eventFilter, { term: { target_kind: kind } }, { term: { target_id: id } }] } },
    });
    return json.count ?? 0;
  }

  // The people document a profile or spot target names, or NotFoundError.
  async function requirePerson(ref) {
    const p = (await peopleByRefs([ref])).get(ref);
    if (!p) throw new NotFoundError(`No profile with ref ${ref} at ${slug}.`);
    return p;
  }

  async function requireMeet(id) {
    const { status, json } = await es('GET', `${idx(MEETS_INDEX)}/_doc/${encodeURIComponent(id)}`, undefined, { okStatuses: [404] });
    if (status === 404 || !json.found || json._source?.event_id !== slug) throw new NotFoundError(`No meet ${id} at ${slug}.`);
    return json._source;
  }

  const failedUpdate = (status) => new Error(`Updating the profile failed with status ${status}.`);

  async function unhideTarget({ kind, id }) {
    const lines = [];
    if (kind === 'meet') {
      const s = await requireMeet(id);
      await es('POST', `${idx(MEETS_INDEX)}/_update/${encodeURIComponent(id)}?refresh=wait_for`, { doc: { hidden: false, hidden_owner_id: null } });
      lines.push(`Unhid ${await meetText(s)}.`);
    } else {
      const p = await requirePerson(id);
      const status = await updatePerson(p._id, kind === 'profile' ? { hidden: false } : { spot_hidden: false });
      if (status < 200 || status > 299) throw failedUpdate(status);
      lines.push(`Unhid ${kind} of ${personText(p, id)}.${kind === 'spot' ? ' The spot line stays cleared until they set it again.' : ''}`);
    }
    const removed = await deleteReports(kind, id);
    lines.push(`Removed ${removed} report${removed === 1 ? '' : 's'}; it is hidden again after two new ones.`);
    return { removed, lines };
  }

  // Deletes a meet, or clears a spot line. A profile is not handled here: the CLI runs the full
  // profile delete (server/people-delete.mjs) for it, and the old script keeps its document-only
  // delete in its own shell.
  async function deleteTarget({ kind, id }) {
    const lines = [];
    if (kind === 'meet') {
      const s = await requireMeet(id);
      await es('DELETE', `${idx(MEETS_INDEX)}/_doc/${encodeURIComponent(id)}?refresh=wait_for`);
      lines.push(`Deleted ${await meetText(s)}.`);
      return { lines };
    }
    if (kind !== 'spot') throw new UsageError('deleteTarget takes a meet or a spot');
    const p = await requirePerson(id);
    const status = await updatePerson(p._id, { presence_spot: null, spot_hidden: true });
    if (status < 200 || status > 299) throw failedUpdate(status);
    lines.push(`Cleared the spot line of ${personText(p, id)}; it stays hidden.`);
    return { lines };
  }

  // The offset of a time zone from UTC at an instant, in milliseconds, through Intl.
  function zoneOffsetMs(utcMs, timeZone) {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).formatToParts(new Date(utcMs));
    const get = (type) => Number(parts.find((p) => p.type === type)?.value);
    return Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second')) - utcMs;
  }

  // 23:59:59 on the conference's last day in its time zone (UTC-12 when unknown), as the server
  // computes visible_until.
  function conferenceEndMs(endDate, timeZone) {
    const [y, m, d] = String(endDate).split('-').map(Number);
    const wall = Date.UTC(y, m - 1, d, 23, 59, 59);
    if (!timeZone) return wall + 12 * 3600_000;
    const t = wall - zoneOffsetMs(wall, timeZone);
    return wall - zoneOffsetMs(t, timeZone);
  }

  // The end of the conference as an ISO instant, or NotFoundError when the document is missing.
  async function conferenceEnd() {
    const { status, json } = await es('GET', `${idx(CONFERENCES_INDEX)}/_doc/${encodeURIComponent(slug)}?_source_includes=end_date,time_zone`, undefined, { okStatuses: [404] });
    if (status === 404 || !json.found || !json._source?.end_date) {
      throw new NotFoundError(`No conference ${slug} with an end date. --purge needs the admin key to read it.`);
    }
    const endMs = conferenceEndMs(json._source.end_date, json._source.time_zone);
    return { endMs, end: new Date(endMs).toISOString() };
  }

  // Deletes the conference's reports once it has ended. Returns { ended, end, deleted, lines }.
  async function purge({ dryRun = false } = {}) {
    const { endMs, end } = await conferenceEnd();
    if (now() <= endMs) return { ended: false, end, deleted: 0, lines: [`${slug} ends at ${end}; nothing is purged before that.`] };
    const query = { bool: { filter: [eventFilter, { range: { created_at: { lt: end } } }] } };
    if (dryRun) {
      const { json } = await es('POST', `${idx(REPORTS_INDEX)}/_count?ignore_unavailable=true`, { query });
      return { ended: true, end, deleted: json.count ?? 0, lines: [`Would delete ${json.count ?? 0} reports of ${slug} made before ${end}.`] };
    }
    const res = await es('POST', `${idx(REPORTS_INDEX)}/_delete_by_query?refresh=true&conflicts=proceed&ignore_unavailable=true`, { query });
    return { ended: true, end, deleted: res.json.deleted ?? 0, lines: [`Deleted ${res.json.deleted ?? 0} reports of ${slug} made before ${end}.`] };
  }

  return { peopleByRefs, reportSummary, listHidden, listSince, updatePerson, deleteReports, countReports, requirePerson, requireMeet, unhideTarget, deleteTarget, purge, conferenceEnd, meetText };
}

export const parseTargetKinds = KINDS;
