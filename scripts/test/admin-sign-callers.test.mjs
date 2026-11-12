// Since step e of DECISIONS.md, "Admin signature v2", every client signs v2. The signer still signs
// v1 when it is asked for `version: 1`, and its default is a constant that a later change could
// flip, so each client names the version itself. This test reads the source of scripts/,
// worker/ingest/ and worker/scripts/ as text and checks that every call of signAdminRequest( there
// passes a literal `version: 2` in the same call expression: not 1, not a value read from a
// variable, not an expression such as `2 - 1`, not a spread object that could carry one, and not
// the signer's default. Test files and the signer's own definition in scripts/lib/admin-sign.mjs
// are not calls of a client. So that no call can hide from this scan, every other occurrence of
// the name signAdminRequest outside comments and import specifiers must be followed by an opening
// parenthesis: an alias (`const sign = signAdminRequest`), a destructuring rename, or a use of
// `.call`, `.apply` or `.bind` fails.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DIRS = ['scripts', 'worker/ingest', 'worker/scripts'];
const NAME = 'signAdminRequest';

// The source files under `dir`, as paths relative to the repository root, without test files,
// test directories and node_modules.
function sources(dir) {
  const out = [];
  for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules' && entry.name !== 'test') out.push(...sources(rel));
    } else if (/\.(?:mjs|cjs|js)$/.test(entry.name) && !/\.test\.(?:mjs|cjs|js)$/.test(entry.name)) {
      out.push(rel);
    }
  }
  return out;
}

// The text from the opening parenthesis at `open` to its matching closing parenthesis. Quoted
// strings and template literals are skipped, so a parenthesis inside one is not counted.
function callText(text, open) {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (c === '"' || c === "'" || c === '`') {
      for (i++; i < text.length && text[i] !== c; i++) if (text[i] === '\\') i++;
      continue;
    }
    if (c === '(') depth++;
    else if (c === ')' && --depth === 0) return text.slice(open, i + 1);
  }
  throw new Error(`no closing parenthesis after offset ${open}`);
}

// `text` with every comment replaced by spaces, so offsets and line numbers stay the same. Quoted
// strings and template literals are kept as they are, so a comment marker inside one does not start
// a comment, and a slash after an operator or an opening bracket starts a regular expression
// literal, which is kept too.
function stripComments(text) {
  let out = '';
  let prev = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const next = text[i + 1];
    if (c === '/' && next === '/') {
      while (i < text.length && text[i] !== '\n') out += ' ', i++;
      if (i < text.length) out += '\n';
      continue;
    }
    if (c === '/' && next === '*') {
      const end = text.indexOf('*/', i + 2);
      const stop = end < 0 ? text.length : end + 2;
      out += text.slice(i, stop).replace(/[^\n]/g, ' ');
      i = stop - 1;
      continue;
    }
    const start = i;
    if (c === '"' || c === "'" || c === '`') {
      for (i++; i < text.length && text[i] !== c; i++) if (text[i] === '\\') i++;
    } else if (c === '/' && (prev === '' || /[(,=:[!&|?{};+\-*%<>~^]/.test(prev))) {
      let inClass = false;
      for (i++; i < text.length && text[i] !== '\n'; i++) {
        if (text[i] === '\\') i++;
        else if (text[i] === '[') inClass = true;
        else if (text[i] === ']') inClass = false;
        else if (text[i] === '/' && !inClass) break;
      }
    }
    out += text.slice(start, i + 1);
    if (!/\s/.test(text[i] ?? '')) prev = text[i];
  }
  return out;
}

const read = (file) => stripComments(fs.readFileSync(path.join(ROOT, file), 'utf8'));

// Every call of signAdminRequest( outside comments and the definition, as { file, line, call }.
function calls(files) {
  const out = [];
  for (const file of files) {
    const text = read(file);
    for (const m of text.matchAll(new RegExp(`\\b${NAME}\\s*\\(`, 'g'))) {
      const lineStart = text.lastIndexOf('\n', m.index) + 1;
      const before = text.slice(lineStart, m.index);
      if (file === 'scripts/lib/admin-sign.mjs' && /\bfunction\s+$/.test(before)) continue;
      const line = text.slice(0, m.index).split('\n').length;
      out.push({ file, line, call: callText(text, m.index + m[0].length - 1) });
    }
  }
  return out;
}

const FILES = DIRS.flatMap(sources);

test('the scan finds the signer and the known clients', () => {
  assert.ok(FILES.includes('scripts/lib/admin-sign.mjs'), 'the signer is scanned');
  const files = new Set(calls(FILES).map((c) => c.file));
  for (const file of ['scripts/smoke.mjs', 'scripts/admin/backends/worker.mjs', 'worker/ingest/lib.mjs']) {
    assert.ok(files.has(file), `no call of ${NAME}( found in ${file}`);
  }
});

test('every client call of signAdminRequest( passes a literal version: 2', () => {
  const problems = [];
  for (const { file, line, call } of calls(FILES)) {
    const where = `${file}:${line}`;
    const versions = [...call.matchAll(/\bversion\b/g)].length;
    if (versions !== 1) problems.push(`${where}: names version ${versions} times, not once`);
    else if (!/\bversion\s*:\s*2\s*[,}]/.test(call)) problems.push(`${where}: does not pass the literal version: 2`);
    if (call.includes('...')) problems.push(`${where}: passes a spread object, which could carry another version`);
  }
  assert.deepEqual(problems, []);
});

test('no client renames signAdminRequest on import, which would hide its calls from this scan', () => {
  const problems = [];
  for (const file of FILES) {
    const text = read(file);
    if (new RegExp(`\\b${NAME}\\s+as\\b`).test(text)) problems.push(file);
  }
  assert.deepEqual(problems, []);
});

test('outside comments and import specifiers, the name signAdminRequest is always followed by an opening parenthesis', () => {
  const problems = [];
  for (const file of FILES) {
    // Import specifiers are blanked out: `import { a, signAdminRequest } from '...'`, on one line
    // or several. A renamed import fails the test above.
    const text = read(file).replace(/\bimport\s*\{[^}]*\}\s*from\s*(['"])[^'"\n]*\1/g, (m) => m.replace(/[^\n]/g, ' '));
    for (const m of text.matchAll(new RegExp(`\\b${NAME}\\b(?!\\s*\\()`, 'g'))) {
      const line = text.slice(0, m.index).split('\n').length;
      problems.push(`${file}:${line}: ${text.slice(text.lastIndexOf('\n', m.index) + 1, text.indexOf('\n', m.index)).trim()}`);
    }
  }
  assert.deepEqual(problems, []);
});
