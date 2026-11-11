// Operator CLI for reports: what is hidden, what was reported, and undoing or confirming a hide.
//
// DEPRECATED: the caddie-admin CLI (scripts/caddie-admin.mjs, `caddie-admin moderation queue |
// hide | unhide | delete | purge-reports`) serves the same actions on every backend tier with a
// dry run, a typed confirmation and an audit log. This script keeps its flags, messages and key
// policy for one release and is then removed. The actions themselves live in
// scripts/admin/backends/es-moderation.mjs, which both run.
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
// Env: ES_URL; ELASTISEARCH_API_KEY (the admin key). --unhide and --purge require it as an operator-only
//      policy, and the people key cannot do them anyway: they delete
//      reports with _delete_by_query?refresh=true, which the people key cannot refresh, and
//      --purge also reads the conference. --hidden, --since and --delete also run with
//      ES_PEOPLE_API_KEY alone; ES_PEOPLE_INDEX (default caddie-people),
//      ES_PEOPLE_MEETS_INDEX (default caddie-people-meets), ES_PEOPLE_REPORTS_INDEX (default
//      caddie-people-reports), ES_CONFERENCES_INDEX (default caddie-conferences).
//
// Output names people by display name and ref only. profile_id, reporter ids and secrets are never
// printed; the key is never printed. Hides and unhides are Bulk partial updates of the flag
// fields, so nothing is re-embedded.

import { createModeration } from './admin/backends/es-moderation.mjs';

const ES_URL = (process.env.ES_URL || 'https://fc875c88f9f44f159f1a359ee724d82b.us-west1.gcp.cloud.es.io:443').replace(/\/$/, '');
const API_KEY = process.env.ELASTISEARCH_API_KEY || process.env.ES_PEOPLE_API_KEY;
const PEOPLE_INDEX = process.env.ES_PEOPLE_INDEX || 'caddie-people';
const MEETS_INDEX = process.env.ES_PEOPLE_MEETS_INDEX || 'caddie-people-meets';
const REPORTS_INDEX = process.env.ES_PEOPLE_REPORTS_INDEX || 'caddie-people-reports';
const CONFERENCES_INDEX = process.env.ES_CONFERENCES_INDEX || 'caddie-conferences';
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,119}$/;
const REF_RE = /^[0-9a-f]{16}$/;
const MEET_ID_RE = /^[A-Za-z0-9_-]{22}$/;
const KINDS = ['profile', 'spot', 'meet'];


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
// Operator policy: --unhide and --purge delete reports with _delete_by_query?refresh=true, so they
// take the admin key only (API_KEY is the admin key whenever it is set) and refuse the people key.
// The action-specific check comes before the generic one so its message is the one an operator sees.
if ((action === 'unhide' || action === 'purge') && !process.env.ELASTISEARCH_API_KEY) {
  console.error(`--${action} needs ELASTISEARCH_API_KEY (the admin key); ES_PEOPLE_API_KEY is not accepted for it.`);
  process.exit(1);
}
if (!API_KEY) {
  console.error('Set ELASTISEARCH_API_KEY or ES_PEOPLE_API_KEY.');
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
const quote = (s) => JSON.stringify(String(s ?? ''));
const personText = (p, ref) => `${quote(p?.display_name ?? '(profile deleted)')} ref ${ref}`;
const print = (lines) => { for (const line of lines) console.log(line); };

const moderation = createModeration({ es, slug, indices: { people: PEOPLE_INDEX, meets: MEETS_INDEX, reports: REPORTS_INDEX, conferences: CONFERENCES_INDEX } });

// Deletes a profile document only, as this script always did. The caddie-admin CLI runs the full
// "Delete my profile" instead (server/people-delete.mjs), which also removes the person's meets,
// push subscriptions, nudge records and the blocks they made.
async function deleteProfileDocument(ref) {
  const p = await moderation.requirePerson(ref);
  await es('DELETE', `${idx(PEOPLE_INDEX)}/_doc/${encodeURIComponent(p._id)}?refresh=wait_for`);
  console.log(`Deleted the profile ${personText(p, ref)}. Their device keeps its own data and can create a profile again; the reports stay until --purge.`);
}

try {
  if (action === 'hidden') print((await moderation.listHidden()).lines);
  else if (action === 'since') print((await moderation.listSince(arg)).lines);
  else if (action === 'unhide') print((await moderation.unhideTarget(parseTarget(arg))).lines);
  else if (action === 'delete') {
    const target = parseTarget(arg);
    if (target.kind === 'profile') await deleteProfileDocument(target.id);
    else print((await moderation.deleteTarget(target)).lines);
  } else print((await moderation.purge()).lines);
} catch (err) {
  console.error(err?.message ?? String(err));
  process.exit(err?.exitCode === 2 ? 2 : 1);
}
