# The operator command line: `caddie-admin`

`caddie-admin` is the only administration interface of Conference Caddie. There is no web admin page, and there is no admin route on the tier 3 server. The command line searches and deletes attendees, works the moderation queue, adds, hides and removes conferences, and reads usage and health, against either backend tier. It is one Node program that uses only Node's built-in modules, so installing it adds no dependency and no new attack surface. This is deliberate: you run your own deployment, so the smallest possible surface for the operator is one program on your own computer that holds your own key.

Every command in this page is a real command of the tool; each one prints its own usage with `-h`.

## Install and configuration

### Install

You need Node 22 or later and a clone of your fork. The tool runs from the clone, because the conference commands rewrite files under `data/` in it:

```sh
npm ci
node scripts/caddie-admin.mjs -h        # the tool itself
npm run admin -- -h                     # the same, through npm
npm link && caddie-admin -h             # optional: a `caddie-admin` command on your PATH (the `bin` entry of package.json)
```

The CLI itself needs no installed packages, so the first command works straight after cloning; `npm ci` is for the repository's other scripts. The conference commands read and write `data/<slug>/conference.json` and `data/conference-operator.json` in the clone that holds the script. `CADDIE_ADMIN_ROOT` points them at another repository root.

### Backends: `config.json`

The file `config.json` names your backends and says which tier each one is. It holds **no secrets**. It lives in the config directory: `CADDIE_ADMIN_HOME` if that is set, otherwise `$XDG_CONFIG_HOME/conference-caddie`, otherwise `~/.config/conference-caddie`. Create it:

```sh
mkdir -p ~/.config/conference-caddie
cat > ~/.config/conference-caddie/config.json <<'EOT'
{
  "default": "free",
  "backends": {
    "free": { "tier": 2, "api": "https://conference-caddie.<your-subdomain>.workers.dev" },
    "paid": {
      "tier": 3,
      "es_url": "https://<deployment-id>.<region>.<provider>.cloud.es.io:443",
      "api": "https://<your cloud run service address>",
      "project": "<your gcp project id>",
      "service": "conference-caddie"
    }
  }
}
EOT
```

A tier 2 entry needs `api`: the Worker's own address, https, with no path. A tier 3 entry needs `es_url`; its `api` (the Cloud Run service address), `project` and `service` are optional and are used only by `stats health` to read the service and to print the exact smoke and log commands. Every address must be https; plain http is accepted only for `localhost`, `127.0.0.1` and `[::1]`, so a credential can never travel in clear to another host. `default` names the backend that is used when you do not pass `--backend <name>`. A missing or malformed file stops the command with exit code 2 and prints the path and the expected shape.

You will usually have one backend. The two-entry example shows both shapes.

### Credentials

The credential is a secret and is never in `config.json`. For each tier the tool reads, in this order, the first that exists:

| Tier | Environment variable | Otherwise a file (must be mode 0600) | Default file |
|---|---|---|---|
| 2 (the Worker) | `ADMIN_TOKEN` | the path in `ADMIN_TOKEN_FILE` | `<config dir>/admin-token` |
| 3 (Elasticsearch) | `ELASTISEARCH_API_KEY` | the path in `ES_ADMIN_KEY_FILE` | `<config dir>/es-admin-key` |

The tier 2 file is the one that `node worker/scripts/setup-secrets.mjs` already wrote when you installed the Worker's secrets ([TIER2_CLOUDFLARE.md](fork/TIER2_CLOUDFLARE.md)), so on tier 2 there is nothing more to do. For tier 3, put your admin key in the file:

```sh
umask 077
cat > ~/.config/conference-caddie/es-admin-key      # paste the key, press Enter, then Ctrl-D
chmod 600 ~/.config/conference-caddie/es-admin-key
```

Values are trimmed. A credential file whose mode allows anyone but its owner to read it is refused with exit code 1; the message names the file and the mode, never the value. On Windows a file's mode cannot be checked, so a credential file is not read there and the environment variable is the only source. The credential is held in the process only. It is never printed, never put in a URL, a child process's argument list or the audit log, and error messages have it replaced with `[REDACTED]`. One credential is read per tier and per run. To work two backends of the same tier, give each its own file and set `ADMIN_TOKEN_FILE` or `ES_ADMIN_KEY_FILE` for the run.

Optionally, if you put Cloudflare Access in front of `/admin/*` ([TIER2_CLOUDFLARE.md](fork/TIER2_CLOUDFLARE.md#optional-cloudflare-access-in-front-of-admin)), the tool sends the two Access headers when both `CF_ACCESS_CLIENT_ID` and `CF_ACCESS_CLIENT_SECRET` are set, and never logs them.

### First check

```sh
caddie-admin stats health                          # the default backend
caddie-admin stats health --backend paid --json
```

It reads the public health and capabilities endpoints and prints the backend's tier, the Bluetooth mode and the push flags, then the exact smoke command and the log-tail command for that backend. Those commands name variables, never values; run them by hand.

## How commands behave

### Global flags

| Flag | Meaning |
|---|---|
| `--backend <name>` | The backend from `config.json`. Defaults to the config's `default`. |
| `--json` | Print exactly one JSON object on standard output: `ok`, `command`, `backend`, `tier` and `result`. Errors go to standard error as `{ "ok": false, "error": "<code>", "message": "<text>" }`. Without it, output is one line per item and one summary line. |
| `--yes` | Run a destructive command for real. |
| `--confirm <target>` | With `--yes`, the exact target, instead of typing it. Required when there is no terminal. |
| `--dry-run` | Preview only, even with `--yes`, and also for commands that are not destructive but write. |
| `-h`, `--help` | Usage. Works at the top, on an area and on every command. |

### Dry run and confirmation

A destructive command only previews unless you pass `--yes`. The preview reads and counts what a run would change, prints it (counts and ids, never names) and writes nothing; the summary line ends with "(dry-run, nothing changed)". With `--yes` you must also name the exact target. On a terminal the tool asks you to type it; with no terminal (a script, a pipe) you must pass `--confirm <target>`, and it must equal the target exactly. A mismatch exits with code 3 and nothing is changed. The target of each destructive command is shown in its usage line: a ref, a `<kind>:<id>`, a conference slug, or one of the words `purge-expired` and `reload`.

```sh
caddie-admin attendees delete --event my-conf-2026 0123456789abcdef --reason spam            # preview
caddie-admin attendees delete --event my-conf-2026 0123456789abcdef --reason spam --yes      # asks you to type the ref
caddie-admin attendees delete --event my-conf-2026 0123456789abcdef --reason spam --yes --confirm 0123456789abcdef
```

The destructive commands are `attendees delete`, `block` and `unblock`; `moderation hide`, `unhide`, `delete`, `purge-reports`, `purge-expired` and `rules reload`; and `conferences hide`, `unhide`, `remove` and `unretire`. `conferences add` and `conferences refresh` write files and start an ingest but are not confirmed; add `--dry-run` to see what they would do first.

### Targets

Target syntax is checked before any request or any read of the config:

- A person's `<ref>` is 16 lowercase hexadecimal characters. You get it from `attendees search`.
- A meet id is 22 characters from A-Z, a-z, 0-9, `_` and `-`.
- A moderation target is `<kind>:<id>` with the kind `profile`, `spot` or `meet`.
- A conference slug is lowercase letters, digits and hyphens, at most 120 characters, starting with a letter or digit.
- `--reason` takes only one of `spam`, `harassment`, `impersonation`, `off-topic` and `other`.
- `--note <text>` is accepted on the commands that take a reason and is a note for your own terminal. It is never sent to a backend and never written to the audit log.

### Exit codes

| Code | Meaning |
|---|---|
| 0 | Success. |
| 1 | A backend or request failure, a credential problem, or a command that did its work but reported warnings on standard error (for example a delete whose best-effort second pass failed; the audit record counts the warnings). |
| 2 | Usage error: an unknown command or flag, a bad target, a missing or malformed config. |
| 3 | Confirmation missing or refused. Nothing was changed. |
| 4 | Not found. |
| 5 | The command is not supported on this tier. |

## Commands

Examples use placeholders: `<slug>` is a conference slug, `<ref>` a person's ref.

### Attendees

```sh
caddie-admin attendees search --event <slug> --name "Ann Lee"
caddie-admin attendees search --event <slug> --ref <ref> --include-hidden --limit 20
caddie-admin attendees view --event <slug> <ref>
caddie-admin attendees view --event <slug> <ref> --text --contact
caddie-admin attendees delete --event <slug> <ref> --reason impersonation --yes --confirm <ref>
caddie-admin attendees block --event <slug> <ref> --reason harassment --yes --confirm <ref>
caddie-admin attendees unblock --event <slug> <ref> --yes --confirm <ref>
```

- `search` finds people by a case-insensitive part of the display name (`--name`) or by exactly one ref (`--ref`; exit 4 when there is none). It excludes hidden people unless you pass `--include-hidden`. It prints the ref, display name, flags and `visible_until`, and nothing else. `--limit` defaults to 50 and takes 1 to 1000; tier 2 shows at most 200. The text you search for is never written to the audit log. On tier 2 it travels base64url-encoded in the query (`q64`), because a signed query may not contain characters that need escaping, and is limited to 200 bytes.
- `view` prints the default fields only: the ref, display name, the hidden flags, whether they are open to meet, `visible_until`, whether presence is on (no zone, position or spot line), counts of shared talks and of meets by state, blocks made and received, push registrations by channel (on tier 2 only `web`), and the reports against the person with their reasons. `--text` adds what the person wrote: `about`, `interests`, `expertise`, `contact_note`, the current spot line and held lines, each cut to 300 characters. `--contact` adds `linkedin_url`. Both flags are written to the audit log by name, with the ref. In no mode does it print the profile id, the device secret hash, reporter ids, push endpoints or tokens, positions, cells, Bluetooth fields or embeddings.
- `delete` removes the profile completely, with the same meaning as the app's "Delete my profile". On tier 3 it hides the profile first, deletes the person's meets, push subscriptions and nudge records, then their own blocks, then the profile document, and runs a second pass; blocks that others made against them stay. On tier 2 it sends one signed delete of the profile. The preview prints counts per index or table and no names. If the second pass fails after the profile is gone, the command exits 1 with a warning, and `npm run people:purge` or `caddie-admin moderation purge-expired` finishes it on tier 3.
- `block` makes a hide that survives edits and re-creation from the same device: it records an operator report for the person and sets `hidden`. The reason goes to the audit log; `--note` goes nowhere. A block cannot stop a person who starts again on a new device, because a new device has a new ref. `unblock` removes only the operator's report, and the person stays hidden if two other people have reported them.

What an installed app does after `attendees delete`: the person's next call that needs a profile answers `403 profile_required`, the apps show "Make your profile visible first." and the person can make a new one. [APPS.md](fork/APPS.md#what-an-installed-app-does-when-the-operator-changes-things) cites the code.

### Moderation

```sh
caddie-admin moderation queue --event <slug>
caddie-admin moderation queue --event <slug> --since 2026-11-10T08:00:00Z --show-content
caddie-admin moderation hide --event <slug> profile:<ref> --reason spam --yes --confirm profile:<ref>
caddie-admin moderation unhide --event <slug> profile:<ref> --yes --confirm profile:<ref>
caddie-admin moderation delete --event <slug> spot:<ref> --yes --confirm spot:<ref>
caddie-admin moderation purge-reports --event <slug> --yes --confirm <slug>
caddie-admin moderation purge-expired --yes --confirm purge-expired
caddie-admin moderation rules test "a line of text"
caddie-admin moderation rules reload --yes --confirm reload
```

- `queue` lists hidden targets and recent reports: kinds, refs, meet ids, times and report counts. Display names and report reasons appear only with `--show-content`. `--since` takes an ISO time ending in `Z`.
- `hide` hides a profile or a spot line and requires `--reason`. It refuses a `meet` target with exit 2, because a meet is removed with `delete`.
- `unhide` clears the hidden flag and removes the target's reports, so it takes two new reports to hide it again.
- `delete` on `profile:` is the full attendee delete above, not a document-only delete. On `spot:` it clears the spot line and keeps the profile hidden. On `meet:` it deletes the meet. On tier 2 a retried delete of something that is already gone answers 404, which the tool reports as "already deleted or never existed" and exits 0, because the first attempt may have succeeded after its answer was lost.
- `purge-reports` deletes the reports of a conference that has ended, and refuses before its end (on tier 2 it prints the end time).
- `purge-expired` (tier 3 only) runs `scripts/purge-expired-people.mjs`, which finishes partial profile deletes and removes expired profiles, presence, meets, push subscriptions, nudges and blocks. On tier 2 it exits 5 because the Worker's own cron does this.
- `rules test` checks one line against the word list and prints the verdict; the line is never logged. `rules reload` loads `config/moderation-words.json` into the percolator index (`--index <name>` picks another). Both are tier 3 only; on tier 2 they exit 5, because the word list is compiled into the Worker and a change needs a deploy.

### Conferences

```sh
caddie-admin conferences list
caddie-admin conferences list --all
caddie-admin conferences add --event <slug>
caddie-admin conferences refresh --event <slug> --allow-shrink
caddie-admin conferences hide --event <slug> --reason other --yes --confirm <slug>
caddie-admin conferences unhide --event <slug> --yes --confirm <slug>
caddie-admin conferences remove --event <slug> --purge-local --yes --confirm <slug>
caddie-admin conferences unretire --event <slug> --yes --confirm <slug>
```

- `list` prints slug, name, dates, status and talk count; `--all` includes the unavailable ones.
- `add` and `refresh` index a Linux Foundation conference by slug (only those in this version; a URL or a Sessionize address is refused with exit 2). On tier 3 they run `scripts/ingest.mjs --event <slug>` and then `scripts/build-facets.mjs <slug>` with `ES_URL` and the key in the child's environment only. On tier 2 they run `gh workflow run ingest.yml -f events=<slug>`, plus `-f allow_shrink=true` for `refresh --allow-shrink`, so the GitHub CLI must be installed and signed in, and its default repository must be your fork (set it once with `gh repo set-default <owner>/<repo>`). The ingest workflow does the fetching and pushing; watch it with `gh run list --workflow ingest.yml`. A conference that was removed is refused with a message until `unretire`.
- `hide` keeps a conference's data but removes it from clients. It sends the conference with `status: 'unavailable'` to the backend, rewrites `data/<slug>/conference.json` (status `unavailable`, reason `operator_hidden`, a new `raw_fetched_at`), records the slug under `hidden` in `data/conference-operator.json`, and prints the files to commit. The next Pages build leaves the conference out of the bundle index. `unhide` reverses all three, restoring the status the conference had before, and tells you to run `conferences refresh`.
- `remove` wipes the conference from the backend and retires it. On tier 3 it deletes the talks, topics and facets of the conference, and the people, meets, blocks, push subscriptions, nudges and reports of the event, then the conference document, and prints the counts; another conference's documents are untouched. On tier 2 it sends `DELETE /admin/conference` and prints the returned counts; the Worker also leaves a tombstone for the slug. Locally it rewrites `data/<slug>/conference.json` as retired (`operator_removed`) and keeps it, because the bundle build needs it to drop the conference, and records the slug under `removed` in the operator file. `--purge-local` also deletes `data/raw/<slug>/` and `data/<slug>/talks.ndjson` and nothing else. The preview prints the same counts and deletes nothing. Commit the printed files and let `pages.yml` run; the bundle directory is carried forward for one more day.
- `unretire` lifts the retired state: see the next section.

**A removed conference stays removed, on both tiers, until `conferences unretire`.** The weekly ingest would otherwise bring it back, because the Linux Foundation still lists it. `scripts/ingest.mjs` skips a slug that is under `removed` in `data/conference-operator.json`, and a hidden slug is written as unavailable again. On tier 2 the Worker also refuses the slug in `PUT /admin/conferences` and `push-ingest.mjs` logs each slug it skipped, unless the document carries `"unretire": true`. `unretire` deletes the `removed` entry of the operator file on both tiers; on tier 2 it also sends the local conference document with `"unretire": true` so the Worker drops its tombstone (on tier 2 it sends it even when the local file has no entry, so you can repair a partly finished removal by running it again; on tier 3 a missing entry exits 4). It then tells you to run `conferences refresh --event <slug>`, which fetches the schedule again and replaces the retired file. Commit `data/conference-operator.json`.

What clients see after `remove`: apps on the tier 1 fallback see the conference gone when they next fetch `conferences.json`, and a bundle already on a device stays until the app replaces it. On tier 2 the Worker's directory cache can still name the slug for up to five minutes, during which the conference answers `400 conference is not available`; on tier 3 the conference cache lasts 60 seconds. [APPS.md](fork/APPS.md#what-an-installed-app-does-when-the-operator-changes-things) gives the files and lines.

### Stats

```sh
caddie-admin stats counts --event <slug>
caddie-admin stats counts
caddie-admin stats usage
caddie-admin stats health
```

- `counts --event <slug>` prints document counts per index on tier 3 and row counts per table on tier 2. Without `--event` it prints totals per index (tier 3) or requests per conference for the day (tier 2).
- `usage` on tier 2 prints, per conference and in total, the day, requests, rows read, rows written and the pace, which tells you how close you are to the Free plan's limits. On tier 3 it prints cluster health and the document counts and sizes of the indices, from `_cluster/health` and `_cat/indices`, which need the `monitor` privilege that the admin key normally holds.
- `health` prints the tier, the Bluetooth mode and the push flags from `GET /api/capabilities` and the health status, then the exact commands: the smoke test, and the log-tail command for this backend (on tier 2 `wrangler tail` through a filter, never unfiltered; on tier 3 a `gcloud logging read` of the service's errors).

## The audit log

Every run appends one line to `audit.jsonl` in the config directory, a file the tool creates with mode 0600 (and repairs if it finds wider permissions). It is append-only. A line holds only values that have the shape of their field, so free text cannot get in:

| Field | Content |
|---|---|
| `ts` | The time, ISO 8601 in UTC |
| `backend`, `tier` | The backend's name and tier |
| `command` | For example `attendees delete` |
| `target` | A slug, a ref, a meet id or a `<kind>:<id>`, and nothing else |
| `reason` | The enumerated reason, when one was given |
| `mode` | `dry-run` or `run` |
| `result` | `ok`, `warned`, `failed`, `not_found`, `unsupported` or `refused` |
| `error` | On a failure, a short code such as `removal_superseded`, never a message |
| `counts` | Numbers only: documents, rows, reports, warnings |
| `flags` | Which of `--text`, `--contact`, `--include-hidden`, `--show-content`, `--all`, `--allow-shrink` and `--purge-local` were used |

It **never** holds `--note` text, the `--name` search text, the text of a `moderation rules test`, a display name, profile text, a contact field, a key, a token, a URL, or the body of a backend's answer. A refused or failed run is recorded too, so you can see what was attempted. The file contains nothing a stranger could use, but it does show which refs and conferences you acted on, so treat it as private and do not publish it.

## Differences between the tiers

| | Tier 2 (Cloudflare Worker) | Tier 3 (Elasticsearch) |
|---|---|---|
| How the tool reaches the backend | HMAC-signed requests to the Worker's `/admin/*` routes | Directly to Elasticsearch with your admin key |
| Credential | The admin token (the HMAC key) | The Elasticsearch admin API key |
| `moderation purge-expired` | Exit 5 (the Worker's cron does it) | Runs `scripts/purge-expired-people.mjs` |
| `moderation rules test`, `reload` | Exit 5 (compiled into the Worker) | Wraps `scripts/moderation-rules.mjs` |
| `conferences add`, `refresh` | `gh workflow run ingest.yml` | `scripts/ingest.mjs` then `scripts/build-facets.mjs` |
| `stats usage` | Meters per conference and totals | Cluster health and index sizes |
| `attendees view`, push registrations | `web` only | `web`, `apns` and `fcm` |
| Removal tombstone | Kept by the Worker until `unretire` | The operator file only |
| A retried delete | 404 reported as "already deleted or never existed" | Not applicable |

## The security model

The aim is the smallest attack surface that still lets you operate the service.

- There is no admin web page, and the tier 3 server has no admin route at all. The server's own routes are all `/api/*`. On tier 3 the tool talks to Elasticsearch with a key that never leaves your computer; the deployed service holds two scoped keys and never the admin key.
- On tier 2 there is one admin surface: the Worker's `/admin/*` routes. Each request carries `X-Caddie-Admin: v1 <ts> <nonce> <bodySha256> <sig>`, an HMAC over the method, path, query, body hash, time and nonce. The token never travels. The Worker checks the signature and the time (within five minutes) before it reads any body, refuses a replayed nonce on every admin path, limits failed signatures per address, answers 404 to anything it does not accept so a scanner learns nothing, and fails closed when no token is configured. A header that leaks from a log works at most once and for minutes.
- The tool never follows a redirect on an admin request and refuses a non-https address except localhost. It refuses a path or a query that would need escaping, so free text always travels encoded. It rebuilds every result row from a list of allowed fields, so a field that a backend adds later is not printed by accident, and it escapes terminal control characters, bidirectional controls and clipboard sequences in anything that came from a person's profile before it prints it, so a hostile display name cannot act on your terminal.
- A credential is read from the environment or from a file in mode 0600, held in memory only, redacted from every message and passed to no other process on its command line or in a URL.
- Destructive commands do nothing without `--yes` and the exact target, and a script must repeat the target with `--confirm`.
- The tier 2 test fixtures under `/admin/test/` answer 404 unless the Worker has the variable `ADMIN_TEST_ROUTES` set to `"1"`; the repository never sets it ([TIER2_CLOUDFLARE.md](fork/TIER2_CLOUDFLARE.md#admin_test_routes-the-smoke-fixtures)).
- Cloudflare Access is an optional extra layer and must never cover the public app (see the rule in [TIER2_CLOUDFLARE.md](fork/TIER2_CLOUDFLARE.md#optional-cloudflare-access-in-front-of-admin)).

## Troubleshooting

**Config or credential errors (exit 2 or 1).** "config not readable" or "has the wrong shape" means `config.json` is missing or malformed; the message prints its path and the expected shape. "no credential" names the variable and the file to set. "has mode 0644; only the owner may read it" means `chmod 600` the file.

**Every tier 2 command answers "not found, or the admin signature was refused".** The Worker answers 404 both for a missing target and for a refused signature, and cannot say which. Check, in this order: the token in your token file is the one the Worker has (after a rotation, `CADDIE_ADMIN_TOKEN` and the file must hold the new value); the `api` address is the Worker's origin with no path; no Cloudflare Access application covers `/admin/*` without your service token; and the computer's clock is right. A valid signature with a clock more than five minutes off answers `401 admin_skew`, which is a clear message. `401 admin_body` and `401 admin_replay` mean a request was altered or reused in transit.

**Bad signatures from a CI runner empty the per-address bucket (the W4 runner note).** The Worker lets each address make ten failed signatures a minute, and while that bucket is empty it answers 404 to every admin request from that address, valid or not, for up to a minute (one token returns every six seconds). A CI runner that signs with a stale `CADDIE_ADMIN_TOKEN`, for example after a rotation, does this: the ingest workflow's `push-ingest.mjs` then sees 404 on every admin call. The fix is the secret or the clock, not the Worker: set the repository secret `CADDIE_ADMIN_TOKEN` from your token file (`gh secret set CADDIE_ADMIN_TOKEN --repo <owner>/<repo> < ~/.config/conference-caddie/admin-token`), wait a minute, and run the workflow again. Your own computer's address is a different bucket, so a failing runner does not lock you out.

**`503 daily_limit` on tier 2.** The Worker records every admin request's nonce as a written row, so when the account's daily limit of written rows is reached, every admin call answers 503 until 00:00 UTC, including reads. Check `caddie-admin stats usage` on a day before the limit, or wait.

**`removal_incomplete`.** A tier 2 removal has several steps (the tombstone, the wipe, the directory row). If it stops between them, the command exits 1 and says at which step, whether the slug is retired and whether it is wiped, and the cause. Run the same `conferences remove` again, after the `Retry-After` the Worker sent if it sent one. A removal that is run again finishes the rest and reports that the slug was already retired.

**`removal_superseded`.** An `unretire` ran while the removal was in progress, so the Worker kept the directory row and the object stays wiped. The tool does nothing more on its own and prints both ways out with your flags filled in: finish the removal by running `conferences remove --event <slug> ... --yes --confirm <slug>` again, or restore the conference with `conferences unretire --event <slug> --yes --confirm <slug>`. Choose one. The audit log records the code `removal_superseded`.

**`unretire` of a conference.** After a removal, `conferences unretire --event <slug> --yes --confirm <slug>`, then `conferences refresh --event <slug>` (tier 2 starts the ingest workflow, tier 3 ingests locally), then commit `data/conference-operator.json` and the rewritten `data/<slug>/conference.json`, and let `pages.yml` run. If it answers `unretire_incomplete`, the Worker could not finish dropping the tombstone in every place: run the same command again. On tier 3, "is not removed" (exit 4) means the operator file has no `removed` entry for the slug, because it was not removed from this clone; pull the latest commits or check `data/conference-operator.json`.

**"already deleted or never existed".** On tier 2 a delete whose first answer was lost is retried with a fresh signature, and a retried request that answers 404 means the first one probably succeeded. The tool says so and exits 0. If you did not retry, the ref was wrong or the person was never there.

**A command exits 1 with a warning after a delete.** On tier 3 the second pass of a profile delete is best effort. The profile is already gone; the warning says what could not be done. Run `caddie-admin moderation purge-expired --yes --confirm purge-expired` or `npm run people:purge` to finish it.

**`conferences add` or `refresh` fails on tier 2 with "gh could not start" or "gh exited".** Install the GitHub CLI, run `gh auth login`, and make sure `gh repo set-default` names your fork. The ingest workflow needs the secret `CADDIE_ADMIN_TOKEN` and the variable `CADDIE_API_BASE` in the repository.

**`stats usage` fails on tier 3 with a 403.** The admin key lacks the `monitor` privilege that `_cluster/health` and `_cat/indices` need. Use a key that has it.

**The Worker refuses a refresh with 409 (a short feed).** Finalize refuses to delete more than 10 talks and more than 10 percent of a conference's talks, so that a short feed cannot erase people's sharing. If the schedule really shrank, run `conferences refresh --event <slug> --allow-shrink`.

## Key rotation

**Tier 2.** The admin token is the HMAC key. Rotate it with `node worker/scripts/setup-secrets.mjs --rotate-admin-token`, then the two finishing commands it prints. The Worker accepts the old and the new token during the change, so no client is ever refused. The new value goes to your token file and the repository secret; copy it to any other computer that runs the CLI. The full procedure and the recovery cases are in [TIER2_CLOUDFLARE.md](fork/TIER2_CLOUDFLARE.md#rotating-the-admin-token).

**Tier 3.** Your admin key is an Elasticsearch API key that you control. To rotate it, create a new API key in Kibana or with the Elasticsearch API, write it to `~/.config/conference-caddie/es-admin-key` (mode 0600) and into any shell that sets `ELASTISEARCH_API_KEY`, check that `caddie-admin stats health` and `stats usage` still work, and then invalidate the old key (Elastic's `DELETE /_security/api_key`, or Kibana's API keys page). The deployed service does not hold the admin key. To rotate the two scoped keys that the service holds, run `GC_PROJECT=<id> ELASTISEARCH_API_KEY=... node scripts/create-es-keys.mjs --only caddie-es-readonly` (or `caddie-es-people`), deploy again with `npm run deploy` so the new secret version is mounted, and invalidate the old key.

After any suspected leak, rotate first, then look at `audit.jsonl` and your Cloudflare or Elastic logs for activity you do not recognise.
