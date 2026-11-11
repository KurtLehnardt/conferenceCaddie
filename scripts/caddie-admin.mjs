#!/usr/bin/env node
// Operator CLI for Conference Caddie: search and delete attendees, work the moderation queue,
// manage conferences and read stats, against any configured backend (tier 2, the Worker, or tier 3,
// Elasticsearch).
//
// Usage: node scripts/caddie-admin.mjs <area> <command> [target] [flags]
//   Areas are attendees, moderation, conferences and stats; add -h after an area or a command for
//   its usage. Global flags: --backend <name>, --json, --yes, --confirm <target>, --dry-run, -h.
//   Destructive commands only preview until --yes is given; with --yes the operator passes
//   --confirm <target> (required when there is no terminal) or types the exact target at a prompt.
//
// Exit codes: 0 success, 1 backend or request failure, 2 usage, 3 confirmation missing or refused,
// 4 not found, 5 not supported on this tier.
//
// Config: <dir>/config.json names the backends and their tier; it holds no secrets. <dir> is
// CADDIE_ADMIN_HOME, else $XDG_CONFIG_HOME/conference-caddie, else ~/.config/conference-caddie.
// Credentials: tier 3 reads ELASTISEARCH_API_KEY, else the file ES_ADMIN_KEY_FILE (default
// <dir>/es-admin-key); tier 2 reads ADMIN_TOKEN, else the file ADMIN_TOKEN_FILE (default
// <dir>/admin-token). A credential file must not be readable by anyone but its owner.
//
// Tier 3 (Elasticsearch): the backend entry holds es_url and, optionally, api (the Cloud Run
// service URL that `stats health` reads), project and service (for the log command it prints).
// `stats usage` calls _cluster/health and _cat/indices, which need the monitor privilege; the
// admin key holds it. Destructive commands run the operator scripts (ingest, build-facets,
// purge-expired-people, moderation-rules) as child processes with ES_URL and the key in their
// environment only. The conference commands also rewrite data/<slug>/conference.json and
// data/conference-operator.json, which the operator commits; CADDIE_ADMIN_ROOT points them at
// another repository root (the tests use it).
//
// Privacy rules: a credential is never printed, logged or written to the audit log. The audit log
// (<dir>/audit.jsonl, mode 0600) holds only times, the backend, the command, an id or slug, an enum
// reason and counts. It never holds --note text, the --name search text, the moderation rules test
// line, display names, profile text, contact fields or URLs. Attendee text and contact fields print
// only when the operator asks with --text or --contact.

import { main } from './admin/cli.mjs';

process.exitCode = await main(process.argv.slice(2), {
  env: process.env,
  stdout: process.stdout,
  stderr: process.stderr,
  stdin: process.stdin,
});
