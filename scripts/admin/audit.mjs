// Append-only audit log of the caddie-admin CLI: one JSON object per line in <dir>/audit.jsonl.
//
// Only whitelisted keys are written, and a string is kept only when it has the shape of its key
// (an enum member, an id, a slug, a failure's short code). Free text cannot reach the file: --note, the --name search text,
// the rules test line, display names, profile text, contact fields, keys, tokens and URLs all
// fail those shapes or have no key at all.

import { chmodSync, closeSync, fstatSync, mkdirSync, openSync, writeSync } from 'node:fs';
import { join } from 'node:path';

const REASONS = ['spam', 'harassment', 'impersonation', 'off-topic', 'other'];
const MODES = ['dry-run', 'run'];
// 'warned': the command did its work but reported warnings (counts.warnings says how many).
const RESULTS = ['ok', 'warned', 'failed', 'not_found', 'unsupported', 'refused'];
const FLAGS = ['text', 'contact', 'include-hidden', 'show-content', 'all', 'allow-shrink', 'purge-local'];
const BACKEND_RE = /^[A-Za-z0-9_.-]{1,40}$/;
const COMMAND_RE = /^[a-z-]{1,30} [a-z-]{1,30}$/;
const REF_RE = /^[0-9a-f]{16}$/;
const MEET_ID_RE = /^[A-Za-z0-9_-]{22}$/;
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,119}$/;
const KIND_ID_RE = /^(profile|spot|meet):([0-9a-f]{16}|[A-Za-z0-9_-]{22})$/;
const COUNT_KEY_RE = /^[A-Za-z0-9_]{1,40}$/;
// The short code of a failure (the `error` of a --json error object), a token such as
// removal_superseded; never a message.
const ERROR_CODE_RE = /^[a-z][a-z0-9_]{0,39}$/;

export function sanitizeAudit(entry) {
  const out = {};
  const e = entry ?? {};
  if (e.ts instanceof Date && !Number.isNaN(e.ts.getTime())) out.ts = e.ts.toISOString();
  else if (typeof e.ts === 'string' && !Number.isNaN(Date.parse(e.ts)) && /^\d{4}-\d\d-\d\dT[\d:.]+Z$/.test(e.ts)) out.ts = e.ts;
  if (typeof e.backend === 'string' && BACKEND_RE.test(e.backend)) out.backend = e.backend;
  if (e.tier === 2 || e.tier === 3) out.tier = e.tier;
  if (typeof e.command === 'string' && COMMAND_RE.test(e.command)) out.command = e.command;
  if (typeof e.target === 'string' && (REF_RE.test(e.target) || MEET_ID_RE.test(e.target) || SLUG_RE.test(e.target) || KIND_ID_RE.test(e.target))) {
    out.target = e.target;
  }
  if (REASONS.includes(e.reason)) out.reason = e.reason;
  if (MODES.includes(e.mode)) out.mode = e.mode;
  if (RESULTS.includes(e.result)) out.result = e.result;
  if (out.result && out.result !== 'ok' && out.result !== 'warned' && typeof e.error === 'string' && ERROR_CODE_RE.test(e.error)) out.error = e.error;
  if (e.counts && typeof e.counts === 'object' && !Array.isArray(e.counts)) {
    const counts = {};
    for (const [key, value] of Object.entries(e.counts)) {
      if (COUNT_KEY_RE.test(key) && Number.isInteger(value)) counts[key] = value;
    }
    out.counts = counts;
  }
  if (Array.isArray(e.flags)) out.flags = FLAGS.filter((flag) => e.flags.includes(flag));
  return out;
}

export function appendAudit(dir, entry) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, 'audit.jsonl');
  const fd = openSync(file, 'a', 0o600);
  try {
    if ((fstatSync(fd).mode & 0o177) !== 0) chmodSync(file, 0o600);
    writeSync(fd, `${JSON.stringify(sanitizeAudit(entry))}\n`);
  } finally {
    closeSync(fd);
  }
  return file;
}
