// Adapter factory of the caddie-admin CLI. An adapter serves the commands of one backend tier:
// tier 3 talks to Elasticsearch with the admin key (es.mjs), tier 2 to the Worker's signed /admin
// routes (worker.mjs). The conference commands that write files (commands/conferences.mjs) wrap
// the tier adapter, so both tiers share them.
//
// Adapter interface. Each method takes one object of named arguments and returns a result object
// `{ items?: [...], summary?: '<one line>', counts?: { <name>: <integer> }, ... }`, or throws one
// of the error classes in ../errors.mjs (NotFoundError for exit 4, UnsupportedError for exit 5).
//   event    conference slug
//   ref      attendee ref (16 hex characters)
//   kind     'profile' | 'spot' | 'meet'
//   id       ref for a profile or spot, meet id (22 characters) for a meet
//   slug     conference slug (conference commands; the same value as event)
//   doc      the local data/<slug>/conference.json as rewritten (conference hide, unhide, unretire)
//   line     the text of `moderation rules test`
//   reason   one of spam, harassment, impersonation, off-topic, other (when given)
//   options  plain object of the command's flags in camelCase, for example { allowShrink: true }.
//            A backend must put these in the request BODY, never in a query string, because a
//            query string lands in access logs.
//   mode     'dry-run' | 'run'. The adapter itself does the preview: in 'dry-run' it reads and
//            counts what a run would change and writes nothing.

import { AdminError } from '../errors.mjs';
import { adminRoot, withConferenceFiles } from '../commands/conferences.mjs';
import { createEsAdapter } from './es.mjs';
import { createWorkerAdapter } from './worker.mjs';

// Method name, the command it serves, and the arguments it reads.
export const ADAPTER_METHODS = {
  searchPeople: 'attendees search: { event, ref | name, options: { limit, includeHidden }, mode }',
  viewPerson: 'attendees view: { event, ref, options: { text, contact }, mode }',
  deletePerson: 'attendees delete: { event, ref, reason, mode }',
  setOperatorBlock: 'attendees block and unblock: { event, ref, reason, options: { unblock }, mode }',
  moderationQueue: 'moderation queue: { event, options: { since, showContent }, mode }',
  hideTarget: 'moderation hide: { event, kind, id, reason, mode }',
  unhideTarget: 'moderation unhide: { event, kind, id, mode }',
  deleteTarget: 'moderation delete: { event, kind, id, reason, mode }',
  purgeReports: 'moderation purge-reports: { event, mode }',
  purgeExpired: 'moderation purge-expired: { mode }',
  rules: 'moderation rules: { action: "test" | "reload", line, options: { index }, mode }',
  listConferences: 'conferences list: { options: { all }, mode }',
  addConference: 'conferences add: { event, slug, mode }',
  refreshConference: 'conferences refresh: { event, slug, options: { allowShrink }, mode }',
  hideConference: 'conferences hide: { event, slug, reason, mode, doc }',
  unhideConference: 'conferences unhide: { event, slug, mode, doc }',
  removeConference: 'conferences remove: { event, slug, reason, options: { purgeLocal }, mode }',
  unretireConference: 'conferences unretire: { event, slug, mode, doc }; tier 2 sends "unretire": true in the PUT /admin/conferences body, tier 3 clears the removed state',
  counts: 'stats counts: { event, mode }',
  usage: 'stats usage: { mode }',
  health: 'stats health: { mode }',
};

// `credential` is the admin key (tier 3) or admin token (tier 2). It is used only to sign or
// authorize requests and is never returned, printed or logged. `env` is the process environment
// (index names, CADDIE_ADMIN_ROOT); `spawn`, `fetch`, `now`, `trackSend` (tier 2: whether an
// attempt was written to a socket) and `sleep` (tier 3: the wait of a demo conference's hide) are
// injectable for the tests.
export function createAdapter(backend, { credential, env = {}, spawn, fetch, now = () => new Date(), trackSend, sleep } = {}) {
  const root = adminRoot(env);
  const deps = { credential, env, spawn, fetch, root, now, trackSend, ...(sleep ? { sleep } : {}) };
  let tier;
  if (backend.tier === 3) tier = createEsAdapter(backend, deps);
  else if (backend.tier === 2) tier = createWorkerAdapter(backend, deps);
  else throw new AdminError(`backend "${backend.name}" has tier ${backend.tier}; only 2 and 3 exist`);
  return withConferenceFiles(tier, { root, now, tier: backend.tier });
}
