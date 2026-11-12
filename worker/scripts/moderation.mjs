#!/usr/bin/env node
// Deprecated. The moderation commands of the caddie-admin CLI (scripts/caddie-admin.mjs, npm run
// admin, docs/ADMIN_CLI.md) replace this script: they call the same GET and POST /admin/moderation
// routes of the Worker, signed the same way, and add a preview before every change, a typed
// confirmation and a private audit log. This script now makes no request at all. It prints, on
// stderr, that it is deprecated and the caddie-admin command that does what the given options asked
// for (or the whole mapping when no action is given or the options do not parse), and exits 2.
//
// The mapping, for a tier 2 backend in the CLI's config.json ({ "tier": 2, "api": "<Worker origin>" },
// which replaces --api and CADDIE_API_BASE; the token is still read from ADMIN_TOKEN, or from
// ADMIN_TOKEN_FILE, whose default is admin-token in the CLI's config directory and must have mode
// 0600; on Windows the CLI reads only ADMIN_TOKEN and no token file, scripts/admin/credentials.mjs):
//   --hidden [--show-content]           moderation queue --event <slug> [--show-content]
//   --since <iso> [--show-content]      moderation queue --event <slug> --since <iso> [--show-content]
//                                       (the queue also lists the hidden targets)
//   --unhide <kind>:<id>                moderation unhide --event <slug> <kind>:<id> --yes --confirm <kind>:<id>
//   --delete <kind>:<id>                moderation delete --event <slug> <kind>:<id> --yes --confirm <kind>:<id>
//   --purge                             moderation purge-reports --event <slug> --yes --confirm <slug>
// Without --yes each of the last three only previews. The CLI sends the Cloudflare Access headers
// when CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET are both set, and never follows a redirect.
//
// The suggested command repeats a value from the command line only when it has the shape of its
// field (a slug, a kind and a ref or meet id, an ISO instant); anything else is shown as a
// placeholder, so nothing the operator typed by mistake reaches the terminal as it is.

import { parseArgs } from 'node:util';

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,119}$/;
const TARGET_RE = /^(?:(?:profile|spot):[0-9a-f]{16}|meet:[A-Za-z0-9_-]{22})$/;
const ISO_RE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}(?:T[0-9:.]{2,18}(?:Z|[+-][0-9]{2}:?[0-9]{2})?)?$/;
const CLI = 'node scripts/caddie-admin.mjs';

const MAPPING = [
  ['--hidden [--show-content]', 'moderation queue --event <slug> [--show-content]'],
  ['--since <iso> [--show-content]', 'moderation queue --event <slug> --since <iso> [--show-content]'],
  ['--unhide <kind>:<id>', 'moderation unhide --event <slug> <kind>:<id> --yes --confirm <kind>:<id>'],
  ['--delete <kind>:<id>', 'moderation delete --event <slug> <kind>:<id> --yes --confirm <kind>:<id>'],
  ['--purge', 'moderation purge-reports --event <slug> --yes --confirm <slug>'],
];

const HEAD = 'worker/scripts/moderation.mjs is deprecated and makes no request; use the caddie-admin CLI (scripts/caddie-admin.mjs, or npm run admin --) with a tier 2 backend instead.';
const TAIL = [
  'Set the Worker origin as a backend in the CLI\'s config.json ({ "tier": 2, "api": "<Worker origin>" }) instead of --api or CADDIE_API_BASE; the token comes from ADMIN_TOKEN or ADMIN_TOKEN_FILE as before (a token file must have mode 0600), except on Windows, where the CLI reads only ADMIN_TOKEN and no token file.',
  'Without --yes, unhide, delete and purge-reports only preview. See docs/ADMIN_CLI.md.',
];

// The caddie-admin command for one set of parsed options, or null when no single action was given.
function equivalent(opts) {
  const slug = typeof opts.event === 'string' && SLUG_RE.test(opts.event) ? opts.event : '<slug>';
  const target = (v) => (TARGET_RE.test(v) ? v : '<kind>:<id>');
  const content = opts['show-content'] ? ' --show-content' : '';
  const actions = [];
  if (opts.hidden) actions.push(`moderation queue --event ${slug}${content}`);
  if (opts.since !== undefined) actions.push(`moderation queue --event ${slug} --since ${ISO_RE.test(opts.since) ? opts.since : '<iso>'}${content}`);
  if (opts.unhide !== undefined) actions.push(`moderation unhide --event ${slug} ${target(opts.unhide)} --yes --confirm ${target(opts.unhide)}`);
  if (opts.delete !== undefined) actions.push(`moderation delete --event ${slug} ${target(opts.delete)} --yes --confirm ${target(opts.delete)}`);
  if (opts.purge) actions.push(`moderation purge-reports --event ${slug} --yes --confirm ${slug}`);
  return actions.length === 1 ? `${CLI} ${actions[0]}` : null;
}

// The lines printed on stderr for an argument list.
function deprecationLines(argv) {
  let opts = null;
  try {
    ({ values: opts } = parseArgs({
      args: argv,
      options: {
        event: { type: 'string' },
        api: { type: 'string' },
        hidden: { type: 'boolean' },
        since: { type: 'string' },
        unhide: { type: 'string' },
        delete: { type: 'string' },
        purge: { type: 'boolean' },
        'show-content': { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
      },
      strict: true,
    }));
  } catch {
    opts = null;
  }
  const command = opts ? equivalent(opts) : null;
  if (command) return [HEAD, `The equivalent command: ${command}`, ...TAIL];
  return [
    HEAD,
    'Each option of this script and its caddie-admin command:',
    ...MAPPING.map(([old, now]) => `  ${old.padEnd(32)}${CLI} ${now}`),
    ...TAIL,
  ];
}

process.stderr.write(`${deprecationLines(process.argv.slice(2)).join('\n')}\n`);
process.exitCode = 2;
