// Command tree, argument parsing, help, exit codes and the run loop of the caddie-admin CLI.
// main() returns the exit code and never calls process.exit, so tests can call it in-process.
//
// Exit codes: 0 success, 1 backend or request failure, or finished with warnings (see stderr; audit
// counts.warnings), 2 usage, 3 confirmation missing or refused, 4 not found, 5 not supported on
// this tier.

import { spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { parseArgs } from 'node:util';
import { appendAudit } from './audit.mjs';
import { createAdapter as defaultCreateAdapter } from './backends/index.mjs';
import { configDir, loadConfig, selectBackend } from './config.mjs';
import { resolveMode } from './confirm.mjs';
import { CREDENTIAL_SOURCES, readCredential, redactor } from './credentials.mjs';
import { AdminError, ConfirmError, NotFoundError, UnsupportedError, UsageError } from './errors.mjs';
import { escapeControls, escapeJsonControls, renderHuman, renderJson } from './output.mjs';

const REF_RE = /^[0-9a-f]{16}$/;
const MEET_ID_RE = /^[A-Za-z0-9_-]{22}$/;
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,119}$/;
const REASONS = ['spam', 'harassment', 'impersonation', 'off-topic', 'other'];
const KINDS = ['profile', 'spot', 'meet'];
const AUDIT_FLAGS = ['text', 'contact', 'include-hidden', 'show-content', 'all', 'allow-shrink', 'purge-local'];

const GLOBAL_OPTIONS = {
  backend: { type: 'string' },
  json: { type: 'boolean' },
  yes: { type: 'boolean' },
  confirm: { type: 'string' },
  'dry-run': { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
};
const REASON_OPTIONS = { reason: { type: 'string' }, note: { type: 'string' } };
const EVENT_OPTION = { event: { type: 'string' } };

// ---- validation helpers ----

function slugOf(values, required) {
  const event = values.event;
  if (event === undefined) {
    if (required) throw new UsageError('--event <slug> is required');
    return undefined;
  }
  if (!SLUG_RE.test(event)) {
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(event)) {
      throw new UsageError('--event takes a conference slug, not a URL; adding a conference from a Sessionize URL is deferred to task E1');
    }
    throw new UsageError('--event must be a slug: lowercase letters, digits and hyphens, up to 120 characters');
  }
  return event;
}

function refOf(text) {
  if (!REF_RE.test(text ?? '')) throw new UsageError('ref must be 16 lowercase hex characters');
  return text;
}

function kindIdOf(text) {
  const match = /^([a-z]+):(.+)$/.exec(text ?? '');
  if (!match || !KINDS.includes(match[1])) throw new UsageError('target must be <kind>:<id> with kind profile, spot or meet');
  const [, kind, id] = match;
  if (kind === 'meet' ? !MEET_ID_RE.test(id) : !REF_RE.test(id)) {
    throw new UsageError(kind === 'meet' ? 'a meet id is 22 characters of A-Z, a-z, 0-9, _ and -' : 'a profile or spot id is a ref of 16 lowercase hex characters');
  }
  return { kind, id };
}

function reasonOf(values, required) {
  const reason = values.reason;
  if (reason === undefined) {
    if (required) throw new UsageError(`--reason is required: ${REASONS.join(', ')}`);
    return undefined;
  }
  if (!REASONS.includes(reason)) throw new UsageError(`--reason must be one of ${REASONS.join(', ')}`);
  return reason;
}

function expectPositionals(positionals, count, what) {
  if (positionals.length < count) throw new UsageError(`missing ${what}`);
  if (positionals.length > count) throw new UsageError(`unexpected argument "${positionals[count]}"`);
}

function drop(object) {
  return Object.fromEntries(Object.entries(object).filter(([, value]) => value !== undefined));
}

// ---- command tree ----
// prepare(values, positionals) validates and returns { args, target }. args go to the adapter
// (never --note); target is what destructive commands confirm and what the audit log records.

export const COMMAND_TREE = {
  attendees: {
    summary: 'search, inspect, delete and block attendees',
    commands: {
      search: {
        usage: 'attendees search --event <slug> (--name <text> | --ref <ref>) [--limit <n>] [--include-hidden]',
        summary: 'list attendees by name or ref',
        options: { ...EVENT_OPTION, name: { type: 'string' }, ref: { type: 'string' }, limit: { type: 'string' }, 'include-hidden': { type: 'boolean' } },
        method: 'searchPeople',
        prepare(v, p) {
          expectPositionals(p, 0);
          const event = slugOf(v, true);
          if ((v.name === undefined) === (v.ref === undefined)) throw new UsageError('give exactly one of --name and --ref');
          if (v.name !== undefined && v.name.trim() === '') throw new UsageError('--name must not be empty');
          const ref = v.ref === undefined ? undefined : refOf(v.ref);
          let limit = 50;
          if (v.limit !== undefined) {
            if (!/^[0-9]{1,4}$/.test(v.limit) || Number(v.limit) < 1 || Number(v.limit) > 1000) throw new UsageError('--limit must be an integer from 1 to 1000');
            limit = Number(v.limit);
          }
          return { args: { event, ref, name: v.name, options: { limit, includeHidden: !!v['include-hidden'] } }, target: ref ?? event };
        },
      },
      view: {
        usage: 'attendees view --event <slug> <ref> [--text] [--contact]',
        summary: 'show one attendee; --text and --contact add user text and the contact link',
        options: { ...EVENT_OPTION, text: { type: 'boolean' }, contact: { type: 'boolean' } },
        method: 'viewPerson',
        prepare(v, p) {
          expectPositionals(p, 1, 'ref');
          const event = slugOf(v, true);
          const ref = refOf(p[0]);
          return { args: { event, ref, options: { text: !!v.text, contact: !!v.contact } }, target: ref };
        },
      },
      delete: {
        usage: 'attendees delete --event <slug> <ref> [--reason <enum>] [--note <text>] [--yes --confirm <ref>]',
        summary: 'delete a profile with full "Delete my profile" semantics',
        options: { ...EVENT_OPTION, ...REASON_OPTIONS },
        destructive: true,
        method: 'deletePerson',
        prepare(v, p) {
          expectPositionals(p, 1, 'ref');
          const event = slugOf(v, true);
          const ref = refOf(p[0]);
          return { args: { event, ref, reason: reasonOf(v, false) }, target: ref };
        },
      },
      block: {
        usage: 'attendees block --event <slug> <ref> --reason <enum> [--note <text>] [--yes --confirm <ref>]',
        summary: 'hide a profile in a way that survives rewrites and re-creation',
        options: { ...EVENT_OPTION, ...REASON_OPTIONS },
        destructive: true,
        method: 'setOperatorBlock',
        prepare(v, p) {
          expectPositionals(p, 1, 'ref');
          const event = slugOf(v, true);
          const ref = refOf(p[0]);
          return { args: { event, ref, reason: reasonOf(v, true), options: { unblock: false } }, target: ref };
        },
      },
      unblock: {
        usage: 'attendees unblock --event <slug> <ref> [--yes --confirm <ref>]',
        summary: 'remove the operator block of a profile',
        options: { ...EVENT_OPTION },
        destructive: true,
        method: 'setOperatorBlock',
        prepare(v, p) {
          expectPositionals(p, 1, 'ref');
          const event = slugOf(v, true);
          const ref = refOf(p[0]);
          return { args: { event, ref, options: { unblock: true } }, target: ref };
        },
      },
    },
  },
  moderation: {
    summary: 'reports, hides, deletes and the word list',
    commands: {
      queue: {
        usage: 'moderation queue --event <slug> [--since <iso>] [--show-content]',
        summary: 'list hidden targets and recent reports',
        options: { ...EVENT_OPTION, since: { type: 'string' }, 'show-content': { type: 'boolean' } },
        method: 'moderationQueue',
        prepare(v, p) {
          expectPositionals(p, 0);
          const event = slugOf(v, true);
          if (v.since !== undefined && Number.isNaN(Date.parse(v.since))) throw new UsageError('--since must be an ISO 8601 instant');
          return { args: { event, options: drop({ since: v.since, showContent: !!v['show-content'] }) }, target: event };
        },
      },
      hide: {
        usage: 'moderation hide --event <slug> <kind>:<id> --reason <enum> [--note <text>] [--yes --confirm <kind>:<id>]',
        summary: 'hide a profile or a spot line (kind profile or spot)',
        options: { ...EVENT_OPTION, ...REASON_OPTIONS },
        destructive: true,
        method: 'hideTarget',
        prepare(v, p) {
          expectPositionals(p, 1, '<kind>:<id>');
          const event = slugOf(v, true);
          const { kind, id } = kindIdOf(p[0]);
          if (kind === 'meet') throw new UsageError('moderation hide takes profile or spot; to remove a meet use moderation delete');
          return { args: { event, kind, id, reason: reasonOf(v, true) }, target: `${kind}:${id}` };
        },
      },
      unhide: {
        usage: 'moderation unhide --event <slug> <kind>:<id> [--yes --confirm <kind>:<id>]',
        summary: 'clear the hidden flag of a target and remove its reports',
        options: { ...EVENT_OPTION },
        destructive: true,
        method: 'unhideTarget',
        prepare(v, p) {
          expectPositionals(p, 1, '<kind>:<id>');
          const event = slugOf(v, true);
          const { kind, id } = kindIdOf(p[0]);
          return { args: { event, kind, id }, target: `${kind}:${id}` };
        },
      },
      delete: {
        usage: 'moderation delete --event <slug> <kind>:<id> [--reason <enum>] [--note <text>] [--yes --confirm <kind>:<id>]',
        summary: 'delete a profile, a spot line or a meet',
        options: { ...EVENT_OPTION, ...REASON_OPTIONS },
        destructive: true,
        method: 'deleteTarget',
        prepare(v, p) {
          expectPositionals(p, 1, '<kind>:<id>');
          const event = slugOf(v, true);
          const { kind, id } = kindIdOf(p[0]);
          return { args: { event, kind, id, reason: reasonOf(v, false) }, target: `${kind}:${id}` };
        },
      },
      'purge-reports': {
        usage: 'moderation purge-reports --event <slug> [--yes --confirm <slug>]',
        summary: 'delete the reports of an ended conference',
        options: { ...EVENT_OPTION },
        destructive: true,
        method: 'purgeReports',
        prepare(v, p) {
          expectPositionals(p, 0);
          const event = slugOf(v, true);
          return { args: { event }, target: event };
        },
      },
      'purge-expired': {
        usage: 'moderation purge-expired [--yes --confirm purge-expired]',
        summary: 'delete expired profiles (tier 3 only)',
        options: {},
        destructive: true,
        method: 'purgeExpired',
        prepare(v, p) {
          expectPositionals(p, 0);
          return { args: {}, target: 'purge-expired' };
        },
      },
      rules: {
        usage: 'moderation rules test "<line>" | reload [--index <name>] [--yes --confirm reload]',
        summary: 'test a line against the word list, or reload the list (tier 3 only)',
        options: { index: { type: 'string' } },
        method: 'rules',
        // Only reload is destructive.
        isDestructive: (p) => p[0] === 'reload',
        prepare(v, p) {
          const action = p[0];
          if (action === 'test') {
            expectPositionals(p, 2, 'line to test');
            return { args: { action, line: p[1], options: drop({ index: v.index }) }, target: undefined };
          }
          if (action === 'reload') {
            expectPositionals(p, 1);
            return { args: { action, options: drop({ index: v.index }) }, target: 'reload' };
          }
          throw new UsageError('moderation rules takes test "<line>" or reload');
        },
      },
    },
  },
  conferences: {
    summary: 'list, add, refresh, hide, remove and unretire conferences',
    commands: {
      list: {
        usage: 'conferences list [--all]',
        summary: 'list conferences',
        options: { all: { type: 'boolean' } },
        method: 'listConferences',
        prepare(v, p) {
          expectPositionals(p, 0);
          return { args: { options: { all: !!v.all } }, target: undefined };
        },
      },
      add: {
        usage: 'conferences add --event <slug>',
        summary: 'index a Linux Foundation conference by slug',
        options: { ...EVENT_OPTION, sessionize: { type: 'string' } },
        method: 'addConference',
        prepare(v, p) {
          expectPositionals(p, 0);
          if (v.sessionize !== undefined) throw new UsageError('--sessionize is not supported yet; adding a conference from a Sessionize URL is deferred to task E1');
          const event = slugOf(v, true);
          return { args: { event, slug: event }, target: event };
        },
      },
      refresh: {
        usage: 'conferences refresh --event <slug> [--allow-shrink]',
        summary: 're-ingest a conference',
        options: { ...EVENT_OPTION, 'allow-shrink': { type: 'boolean' } },
        method: 'refreshConference',
        prepare(v, p) {
          expectPositionals(p, 0);
          const event = slugOf(v, true);
          return { args: { event, slug: event, options: { allowShrink: !!v['allow-shrink'] } }, target: event };
        },
      },
      hide: {
        usage: 'conferences hide --event <slug> [--reason <enum>] [--note <text>] [--yes --confirm <slug>]',
        summary: 'hide a conference from clients, keeping its data',
        options: { ...EVENT_OPTION, ...REASON_OPTIONS },
        destructive: true,
        method: 'hideConference',
        prepare(v, p) {
          expectPositionals(p, 0);
          const event = slugOf(v, true);
          return { args: { event, slug: event, reason: reasonOf(v, false) }, target: event };
        },
      },
      unhide: {
        usage: 'conferences unhide --event <slug> [--yes --confirm <slug>]',
        summary: 'undo conferences hide: the conference becomes visible again and the committed files are rewritten',
        options: { ...EVENT_OPTION },
        destructive: true,
        method: 'unhideConference',
        prepare(v, p) {
          expectPositionals(p, 0);
          const event = slugOf(v, true);
          return { args: { event, slug: event }, target: event };
        },
      },
      remove: {
        usage: 'conferences remove --event <slug> [--reason <enum>] [--note <text>] [--purge-local] [--yes --confirm <slug>]',
        summary: 'wipe a conference from the backend and retire it',
        options: { ...EVENT_OPTION, ...REASON_OPTIONS, 'purge-local': { type: 'boolean' } },
        destructive: true,
        method: 'removeConference',
        prepare(v, p) {
          expectPositionals(p, 0);
          const event = slugOf(v, true);
          return { args: { event, slug: event, reason: reasonOf(v, false), options: { purgeLocal: !!v['purge-local'] } }, target: event };
        },
      },
      unretire: {
        usage: 'conferences unretire --event <slug> [--yes --confirm <slug>]',
        summary: 'lift the retired state of a removed conference; follow with conferences refresh',
        options: { ...EVENT_OPTION },
        destructive: true,
        method: 'unretireConference',
        prepare(v, p) {
          expectPositionals(p, 0);
          const event = slugOf(v, true);
          return { args: { event, slug: event }, target: event };
        },
      },
    },
  },
  stats: {
    summary: 'counts, usage and health',
    commands: {
      counts: {
        usage: 'stats counts [--event <slug>]',
        summary: 'document counts, per event or overall',
        options: { ...EVENT_OPTION },
        method: 'counts',
        prepare(v, p) {
          expectPositionals(p, 0);
          const event = slugOf(v, false);
          return { args: drop({ event }), target: event };
        },
      },
      usage: {
        usage: 'stats usage',
        summary: 'meters and totals (tier 2) or cluster health and index sizes (tier 3; _cluster/health and _cat/indices need the monitor privilege, which the admin key holds)',
        options: {},
        method: 'usage',
        prepare(v, p) {
          expectPositionals(p, 0);
          return { args: {}, target: undefined };
        },
      },
      health: {
        usage: 'stats health',
        summary: 'health and capabilities, plus the smoke and log-tail commands to run by hand',
        options: {},
        method: 'health',
        prepare(v, p) {
          expectPositionals(p, 0);
          return { args: {}, target: undefined };
        },
      },
    },
  },
};

// ---- help ----

const GLOBAL_HELP = [
  'Global flags:',
  '  --backend <name>    backend from config.json (default: the config\'s "default")',
  '  --json              print one JSON object on stdout',
  '  --yes               run a destructive command for real (otherwise it previews)',
  '  --confirm <target>  with --yes, the exact target; replaces typing it, and is required off a terminal',
  '  --dry-run           preview only, even with --yes',
  '  -h, --help          this help',
  'Exit codes: 0 ok, 1 backend failure, or finished with warnings (see stderr; audit counts.warnings), 2 usage, 3 confirmation missing or refused, 4 not found, 5 not supported on this tier.',
];

function rootHelp() {
  return [
    'Usage: caddie-admin <area> <command> [target] [flags]',
    '',
    'Areas:',
    ...Object.entries(COMMAND_TREE).map(([name, area]) => `  ${name.padEnd(12)}${area.summary}`),
    '',
    ...GLOBAL_HELP,
    '',
  ].join('\n');
}

function areaHelp(areaName) {
  const area = COMMAND_TREE[areaName];
  return [
    `Usage: caddie-admin ${areaName} <command> [target] [flags]`,
    '',
    'Commands:',
    ...Object.entries(area.commands).map(([name, command]) => `  ${name.padEnd(14)}${command.summary}`),
    '',
    ...GLOBAL_HELP,
    '',
  ].join('\n');
}

function commandHelp(command) {
  return [`Usage: caddie-admin ${command.usage}`, '', command.summary, ...(command.destructive ? ['Destructive: previews unless --yes is given.'] : []), '', ...GLOBAL_HELP, ''].join('\n');
}

// ---- default dependencies ----

function readlinePrompt(stdin, stderr) {
  return (question) => new Promise((resolve) => {
    const rl = createInterface({ input: stdin, output: stderr });
    let answered = false;
    rl.on('close', () => { if (!answered) resolve(''); });
    rl.question(question, (answer) => {
      answered = true;
      rl.close();
      resolve(answer);
    });
  });
}

const EXIT_CODE_NAMES = { 2: 'usage', 3: 'confirm', 4: 'not_found', 5: 'unsupported' };
function foreignError(raw) {
  const error = new AdminError(raw?.message ?? String(raw));
  if (Number.isInteger(raw?.exitCode) && raw.exitCode >= 1) {
    error.exitCode = raw.exitCode;
    error.code = EXIT_CODE_NAMES[raw.exitCode] ?? 'failed';
  }
  return error;
}

function auditResult(error) {
  if (error instanceof ConfirmError) return 'refused';
  if (error instanceof NotFoundError) return 'not_found';
  if (error instanceof UnsupportedError) return 'unsupported';
  return 'failed';
}

// ---- main ----

export async function main(argv, deps = {}) {
  const env = deps.env ?? {};
  const stdout = deps.stdout ?? process.stdout;
  const stderr = deps.stderr ?? process.stderr;
  const stdin = deps.stdin ?? process.stdin;
  const d = {
    isTTY: deps.isTTY ?? stdin?.isTTY ?? false,
    prompt: deps.prompt ?? readlinePrompt(stdin, stderr),
    createAdapter: deps.createAdapter ?? defaultCreateAdapter,
    now: deps.now ?? (() => new Date()),
    // The child-process runner and the fetch the adapters use; the tests inject recording ones.
    spawn: deps.spawn ?? spawnSync,
    fetch: deps.fetch ?? ((...args) => globalThis.fetch(...args)),
  };
  const json = argv.includes('--json');
  const secrets = [];
  const redact = (text) => redactor(secrets)(text);

  try {
    return await run(argv, { env, stdout, stderr, d, secrets, redact });
  } catch (raw) {
    // A UsageError of the signer or another module carries its own exitCode (an integer of 1 or
    // more); anything else is 1. The code names the exit codes this CLI defines.
    // A message can echo a value a backend answered with, so it is escaped like any output.
    const error = raw instanceof AdminError ? raw : foreignError(raw);
    const message = redact(error.message);
    stderr.write(json
      ? `${escapeJsonControls(JSON.stringify({ ok: false, error: error.code, message }))}\n`
      : `caddie-admin: ${escapeControls(message.split('\n')[0])}\n`);
    return error.exitCode;
  }
}

async function run(argv, ctx) {
  const { env, stdout, stderr, d, secrets, redact } = ctx;

  // Help at the root and area levels.
  const [first, second] = argv;
  const wantsHelp = (token) => token === '-h' || token === '--help';
  if (first === undefined) {
    stderr.write(rootHelp());
    return 2;
  }
  if (wantsHelp(first)) {
    stdout.write(rootHelp());
    return 0;
  }
  if (!Object.hasOwn(COMMAND_TREE, first)) throw new UsageError(`unknown area "${first}"; areas: ${Object.keys(COMMAND_TREE).join(', ')}`);
  const area = COMMAND_TREE[first];
  if (second === undefined) {
    stderr.write(areaHelp(first));
    return 2;
  }
  if (wantsHelp(second)) {
    stdout.write(areaHelp(first));
    return 0;
  }
  if (!Object.hasOwn(area.commands, second)) throw new UsageError(`unknown command "${first} ${second}"; commands: ${Object.keys(area.commands).join(', ')}`);
  const command = area.commands[second];

  let parsed;
  try {
    parsed = parseArgs({
      args: argv.slice(2),
      options: { ...GLOBAL_OPTIONS, ...command.options },
      strict: true,
      allowPositionals: true,
    });
  } catch (err) {
    throw new UsageError(String(err.message).split('\n')[0]);
  }
  const { values, positionals } = parsed;
  if (values.help) {
    stdout.write(commandHelp(command));
    return 0;
  }

  // Everything is validated before the config, the credential or an adapter is touched.
  const { args, target } = command.prepare(values, positionals);
  const destructive = command.isDestructive ? command.isDestructive(positionals) : !!command.destructive;
  const commandName = `${first} ${second}`;

  const config = loadConfig(env);
  const backend = selectBackend(config, values.backend);
  const source = CREDENTIAL_SOURCES[backend.tier];
  const credential = readCredential({ env, ...source });
  secrets.push(credential);

  const audit = {
    backend: backend.name,
    tier: backend.tier,
    command: commandName,
    target,
    reason: args.reason,
    flags: AUDIT_FLAGS.filter((flag) => values[flag]),
  };
  const writeAudit = (extra) => {
    try {
      appendAudit(configDir(env), { ts: d.now(), ...audit, ...extra });
    } catch {
      stderr.write('caddie-admin: warning: the audit log could not be written\n');
    }
  };

  // The mode the operator asked for, so a refused confirmation is audited as a refused run.
  let mode = values['dry-run'] || (destructive && !values.yes) ? 'dry-run' : 'run';
  try {
    mode = await resolveMode({
      destructive,
      target,
      yes: !!values.yes,
      confirm: values.confirm,
      dryRun: !!values['dry-run'],
      isTTY: d.isTTY,
      prompt: d.prompt,
    });
    const adapter = d.createAdapter(backend, { credential, env, spawn: d.spawn, fetch: d.fetch, now: d.now });
    const result = (await adapter[command.method]({ ...args, mode })) ?? {};
    const warnings = Array.isArray(result.warnings) ? result.warnings : [];
    writeAudit({ mode, result: warnings.length ? 'warned' : 'ok', counts: warnings.length ? { ...(result.counts ?? {}), warnings: warnings.length } : result.counts });
    const text = values.json
      ? renderJson({ command: commandName, backend: backend.name, tier: backend.tier, mode, result })
      : renderHuman({ command: commandName, mode, result });
    stdout.write(redact(text));
    // A command that did its work but reports warnings (for example a delete whose best-effort
    // second pass failed) says so on stderr and exits 1, so a script notices.
    for (const warning of warnings) stderr.write(redact(`caddie-admin: warning: ${escapeControls(warning)}\n`));
    return warnings.length ? 1 : 0;
  } catch (error) {
    writeAudit({ mode, result: auditResult(error) });
    throw error;
  }
}
