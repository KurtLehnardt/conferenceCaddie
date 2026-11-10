// Operator CLI for reports: what is hidden, what was reported, and undoing or confirming a hide.
//
// Usage: node scripts/moderation.mjs --event <slug> <one action>
//   --hidden                lists hidden profiles, spots and meets with report counts and reasons
//   --since <iso>           lists the reports made since that instant
//   --unhide <kind>:<id>    clears the hidden flag of one target and removes its reports, so it
//                           needs two fresh reports to be hidden again
//   --delete <kind>:<id>    removes the target: a profile document, a meet document, or the spot
//                           line of a profile. Never a person's device data, which only the device
//                           holds; the person can create a profile again.
//   --purge                 deletes the conference's reports once the conference has ended
//   <kind> is profile, spot or meet; <id> is the person's ref (16 hex characters) for a profile or
//   a spot and the meet id for a meet, as --hidden and --since print them.
//
// Env: ES_URL; ELASTISEARCH_API_KEY (the admin key). --unhide and --purge require it: they delete
//      reports with _delete_by_query?refresh=true, which the people key cannot refresh, and
//      --purge also reads the conference. --hidden, --since and --delete also run with
//      ES_PEOPLE_API_KEY alone; ES_PEOPLE_INDEX (default caddie-people),
//      ES_PEOPLE_MEETS_INDEX (default caddie-people-meets), ES_PEOPLE_REPORTS_INDEX (default
//      caddie-people-reports), ES_CONFERENCES_INDEX (default caddie-conferences).
//
// Output names people by display name and ref only. profile_id, reporter ids and secrets are never
// printed; the key is never printed. Hides and unhides are Bulk partial updates of the flag
// fields, so nothing is re-embedded.

const ES_URL = (process.env.ES_URL || 'https://fc875c88f9f44f159f1a359ee724d82b.us-west1.gcp.cloud.es.io:443').replace(/\/$/, '');
const API_KEY = process.env.ELASTISEARCH_API_KEY || process.env.ES_PEOPLE_API_KEY;
const PEOPLE_INDEX = process.env.ES_PEOPLE_INDEX || 'caddie-people';
const MEETS_INDEX = process.env.ES_PEOPLE_MEETS_INDEX || 'caddie-people-meets';
const REPORTS_INDEX = process.env.ES_PEOPLE_REPORTS_INDEX || 'caddie-people-reports';
const CONFERENCES_INDEX = process.env.ES_CONFERENCES_INDEX || 'caddie-conferences';
const PAGE = 1000;
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,119}$/;
const REF_RE = /^[0-9a-f]{16}$/;
const MEET_ID_RE = /^[A-Za-z0-9_-]{22}$/;
const KINDS = ['profile', 'spot', 'meet'];

if (!API_KEY) {
  console.error('Set ELASTISEARCH_API_KEY or ES_PEOPLE_API_KEY.');
  process.exit(1);
}

const usage = (message) => {
  if (message) console.error(message);
  console.error('Usage: node scripts/moderation.mjs --event <slug> (--hidden | --since <iso> | --unhide <kind>:<id> | --delete <kind>:<id> | --purge)');
  process.exit(2);
};

const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(name);
  if (i === -1) return undefined;
  const v = args[i + 1];
  args.splice(i, 2);
  return v ?? '';
};
const flag = (name) => {
  const i = args.indexOf(name);
  if (i === -1) return false;
  args.splice(i, 1);
  return true;
};

const slug = opt('--event');
if (!slug || !SLUG_RE.test(slug)) usage('--event <slug> is required.');
const actions = [];
if (flag('--hidden')) actions.push(['hidden']);
const since = opt('--since');
if (since !== undefined) actions.push(['since', since]);
const unhide = opt('--unhide');
if (unhide !== undefined) actions.push(['unhide', unhide]);
const del = opt('--delete');
if (del !== undefined) actions.push(['delete', del]);
if (flag('--purge')) actions.push(['purge']);
if (args.length) usage(`Unknown argument: ${args[0]}`);
if (actions.length !== 1) usage('Give exactly one action.');
const [action, arg] = actions[0];
// API_KEY is the admin key whenever it is set; --unhide and --purge refuse to run without it.
if ((action === 'unhide' || action === 'purge') && !process.env.ELASTISEARCH_API_KEY) {
  console.error(`--${action} needs ELASTISEARCH_API_KEY (the admin key); ES_PEOPLE_API_KEY cannot refresh the reports index.`);
  process.exit(1);
}

// --unhide and --delete name a target as kind:id.
function parseTarget(value) {
  const colon = String(value).indexOf(':');
  const kind = colon === -1 ? '' : value.slice(0, colon);
  const id = colon === -1 ? '' : value.slice(colon + 1);
  if (!KINDS.includes(kind)) usage('The target must be profile:<ref>, spot:<ref> or meet:<meet id>.');
  if (kind === 'meet' ? !MEET_ID_RE.test(id) : !REF_RE.test(id)) usage(kind === 'meet' ? 'A meet id has 22 characters.' : 'A ref has 16 hex characters.');
  return { kind, id };
}

async function es(method, path, body, { ndjson = false, okStatuses = [] } = {}) {
  let res;
  try {
    res = await fetch(ES_URL + path, {
      method,
      headers: { Authorization: `ApiKey ${API_KEY}`, 'Content-Type': ndjson ? 'application/x-ndjson' : 'application/json' },
      body: body === undefined ? undefined : ndjson ? body : JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });
  } catch (err) {
    console.error(`Could not reach Elasticsearch: ${err?.cause?.code ?? err?.name ?? 'error'}`);
    process.exit(1);
  }
  const json = await res.json().catch(() => ({}));
  if (!res.ok && !okStatuses.includes(res.status)) {
    console.error(`${method} ${path.split('?')[0]} failed with status ${res.status}: ${json.error?.type ?? ''}`);
    process.exit(1);
  }
  return { status: res.status, json };
}

const idx = (name) => `/${encodeURIComponent(name)}`;
const eventFilter = { term: { event_id: slug } };
const quote = (s) => JSON.stringify(String(s ?? ''));

// ---------------------------------------------------------------------------------------------
// Lookups.

// People documents of this conference by ref: Map ref -> { _id, display_name, ... }.
async function peopleByRefs(refs) {
  const wanted = [...new Set(refs)].filter(Boolean);
  if (!wanted.length) return new Map();
  const { json } = await es('POST', `${idx(PEOPLE_INDEX)}/_search`, {
    size: wanted.length,
    _source: ['ref', 'display_name', 'hidden', 'spot_hidden', 'presence_spot'],
    query: { bool: { filter: [eventFilter, { terms: { ref: wanted } }] } },
  });
  const map = new Map();
  for (const h of json.hits?.hits ?? []) if (h._source?.ref) map.set(h._source.ref, { _id: h._id, ...h._source });
  return map;
}

// Display names of the people a meet is between, by profile id, without printing the ids.
async function namesById(profileIds) {
  const ids = [...new Set(profileIds)].filter(Boolean);
  if (!ids.length) return new Map();
  const { json } = await es('POST', `${idx(PEOPLE_INDEX)}/_mget`, {
    ids: ids.map((id) => `${slug}:${id}`),
    _source: ['profile_id', 'display_name', 'ref'],
  });
  const map = new Map();
  for (const d of json.docs ?? []) if (d.found && d._source?.profile_id) map.set(d._source.profile_id, d._source);
  return map;
}

// Report counts per target: Map "kind:id" -> { reporters, reasons: { reason: n } }. One report
// document is one reporter, so the document count is the distinct reporter count.
async function reportSummary() {
  const { json } = await es('POST', `${idx(REPORTS_INDEX)}/_search?ignore_unavailable=true`, {
    size: 0,
    query: eventFilter,
    aggs: {
      targets: {
        multi_terms: { terms: [{ field: 'target_kind' }, { field: 'target_id' }], size: PAGE },
        aggs: { reasons: { terms: { field: 'reason', size: 10 } } },
      },
    },
  });
  const map = new Map();
  for (const b of json.aggregations?.targets?.buckets ?? []) {
    const [kind, id] = b.key;
    map.set(`${kind}:${id}`, { reporters: b.doc_count, reasons: Object.fromEntries((b.reasons?.buckets ?? []).map((r) => [r.key, r.doc_count])) });
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

// ---------------------------------------------------------------------------------------------
// Actions.

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
  let n = 0;
  for (const h of peopleHits.json.hits?.hits ?? []) {
    const s = h._source ?? {};
    if (s.hidden === true) {
      n += 1;
      const sm = summary.get(`profile:${s.ref}`);
      console.log(`profile  ${personText(s, s.ref)}  ${countText(sm)}${sm ? `: ${reasonsText(sm)}` : ''}`);
    }
    if (s.spot_hidden === true) {
      n += 1;
      const sm = summary.get(`spot:${s.ref}`);
      console.log(`spot     ${personText(s, s.ref)}  ${countText(sm)}${sm ? `: ${reasonsText(sm)}` : ''}`);
    }
  }
  for (const h of meetHits.json.hits?.hits ?? []) {
    const s = h._source ?? {};
    n += 1;
    const sm = summary.get(`meet:${s.meet_id}`);
    console.log(`meet     ${await meetText(s)}  ${countText(sm)}${sm ? `: ${reasonsText(sm)}` : ''}`);
  }
  console.log(n ? `${n} hidden target${n === 1 ? '' : 's'} at ${slug}.` : `Nothing is hidden at ${slug}.`);
}

async function listSince(iso) {
  const sinceMs = Date.parse(iso);
  if (!Number.isFinite(sinceMs)) usage('--since needs an ISO 8601 instant, for example 2026-11-10T08:00:00Z.');
  const { json } = await es('POST', `${idx(REPORTS_INDEX)}/_search?ignore_unavailable=true`, {
    size: PAGE,
    _source: ['target_kind', 'target_id', 'reason', 'created_at'],
    sort: [{ created_at: 'asc' }],
    query: { bool: { filter: [eventFilter, { range: { created_at: { gte: new Date(sinceMs).toISOString() } } }] } },
  });
  const rows = (json.hits?.hits ?? []).map((h) => h._source ?? {});
  const people = await peopleByRefs(rows.filter((r) => r.target_kind !== 'meet').map((r) => r.target_id));
  const meetIds = [...new Set(rows.filter((r) => r.target_kind === 'meet').map((r) => r.target_id))];
  const meets = new Map();
  if (meetIds.length) {
    const found = await es('POST', `${idx(MEETS_INDEX)}/_mget`, { ids: meetIds }, { okStatuses: [404] });
    for (const d of found.json.docs ?? []) if (d.found) meets.set(d._id, d._source ?? {});
  }
  for (const r of rows) {
    const target = r.target_kind === 'meet'
      ? (meets.has(r.target_id) ? await meetText(meets.get(r.target_id)) : `meet ${r.target_id} (deleted)`)
      : personText(people.get(r.target_id), r.target_id);
    console.log(`${r.created_at}  ${String(r.target_kind).padEnd(7)}  ${String(r.reason).padEnd(10)}  ${target}`);
  }
  console.log(`${rows.length} report${rows.length === 1 ? '' : 's'} since ${new Date(sinceMs).toISOString()} at ${slug}${rows.length === PAGE ? ' (more exist; narrow --since)' : ''}.`);
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

// The people document a profile or spot target names, or exit 1.
async function requirePerson(ref) {
  const p = (await peopleByRefs([ref])).get(ref);
  if (!p) {
    console.error(`No profile with ref ${ref} at ${slug}.`);
    process.exit(1);
  }
  return p;
}

async function requireMeet(id) {
  const { status, json } = await es('GET', `${idx(MEETS_INDEX)}/_doc/${encodeURIComponent(id)}`, undefined, { okStatuses: [404] });
  if (status === 404 || !json.found || json._source?.event_id !== slug) {
    console.error(`No meet ${id} at ${slug}.`);
    process.exit(1);
  }
  return json._source;
}

async function unhideTarget({ kind, id }) {
  if (kind === 'meet') {
    const s = await requireMeet(id);
    await es('POST', `${idx(MEETS_INDEX)}/_update/${encodeURIComponent(id)}?refresh=wait_for`, { doc: { hidden: false, hidden_owner_id: null } });
    console.log(`Unhid ${await meetText(s)}.`);
  } else {
    const p = await requirePerson(id);
    const status = await updatePerson(p._id, kind === 'profile' ? { hidden: false } : { spot_hidden: false });
    if (status < 200 || status > 299) {
      console.error(`Updating the profile failed with status ${status}.`);
      process.exit(1);
    }
    console.log(`Unhid ${kind} of ${personText(p, id)}.${kind === 'spot' ? ' The spot line stays cleared until they set it again.' : ''}`);
  }
  const removed = await deleteReports(kind, id);
  console.log(`Removed ${removed} report${removed === 1 ? '' : 's'}; it is hidden again after two new ones.`);
}

async function deleteTarget({ kind, id }) {
  if (kind === 'meet') {
    const s = await requireMeet(id);
    await es('DELETE', `${idx(MEETS_INDEX)}/_doc/${encodeURIComponent(id)}?refresh=wait_for`);
    console.log(`Deleted ${await meetText(s)}.`);
    return;
  }
  const p = await requirePerson(id);
  if (kind === 'spot') {
    const status = await updatePerson(p._id, { presence_spot: null, spot_hidden: true });
    if (status < 200 || status > 299) {
      console.error(`Updating the profile failed with status ${status}.`);
      process.exit(1);
    }
    console.log(`Cleared the spot line of ${personText(p, id)}; it stays hidden.`);
    return;
  }
  await es('DELETE', `${idx(PEOPLE_INDEX)}/_doc/${encodeURIComponent(p._id)}?refresh=wait_for`);
  console.log(`Deleted the profile ${personText(p, id)}. Their device keeps its own data and can create a profile again; the reports stay until --purge.`);
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

async function purge() {
  const { status, json } = await es('GET', `${idx(CONFERENCES_INDEX)}/_doc/${encodeURIComponent(slug)}?_source_includes=end_date,time_zone`, undefined, { okStatuses: [404] });
  if (status === 404 || !json.found || !json._source?.end_date) {
    console.error(`No conference ${slug} with an end date. --purge needs the admin key to read it.`);
    process.exit(1);
  }
  const endMs = conferenceEndMs(json._source.end_date, json._source.time_zone);
  const end = new Date(endMs).toISOString();
  if (Date.now() <= endMs) {
    console.log(`${slug} ends at ${end}; nothing is purged before that.`);
    return;
  }
  const res = await es('POST', `${idx(REPORTS_INDEX)}/_delete_by_query?refresh=true&conflicts=proceed&ignore_unavailable=true`, {
    query: { bool: { filter: [eventFilter, { range: { created_at: { lt: end } } }] } },
  });
  console.log(`Deleted ${res.json.deleted ?? 0} reports of ${slug} made before ${end}.`);
}

if (action === 'hidden') await listHidden();
else if (action === 'since') await listSince(arg);
else if (action === 'unhide') await unhideTarget(parseTarget(arg));
else if (action === 'delete') await deleteTarget(parseTarget(arg));
else await purge();
