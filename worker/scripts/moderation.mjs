#!/usr/bin/env node
// Operator CLI for reports on the free stack: what is hidden, what was reported, and undoing or
// confirming a hide. It is the Worker counterpart of scripts/moderation.mjs (the Elasticsearch
// version) and talks only to the Worker's GET and POST /admin/moderation routes.
//
// Usage: node worker/scripts/moderation.mjs --event <slug> [--api <base>] [--show-content] <one action>
//   --hidden                lists hidden profiles, spots and meets with their report counts
//   --since <iso>           lists the reports made since that instant
//   --unhide <kind>:<id>    clears the hidden flag of one target and removes its reports, so it
//                           needs two fresh reports to be hidden again
//   --delete <kind>:<id>    removes the target: a profile (everywhere, as a profile delete does),
//                           a meet, or the spot line of a profile
//   --purge                 deletes the conference's reports once the conference has ended
//   --show-content          also prints display names and report reasons; without it the output
//                           holds refs, meet ids, kinds, times and counts only
//   <kind> is profile, spot or meet; <id> is the person's ref (16 hex characters) for a profile or
//   a spot and the meet id (22 characters) for a meet, as --hidden and --since print them.
//
// Env: CADDIE_API_BASE (the Worker URL, when --api is not given); ADMIN_TOKEN, or ADMIN_TOKEN_FILE
//      (default ~/.config/conference-caddie/admin-token, written by setup-secrets.mjs).
//
// The admin token is sent only in the Authorization header and is never printed. The Worker never
// returns profile ids or reporter ids from these routes, and this script prints neither.

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,119}$/;
const REF_RE = /^[0-9a-f]{16}$/;
const MEET_ID_RE = /^[A-Za-z0-9_-]{22}$/;
const KINDS = ['profile', 'spot', 'meet'];
const USAGE = 'Usage: node worker/scripts/moderation.mjs --event <slug> [--api <base>] [--show-content] (--hidden | --since <iso> | --unhide <kind>:<id> | --delete <kind>:<id> | --purge)';

function usage(message, code = 2) {
  if (message) console.error(message);
  (code === 0 ? console.log : console.error)(USAGE);
  if (code === 0) {
    console.log('  <kind> is profile, spot or meet; <id> is a ref (16 hex characters) or a meet id (22 characters).');
    console.log('  The API base comes from --api or CADDIE_API_BASE; the admin token from ADMIN_TOKEN or ADMIN_TOKEN_FILE');
    console.log('  (default ~/.config/conference-caddie/admin-token). Display names and reasons print only with --show-content.');
  }
  process.exit(code);
}

let opts;
try {
  ({ values: opts } = parseArgs({
    options: {
      event: { type: 'string' },
      api: { type: 'string' },
      hidden: { type: 'boolean', default: false },
      since: { type: 'string' },
      unhide: { type: 'string' },
      delete: { type: 'string' },
      purge: { type: 'boolean', default: false },
      'show-content': { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
    strict: true,
  }));
} catch (err) {
  usage(err.message);
}
if (opts.help) usage('', 0);

const slug = opts.event;
if (!slug || !SLUG_RE.test(slug)) usage('--event <slug> is required.');
const actions = [];
if (opts.hidden) actions.push(['hidden']);
if (opts.since !== undefined) actions.push(['since', opts.since]);
if (opts.unhide !== undefined) actions.push(['unhide', opts.unhide]);
if (opts.delete !== undefined) actions.push(['delete', opts.delete]);
if (opts.purge) actions.push(['purge']);
if (actions.length !== 1) usage('Give exactly one action.');
const [action, arg] = actions[0];
const showContent = opts['show-content'];

const rawBase = opts.api ?? process.env.CADDIE_API_BASE ?? '';
let base;
try {
  const u = new URL(rawBase);
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('protocol');
  base = u.origin + u.pathname.replace(/\/+$/, '');
} catch {
  usage('--api <base> (or CADDIE_API_BASE) must be the Worker URL, for example https://conference-caddie-api.<subdomain>.workers.dev.');
}

function readToken() {
  if (process.env.ADMIN_TOKEN) return process.env.ADMIN_TOKEN.trim();
  const file = process.env.ADMIN_TOKEN_FILE || join(homedir(), '.config', 'conference-caddie', 'admin-token');
  try {
    return readFileSync(file, 'utf8').trim();
  } catch {
    return '';
  }
}
const token = readToken();
if (!token) {
  console.error('No admin token: set ADMIN_TOKEN or ADMIN_TOKEN_FILE, or run node worker/scripts/setup-secrets.mjs first.');
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

const redact = (text) => String(text ?? '').split(token).join('[ADMIN_TOKEN]');

async function admin(method, path, body) {
  const url = `${base}/admin/moderation?${new URLSearchParams(path)}`;
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    const why = err?.name === 'TimeoutError' ? 'timed out' : redact(err?.cause?.code ?? err?.cause?.message ?? err?.name ?? 'error');
    console.error(`Could not reach the Worker at ${base} (${why}). Check --api or CADDIE_API_BASE.`);
    process.exit(1);
  }
  const json = await res.json().catch(() => ({}));
  if (res.status === 404) {
    console.error(`The Worker answered 404 to ${method} /admin/moderation. Either the admin token is wrong or not set on the Worker (admin routes answer 404 then), or the conference ${slug} is unknown there.`);
    process.exit(1);
  }
  if (!res.ok) {
    const message = typeof json?.error === 'string' ? `: ${redact(json.error).slice(0, 200)}` : '';
    console.error(`${method} /admin/moderation failed with status ${res.status}${message}.`);
    process.exit(1);
  }
  return json;
}

// ---------------------------------------------------------------------------------------------
// Normalising the response. The Worker returns {hidden, reports}; each entry names its target by
// kind and ref (profiles and spots) or meet id, with a report count and reasons. Field names are
// read leniently so that small differences in the admin module do not break the operator view.

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const quote = (s) => JSON.stringify(String(s ?? ''));

function targetId(e) {
  return String(e.ref ?? e.meet_id ?? e.target_id ?? e.id ?? '?');
}

function reportCount(e) {
  for (const key of ['reporters', 'report_count', 'count', 'reports']) {
    const v = e[key];
    if (typeof v === 'number') return v;
    if (Array.isArray(v)) return v.length;
  }
  return 0;
}

function reasonsText(e) {
  let r = e.reasons ?? (Array.isArray(e.reports) ? e.reports.map((x) => x?.reason).filter(Boolean) : null);
  if (!r) return '';
  if (Array.isArray(r)) {
    const counts = {};
    for (const x of r) {
      if (typeof x === 'string') counts[x] = (counts[x] ?? 0) + 1;
      else if (x && typeof x === 'object' && x.reason) counts[x.reason] = (counts[x.reason] ?? 0) + (Number(x.count) || 1);
    }
    r = counts;
  }
  if (typeof r !== 'object') return '';
  return Object.entries(r).sort((a, b) => b[1] - a[1]).map(([reason, n]) => `${reason} x${n}`).join(', ');
}

function namesText(e) {
  if (e.display_name !== undefined) return quote(e.display_name ?? '(profile deleted)');
  const names = e.names ?? e.participants ?? e.display_names;
  if (Array.isArray(names)) return names.map((n) => quote(typeof n === 'string' ? n : n?.display_name ?? '(profile deleted)')).join(' and ');
  return '';
}

const KIND_FROM_KEY = { profiles: 'profile', spots: 'spot', meets: 'meet', profile: 'profile', spot: 'spot', meet: 'meet' };

function hiddenEntries(hidden) {
  if (Array.isArray(hidden)) return hidden.map((e) => ({ ...e, kind: e.kind ?? e.target_kind ?? '?' }));
  if (hidden && typeof hidden === 'object') {
    return Object.entries(hidden).flatMap(([key, list]) => (Array.isArray(list) ? list.map((e) => ({ ...e, kind: e.kind ?? KIND_FROM_KEY[key] ?? key })) : []));
  }
  return [];
}

function createdIso(e) {
  if (typeof e.created_at === 'string') return e.created_at;
  const ms = e.created_at_ms ?? e.created_at;
  return Number.isFinite(ms) ? new Date(ms).toISOString() : '?';
}

// ---------------------------------------------------------------------------------------------
// Actions.

async function listHidden() {
  const json = await admin('GET', { event: slug });
  const entries = hiddenEntries(json.hidden);
  for (const e of entries) {
    const n = reportCount(e);
    const parts = [String(e.kind).padEnd(7), e.kind === 'meet' ? `meet ${targetId(e)}` : `ref ${targetId(e)}`];
    if (e.kind === 'meet' && e.state) parts.push(`state ${e.state}`);
    parts.push(plural(n, 'report'));
    if (showContent) {
      const names = namesText(e);
      const reasons = reasonsText(e);
      if (names) parts.push(names);
      if (reasons) parts.push(`reasons: ${reasons}`);
    }
    console.log(parts.join('  '));
  }
  console.log(entries.length ? `${plural(entries.length, 'hidden target')} at ${slug}.` : `Nothing is hidden at ${slug}.`);
}

async function listSince(iso) {
  const sinceMs = Date.parse(iso);
  if (!Number.isFinite(sinceMs)) usage('--since needs an ISO 8601 instant, for example 2026-11-10T08:00:00Z.');
  const sinceIso = new Date(sinceMs).toISOString();
  const json = await admin('GET', { event: slug, since: sinceIso });
  const rows = (Array.isArray(json.reports) ? json.reports : [])
    .filter((r) => {
      const t = Date.parse(createdIso(r));
      return !Number.isFinite(t) || t >= sinceMs;
    })
    .sort((a, b) => createdIso(a).localeCompare(createdIso(b)));
  for (const r of rows) {
    const kind = String(r.target_kind ?? r.kind ?? '?');
    const parts = [createdIso(r), kind.padEnd(7), kind === 'meet' ? `meet ${targetId(r)}` : `ref ${targetId(r)}`];
    if (showContent) {
      if (r.reason) parts.push(`reason ${r.reason}`);
      const names = namesText(r);
      if (names) parts.push(names);
    }
    console.log(parts.join('  '));
  }
  console.log(`${plural(rows.length, 'report')} since ${sinceIso} at ${slug}.`);
}

// Prints the numeric and boolean fields of an action's answer (counts only, never content).
function countsText(json) {
  const parts = Object.entries(json ?? {})
    .filter(([k, v]) => k !== 'ok' && (typeof v === 'number' || typeof v === 'boolean'))
    .map(([k, v]) => `${k} ${v}`);
  return parts.length ? ` (${parts.join(', ')})` : '';
}

async function act(body, done) {
  const json = await admin('POST', { event: slug }, body);
  if (json?.ok === false) {
    console.error(`The Worker did not apply ${body.action}${countsText(json)}.`);
    process.exit(1);
  }
  console.log(`${done}${countsText(json)}.`);
}

if (action === 'hidden') await listHidden();
else if (action === 'since') await listSince(arg);
else if (action === 'unhide') {
  const t = parseTarget(arg);
  await act({ action: 'unhide', kind: t.kind, id: t.id }, `Unhid ${t.kind} ${t.id} at ${slug} and removed its reports; it is hidden again after two new ones`);
} else if (action === 'delete') {
  const t = parseTarget(arg);
  const what = t.kind === 'spot' ? `the spot line of ref ${t.id}` : t.kind === 'meet' ? `meet ${t.id}` : `the profile with ref ${t.id} everywhere`;
  await act({ action: 'delete', kind: t.kind, id: t.id }, `Deleted ${what} at ${slug}`);
} else {
  await act({ action: 'purge' }, `Purged the reports of ${slug}`);
}
