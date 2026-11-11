// The caddie-admin CLI skeleton (scripts/caddie-admin.mjs and scripts/admin/), driven in-process
// through main() with a stub adapter factory that records every call.
//
// Run with `npm test`. Nothing here reaches the network: the stub replaces the real adapters, whose
// methods only throw in this release, and the one child process started prints help. The config
// directory is a fresh temp dir per test, and the credentials are dummy strings. Every call also
// checks that neither dummy credential appears in stdout, stderr or the audit file.
//
// The tests check that
// - the CLI imports only Node built-ins and repo files, and package.json keeps its one dependency;
// - --json prints exactly one object, human output prints item lines and one summary line;
// - each exit code 0 to 5 is reachable, and every area and command answers -h with usage and 0;
// - a missing or malformed config, an unknown backend, and bad targets exit 2 before any adapter call;
// - a credential file wider than 0600 is refused without echoing the value, and the environment wins;
// - destructive commands preview by default and run only with --yes and the exact target;
// - the audit file is 0600, holds whitelisted keys only, and never holds free text;
// - --reason is an enum, --note never reaches the adapter, moderation hide refuses meets, and
//   adding a conference from a Sessionize URL is refused as deferred.

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { main, COMMAND_TREE } from '../scripts/admin/cli.mjs';
import { AdminError, ConfirmError, NotFoundError, UnsupportedError, UsageError } from '../scripts/admin/errors.mjs';
import { ADAPTER_METHODS } from '../scripts/admin/backends/index.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ES_KEY = 'dummy-es-admin-key-0123456789-abcdefghijklmnopqrstuvwxyz';
const TOKEN = 'dummy-admin-token-0123456789-abcdefghijklmnopqrstuvwxyz';
const NOTE = 'fixture-note-text-that-must-not-travel';
const NAME = 'Fixture Display Name Zed';
const LINE = 'fixture rules test line that must not be logged';
const REF = '0123456789abcdef';
const MEET = 'AbCdEfGhIjKlMnOpQrSt_-';
const SLUG = 'kubecon-na-2026';

let home;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'caddie-admin-cli-'));
  writeConfig({
    default: 't3',
    backends: {
      t3: { tier: 3, es_url: 'https://es.example.test' },
      t2: { tier: 2, api: 'https://api.example.test' },
    },
  });
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

function writeConfig(config) {
  writeFileSync(join(home, 'config.json'), typeof config === 'string' ? config : JSON.stringify(config));
}

function sink() {
  const chunks = [];
  return { write: (s) => { chunks.push(String(s)); return true; }, text: () => chunks.join('') };
}

function auditLines() {
  const file = join(home, 'audit.jsonl');
  return existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean) : [];
}

// Runs main() with a recording stub adapter. `behavior` is a function (method, args) that may
// return a result or throw.
async function invoke(argv, { env = {}, isTTY = false, prompt, behavior, noStub = false } = {}) {
  const calls = [];
  const out = sink();
  const err = sink();
  const createAdapter = (backend, { credential }) => new Proxy({}, {
    get: (_, method) => async (args) => {
      calls.push({ method, args, backend, credential });
      return behavior ? behavior(method, args) : { items: [{ ref: REF, flag: 'ok' }], summary: `${method} done`, counts: { rows: 1 } };
    },
  });
  const code = await main(argv, {
    env: { CADDIE_ADMIN_HOME: home, ELASTISEARCH_API_KEY: ES_KEY, ADMIN_TOKEN: TOKEN, ...env },
    stdout: out,
    stderr: err,
    stdin: { isTTY },
    isTTY,
    prompt,
    now: () => new Date('2026-11-11T10:00:00Z'),
    ...(noStub ? {} : { createAdapter }),
  });
  const stdout = out.text();
  const stderr = err.text();
  const audit = existsSync(join(home, 'audit.jsonl')) ? readFileSync(join(home, 'audit.jsonl'), 'utf8') : '';
  for (const secret of [ES_KEY, TOKEN]) {
    for (const [where, text] of [['stdout', stdout], ['stderr', stderr], ['audit', audit]]) {
      assert.ok(!text.includes(secret), `a credential leaked into ${where}`);
    }
  }
  return { code, stdout, stderr, calls, audit };
}

const throwing = (error) => () => { throw error; };

describe('CLI-1 dependencies and files', () => {
  test('the CLI imports only node built-ins and repo files', () => {
    const files = [join(ROOT, 'scripts/caddie-admin.mjs')];
    const walk = (dir) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (entry.name.endsWith('.mjs')) files.push(path);
      }
    };
    walk(join(ROOT, 'scripts/admin'));
    assert.ok(files.length >= 9);
    const re = /(?:from\s+|import\s*\(\s*|import\s+)['"]([^'"]+)['"]/g;
    for (const file of files) {
      for (const [, spec] of readFileSync(file, 'utf8').matchAll(re)) {
        if (spec.startsWith('node:')) continue;
        assert.ok(spec.startsWith('.'), `${file} imports ${spec}`);
        const target = resolve(dirname(file), spec);
        assert.ok(target.startsWith(ROOT) && existsSync(target), `${file} imports a missing file ${spec}`);
      }
    }
  });

  test('package.json keeps its one dependency and gains the admin script and bin', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
    assert.deepEqual(pkg.dependencies, { 'web-push': '4.0.0' });
    assert.equal(pkg.scripts.admin, 'node scripts/caddie-admin.mjs');
    assert.deepEqual(pkg.bin, { 'caddie-admin': 'scripts/caddie-admin.mjs' });
  });

  test('every adapter method is documented', () => {
    assert.equal(Object.keys(ADAPTER_METHODS).length, 21);
  });
});

describe('CLI-11 entry point', () => {
  test('the entry is executable and prints help as a child process', () => {
    assert.ok((statSync(join(ROOT, 'scripts/caddie-admin.mjs')).mode & 0o100) !== 0);
    const out = execFileSync(process.execPath, [join(ROOT, 'scripts/caddie-admin.mjs'), '-h'], { encoding: 'utf8', env: { PATH: process.env.PATH } });
    assert.match(out, /Usage: caddie-admin/);
  });

  test('a child process exits 2 on an unknown area', () => {
    const r = spawnSync(process.execPath, [join(ROOT, 'scripts/caddie-admin.mjs'), 'nope'], { encoding: 'utf8', env: { PATH: process.env.PATH } });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /unknown area "nope"/);
  });
});

describe('CLI-2 output', () => {
  test('--json prints exactly one object on stdout', async () => {
    const r = await invoke(['attendees', 'view', '--event', SLUG, REF, '--json']);
    assert.equal(r.code, 0);
    assert.equal(r.stdout.trim().split('\n').length, 1);
    const body = JSON.parse(r.stdout);
    assert.deepEqual(Object.keys(body), ['ok', 'command', 'backend', 'tier', 'result']);
    assert.equal(body.ok, true);
    assert.equal(body.command, 'attendees view');
    assert.equal(body.backend, 't3');
    assert.equal(body.tier, 3);
    assert.equal(r.stderr, '');
  });

  test('human output is one line per item and one summary line', async () => {
    const r = await invoke(['stats', 'counts']);
    assert.equal(r.stdout, `ref=${REF} flag=ok\nviewPerson done\n`.replace('viewPerson', 'counts'));
  });

  test('a json error is one object on stderr', async () => {
    const r = await invoke(['stats', 'usage', '--json'], { behavior: throwing(new NotFoundError('gone')) });
    assert.equal(r.stdout, '');
    assert.deepEqual(JSON.parse(r.stderr), { ok: false, error: 'not_found', message: 'gone' });
  });
});

describe('CLI-3 exit codes', () => {
  test('0 on success', async () => {
    assert.equal((await invoke(['stats', 'usage'])).code, 0);
  });
  test('1 on a backend failure, and for the unimplemented real adapter', async () => {
    const r = await invoke(['stats', 'usage'], { behavior: throwing(new AdminError('boom')) });
    assert.equal(r.code, 1);
    const real = await invoke(['stats', 'usage'], { noStub: true });
    assert.equal(real.code, 1);
    assert.match(real.stderr, /not implemented in this release/);
    assert.equal(JSON.parse(real.audit.trim().split('\n').at(-1)).result, 'failed');
  });
  test('2 on usage', async () => {
    assert.equal((await invoke(['stats', 'usage'], { behavior: throwing(new UsageError('x')) })).code, 2);
    assert.equal((await invoke(['stats'])).code, 2);
  });
  test('3 on a missing confirmation', async () => {
    const r = await invoke(['attendees', 'delete', '--event', SLUG, REF, '--yes']);
    assert.equal(r.code, 3);
    assert.equal(JSON.parse(r.audit.trim()).result, 'refused');
  });
  test('4 when not found', async () => {
    const r = await invoke(['attendees', 'view', '--event', SLUG, REF], { behavior: throwing(new NotFoundError('no such attendee')) });
    assert.equal(r.code, 4);
    assert.equal(JSON.parse(r.audit.trim()).result, 'not_found');
  });
  test('5 when the tier cannot serve it', async () => {
    const r = await invoke(['moderation', 'purge-expired', '--backend', 't2'], { behavior: throwing(new UnsupportedError('tier 2 has a cron')) });
    assert.equal(r.code, 5);
    assert.equal(JSON.parse(r.audit.trim()).result, 'unsupported');
  });
  test('a plain Error maps to 1', async () => {
    assert.equal((await invoke(['stats', 'usage'], { behavior: throwing(new Error('weird')) })).code, 1);
  });
});

describe('CLI-4 help and unknown flags', () => {
  test('-h and --help at every level exit 0 and print usage', async () => {
    const root = await invoke(['-h']);
    assert.equal(root.code, 0);
    assert.match(root.stdout, /Usage: caddie-admin/);
    for (const [area, def] of Object.entries(COMMAND_TREE)) {
      const a = await invoke([area, '--help']);
      assert.equal(a.code, 0);
      assert.match(a.stdout, new RegExp(`Usage: caddie-admin ${area}`));
      for (const command of Object.keys(def.commands)) {
        for (const flag of ['-h', '--help']) {
          const c = await invoke([area, command, flag]);
          assert.equal(c.code, 0, `${area} ${command} ${flag}`);
          assert.match(c.stdout, new RegExp(`Usage: caddie-admin ${area} ${command}`));
          assert.equal(c.calls.length, 0);
        }
      }
    }
  });

  test('the tree has the designed commands', () => {
    const names = Object.entries(COMMAND_TREE).flatMap(([a, d]) => Object.keys(d.commands).map((c) => `${a} ${c}`));
    assert.deepEqual(names, [
      'attendees search', 'attendees view', 'attendees delete', 'attendees block', 'attendees unblock',
      'moderation queue', 'moderation hide', 'moderation unhide', 'moderation delete', 'moderation purge-reports',
      'moderation purge-expired', 'moderation rules',
      'conferences list', 'conferences add', 'conferences refresh', 'conferences hide', 'conferences unhide',
      'conferences remove', 'conferences unretire',
      'stats counts', 'stats usage', 'stats health',
    ]);
  });

  test('an unknown flag exits 2 and is named', async () => {
    const r = await invoke(['stats', 'usage', '--bogus']);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /--bogus/);
    assert.equal(r.calls.length, 0);
  });

  test('a flag of another command is unknown here', async () => {
    const r = await invoke(['stats', 'usage', '--allow-shrink']);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /--allow-shrink/);
  });
});

describe('CLI-5 config', () => {
  test('a missing config exits 2 naming the path and the shape', async () => {
    rmSync(join(home, 'config.json'));
    const r = await invoke(['stats', 'usage']);
    assert.equal(r.code, 2);
    assert.ok(r.stderr.includes(join(home, 'config.json')));
    assert.match(r.stderr, /"backends"/);
    assert.equal(r.calls.length, 0);
  });
  test('a malformed config exits 2', async () => {
    for (const bad of ['{ not json', '[]', '{"backends":{}}', '{"backends":{"x":{"tier":4}}}', '{"backends":{"x":{"tier":2}}}']) {
      writeConfig(bad);
      assert.equal((await invoke(['stats', 'usage'])).code, 2, bad);
    }
  });
  test('an unknown --backend exits 2', async () => {
    const r = await invoke(['stats', 'usage', '--backend', 'nope']);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /unknown backend "nope"/);
  });
  test('--backend picks the entry and its tier, and each tier gets its own credential', async () => {
    const t2 = await invoke(['stats', 'usage', '--backend', 't2']);
    assert.equal(t2.calls[0].backend.tier, 2);
    assert.equal(t2.calls[0].credential, TOKEN);
    const t3 = await invoke(['stats', 'usage']);
    assert.equal(t3.calls[0].backend.name, 't3');
    assert.equal(t3.calls[0].credential, ES_KEY);
  });
  test('no default and no --backend exits 2', async () => {
    writeConfig({ backends: { a: { tier: 3, es_url: 'https://es.example.test' } } });
    assert.equal((await invoke(['stats', 'usage'])).code, 2);
  });
});

describe('CLI-6 target syntax', () => {
  const bad = [
    ['attendees', 'view', '--event', SLUG, 'XYZ'],
    ['attendees', 'view', '--event', SLUG, '0123456789ABCDEF'],
    ['attendees', 'delete', '--event', SLUG, 'short'],
    ['attendees', 'search', '--event', SLUG, '--ref', '123'],
    ['moderation', 'delete', '--event', SLUG, 'meet:tooshort'],
    ['moderation', 'delete', '--event', SLUG, 'profile:AbCdEfGhIjKlMnOpQrSt_-'],
    ['moderation', 'unhide', '--event', SLUG, 'event:0123456789abcdef'],
    ['moderation', 'unhide', '--event', SLUG, REF],
    ['conferences', 'refresh', '--event', 'Bad Slug'],
    ['conferences', 'remove', '--event', '-lead'],
    ['conferences', 'remove', '--event', 'a'.repeat(121)],
    ['attendees', 'view', '--event', SLUG],
    ['attendees', 'view', '--event', SLUG, REF, 'extra'],
    ['attendees', 'view', REF],
  ];
  for (const argv of bad) {
    test(`rejects ${argv.slice(0, 2).join(' ')} ${argv.slice(-1)[0].slice(0, 30)}`, async () => {
      const r = await invoke(argv);
      assert.equal(r.code, 2);
      assert.equal(r.calls.length, 0);
      assert.equal(r.audit, '');
    });
  }
  test('valid targets reach the adapter', async () => {
    assert.equal((await invoke(['attendees', 'view', '--event', SLUG, REF])).calls.length, 1);
    const meet = await invoke(['moderation', 'delete', '--event', SLUG, `meet:${MEET}`]);
    assert.equal(meet.calls[0].args.kind, 'meet');
    assert.equal(meet.calls[0].args.id, MEET);
  });
  test('attendees search needs exactly one of --name and --ref', async () => {
    assert.equal((await invoke(['attendees', 'search', '--event', SLUG])).code, 2);
    assert.equal((await invoke(['attendees', 'search', '--event', SLUG, '--name', 'a', '--ref', REF])).code, 2);
    const ok = await invoke(['attendees', 'search', '--event', SLUG, '--name', NAME, '--limit', '10', '--include-hidden']);
    assert.equal(ok.code, 0);
    assert.deepEqual(ok.calls[0].args.options, { limit: 10, includeHidden: true });
    assert.equal(ok.calls[0].args.name, NAME);
    assert.equal((await invoke(['attendees', 'search', '--event', SLUG, '--ref', REF, '--limit', '0'])).code, 2);
  });
});

describe('SEC-2 credentials', () => {
  const noEnvKey = { ELASTISEARCH_API_KEY: '', ES_ADMIN_KEY_FILE: undefined };

  function keyFile(mode, content) {
    const file = join(home, 'es-admin-key');
    writeFileSync(file, content);
    chmodSync(file, mode);
    return file;
  }

  test('a 0644 file is refused naming the file and the mode, not the value', async () => {
    const file = keyFile(0o644, ES_KEY);
    const r = await invoke(['stats', 'usage'], { env: { ...noEnvKey, ES_ADMIN_KEY_FILE: file } });
    assert.equal(r.code, 1);
    assert.ok(r.stderr.includes(file));
    assert.ok(r.stderr.includes('0644'));
    assert.equal(r.calls.length, 0);
  });

  test('a 0640 and a 0700 file are refused too', async () => {
    for (const mode of [0o640, 0o700]) {
      const file = keyFile(mode, ES_KEY);
      assert.equal((await invoke(['stats', 'usage'], { env: { ...noEnvKey, ES_ADMIN_KEY_FILE: file } })).code, 1);
    }
  });

  test('a 0600 file works and its value is trimmed', async () => {
    const file = keyFile(0o600, `  ${ES_KEY}\n`);
    const r = await invoke(['stats', 'usage'], { env: { ...noEnvKey, ES_ADMIN_KEY_FILE: file } });
    assert.equal(r.code, 0);
    assert.equal(r.calls[0].credential, ES_KEY);
  });

  test('the default file name under the config dir is used', async () => {
    keyFile(0o600, ES_KEY);
    const r = await invoke(['stats', 'usage'], { env: noEnvKey });
    assert.equal(r.calls[0].credential, ES_KEY);
  });

  test('the environment variable wins over the file, and is trimmed', async () => {
    const file = keyFile(0o644, 'a-different-value-in-a-file-that-is-too-open');
    const r = await invoke(['stats', 'usage'], { env: { ES_ADMIN_KEY_FILE: file, ELASTISEARCH_API_KEY: `\n${ES_KEY} ` } });
    assert.equal(r.code, 0);
    assert.equal(r.calls[0].credential, ES_KEY);
  });

  test('an empty file and a missing credential exit 1', async () => {
    const file = keyFile(0o600, ' \n');
    assert.equal((await invoke(['stats', 'usage'], { env: { ...noEnvKey, ES_ADMIN_KEY_FILE: file } })).code, 1);
    rmSync(file);
    const missing = await invoke(['stats', 'usage'], { env: noEnvKey });
    assert.equal(missing.code, 1);
    assert.match(missing.stderr, /ELASTISEARCH_API_KEY/);
  });

  test('tier 2 reads ADMIN_TOKEN_FILE with the same checks', async () => {
    const file = join(home, 'admin-token');
    writeFileSync(file, TOKEN);
    chmodSync(file, 0o644);
    const bad = await invoke(['stats', 'usage', '--backend', 't2'], { env: { ADMIN_TOKEN: '', ADMIN_TOKEN_FILE: file } });
    assert.equal(bad.code, 1);
    assert.ok(bad.stderr.includes('0644'));
    chmodSync(file, 0o600);
    const good = await invoke(['stats', 'usage', '--backend', 't2'], { env: { ADMIN_TOKEN: '', ADMIN_TOKEN_FILE: file } });
    assert.equal(good.calls[0].credential, TOKEN);
  });

  test('a credential inside a backend error message is redacted', async () => {
    const r = await invoke(['stats', 'usage'], { behavior: throwing(new AdminError(`request to https://es.example.test failed with key ${ES_KEY}`)) });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /\[REDACTED\]/);
  });

  test('a credential inside a result is redacted', async () => {
    const r = await invoke(['stats', 'usage', '--json'], { behavior: () => ({ summary: `leak ${ES_KEY}` }) });
    assert.match(r.stdout, /\[REDACTED\]/);
  });
});

describe('SEC-11 confirmation', () => {
  const cases = [
    { name: 'attendees delete', argv: ['attendees', 'delete', '--event', SLUG, REF], target: REF, method: 'deletePerson' },
    { name: 'attendees block', argv: ['attendees', 'block', '--event', SLUG, REF, '--reason', 'spam'], target: REF, method: 'setOperatorBlock' },
    { name: 'moderation delete', argv: ['moderation', 'delete', '--event', SLUG, `meet:${MEET}`], target: `meet:${MEET}`, method: 'deleteTarget' },
    { name: 'conferences hide', argv: ['conferences', 'hide', '--event', SLUG], target: SLUG, method: 'hideConference' },
    { name: 'conferences remove', argv: ['conferences', 'remove', '--event', SLUG], target: SLUG, method: 'removeConference' },
    { name: 'conferences unretire', argv: ['conferences', 'unretire', '--event', SLUG], target: SLUG, method: 'unretireConference' },
  ];
  for (const c of cases) {
    describe(c.name, () => {
      test('no --yes is a dry-run', async () => {
        const r = await invoke(c.argv);
        assert.equal(r.code, 0);
        assert.equal(r.calls.length, 1);
        assert.equal(r.calls[0].method, c.method);
        assert.equal(r.calls[0].args.mode, 'dry-run');
        assert.match(r.stdout, /dry-run/);
      });
      test('--dry-run wins over --yes and --confirm', async () => {
        const r = await invoke([...c.argv, '--yes', '--confirm', c.target, '--dry-run']);
        assert.equal(r.calls[0].args.mode, 'dry-run');
      });
      test('a wrong --confirm exits 3 with no run call', async () => {
        const r = await invoke([...c.argv, '--yes', '--confirm', 'wrong']);
        assert.equal(r.code, 3);
        assert.ok(!r.calls.some((call) => call.args.mode === 'run'));
        assert.equal(r.calls.length, 0);
      });
      test('--yes with the exact --confirm runs', async () => {
        const r = await invoke([...c.argv, '--yes', '--confirm', c.target]);
        assert.equal(r.code, 0);
        assert.equal(r.calls[0].args.mode, 'run');
      });
      test('--yes off a terminal without --confirm exits 3 naming --confirm', async () => {
        const r = await invoke([...c.argv, '--yes']);
        assert.equal(r.code, 3);
        assert.match(r.stderr, /--confirm/);
        assert.equal(r.calls.length, 0);
      });
      test('--yes on a terminal runs when the typed line is the target', async () => {
        const questions = [];
        const r = await invoke([...c.argv, '--yes'], { isTTY: true, prompt: async (q) => { questions.push(q); return c.target; } });
        assert.equal(r.code, 0);
        assert.equal(r.calls[0].args.mode, 'run');
        assert.equal(questions[0], `Type the target (${c.target}) to confirm, or anything else to abort: `);
      });
      test('--yes on a terminal aborts when the typed line differs', async () => {
        const r = await invoke([...c.argv, '--yes'], { isTTY: true, prompt: async () => 'nope' });
        assert.equal(r.code, 3);
        assert.equal(r.calls.length, 0);
      });
    });
  }

  test('non-destructive commands run without --yes', async () => {
    const r = await invoke(['conferences', 'refresh', '--event', SLUG, '--allow-shrink']);
    assert.equal(r.calls[0].args.mode, 'run');
    assert.deepEqual(r.calls[0].args.options, { allowShrink: true });
  });

  test('only moderation rules reload is destructive', async () => {
    const test_ = await invoke(['moderation', 'rules', 'test', LINE]);
    assert.equal(test_.calls[0].args.mode, 'run');
    assert.equal(test_.calls[0].args.line, LINE);
    const reload = await invoke(['moderation', 'rules', 'reload']);
    assert.equal(reload.calls[0].args.mode, 'dry-run');
    const confirmed = await invoke(['moderation', 'rules', 'reload', '--yes', '--confirm', 'reload']);
    assert.equal(confirmed.calls[0].args.mode, 'run');
  });
});

describe('SEC-12 audit log', () => {
  const ALLOWED = new Set(['ts', 'backend', 'tier', 'command', 'target', 'reason', 'mode', 'result', 'counts', 'flags']);

  test('one whitelisted line per run, file mode 0600, no free text', async () => {
    await invoke(['attendees', 'search', '--event', SLUG, '--name', NAME]);
    await invoke(['moderation', 'rules', 'test', LINE]);
    await invoke(['attendees', 'view', '--event', SLUG, REF, '--text', '--contact']);
    const r = await invoke(['attendees', 'block', '--event', SLUG, REF, '--reason', 'harassment', '--note', NOTE, '--yes', '--confirm', REF]);
    assert.equal(r.code, 0);
    const lines = auditLines();
    assert.equal(lines.length, 4);
    assert.equal(statSync(join(home, 'audit.jsonl')).mode & 0o777, 0o600);
    for (const line of lines) {
      const entry = JSON.parse(line);
      for (const key of Object.keys(entry)) assert.ok(ALLOWED.has(key), key);
    }
    const last = JSON.parse(lines[3]);
    assert.deepEqual(last, {
      ts: '2026-11-11T10:00:00.000Z', backend: 't3', tier: 3, command: 'attendees block', target: REF,
      reason: 'harassment', mode: 'run', result: 'ok', counts: { rows: 1 }, flags: [],
    });
    assert.deepEqual(JSON.parse(lines[2]).flags, ['text', 'contact']);
    const text = lines.join('\n');
    for (const secret of [NOTE, NAME, LINE, ES_KEY, TOKEN, 'example.test']) assert.ok(!text.includes(secret), secret);
  });

  test('a wider existing audit file is narrowed to 0600', async () => {
    const file = join(home, 'audit.jsonl');
    writeFileSync(file, '');
    chmodSync(file, 0o644);
    await invoke(['stats', 'usage']);
    assert.equal(statSync(file).mode & 0o777, 0o600);
  });

  test('a missing config dir is created with mode 0700', async () => {
    const sub = mkdtempSync(join(tmpdir(), 'caddie-admin-cli-sub-'));
    try {
      const { appendAudit } = await import('../scripts/admin/audit.mjs');
      appendAudit(join(sub, 'a', 'b'), { command: 'stats usage' });
      assert.equal(statSync(join(sub, 'a', 'b')).mode & 0o777, 0o700);
    } finally {
      rmSync(sub, { recursive: true, force: true });
    }
  });

  test('appendAudit drops unknown keys and free text', async () => {
    const { appendAudit } = await import('../scripts/admin/audit.mjs');
    appendAudit(home, {
      ts: new Date('2026-11-11T10:00:00Z'), backend: 'ok name', tier: 9, command: 'stats usage', note: NOTE, name: NAME,
      target: NAME, reason: NOTE, mode: 'dry-run', result: 'ok', counts: { rows: 2, bad: NAME, 'bad key': 1, frac: 1.5 },
      flags: ['text', NOTE, 'all'], url: 'https://x.example.test/?k=v',
    });
    const entry = JSON.parse(auditLines().at(-1));
    assert.deepEqual(entry, { ts: '2026-11-11T10:00:00.000Z', command: 'stats usage', mode: 'dry-run', result: 'ok', counts: { rows: 2 }, flags: ['text', 'all'] });
  });

  test('failures are audited too, with the failure result', async () => {
    await invoke(['stats', 'usage'], { behavior: throwing(new AdminError(NOTE)) });
    const entry = JSON.parse(auditLines()[0]);
    assert.equal(entry.result, 'failed');
    assert.ok(!auditLines()[0].includes(NOTE));
  });
});

describe('ATT-11, MOD-7, CONF-10 and --note', () => {
  test('--reason outside the enum exits 2, every enum member passes', async () => {
    const bad = await invoke(['attendees', 'block', '--event', SLUG, REF, '--reason', 'bogus']);
    assert.equal(bad.code, 2);
    assert.equal(bad.calls.length, 0);
    for (const reason of ['spam', 'harassment', 'impersonation', 'off-topic', 'other']) {
      const ok = await invoke(['attendees', 'block', '--event', SLUG, REF, '--reason', reason]);
      assert.equal(ok.calls[0].args.reason, reason);
    }
  });

  test('block needs --reason, delete does not', async () => {
    assert.equal((await invoke(['attendees', 'block', '--event', SLUG, REF])).code, 2);
    assert.equal((await invoke(['attendees', 'delete', '--event', SLUG, REF])).code, 0);
  });

  test('moderation hide refuses a meet and names moderation delete', async () => {
    const r = await invoke(['moderation', 'hide', '--event', SLUG, `meet:${MEET}`, '--reason', 'spam']);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /moderation delete/);
    assert.equal(r.calls.length, 0);
    const ok = await invoke(['moderation', 'hide', '--event', SLUG, `spot:${REF}`, '--reason', 'spam']);
    assert.equal(ok.calls[0].args.kind, 'spot');
  });

  test('conferences add refuses Sessionize, naming task E1', async () => {
    const flag = await invoke(['conferences', 'add', '--event', SLUG, '--sessionize', 'https://sessionize.com/x']);
    assert.equal(flag.code, 2);
    assert.match(flag.stderr, /E1/);
    const url = await invoke(['conferences', 'add', '--event', 'https://sessionize.com/x']);
    assert.equal(url.code, 2);
    assert.match(url.stderr, /E1/);
    assert.equal(flag.calls.length + url.calls.length, 0);
    assert.equal((await invoke(['conferences', 'add', '--event', SLUG])).calls[0].method, 'addConference');
  });

  test('--note is accepted where --reason is and never reaches the adapter or any output', async () => {
    const withReason = [
      ['attendees', 'delete', '--event', SLUG, REF],
      ['attendees', 'block', '--event', SLUG, REF, '--reason', 'spam'],
      ['moderation', 'hide', '--event', SLUG, `profile:${REF}`, '--reason', 'spam'],
      ['moderation', 'delete', '--event', SLUG, `meet:${MEET}`],
      ['conferences', 'hide', '--event', SLUG],
      ['conferences', 'remove', '--event', SLUG, '--purge-local'],
    ];
    for (const argv of withReason) {
      const r = await invoke([...argv, '--note', NOTE, '--json']);
      assert.equal(r.code, 0, argv.join(' '));
      assert.ok(!JSON.stringify(r.calls[0].args).includes(NOTE));
      assert.ok(!r.stdout.includes(NOTE) && !r.stderr.includes(NOTE) && !r.audit.includes(NOTE));
    }
  });

  test('--note is unknown where --reason is not', async () => {
    assert.equal((await invoke(['stats', 'usage', '--note', 'x'])).code, 2);
  });

  test('conferences unretire and the purge-local flag reach the adapter as options', async () => {
    const remove = await invoke(['conferences', 'remove', '--event', SLUG, '--purge-local']);
    assert.deepEqual(remove.calls[0].args.options, { purgeLocal: true });
    const unretire = await invoke(['conferences', 'unretire', '--event', SLUG]);
    assert.equal(unretire.calls[0].method, 'unretireConference');
    assert.equal(unretire.calls[0].args.slug, SLUG);
  });
});

describe('round-1 fixes', () => {
  test('a non-AdminError with an integer exitCode keeps it (the signer\'s UsageError is 2)', async () => {
    const usage = Object.assign(new Error('The admin query string may hold only letters'), { exitCode: 2, code: 'query_charset' });
    let r = await invoke(['stats', 'usage', '--json'], { behavior: throwing(usage) });
    assert.equal(r.code, 2);
    assert.deepEqual(JSON.parse(r.stderr), { ok: false, error: 'usage', message: 'The admin query string may hold only letters' });
    r = await invoke(['stats', 'usage'], { behavior: throwing(Object.assign(new Error('x'), { exitCode: 5 })) });
    assert.equal(r.code, 5);
    for (const bad of [Object.assign(new Error('x'), { exitCode: 2.5 }), Object.assign(new Error('x'), { exitCode: '2' }), new Error('x')]) {
      r = await invoke(['stats', 'usage'], { behavior: throwing(bad) });
      assert.equal(r.code, 1);
    }
  });

  test('on Windows a credential file is refused and the environment variable is the only source', async () => {
    const original = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    try {
      const file = join(home, 'es-admin-key');
      writeFileSync(file, ES_KEY, { mode: 0o600 });
      let r = await invoke(['stats', 'usage'], { env: { ELASTISEARCH_API_KEY: '' } });
      assert.equal(r.code, 1);
      assert.ok(r.stderr.includes('use the environment variable on Windows'), r.stderr);
      assert.ok(r.stderr.includes('ELASTISEARCH_API_KEY'));
      assert.equal(r.calls.length, 0);
      r = await invoke(['stats', 'usage']);
      assert.equal(r.code, 0);
      assert.equal(r.calls[0].credential, ES_KEY);
    } finally {
      Object.defineProperty(process, 'platform', original);
    }
  });

  test('SEC-13: a tier 2 api url must be https, or http to this machine only', async () => {
    for (const api of ['http://api.example.test', 'http://10.0.0.5:8787', 'ftp://localhost']) {
      writeConfig({ default: 't2', backends: { t2: { tier: 2, api } } });
      const r = await invoke(['stats', 'usage']);
      assert.equal(r.code, 2, api);
      assert.ok(r.stderr.includes('https api url (http only for localhost)'), r.stderr);
      assert.equal(r.calls.length, 0);
    }
    for (const api of ['http://localhost:8787', 'http://127.0.0.1:8787', 'http://[::1]:8787', 'https://api.example.test']) {
      writeConfig({ default: 't2', backends: { t2: { tier: 2, api } } });
      const r = await invoke(['stats', 'usage']);
      assert.equal(r.code, 0, api);
    }
  });

  test('a refused confirmation is audited as the run the operator asked for', async () => {
    let r = await invoke(['attendees', 'delete', '--event', SLUG, REF, '--yes', '--confirm', 'wrong']);
    assert.equal(r.code, 3);
    assert.deepEqual(JSON.parse(r.audit.trim()), { ts: '2026-11-11T10:00:00.000Z', backend: 't3', tier: 3, command: 'attendees delete', target: REF, mode: 'run', result: 'refused', flags: [] });
    rmSync(join(home, 'audit.jsonl'));
    r = await invoke(['attendees', 'delete', '--event', SLUG, REF, '--yes']);
    assert.equal(r.code, 3);
    assert.equal(JSON.parse(r.audit.trim()).mode, 'run');
    rmSync(join(home, 'audit.jsonl'));
    // Without --yes the preview is what was asked for, and a failure in it is audited as a dry-run.
    r = await invoke(['attendees', 'delete', '--event', SLUG, REF], { behavior: throwing(new AdminError('boom')) });
    assert.equal(r.code, 1);
    assert.equal(JSON.parse(r.audit.trim()).mode, 'dry-run');
  });

  test('--confirm works on a terminal too, without a prompt', async () => {
    let prompted = false;
    const r = await invoke(['attendees', 'delete', '--event', SLUG, REF, '--yes', '--confirm', REF], { isTTY: true, prompt: async () => { prompted = true; return REF; } });
    assert.equal(r.code, 0);
    assert.equal(prompted, false);
    assert.equal(r.calls[0].args.mode, 'run');
  });
});
