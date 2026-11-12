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
// Exit codes: 0 success, 1 backend or request failure, or finished with warnings (see stderr; audit
// counts.warnings), 2 usage, 3 confirmation missing or refused, 4 not found, 5 not supported on
// this tier.
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
// Tier 2 (Cloudflare Worker): the backend entry holds api, the Worker's own origin (https; plain
// http for localhost only; no path), read strictly as typed (canonicalOrigin: plain ASCII, no user
// name, "%" or backslash, an internationalised host in its punycode xn-- form; anything else is
// exit 2). Every admin request is signed with the token (X-Caddie-Admin, scripts/lib/admin-sign.mjs),
// re-signed on each retry, and never follows a redirect. The signature is v2, bound to the api's
// origin; CADDIE_ADMIN_SIG_VERSION=1 signs v1, which the Worker refuses since step d of the migration
// (DECISIONS.md, "Admin signature v2") unless ADMIN_SIG_MIN = "1" is committed in its [vars] (the
// rollback), with one warning on stderr that v1 is not bound to a host;
// unset or empty means 2, and any other value is exit 2. The api and the version are checked right
// after the backend is chosen, before the credential is read or a confirmation asked. A 404 is
// exit 4: "no such target" when the Worker answers not_found or no_operator_block, "refused" (the
// key, the failed-signature limit or the route) when it answers "Not found". After an attempt that
// may have run (a 5xx, or a timeout or reset once connected; never a failure to connect or a 429),
// a retried delete or unhide that answers not_found, or unblock that answers not_found or
// no_operator_block, reads as "already done" and exits 0 with a note. A conference the Worker does
// not route (never added, a typo, or removed) exits 4 with the code conference_unavailable. An
// unretire is refused when the Worker lists the slug with another status than the one it sends.
// `conferences add` and `refresh` start the ingest workflow with `gh workflow run ingest.yml`;
// `moderation purge-expired` and `moderation rules` exit 5 (the cron purges; the word list is
// compiled into the Worker). When CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET are both set,
// admin requests also carry the Cloudflare Access headers.
//
// Privacy rules: a credential is never printed, logged or written to the audit log. The audit log
// (<dir>/audit.jsonl, mode 0600) holds only times, the backend, the command, an id or slug, an enum
// reason, counts, and enum codes for a failure (error) and a result note (note). It never holds
// --note text, the --name search text, the moderation rules test line, display names, profile
// text, contact fields or URLs. Attendee text and contact fields print only when the operator asks
// with --text or --contact.

import { main } from './admin/cli.mjs';

process.exitCode = await main(process.argv.slice(2), {
  env: process.env,
  stdout: process.stdout,
  stderr: process.stderr,
  stdin: process.stdin,
});
