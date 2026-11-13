// Tier 3 adapter of the caddie-admin CLI: Elasticsearch behind Cloud Run, reached directly with
// the operator's admin key. The tier 3 server has no admin route and gains none; every command
// here is an Elasticsearch call, or a child process running one of the operator scripts with the
// key in its environment (never on its command line).
//
// createEsAdapter(backend, { credential, env, spawn, fetch, root }) where backend is the config
// entry ({ tier: 3, es_url, api?, project?, service? }), credential the admin key, env the process
// environment (index names, as every script reads them), spawn a spawnSync-like function and fetch
// a fetch-like function (both injectable for the tests), and root the repository root the
// conference commands write under (CADDIE_ADMIN_ROOT in the tests).
//
// Rules this module keeps:
// - The key travels only in the Authorization header of an Elasticsearch request and in the
//   environment of a child process. It is never in a URL, an argument list, a result or an error.
// - A result row never holds profile_id, secret_hash, reporter ids, push endpoints or tokens,
//   positions, cells or Bluetooth fields. profile_id is read from _source where a write needs it
//   (the delete, the operator report) and goes nowhere else.
// - The profile delete is server/people-delete.mjs with this adapter's transport, so an operator
//   delete and a person's own "Delete my profile" make the same calls (test/delete-profile.test.mjs
//   is the oracle; test/admin-es.test.mjs checks the parity).
// - mode 'dry-run' reads and counts and writes nothing.

import { spawnSync as defaultSpawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createProfileDelete } from '../../../server/people-delete.mjs';
import { HIDE_AT, OPERATOR_REPORTER, PRESENCE_OFF, operatorReportId } from '../../../server/people-shared.mjs';
import { peoplePreference, withPreference } from '../../../server/preference.mjs';
import { AdminError, NotFoundError } from '../errors.mjs';
import { createModeration } from './es-moderation.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const ES_TIMEOUT_MS = 60_000;
const SEARCH_PAGE = 1000;
const SEARCH_ROUNDS = 50;
const TEXT_MAX = 300;

// Index names, from the same variables every script reads.
export function indicesFrom(env) {
  return {
    people: env.ES_PEOPLE_INDEX || 'caddie-people',
    blocks: env.ES_PEOPLE_BLOCKS_INDEX || 'caddie-people-blocks',
    meets: env.ES_PEOPLE_MEETS_INDEX || 'caddie-people-meets',
    push: env.ES_PEOPLE_PUSH_INDEX || 'caddie-people-push',
    nudges: env.ES_PEOPLE_NUDGES_INDEX || 'caddie-people-nudges',
    reports: env.ES_PEOPLE_REPORTS_INDEX || 'caddie-people-reports',
    conferences: env.ES_CONFERENCES_INDEX || 'caddie-conferences',
    talks: env.ES_INDEX || 'caddie-talks',
    topics: env.ES_TOPICS_INDEX || 'caddie-topics',
    facets: env.ES_FACETS_INDEX || 'caddie-facets',
  };
}

// What `attendees view` reads. The default fields, the fields behind --text and --contact, and
// profile_id, which the counts need and which never leaves this module.
const VIEW_FIELDS = ['ref', 'display_name', 'hidden', 'spot_hidden', 'open_to_meet', 'sample', 'visible_until', 'updated_at', 'presence_until', 'shared_talk_ids', 'profile_id'];
const TEXT_FIELDS = ['about', 'interests', 'expertise', 'contact_note', 'presence_spot', 'pending_about', 'pending_interests', 'pending_expertise'];
const CONTACT_FIELDS = ['linkedin_url'];
const SEARCH_FIELDS = ['ref', 'display_name', 'hidden', 'spot_hidden', 'open_to_meet', 'sample', 'visible_until'];
// The indices a conference's documents live in, with the field that names the conference.
const CONFERENCE_SCOPES = [
  ['talks', 'conference'], ['topics', 'conference'], ['facets', 'conference'],
  ['people', 'event_id'], ['meets', 'event_id'], ['blocks', 'event_id'], ['push', 'event_id'], ['nudges', 'event_id'], ['reports', 'event_id'],
];

// The field that names the conference in each index, the conferences index included: what the
// cross-conference counts filter on to leave the demo conference out.
const CONFERENCE_FIELD = { ...Object.fromEntries(CONFERENCE_SCOPES), conferences: 'slug' };
// Presence, meet and nudge rows are cleared in pages of this many profiles when a demo conference
// is hidden.
const PRESENCE_PAGE = 500;

const idx = (name) => `/${encodeURIComponent(name)}`;
// One search result row, every listed field present.
const searchRow = (s) => ({ ref: s.ref, display_name: s.display_name ?? null, hidden: s.hidden === true, spot_hidden: s.spot_hidden === true, open_to_meet: s.open_to_meet === true, sample: s.sample === true, visible_until: s.visible_until ?? null });
const cut = (value) => (typeof value === 'string' ? value.slice(0, TEXT_MAX) : value ?? null);
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

export function createEsAdapter(backend, { credential, env = {}, spawn = defaultSpawnSync, fetch = (...args) => globalThis.fetch(...args), root = REPO_ROOT, now = () => new Date(), sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {}) {
  if (typeof credential !== 'string' || !credential) throw new AdminError('no credential for the Elasticsearch backend');
  const esUrl = String(backend.es_url ?? '').replace(/\/+$/, '');
  if (!esUrl) throw new AdminError(`backend "${backend.name}" has no es_url`);
  const INDEX = indicesFrom(env);
  // The conference field of a concrete index (caddie-talks-v3 behind the alias caddie-talks): the
  // index name or alias it equals, or the longest one it extends with "-", or null.
  const fieldOfIndex = (name) => {
    let best = null;
    for (const [key, alias] of Object.entries(INDEX)) {
      if ((name === alias || name.startsWith(`${alias}-`)) && (!best || alias.length > best.alias.length)) best = { alias, field: CONFERENCE_FIELD[key] };
    }
    return best?.field ?? null;
  };

  // ---- transport ----

  async function es(method, path, body, { ndjson = false, okStatuses = [] } = {}) {
    let res;
    try {
      res = await fetch(esUrl + path, {
        method,
        headers: { Authorization: `ApiKey ${credential}`, 'Content-Type': ndjson ? 'application/x-ndjson' : 'application/json' },
        body: body === undefined ? undefined : ndjson ? body : JSON.stringify(body),
        // A redirect would carry the key to another host (SEC-13).
        redirect: 'error',
        signal: AbortSignal.timeout(ES_TIMEOUT_MS),
      });
    } catch (err) {
      throw new AdminError(`Could not reach Elasticsearch: ${err?.cause?.code ?? err?.name ?? 'error'}`);
    }
    const json = await res.json().catch(() => ({}));
    if (!res.ok && !okStatuses.includes(res.status)) {
      const type = json?.error?.type;
      throw new AdminError(`${method} ${path.split('?')[0]} failed with status ${res.status}${type ? `: ${type}` : ''}`);
    }
    return { status: res.status, json };
  }

  const count = async (index, query) => (await es('POST', `${idx(index)}/_count?ignore_unavailable=true`, query ? { query } : undefined)).json.count ?? 0;

  // The slugs of the demo conferences (demo: true in the stored document; the field is not
  // indexed, so it is read from _source). Every count that spans conferences leaves them out.
  async function demoSlugs() {
    const { json } = await es('POST', `${idx(INDEX.conferences)}/_search?ignore_unavailable=true`, { size: 500, _source: ['slug', 'demo'], query: { match_all: {} } });
    return (json.hits?.hits ?? []).map((h) => h._source ?? {}).filter((d) => d.demo === true && typeof d.slug === 'string').map((d) => d.slug);
  }
  const withoutDemo = (field, demos) => (demos.length ? { bool: { must_not: [{ terms: { [field]: demos } }] } } : undefined);

  // A demo conference that is hidden keeps nothing live: its presence is cleared on every profile
  // (the purge's own PRESENCE_OFF write), and its meet requests (the inbox) and nudge records are
  // deleted. One sweep; it throws when anything is left or failed, so the operator runs the hide
  // again. Returns the counts.
  const RERUN = 'run the same conferences hide again';
  async function sweepDemoActivity(slug, counts) {
    const presenceQuery = { bool: { filter: [{ term: { event_id: slug } }, { exists: { field: 'presence_until' } }] } };
    for (let round = 0; ; round++) {
      const { json } = await es('POST', `${idx(INDEX.people)}/_search?ignore_unavailable=true`, { size: PRESENCE_PAGE, _source: false, query: presenceQuery });
      const ids = (json.hits?.hits ?? []).map((h) => h._id);
      if (!ids.length) break;
      if (round >= SEARCH_ROUNDS) throw new AdminError(`clearing the presence of ${slug} did not finish after ${SEARCH_ROUNDS} pages; ${RERUN}`);
      const body = ids.map((id) => `${JSON.stringify({ update: { _id: id } })}\n${JSON.stringify({ doc: PRESENCE_OFF })}\n`).join('');
      const res = await es('POST', `${idx(INDEX.people)}/_bulk?refresh=wait_for`, body, { ndjson: true });
      const ok = (res.json.items ?? []).filter((i) => i.update?.status >= 200 && i.update?.status < 300).length;
      counts.presence += ok;
      if (ok < ids.length) throw new AdminError(`clearing the presence of ${slug} failed for ${ids.length - ok} profiles; ${RERUN}`);
    }
    for (const name of ['meets', 'nudges']) {
      const { json } = await es('POST', `${idx(INDEX[name])}/_delete_by_query?refresh=true&conflicts=proceed&ignore_unavailable=true`, { query: { term: { event_id: slug } } });
      counts[name] += json.deleted ?? 0;
      const conflicts = json.version_conflicts ?? 0;
      const failures = Array.isArray(json.failures) ? json.failures.length : 0;
      if (conflicts || failures) throw new AdminError(`deleting the ${name} of ${slug} left ${conflicts} conflicting and ${failures} failed documents; ${RERUN}`);
    }
  }

  // The tier 3 server reads the conference list through a 60-second cache, so for up to a minute
  // after the hide it may still accept presence, meets and nudges for the demo. The second sweep
  // runs after that minute and catches them.
  const SERVER_CACHE_MS = 61_000;
  async function clearDemoActivity(slug) {
    const counts = { presence: 0, meets: 0, nudges: 0 };
    await sweepDemoActivity(slug, counts);
    await sleep(SERVER_CACHE_MS);
    await sweepDemoActivity(slug, counts);
    return counts;
  }

  const profileDelete = createProfileDelete({
    people: es,
    withPreference,
    peoplePreference,
    indices: { people: INDEX.people, meets: INDEX.meets, push: INDEX.push, nudges: INDEX.nudges, blocks: INDEX.blocks },
    UpstreamError: AdminError,
    // The best-effort second pass logs its failure; deletePerson collects it as a warning.
    log: (message) => deleteWarnings.push(message),
  });
  const deleteWarnings = [];

  const moderationFor = (slug) => createModeration({ es, slug, indices: INDEX, now: () => now().getTime() });

  // ---- people lookups ----

  // One person by ref, with exactly these source fields, or NotFoundError.
  async function personByRef(event, ref, fields) {
    const { json } = await es('POST', withPreference(`${idx(INDEX.people)}/_search`, peoplePreference(event)), {
      size: 1,
      _source: fields,
      query: { bool: { filter: [{ term: { event_id: event } }, { term: { ref } }] } },
    });
    const hit = json.hits?.hits?.[0];
    if (!hit?._source?.ref) throw new NotFoundError(`no profile with ref ${ref} at ${event}`);
    return { id: hit._id, source: hit._source };
  }

  // The queries of everything that goes with a profile, by index, as the delete runs them.
  const connectionQueries = (event, profileId) => ({
    meets: { bool: { filter: [{ term: { event_id: event } }, { term: { participants: profileId } }] } },
    push: { bool: { filter: [{ term: { event_id: event } }, { term: { profile_id: profileId } }] } },
    nudges: { bool: { filter: [{ term: { event_id: event } }, { term: { profile_ids: profileId } }] } },
    blocks: { bool: { filter: [{ term: { event_id: event } }, { term: { blocker_id: profileId } }] } },
  });

  async function connectionCounts(event, profileId) {
    const counts = { profile: 1 };
    for (const [name, query] of Object.entries(connectionQueries(event, profileId))) counts[name] = await count(INDEX[name], query);
    return counts;
  }

  // One Bulk partial update of a people document with refresh=wait_for; the item status.
  async function patchPerson(id, doc) {
    const body = `${JSON.stringify({ update: { _id: id } })}\n${JSON.stringify({ doc })}\n`;
    const { json } = await es('POST', `${idx(INDEX.people)}/_bulk?refresh=wait_for`, body, { ndjson: true });
    const status = json.items?.[0]?.update?.status ?? 500;
    if (status < 200 || status > 299) throw new AdminError(`updating the profile failed with status ${status}`);
  }

  const reportsQuery = (event, kind, id) => ({ bool: { filter: [{ term: { event_id: event } }, { term: { target_kind: kind } }, { term: { target_id: id } }] } });

  // Writes the operator's report of a target (one per target, op_type create) and sets the flag.
  // target_profile_id comes from _source and goes into the report document only.
  async function operatorHide(event, kind, ref, mode) {
    const person = await personByRef(event, ref, ['ref', 'hidden', 'spot_hidden', 'profile_id']);
    const before = await count(INDEX.reports, reportsQuery(event, kind, ref));
    const flag = kind === 'profile' ? { hidden: true } : { presence_spot: null, spot_hidden: true };
    const already = kind === 'profile' ? person.source.hidden === true : person.source.spot_hidden === true;
    if (mode === 'dry-run') {
      return { counts: { reports: before }, summary: `would ${already ? 'keep' : 'set'} ${kind} ${ref} hidden with an operator report (${plural(before, 'report')} on file)` };
    }
    const { status: created } = await es('PUT', `${idx(INDEX.reports)}/_create/${encodeURIComponent(operatorReportId(kind, ref))}?refresh=wait_for`, {
      event_id: event,
      target_kind: kind,
      target_id: ref,
      target_profile_id: person.source.profile_id,
      reporter_id: OPERATOR_REPORTER,
      reason: OPERATOR_REPORTER,
      created_at: now().toISOString(),
    }, { okStatuses: [409] });
    await patchPerson(person.id, flag);
    // A 409 means the operator's report was on file already, so nothing was added.
    return { counts: { reports: created === 409 ? before : before + 1 }, summary: `${kind} ${ref} is hidden by an operator report${already ? ' (it was hidden already)' : ''}` };
  }

  // ---- child processes ----

  // The environment of a child process is built from scratch: the key the CLI checked travels as
  // ELASTISEARCH_API_KEY and no other *API_KEY variable reaches the child, because the scripts
  // prefer ES_API_KEY (scripts/lib/es.mjs) or ES_PEOPLE_API_KEY (purge-expired-people.mjs,
  // moderation-rules.mjs) when they are set and would otherwise use a different key than the one
  // the operator chose. Index names, the listed NODE_* settings, the proxy and certificate
  // settings and the basics (Windows ones included) pass through; nothing whose name looks like a
  // token, secret, password or key does; CADDIE_DATA_DIR points ingest.mjs at this root's data
  // directory.
  const CHILD_ENV_RE = /^(PATH|HOME|TMPDIR|TMP|TEMP|LANG|LC_[A-Z_]+|TZ|SHELL|USER|SYSTEMROOT|PATHEXT|APPDATA|USERPROFILE|COMSPEC|NODE_OPTIONS|NODE_EXTRA_CA_CERTS|NODE_ENV|NODE_USE_ENV_PROXY|NODE_TLS_REJECT_UNAUTHORIZED|NODE_DEBUG|NODE_PATH|HTTP_PROXY|HTTPS_PROXY|NO_PROXY|http_proxy|https_proxy|no_proxy|SSL_CERT_FILE|SSL_CERT_DIR|ES_INDEX|ES_[A-Z_]+_INDEX|MODERATION_WORDS_FILE|CADDIE_DATA_DIR)$/;
  const CHILD_ENV_DENY_RE = /(TOKEN|SECRET|PASSWORD|API_KEY)/i;
  function childEnv() {
    const out = {};
    for (const [key, value] of Object.entries(env)) {
      if (CHILD_ENV_RE.test(key) && !CHILD_ENV_DENY_RE.test(key) && typeof value === 'string') out[key] = value;
    }
    if (!out.CADDIE_DATA_DIR && root !== REPO_ROOT) out.CADDIE_DATA_DIR = join(root, 'data');
    return { ...out, ES_URL: esUrl, ELASTISEARCH_API_KEY: credential };
  }

  function runScript(script, args, { okStatuses = [0] } = {}) {
    const result = spawn(process.execPath, [join(root, 'scripts', script), ...args], {
      cwd: root,
      encoding: 'utf8',
      env: childEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 16 * 1024 * 1024,
    });
    const lines = (text) => String(text ?? '').split('\n').filter(Boolean);
    if (result.error) throw new AdminError(`scripts/${script} could not start: ${result.error.code ?? result.error.message}`);
    if (!okStatuses.includes(result.status)) {
      throw new AdminError(`scripts/${script} exited with ${result.status}${lines(result.stderr).length ? `: ${lines(result.stderr)[0]}` : ''}`);
    }
    return { status: result.status, stdout: lines(result.stdout), stderr: lines(result.stderr) };
  }

  // Writes the status fields of the rewritten local conference document over the backend's (a
  // partial update of status, status_reason and raw_fetched_at only, so a stale local copy never
  // overwrites the rest), or NotFoundError when the backend does not hold the conference. Shared
  // by hide and unhide.
  async function writeConferenceDoc(slug, doc, mode) {
    const { status, json } = await es('GET', `${idx(INDEX.conferences)}/_doc/${encodeURIComponent(slug)}?_source_includes=status,status_reason`, undefined, { okStatuses: [404] });
    if (status === 404 || !json.found) throw new NotFoundError(`no conference ${slug} on this backend`);
    const current = `${json._source?.status ?? '?'}${json._source?.status_reason ? ` (${json._source.status_reason})` : ''}`;
    const wanted = `${doc.status}${doc.status_reason ? ` (${doc.status_reason})` : ''}`;
    if (mode === 'dry-run') return { summary: `would set ${slug} to ${wanted} on the backend (now ${current})` };
    await es('POST', `${idx(INDEX.conferences)}/_update/${encodeURIComponent(slug)}?refresh=wait_for`, {
      doc: { status: doc.status, status_reason: doc.status_reason ?? null, raw_fetched_at: doc.raw_fetched_at },
    });
    return { summary: `set ${slug} to ${wanted} on the backend (was ${current})` };
  }

  // ---- the adapter ----

  return {
    async searchPeople({ event, ref, name, options }) {
      if (ref !== undefined) {
        const person = await personByRef(event, ref, SEARCH_FIELDS);
        return { items: [searchRow(person.source)], counts: { matched: 1 }, summary: `1 attendee at ${event}` };
      }
      const needle = String(name).toLowerCase();
      const filter = [{ term: { event_id: event } }];
      if (!options.includeHidden) filter.push({ bool: { must_not: [{ term: { hidden: true } }] } });
      const items = [];
      let after;
      let scanned = 0;
      for (let round = 0; round < SEARCH_ROUNDS; round++) {
        const body = { size: SEARCH_PAGE, _source: SEARCH_FIELDS, sort: [{ 'display_name.keyword': 'asc' }, { ref: 'asc' }], query: { bool: { filter } } };
        if (after) body.search_after = after;
        const { json } = await es('POST', withPreference(`${idx(INDEX.people)}/_search`, peoplePreference(event)), body);
        const hits = json.hits?.hits ?? [];
        scanned += hits.length;
        for (const h of hits) {
          const s = h._source ?? {};
          if (String(s.display_name ?? '').toLowerCase().includes(needle)) items.push(searchRow(s));
        }
        if (hits.length < SEARCH_PAGE || !Array.isArray(hits[hits.length - 1].sort)) break;
        after = hits[hits.length - 1].sort;
      }
      const limited = items.slice(0, options.limit);
      return {
        items: limited,
        counts: { matched: items.length, shown: limited.length, scanned },
        summary: `${plural(items.length, 'attendee')} matched at ${event}${items.length > limited.length ? `, ${limited.length} shown (--limit)` : ''}${options.includeHidden ? '' : ' (hidden excluded)'}`,
      };
    },

    async viewPerson({ event, ref, options }) {
      const fields = [...VIEW_FIELDS, ...(options.text ? TEXT_FIELDS : []), ...(options.contact ? CONTACT_FIELDS : [])];
      const { source } = await personByRef(event, ref, fields);
      const profileId = source.profile_id;
      const profile = {
        ref: source.ref,
        display_name: source.display_name ?? null,
        hidden: source.hidden === true,
        spot_hidden: source.spot_hidden === true,
        open_to_meet: source.open_to_meet === true,
        sample: source.sample === true,
        visible_until: source.visible_until ?? null,
        updated_at: source.updated_at ?? null,
        presence: typeof source.presence_until === 'string' && Date.parse(source.presence_until) > Date.now() ? 'on' : 'off',
        shared_talks: Array.isArray(source.shared_talk_ids) ? source.shared_talk_ids.length : 0,
      };
      const meetsByState = await es('POST', `${idx(INDEX.meets)}/_search?ignore_unavailable=true`, {
        size: 0,
        query: { bool: { filter: [{ term: { event_id: event } }, { term: { participants: profileId } }] } },
        aggs: { states: { terms: { field: 'state', size: 10 } } },
      });
      const meets = {};
      for (const b of meetsByState.json.aggregations?.states?.buckets ?? []) meets[b.key] = b.doc_count;
      const blocksMade = await count(INDEX.blocks, { bool: { filter: [{ term: { event_id: event } }, { term: { blocker_id: profileId } }] } });
      const blocksReceived = await count(INDEX.blocks, { bool: { filter: [{ term: { event_id: event } }, { term: { blocked_id: profileId } }] } });
      const pushRows = await es('POST', `${idx(INDEX.push)}/_search?ignore_unavailable=true`, {
        size: 100,
        _source: ['platform'],
        query: { bool: { filter: [{ term: { event_id: event } }, { term: { profile_id: profileId } }] } },
      });
      const push = {};
      for (const h of pushRows.json.hits?.hits ?? []) {
        const channel = h._source?.platform ?? 'web';
        push[channel] = (push[channel] ?? 0) + 1;
      }
      const reportRows = await es('POST', `${idx(INDEX.reports)}/_search?ignore_unavailable=true`, {
        size: 100,
        _source: ['target_kind', 'reason'],
        query: { bool: { filter: [{ term: { event_id: event } }, { term: { target_id: ref } }] } },
      });
      const reports = { profile: 0, spot: 0, reasons: {} };
      for (const h of reportRows.json.hits?.hits ?? []) {
        const s = h._source ?? {};
        if (s.target_kind === 'profile' || s.target_kind === 'spot') reports[s.target_kind] += 1;
        reports.reasons[s.reason] = (reports.reasons[s.reason] ?? 0) + 1;
      }
      const meetsTotal = Object.values(meets).reduce((a, b) => a + b, 0);
      const items = [profile, { meets: meetsTotal, meets_by_state: meets, blocks_made: blocksMade, blocks_received: blocksReceived, push, reports }];
      if (options.text) items.push(Object.fromEntries(TEXT_FIELDS.map((f) => [f, cut(source[f])])));
      if (options.contact) items.push(Object.fromEntries(CONTACT_FIELDS.map((f) => [f, source[f] ?? null])));
      return {
        items,
        counts: { meets: meetsTotal, blocks_made: blocksMade, blocks_received: blocksReceived, push: Object.values(push).reduce((a, b) => a + b, 0), reports: reports.profile + reports.spot },
        summary: `attendee ${ref} at ${event}${options.text ? ' with text' : ''}${options.contact ? ' with contact' : ''}`,
      };
    },

    async deletePerson({ event, ref, mode }) {
      const { source } = await personByRef(event, ref, ['ref', 'profile_id']);
      const counts = await connectionCounts(event, source.profile_id);
      const what = Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(', ');
      if (mode === 'dry-run') return { counts, summary: `would delete profile ${ref} at ${event} and what goes with it: ${what}` };
      deleteWarnings.length = 0;
      await profileDelete.deleteProfileAndConnections(event, source.profile_id);
      const warnings = deleteWarnings.splice(0).map((m) => `${m}; the hourly purge and the conference-end purge remove what landed after the delete`);
      return { counts, warnings, summary: `deleted profile ${ref} at ${event} and what went with it: ${what}${warnings.length ? ' (with warnings)' : ''}` };
    },

    async setOperatorBlock({ event, ref, options, mode }) {
      if (!options.unblock) return operatorHide(event, 'profile', ref, mode);
      const person = await personByRef(event, ref, ['ref', 'hidden']);
      const { status } = await es('GET', `${idx(INDEX.reports)}/_doc/${encodeURIComponent(operatorReportId('profile', ref))}?_source=false`, undefined, { okStatuses: [404] });
      const blocked = status === 200;
      const others = (await count(INDEX.reports, reportsQuery(event, 'profile', ref))) - (blocked ? 1 : 0);
      const staysHidden = others >= HIDE_AT;
      if (mode === 'dry-run') {
        return { counts: { reports_remaining: others }, summary: blocked ? `would remove the operator block of ${ref}; ${plural(others, 'other report')} remain, so it would ${staysHidden ? 'stay hidden' : 'become visible'}` : `${ref} has no operator block` };
      }
      if (!blocked) throw new NotFoundError(`${ref} has no operator block at ${event}`);
      await es('DELETE', `${idx(INDEX.reports)}/_doc/${encodeURIComponent(operatorReportId('profile', ref))}?refresh=wait_for`, undefined, { okStatuses: [404] });
      await patchPerson(person.id, { hidden: staysHidden });
      return { counts: { reports_remaining: others }, summary: `removed the operator block of ${ref}; ${plural(others, 'other report')} remain, so it ${staysHidden ? 'stays hidden' : 'is visible again'}` };
    },

    async moderationQueue({ event, options }) {
      const moderation = moderationFor(event);
      const show = (row) => (options.showContent ? row : { ...row, display_name: undefined, reasons: undefined });
      const hidden = await moderation.listHidden();
      const items = hidden.rows.map((row) => ({ list: 'hidden', ...show(row) }));
      const counts = { hidden: hidden.rows.length };
      let summary = hidden.lines.at(-1);
      if (options.since !== undefined) {
        const since = await moderation.listSince(options.since);
        for (const row of since.rows) items.push({ list: 'report', ...(options.showContent ? row : { ...row, display_name: undefined, reason: undefined }) });
        counts.reports = since.rows.length;
        summary = `${summary} ${since.lines.at(-1)}`;
      }
      return { items: items.map((row) => Object.fromEntries(Object.entries(row).filter(([, v]) => v !== undefined))), counts, summary };
    },

    async hideTarget({ event, kind, id, mode }) {
      return operatorHide(event, kind, id, mode);
    },

    async unhideTarget({ event, kind, id, mode }) {
      const moderation = moderationFor(event);
      if (mode === 'dry-run') {
        if (kind === 'meet') await moderation.requireMeet(id);
        else await moderation.requirePerson(id);
        const reports = await moderation.countReports(kind, id);
        return { counts: { reports }, summary: `would clear the hidden flag of ${kind} ${id} and remove ${plural(reports, 'report')}` };
      }
      const { removed, lines } = await moderation.unhideTarget({ kind, id });
      return { counts: { reports: removed }, summary: lines.join(' ') };
    },

    async deleteTarget({ event, kind, id, reason, mode }) {
      if (kind === 'profile') return this.deletePerson({ event, ref: id, reason, mode });
      const moderation = moderationFor(event);
      if (mode === 'dry-run') {
        if (kind === 'meet') await moderation.requireMeet(id);
        else await moderation.requirePerson(id);
        return { counts: { [kind]: 1 }, summary: kind === 'meet' ? `would delete meet ${id}` : `would clear the spot line of ${id} and keep it hidden` };
      }
      const { lines } = await moderation.deleteTarget({ kind, id });
      return { counts: { [kind]: 1 }, summary: lines.join(' ') };
    },

    async purgeReports({ event, mode }) {
      const result = await moderationFor(event).purge({ dryRun: mode === 'dry-run' });
      if (!result.ended) throw new AdminError(result.lines[0]);
      return { counts: { reports: result.deleted }, ends_at: result.end, summary: result.lines.join(' ') };
    },

    async purgeExpired({ mode }) {
      if (mode === 'dry-run') return { summary: 'would run scripts/purge-expired-people.mjs with ES_URL and ELASTISEARCH_API_KEY in its environment' };
      const { stdout } = runScript('purge-expired-people.mjs', []);
      return { items: stdout.map((line) => ({ line })), summary: 'scripts/purge-expired-people.mjs finished' };
    },

    async rules({ action, line, options, mode }) {
      const indexArgs = options.index ? ['--index', options.index] : [];
      if (action === 'test') {
        if (mode === 'dry-run') return { summary: `would run scripts/moderation-rules.mjs --test "<line>"${options.index ? ` --index ${options.index}` : ''} with ES_URL and ELASTISEARCH_API_KEY in its environment` };
        const { status, stdout } = runScript('moderation-rules.mjs', ['--test', line, ...indexArgs], { okStatuses: [0, 3] });
        return { items: stdout.map((l) => ({ line: l })), counts: { matched: status === 3 ? Math.max(stdout.length - 1, 0) : 0 }, summary: status === 3 ? 'the line matched the word list' : 'no rule matched' };
      }
      if (mode === 'dry-run') return { summary: 'would run scripts/moderation-rules.mjs --reload-rules with ES_URL and ELASTISEARCH_API_KEY in its environment' };
      const { stdout } = runScript('moderation-rules.mjs', ['--reload-rules', ...indexArgs]);
      return { items: stdout.map((l) => ({ line: l })), summary: 'the word list was reloaded' };
    },

    async listConferences({ options }) {
      const { json } = await es('POST', `${idx(INDEX.conferences)}/_search?ignore_unavailable=true`, {
        size: 500,
        _source: ['slug', 'name', 'start_date', 'end_date', 'status', 'counts', 'demo'],
        sort: ['start_date', 'name'],
        query: { match_all: {} },
      });
      const all = (json.hits?.hits ?? []).map((h) => h._source ?? {}).filter((s) => typeof s.slug === 'string');
      const shown = options.all ? all : all.filter((s) => s.status === 'searchable');
      return {
        // The demo conference (invented data) is listed with demo: true.
        items: shown.map((s) => ({ slug: s.slug, name: s.name ?? null, start_date: s.start_date ?? null, end_date: s.end_date ?? null, status: s.status ?? null, talks: s.counts?.talk ?? 0, ...(s.demo === true ? { demo: true } : {}) })),
        counts: { shown: shown.length, total: all.length },
        summary: `${plural(shown.length, 'conference')}${options.all ? '' : ` searchable of ${all.length}`}`,
      };
    },

    async addConference({ slug, mode }) {
      return this.refreshConference({ slug, options: {}, mode });
    },

    async refreshConference({ slug, options, mode }) {
      if (mode === 'dry-run') {
        return {
          items: [{ step: 'ingest', command: `node scripts/ingest.mjs --event ${slug}` }, { step: 'facets', command: `node scripts/build-facets.mjs ${slug}` }],
          summary: `would run the two commands above with ES_URL and ELASTISEARCH_API_KEY in their environment${options.allowShrink ? ' (--allow-shrink has no effect on tier 3)' : ''}`,
        };
      }
      const ingest = runScript('ingest.mjs', ['--event', slug]);
      const facets = runScript('build-facets.mjs', [slug]);
      return {
        items: [...ingest.stdout.map((line) => ({ step: 'ingest', line })), ...facets.stdout.map((line) => ({ step: 'facets', line }))],
        summary: `ingested ${slug} and rebuilt its facets${options.allowShrink ? ' (--allow-shrink has no effect on tier 3)' : ''}`,
      };
    },

    // hide and unhide both write the rewritten local document over the conference document on
    // this backend (a partial update), or exit 4 when the backend does not hold the conference.
    // Hiding a demo conference (demo: true) also leaves no presence, meet request or nudge of it
    // behind (clearDemoActivity); a real conference keeps them, as a hide keeps a conference's data.
    async hideConference({ slug, doc, mode }) {
      const demo = doc?.demo === true || (await demoSlugs()).includes(slug);
      const result = await writeConferenceDoc(slug, doc, mode);
      if (!demo) return result;
      if (mode === 'dry-run') {
        return { ...result, summary: `${result.summary}; it is the demo conference, so its presence would be cleared and its meet requests and nudges deleted` };
      }
      const cleared = await clearDemoActivity(slug);
      return { ...result, counts: { ...(result.counts ?? {}), ...cleared }, summary: `${result.summary}; demo conference: cleared presence on ${plural(cleared.presence, 'profile')}, deleted ${plural(cleared.meets, 'meet')} and ${plural(cleared.nudges, 'nudge record')}` };
    },

    async unhideConference({ slug, doc, mode }) {
      return writeConferenceDoc(slug, doc, mode);
    },

    async removeConference({ slug, mode }) {
      const counts = {};
      for (const [name, field] of CONFERENCE_SCOPES) counts[name] = await count(INDEX[name], { term: { [field]: slug } });
      const { status } = await es('GET', `${idx(INDEX.conferences)}/_doc/${encodeURIComponent(slug)}?_source=false`, undefined, { okStatuses: [404] });
      counts.conference = status === 200 ? 1 : 0;
      const what = Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(', ');
      if (mode === 'dry-run') return { counts, summary: `would delete from the backend: ${what}` };
      for (const [name, field] of CONFERENCE_SCOPES) {
        if (!counts[name]) continue;
        await es('POST', `${idx(INDEX[name])}/_delete_by_query?refresh=true&conflicts=proceed&ignore_unavailable=true`, { query: { term: { [field]: slug } } });
      }
      if (counts.conference) await es('DELETE', `${idx(INDEX.conferences)}/_doc/${encodeURIComponent(slug)}?refresh=wait_for`, undefined, { okStatuses: [404] });
      return { counts, summary: `deleted from the backend: ${what}` };
    },

    async unretireConference({ slug }) {
      return { backend: 'none', summary: `${slug}: nothing to do on tier 3; the next conferences refresh re-indexes it` };
    },

    // Without --event the totals span every conference, so the demo conference (invented data) is
    // left out of them; --event <the demo's slug> still counts it.
    async counts({ event }) {
      const counts = {};
      let demos = [];
      if (event === undefined) {
        demos = await demoSlugs();
        for (const name of Object.keys(INDEX)) counts[name] = await count(INDEX[name], withoutDemo(CONFERENCE_FIELD[name], demos));
      } else {
        for (const [name, field] of CONFERENCE_SCOPES) counts[name] = await count(INDEX[name], { term: { [field]: event } });
        counts.conferences = await count(INDEX.conferences, { term: { slug: event } });
      }
      const left = demos.length ? ` (the demo conference ${demos.join(', ')} left out)` : '';
      return { items: Object.entries(counts).map(([index, n]) => ({ index, count: n })), counts, summary: event === undefined ? `documents per index${left}` : `documents of ${event} per index` };
    },

    // When a demo conference (invented data) exists, the document count of every index that names a
    // conference is a _count of its top-level documents without the demo's (docs.count of _cat would
    // also count the nested chunks of semantic_text fields, the demo's included). The store sizes
    // are the indices' own and cannot be split.
    async usage() {
      const health = (await es('GET', '/_cluster/health')).json;
      const cat = (await es('GET', '/_cat/indices/caddie-*?format=json&h=index,docs.count,store.size')).json;
      const demos = await demoSlugs();
      const rows = [];
      for (const r of Array.isArray(cat) ? cat : []) {
        const field = demos.length ? fieldOfIndex(r.index) : null;
        const docs = field ? await count(r.index, withoutDemo(field, demos)) : Number(r['docs.count'] ?? 0);
        rows.push({ index: r.index, docs, size: r['store.size'] ?? null });
      }
      return {
        items: [
          { cluster: health.cluster_name ?? null, status: health.status ?? null, nodes: health.number_of_nodes ?? null, active_shards: health.active_shards ?? null, unassigned_shards: health.unassigned_shards ?? null },
          ...rows,
        ],
        counts: Object.fromEntries(rows.map((r) => [r.index.replace(/[^A-Za-z0-9_]/g, '_').slice(0, 40), r.docs])),
        summary: `cluster ${health.status ?? '?'}, ${rows.length} caddie ${rows.length === 1 ? 'index' : 'indices'}${demos.length ? ` (top-level documents counted without the demo conference ${demos.join(', ')}; sizes include it)` : ''} (needs the monitor privilege; the admin key holds it)`,
      };
    },

    async health() {
      const api = String(backend.api ?? '').replace(/\/+$/, '');
      if (!api) throw new AdminError(`backend "${backend.name}" has no api (the Cloud Run service URL) in config.json`);
      const get = async (path) => {
        let res;
        try {
          res = await fetch(api + path, { redirect: 'error', signal: AbortSignal.timeout(ES_TIMEOUT_MS) });
        } catch (err) {
          throw new AdminError(`GET ${path} failed: ${err?.cause?.code ?? err?.name ?? 'error'}`);
        }
        return { status: res.status, json: await res.json().catch(() => ({})) };
      };
      const health = await get('/api/health');
      const caps = await get('/api/capabilities');
      const c = caps.json ?? {};
      const service = backend.service ?? 'conference-caddie';
      const project = backend.project ?? '<GC_PROJECT>';
      const smoke = `BASE_URL="${api}" ES_URL="${esUrl}" ELASTISEARCH_API_KEY="$ELASTISEARCH_API_KEY" node scripts/smoke.mjs`;
      const logs = `gcloud logging read 'resource.type="cloud_run_revision" AND resource.labels.service_name="${service}" AND severity>=ERROR' --limit 50 --project ${project} --format=json`;
      return {
        items: [
          { health: health.status, ok: health.json?.ok === true },
          { capabilities: caps.status, tier: c.tier ?? null, ble_mode: c.ble?.mode ?? null, push_apns: c.push?.apns ?? null, push_fcm: c.push?.fcm ?? null },
          { smoke },
          { logs },
        ],
        commands: { smoke, logs },
        summary: `health ${health.status}, capabilities ${caps.status}; run the smoke and log commands above by hand`,
      };
    },
  };
}
