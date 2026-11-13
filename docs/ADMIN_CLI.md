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

The examples in this guide are written as `caddie-admin ...`, which assumes you ran `npm link`. Without it, write `node scripts/caddie-admin.mjs ...` (or `npm run admin -- ...`) in its place.

The CLI itself needs no installed packages, so the first command works straight after cloning; `npm ci` is for the repository's other scripts. The conference commands read and write `data/<slug>/conference.json` and `data/conference-operator.json` in the clone that holds the script. `CADDIE_ADMIN_ROOT` points them at another repository root.

### Backends: `config.json`

The file `config.json` names your backends and says which tier each one is. It holds **no secrets**. It lives in the config directory: `CADDIE_ADMIN_HOME` if that is set, otherwise `$XDG_CONFIG_HOME/conference-caddie`, otherwise `~/.config/conference-caddie`. If you have no `config.json` yet, create it there. The commands below write to the directory the tool reads and never overwrite a file that exists (`set -o noclobber`); if you already have a `config.json`, for example with a tier 3 backend, they change nothing and say so, and you add the new entry under `backends` of that file with an editor instead:

```sh
(
  set -o noclobber   # an existing config.json is never overwritten
  mkdir -m 700 -p "${CADDIE_ADMIN_HOME:-${XDG_CONFIG_HOME:-$HOME/.config}/conference-caddie}"
  cat > "${CADDIE_ADMIN_HOME:-${XDG_CONFIG_HOME:-$HOME/.config}/conference-caddie}/config.json" <<'EOT' || echo 'config.json exists: add the backend under "backends" of that file with an editor instead' >&2
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
)
```

A tier 2 entry needs `api`: the Worker's own address, https, with no path. A tier 3 entry needs `es_url`; its `api` (the Cloud Run service address), `project` and `service` are optional and are used only by `stats health` to read the service and to print the exact smoke and log commands. Every address must be https; plain http is accepted only for `localhost`, `127.0.0.1` and `[::1]`, so a credential can never travel in clear to another host. `default` names the backend that is used when you do not pass `--backend <name>`. A missing or malformed file stops the command with exit code 2 and prints the path and the expected shape.

You will usually have one backend. The two-entry example shows both shapes.

### Credentials

The credential is a secret and is never in `config.json`. For each tier the tool reads, in this order, the first that exists:

| Tier | Environment variable | Otherwise a file (must be mode 0600) | Default file |
|---|---|---|---|
| 2 (the Worker) | `ADMIN_TOKEN` | the path in `ADMIN_TOKEN_FILE` | `<config dir>/admin-token` |
| 3 (Elasticsearch) | `ELASTISEARCH_API_KEY` | the path in `ES_ADMIN_KEY_FILE` | `<config dir>/es-admin-key` |

The tier 2 file is the one that `node worker/scripts/setup-secrets.mjs` already wrote when you installed the Worker's secrets ([TIER2_CLOUDFLARE.md](fork/TIER2_CLOUDFLARE.md)), so on tier 2 there is nothing more to do. That script writes `~/.config/conference-caddie/admin-token` (or the path in `ADMIN_TOKEN_FILE`) whatever `CADDIE_ADMIN_HOME` and `XDG_CONFIG_HOME` say, so if either of them moves your config directory, set `ADMIN_TOKEN_FILE` to that file for the CLI too (the smoke test falls back to that file by itself and says so; see [The smoke test and the token file](#the-smoke-test-and-the-token-file)). For tier 3 the credential is the **operator key**, a limited Elasticsearch key that is restricted to the `caddie-*` indices and holds no security privilege. Do not use your setup or superuser key here. `scripts/create-es-keys.mjs --operator` mints it and writes it to the default file with mode 0600, without printing it ([TIER3_GCP_ELASTIC.md](fork/TIER3_GCP_ELASTIC.md#the-operator-key)). If you have a key from elsewhere, store it without echoing it. Like the script, this never overwrites a key file that exists; move an old one away first (see [Key rotation](#key-rotation)):

```sh
(
  umask 077
  set -o noclobber   # an existing es-admin-key is never overwritten
  mkdir -m 700 -p "${CADDIE_ADMIN_HOME:-${XDG_CONFIG_HOME:-$HOME/.config}/conference-caddie}"
  read -rs KEY && printf '%s' "$KEY" > "${CADDIE_ADMIN_HOME:-${XDG_CONFIG_HOME:-$HOME/.config}/conference-caddie}/es-admin-key"     # the key is not echoed and not in your history
)
```

Values are trimmed. A credential file whose mode allows anyone but its owner to read it is refused with exit code 1; the message names the file and the mode, never the value. On Windows a file's mode cannot be checked, so a credential file is not read there and the environment variable is the only source. The credential is held in the process only. It is never printed, never put in a URL, a child process's argument list or the audit log, and error messages have it replaced with `[REDACTED]`. One credential is read per tier and per run. To work two backends of the same tier, give each its own file and set `ADMIN_TOKEN_FILE` or `ES_ADMIN_KEY_FILE` for the run.

Optionally, if you put Cloudflare Access in front of `/admin/*` ([TIER2_CLOUDFLARE.md](fork/TIER2_CLOUDFLARE.md#optional-cloudflare-access-in-front-of-admin)), the tool sends the two Access headers when both `CF_ACCESS_CLIENT_ID` and `CF_ACCESS_CLIENT_SECRET` are set, and never logs them.

### The signature version

On tier 2 every admin request is signed with version 2 of the signature (`X-Caddie-Admin: v2 ...`), which binds the request to the origin of the backend's `api`. A signed request that reaches another host (a typo in the address, a hostile mirror, a staging Worker that holds the same token) therefore cannot be replayed to your Worker. The smoke test signs its admin calls the same way.

`CADDIE_ADMIN_SIG_VERSION` is removed. From step c to step e of the migration (DECISIONS.md, "Admin signature v2") it made this tool and the smoke sign version 1 again, the older scheme without the origin, as a temporary rollback. Since step e both always sign version 2 and ignore the variable. When it is still set to anything but the empty string and the backend is tier 2, this tool prints one warning on stderr, `CADDIE_ADMIN_SIG_VERSION was removed in step e of the admin signature migration (DECISIONS.md, "Admin signature v2") and is ignored: every admin request is signed with v2; unset it` (with `--json`, one line with the code `sig_version_removed`), and the smoke prints the same text as one `NOTE` line. Neither prints the value, and neither stops: the run goes on with version 2, and this warning leaves the exit code unchanged. With a tier 3 backend this tool signs nothing and prints no warning, so the variable may still be set when you see none; check your environment. Unset the variable. Since step d a current Worker refuses version 1 (404) unless its `ADMIN_SIG_MIN` is `"1"`, which belongs in `[vars]` of `worker/wrangler.toml`, committed and deployed, and never in a secret; the Worker reads whatever value it has when it runs, so a secret or a dashboard variable of `"1"` opens version 1 as well. That rollback is now needed only for a client run from a checkout before step e that still signs version 1; end it (remove the line and deploy again) as soon as you can, because version 1 is not bound to a host ([worker/README.md, Signature v2](../worker/README.md#signature-v2)). A Worker from before version 2 answers 404 to every request this tool sends, so deploy it again.

The `api` of a tier 2 backend is read strictly, before any URL parsing. Only whitespace around the value is trimmed, and one final `/` is allowed; what remains must be plain ASCII, `https://` (or `http://` for localhost) followed by a host and an optional port, and nothing else, so no path, no user name, no `%` and no backslash. Letter case and a default port make no difference: `HTTPS://Caddie.Example:443/` is `https://caddie.example`. An internationalised host must be written in its punycode form (`xn--...`), and an IP address as the URL parser writes it, a plain dotted quad such as `127.0.0.1` or a compressed IPv6 address such as `[::1]`: other numeric forms (`2130706433`, `0x7f.1`, `0177.0.0.1`, `127.1`), an IPv6 address written in full and a port with a leading zero are refused, because the parser would rewrite them. A value that the URL parser would silently turn into another host, such as one with a full-width character or a percent-encoded host, is a usage error (exit 2) that says `api must be the Worker's origin as plain ASCII`, rather than a request to wherever the parser lands.

The smoke test no longer has a bearer mode. `SMOKE_ADMIN_AUTH=bearer` sent the raw token in an `Authorization` header to whatever host `API_BASE` named, and the Worker has not read that header on `/admin/*` since #65. The smoke now refuses that value, and any value other than `signed`, before it sends anything.

### The smoke test and the token file

`scripts/smoke.mjs` takes the Worker's admin token from `ADMIN_TOKEN`, else from the file in `ADMIN_TOKEN_FILE`; a set but empty `ADMIN_TOKEN_FILE` means no token. It reads a file with this tool's checks (mode 0600, the whole file trimmed), so the smoke and this tool always use the same key, and it never prints the token. With neither variable set, it reads the token file this tool reads, `<config dir>/admin-token`, by itself only when all three of these hold:

- the origin of `API_BASE` as you typed it (by default the scheme and host of `BASE_URL`) passes the strict reading of [The signature version](#the-signature-version), and is exactly the `api` of a tier 2 backend in your `config.json` that passes it too;
- that origin is not on this machine (a local Worker has its own token, in its `.dev.vars`);
- `SMOKE_API` is not `cloudrun`.

For any other address, name the file with `ADMIN_TOKEN_FILE`, as the command that `stats health` prints does. Whenever the smoke signs admin calls (with a token from anywhere, and against the Worker even without one, since check `adm1` signs a probe with a random key), an `API_BASE` (or `BASE_URL`) that fails the strict reading stops it with a config FAIL before any request. The smoke drops any trailing `/` from both variables before it reads them. Check `unav1`, which flips a conference on a local Worker, always needs `ADMIN_TOKEN` or `ADMIN_TOKEN_FILE`. The rule dates from version 1 signatures, which are not bound to a host: whatever answered at `API_BASE` could replay one to your Worker within its five-minute window. Since step e the smoke signs only version 2, which is bound to the origin of `API_BASE`, and the rule stays so that the token of a configured Worker is never used for any other origin.

If `<config dir>/admin-token` does not exist but `~/.config/conference-caddie/admin-token` does (the file that `node worker/scripts/setup-secrets.mjs` writes even when `XDG_CONFIG_HOME` moves your config directory), the smoke reads the old file, with two exceptions. It never does when `CADDIE_ADMIN_HOME` is set, because that names a separate setup, a fork's for example, whose Worker must never get the token at the old path. And when the old directory has its own `config.json`, that file must list the same origin as a tier 2 `api`; otherwise the smoke runs without a token and prints a note that starts `NOTE admin token: <config dir>/admin-token does not exist, and the old path ~/.config/conference-caddie/admin-token is not read`. When it does read the old file, it then prints one line that starts `NOTE admin token: <config dir>/admin-token does not exist, so the old path ~/.config/conference-caddie/admin-token was read. Move it to <config dir>/admin-token and leave a symlink at the old path` and gives the `ln -s` command, quoted for the shell, so that this tool, the smoke and `setup-secrets.mjs` share one file.

If both files exist and are different files, the smoke reads the one in the config directory and prints a note that says `Do not delete either until you know which one the Worker accepts`, that `setup-secrets.mjs` writes the old path, and which of the two is newer by modification time. A token rotation writes the old path, so the newer token can be the one the smoke did not read. A symlinked `~/.config` or `conference-caddie` directory, or a hard link, makes the two paths one file, and then there is no note.

A token file that cannot be used stops the smoke, and this tool, with a message that names the file and never the value: a mode wider than 0600, a directory on its path that cannot be searched (`cannot be reached`), a directory where the file should be (`is a directory`), or an empty file.

### First check

```sh
caddie-admin stats health                          # the default backend
caddie-admin stats health --backend paid --json
```

It reads the public health and capabilities endpoints and prints the backend's tier, the Bluetooth mode and the push flags, then the exact smoke command and the log-tail command for that backend. Those commands name variables and file paths, never values; run them by hand. On tier 2 the smoke command always names the token file this tool reads, quoted for a POSIX shell, for example `BASE_URL='https://<your worker>' SMOKE_API=worker ADMIN_TOKEN_FILE=~/'.config/conference-caddie/admin-token' node scripts/smoke.mjs`. The address is single-quoted. A path under your home directory starts with `~/` outside the single quotes, so the shell expands it; any other path is single-quoted whole, with a `'` in it written `'\''`.

## How commands behave

### Global flags

| Flag | Meaning |
|---|---|
| `--backend <name>` | The backend from `config.json`. Defaults to the config's `default`. |
| `--json` | Print exactly one JSON object on standard output: `ok`, `command`, `backend`, `tier` and `result`. Errors go to standard error as `{ "ok": false, "error": "<code>", "message": "<text>" }`. Warnings go there too, one JSON object per line, as `{ "ok": true, "warning": "<code>", "message": "<text>" }` (`sig_version_removed`, `audit_not_written`, or `result` for a command that finished with warnings), so every line of standard error parses, and an error, when there is one, is the last line. Since step e of the signature migration the code `sig_version_removed` replaces `sig_version_1`, the warning of the removed rollback, which this tool no longer prints, so a script that matched `sig_version_1` should match `sig_version_removed` instead. Without `--json`, output is one line per item and one summary line. |
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
| 1 | A backend or request failure, a credential problem, or a command that did its work but reported result warnings (code `result` with `--json`) on standard error, for example a delete whose best-effort second pass failed; the audit record counts these warnings. The warnings `sig_version_removed` and `audit_not_written` leave the exit code unchanged: a run that prints only them exits as it would without them. |
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
- `delete` on `profile:` is the full attendee delete above, not a document-only delete. On `spot:` it clears the spot line and keeps the profile hidden. On `meet:` it deletes the meet. On tier 2, a delete that answers `not_found` on a retry, after an earlier attempt that may have run and whose answer was lost, is reported as `<what>: already done (an earlier attempt may have run and its answer was lost; the retry answered not_found)` and exits 0. The same 404 on a first attempt is `no such target (the Worker answered not_found)` and exits 4.
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
- `add` and `refresh` index a Linux Foundation conference by slug (only those in this version; a URL or a Sessionize address is refused with exit 2). On tier 3 they run `scripts/ingest.mjs --event <slug>` and then `scripts/build-facets.mjs <slug>` with `ES_URL` and the key in the child's environment only. On tier 2 they start the `ingest.yml` workflow with the GitHub CLI, with the input `events=<slug>` (and `allow_shrink=true` for `refresh --allow-shrink`). The CLI does not pass `--repo`, so it acts on the GitHub CLI's default repository: the GitHub CLI must be installed and signed in, and its default must be your fork (set it once with `gh repo set-default <owner>/<repo>`; after `gh repo fork --clone` the default can be the original project). The ingest workflow does the fetching and pushing; watch it with `gh run list --workflow ingest.yml --repo <owner>/<repo>`. A conference that was removed is refused with a message until `unretire`.
- `hide` keeps a conference's data but removes it from clients. It sends the conference with `status: 'unavailable'` to the backend, rewrites `data/<slug>/conference.json` (status `unavailable`, reason `operator_hidden`, a new `raw_fetched_at`), records the slug under `hidden` in `data/conference-operator.json`, and prints the files to commit. The next Pages build leaves the conference out of the bundle index. `unhide` reverses all three, restoring the status the conference had before, and tells you to run `conferences refresh`.
- `remove` wipes the conference from the backend and retires it. On tier 3 it deletes the talks, topics and facets of the conference, and the people, meets, blocks, push subscriptions, nudges and reports of the event, then the conference document, and prints the counts; another conference's documents are untouched. On tier 2 it sends `DELETE /admin/conference` and prints the returned counts; the Worker also leaves a tombstone for the slug. Locally it rewrites `data/<slug>/conference.json` as retired (`operator_removed`) and keeps it, because the bundle build needs it to drop the conference, and records the slug under `removed` in the operator file. `--purge-local` also deletes `data/raw/<slug>/` and `data/<slug>/talks.ndjson` and nothing else. The preview prints the same counts and deletes nothing. Commit the printed files and let `pages.yml` run; the bundle directory is carried forward for one more day.
- `unretire` lifts the retired state: see the next section.

**A removed conference stays removed, on both tiers, until `conferences unretire`.** The weekly ingest would otherwise bring it back, because the Linux Foundation still lists it. `scripts/ingest.mjs` skips a slug that is under `removed` in `data/conference-operator.json`, and a hidden slug is written as unavailable again. On tier 2 the Worker also refuses the slug in `PUT /admin/conferences` and `push-ingest.mjs` logs each slug it skipped, unless the document carries `"unretire": true`. `unretire` deletes the `removed` entry of the operator file on both tiers; on tier 2 it also sends the local conference document with `"unretire": true`, so the Worker drops its tombstone, and `"expect_status"`, the status `GET /api/conferences` lists for the slug (or `null` when it is not listed), which the Worker checks inside its write, so a removal or unretire that lands between the CLI's read and its write is refused rather than undone (`status_mismatch` under [Troubleshooting](#troubleshooting)). On tier 2 it sends the document even when the local file has no entry, so you can repair a partly finished removal by running it again; on tier 3 a missing entry exits 4. It then tells you to run `conferences refresh --event <slug>`, which fetches the schedule again and replaces the retired file. Commit `data/conference-operator.json`.

What clients see after `remove`: apps on the tier 1 fallback see the conference gone when they next fetch `conferences.json`, and a bundle already on a device stays until the app replaces it. On tier 2 the Worker's directory cache can still name the slug for up to five minutes, during which the conference answers `400 conference is not available`; on tier 3 the conference cache lasts 60 seconds. [APPS.md](fork/APPS.md#what-an-installed-app-does-when-the-operator-changes-things) gives the files and lines.

### The demo conference

The demo conference is an invented conference for showing the apps when no real conference is on. Its talks, speakers and organisations are made up by `scripts/lib/demo-conference.mjs` (speakers such as "Avery Example, Staff Engineer, Example Corp"), and every abstract says that the session and its speakers are fictional. Its talks are always yesterday, today and tomorrow in its time zone: two rooms with a 45-minute talk every half hour from 07:00 to 23:15, three workshops a day, breaks and a hallway track. So the schedule's now and next, For you, "I'm around" and Around now, Meet up and the people screens always have something live. No people are seeded: you show the people features with real phones.

It can never be taken for a real conference. Its conference document carries `demo: true` (`docs/contracts/talk-bundle.md`, The demo marker), its name contains the word "Demo", its bundle names no licensor of real content, the apps label it Demo wherever its data appears, and its pushes say "Demo". The counts that span conferences leave it out: `stats counts` without `--event` and the document counts of `stats usage` (the index sizes cannot be split). `stats counts --event <its slug>` counts it.

It is off by default. `config/demo-conference.json` holds the switch and the settings:

| Key | Meaning |
|---|---|
| `enabled` | `false` (the default) or `true`. Nothing generates, publishes or refreshes the demo while it is `false`, and `scripts/ingest.mjs` refuses its slug. |
| `slug` | The conference slug, default `caddie-demo-conference`. It must contain `demo`. If you change it, add its folder under `data/` to `.gitignore`, as the default one is. |
| `name` | The name shown in the apps, default `Caddie Demo Conference`. It must contain the word `Demo`. |
| `time_zone` | The IANA zone whose days the talks follow, default `America/Denver`. Use the zone you demonstrate in, because the talks run from 07:00 to 23:15 there. |
| `location` | `city`, `region`, `country` and `virtual`, default `Demo City`. |

The ingest builds the demo only for an explicit `--event <its slug>`, never in `--all-upcoming`, and without any network call. Its talk ids are the same every day (`d1-a10` is always today's 10:00 talk in the main hall), so a daily run only moves the times of the same talks: nothing is re-embedded or deleted, the shrink guard is never involved, and nobody's shared talks change. The operator file applies to it as to any conference.

**Switch it on (tiers 1 and 3).** Do it once the apps that show the Demo label are released: while the demo is on, an app that has not chosen a conference opens on it whenever it is the earliest conference that has not ended.

1. Tier 3 only: deploy this release once (`npm run deploy`). The server's handling of the demo is new: the marker in `GET /api/conferences`, the Demo label in pushes, and the longer lifetime of its profiles (below).
2. Set `"enabled": true` in `config/demo-conference.json`, commit it and push it to `main`. `pages.yml` runs on the push and publishes the demo's talk bundle, which every tier's apps use for the talk features.
3. Tier 3 only: index it once, with its topics and facets, using the operator key: `caddie-admin conferences add --event caddie-demo-conference`.
4. Tier 3 only: mint the narrow key of the scheduled refresh with a short-lived setup key in `ELASTISEARCH_API_KEY`, as in [step 5 of the tier 3 guide](fork/TIER3_GCP_ELASTIC.md#5-the-service-keys-the-push-keys-the-operator-key-and-ending-the-setup-key). It holds read, index and maintenance on `caddie-talks*` and read and index on `caddie-conferences*`: it can write and update those documents but never delete one, and it holds nothing on the people indices. The script checks all of that. Keep it in a GitHub environment that only `main` may use, set the cluster address, then delete the file:

   ```sh
   node scripts/create-es-keys.mjs --demo            # writes ~/.config/conference-caddie/es-demo-key, mode 0600, valid 90 days
   gh api -X PUT repos/<owner>/<repo>/environments/demo-refresh --input - <<'EOT'
   {"deployment_branch_policy": {"protected_branches": false, "custom_branch_policies": true}}
   EOT
   gh api -X POST repos/<owner>/<repo>/environments/demo-refresh/deployment-branch-policies -f name=main -f type=branch
   gh secret set CADDIE_DEMO_ES_API_KEY --env demo-refresh --repo <owner>/<repo> < ~/.config/conference-caddie/es-demo-key
   rm ~/.config/conference-caddie/es-demo-key
   gh variable set CADDIE_ES_URL --repo <owner>/<repo> --body "<your ES_URL>"
   ```

5. Run the refresh once by hand: `gh workflow run demo-conference.yml --repo <owner>/<repo>`. From then on `.github/workflows/demo-conference.yml` runs every three hours. It refreshes the demo on Elasticsearch with `scripts/ingest.mjs --refresh-only`, which skips it when Elasticsearch does not hold it or holds it hidden or removed by an operator, so the schedule never creates it or brings it back. It republishes the bundles when the live ones are stale, unless an ingest or Pages run is already publishing them. Every run is idempotent. Mint a new key before the old one expires.

The demo's data folder under `data/` is generated by every run and ignored by git, so there is nothing to commit for it; `hide` and `unhide` work without it. Its end date is always tomorrow, so on tier 3 a profile, a push registration or a nudge record written for it lasts seven days after that (`DEMO_GRACE_DAYS` in `server/people-shared.mjs`) instead of running out with the rolling end date. Within a week of a demonstration, save the profile again and turn push nudges off and on, so the push registration is renewed too.

**Switch it off.**

1. Set `"enabled": false`, commit it and push it to `main`. `pages.yml` drops the demo from the published index, and the scheduled refresh stops refreshing it.
2. On tier 3, take it off the backend: `caddie-admin conferences hide --event caddie-demo-conference --yes --confirm caddie-demo-conference` keeps its talks, clears its presence and deletes its meet requests and nudges (twice, a minute apart, because the server caches the conference list for 60 seconds, so the command takes a little over a minute), or `caddie-admin conferences remove --event caddie-demo-conference --yes --confirm caddie-demo-conference` deletes everything of it. Either way the server leaves it out of `GET /api/conferences`. Commit `data/conference-operator.json`; the demo's own folder is ignored by git, so the conference file the command names needs no commit. Until this step is done, every scheduled run warns that Elasticsearch still lists the demo.
3. Delete the `CADDIE_DEMO_ES_API_KEY` secret when you no longer need it.

**Tier 2.** The talk bundles carry the demo for the talk features, but the Worker does not yet refresh it every day, so its people features would not work on it. Keep it switched off on a tier 2 deployment for now (`DECISIONS.md`, "The demo conference").

### Stats

```sh
caddie-admin stats counts --event <slug>
caddie-admin stats counts
caddie-admin stats usage
caddie-admin stats health
```

- `counts --event <slug>` prints document counts per index on tier 3 and row counts per table on tier 2. Without `--event` it prints totals per index (tier 3) or requests per conference for the day (tier 2).
- `usage` on tier 2 prints, per conference and in total, the day, requests, rows read, rows written and the pace, which tells you how close you are to the Free plan's limits. On tier 3 it prints cluster health and the document counts and sizes of the indices, from `_cluster/health` and `_cat/indices`. These need the cluster actions `cluster:monitor/health` and `cluster:monitor/state` and the index privilege `monitor` on `caddie-*`, which the operator key holds (it does not hold the named cluster privilege `monitor`, which would also cover inference).
- `health` prints the tier, the Bluetooth mode and the push flags from `GET /api/capabilities` and the health status, then the exact commands: the smoke test (on tier 2 with `ADMIN_TOKEN_FILE` naming the token file, see [First check](#first-check)), and the log-tail command for this backend (on tier 2 `wrangler tail` through a filter, never unfiltered; on tier 3 a `gcloud logging read` of the service's errors).

## The audit log

Every run that gets past reading the config and the credential appends one line to `audit.jsonl`, including previews and refused or failed runs. Runs that stop earlier are not audited: help (`-h`), an unknown area, command or flag, a bad target or `--reason`, and a missing or malformed `config.json` (all usage errors, exit 2). A credential error is not recorded either, because it stops before the command starts. The file is `audit.jsonl` in the config directory, a file the tool creates with mode 0600 (and repairs if it finds wider permissions). It is append-only. A line holds only values that have the shape of their field, so free text cannot get in:

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
| `note` | One of `already_deleted`, `already_unhidden`, `already_unblocked`, `already_retired` or `earlier_attempt_may_have_run`, set when a tier 2 command succeeded but an earlier attempt may have done part of the work (never the `--note` text) |
| `counts` | Numbers only: documents, rows, reports, warnings |
| `flags` | Which of `--text`, `--contact`, `--include-hidden`, `--show-content`, `--all`, `--allow-shrink` and `--purge-local` were used |

It **never** holds `--note` text, the `--name` search text, the text of a `moderation rules test`, a display name, profile text, a contact field, a key, a token, a URL, or the body of a backend's answer. A refused or failed run is recorded too, so you can see what was attempted. The file contains nothing a stranger could use, but it does show which refs and conferences you acted on, so treat it as private and do not publish it.

## Differences between the tiers

| | Tier 2 (Cloudflare Worker) | Tier 3 (Elasticsearch) |
|---|---|---|
| How the tool reaches the backend | HMAC-signed requests to the Worker's `/admin/*` routes | Directly to Elasticsearch with your operator key |
| Credential | The admin token (the HMAC key) | The Elasticsearch admin API key |
| `moderation purge-expired` | Exit 5 (the Worker's cron does it) | Runs `scripts/purge-expired-people.mjs` |
| `moderation rules test`, `reload` | Exit 5 (compiled into the Worker) | Wraps `scripts/moderation-rules.mjs` |
| `conferences add`, `refresh` | Starts the `ingest.yml` workflow (GitHub CLI, default repository) | `scripts/ingest.mjs` then `scripts/build-facets.mjs` |
| `stats usage` | Meters per conference and totals | Cluster health and index sizes |
| `attendees view`, push registrations | `web` only | `web`, `apns` and `fcm` |
| Removal tombstone | Kept by the Worker until `unretire` | The operator file only |
| A retried delete | `<what>: already done (an earlier attempt may have run and its answer was lost; the retry answered not_found)`, exit 0, audit `note` | Not applicable |

## The security model

The aim is the smallest attack surface that still lets you operate the service.

- There is no admin web page, and the tier 3 server has no admin route at all. The server's own routes are all `/api/*`. On tier 3 the tool talks to Elasticsearch with a key that never leaves your computer; the deployed service holds two scoped keys and neither the operator key nor the setup key.
- On tier 2 there is one admin surface: the Worker's `/admin/*` routes. Each request carries `X-Caddie-Admin: v2 <ts> <nonce> <bodySha256> <sig>`, an HMAC over the method, path, query, body hash, time, nonce and the origin of the Worker it is sent to. The tool never signs `v1`, the older version without the origin, which the Worker refuses since step d of the migration unless it is rolled back with `ADMIN_SIG_MIN = "1"`. The token never travels. The Worker checks the signature and the time (within five minutes) before it reads any body, refuses a replayed nonce on every admin path, limits failed signatures per address, answers 404 to anything it does not accept so a scanner learns nothing, and fails closed when no token is configured. A header that leaks from a log works at most once, for minutes, and only on the origin it was signed for.
- The tool never follows a redirect on an admin request and refuses a non-https address except localhost. It refuses a path or a query that would need escaping, so free text always travels encoded. It rebuilds every result row from a list of allowed fields, so a field that a backend adds later is not printed by accident, and it escapes terminal control characters, bidirectional controls and clipboard sequences in anything that came from a person's profile before it prints it, so a hostile display name cannot act on your terminal.
- A credential is read from the environment or from a file in mode 0600, held in memory only, redacted from every message and passed to no other process on its command line or in a URL.
- Destructive commands do nothing without `--yes` and the exact target, and a script must repeat the target with `--confirm`.
- The tier 2 test fixtures under `/admin/test/` answer 404 unless the Worker has the variable `ADMIN_TEST_ROUTES` set to `"1"`; the repository never sets it ([TIER2_CLOUDFLARE.md](fork/TIER2_CLOUDFLARE.md#admin_test_routes-the-smoke-fixtures)).
- Cloudflare Access is an optional extra layer and must never cover the public app (see the rule in [TIER2_CLOUDFLARE.md](fork/TIER2_CLOUDFLARE.md#optional-cloudflare-access-in-front-of-admin)).

## Troubleshooting

**Config or credential errors (exit 2 or 1).** "config not readable" or "has the wrong shape" means `config.json` is missing or malformed; the message prints its path and the expected shape. "no credential" names the variable and the file to set. "has mode 0644; only the owner may read it" means `chmod 600` the file.

**A tier 2 command exits 4 with "no such target" or "refused".** A 404 of the Worker is one of two things, and the CLI tells them apart by the code in the answer. `<what>: no such target (the Worker answered not_found)` (or `no_operator_block`) means the conference, person or block is not there; check the slug and the ref. `<what>: refused: check the admin key, the failed-signature rate limit or the route (the Worker answers 404 "Not found" to each)` means the Worker answered its plain `Not found`, which it gives to a refused signature, to an empty failed-signature bucket, to an unknown route and to a missing nonce alike; the CLI cannot tell which of those it was. Check, in this order: the token in your token file is the one the Worker has (after a rotation, `CADDIE_ADMIN_TOKEN` and the file must hold the new value); the `api` address is the Worker's origin with no path, and an origin the Worker expects (its `workers.dev` hostname, or one listed in its `ADMIN_ORIGIN`), because a version 2 signature made for any other origin is refused like a wrong key; and the Worker is not from before signature v2 (#90), which refuses every version 2 request the same way: deploy it again ([TIER2_CLOUDFLARE.md](fork/TIER2_CLOUDFLARE.md#3-deploy-the-worker), step 3). Confirm the `api` host first, then test with a read-only command such as `stats usage`. Then check that no Cloudflare Access application covers `/admin/*` without your service token, and that the Worker has the routes (a Worker older than this CLI answers `Not found` to a route it lacks). A clock more than five minutes off answers `401` and the CLI says `this machine's clock is more than five minutes from the Worker's`. A replayed request says `the Worker saw this nonce before`. When an earlier attempt of a write failed (a network error or a 5xx) the message ends with `an earlier attempt failed (...); if it reached the Worker it may have done the work`.

**Bad signatures from a CI runner empty the per-address bucket (the W4 runner note).** The Worker lets each address make ten failed signatures a minute, and while that bucket is empty it answers 404 to every admin request from that address, valid or not, for up to a minute (one token returns every six seconds). A CI runner that signs with a stale `CADDIE_ADMIN_TOKEN`, for example after a rotation, does this: the ingest workflow's `push-ingest.mjs` then sees 404 on every admin call. The fix is the secret or the clock, not the Worker: set the repository secret `CADDIE_ADMIN_TOKEN` from your token file (`gh secret set CADDIE_ADMIN_TOKEN --repo <owner>/<repo> < ~/.config/conference-caddie/admin-token`), wait a minute, and run the workflow again. Your own computer's address is a different bucket, so a failing runner does not lock you out.

**`503 daily_limit` on tier 2.** The Worker records every admin request's nonce as a written row, so when the account's daily limit of written rows is reached, every admin call answers 503 until 00:00 UTC, including reads. Check `caddie-admin stats usage` on a day before the limit, or wait.

**`removal_incomplete`.** A tier 2 removal has several steps (the tombstone, the wipe, the directory row). If it stops between them, the command exits 1 with `removal incomplete at step <step> (status <n>; retired <true|false>, wiped <true|false>; cause: ...)` and either `run the removal again after <n> seconds (Retry-After)` or `run the removal again (after the Retry-After the Worker sent, if any)`. Run the same `conferences remove` again. A removal that is run again finishes the rest and says the slug was already retired.

**`removal_superseded`.** An `unretire` ran while the removal was in progress. The command exits 1 with a message that begins `an unretire overtook the removal of <slug> at step <wipe|directory>`, says what was and was not deleted and whether the directory holds a tombstone, says `nothing further was done`, and gives two commands with your flags filled in, written `caddie-admin conferences remove --event <slug> ... --yes --confirm <slug>` and `caddie-admin conferences unretire --event <slug> --yes --confirm <slug>`. Which of them it offers depends on the step: after a `wipe` step the conference is live as the unretire left it and you choose between removing it after all and keeping it; after a `directory` step the object was wiped and you choose between finishing the removal and restoring the conference. The tool does nothing more on its own. The audit log records the code `removal_superseded`.

**`unretire` of a conference.** After a removal, `conferences unretire --event <slug> --yes --confirm <slug>`, then `conferences refresh --event <slug>` (tier 2 starts the ingest workflow, tier 3 ingests locally), then commit `data/conference-operator.json` and the rewritten `data/<slug>/conference.json`, and let `pages.yml` run. If it answers `unretire_incomplete`, the Worker could not finish dropping the tombstone in every place: run the same command again. On tier 3, "is not removed" (exit 4) means the operator file has no `removed` entry for the slug, because it was not removed from this clone; pull the latest commits or check `data/conference-operator.json`.

**`status_mismatch` (a tier 2 unretire, exit 1).** Before it writes, `conferences unretire` on tier 2 reads `GET /api/conferences` and sends `expect_status` with the document: the status the listing shows for the slug, or `null` when the slug has no row (the listing shows every directory row, tombstoned or not, so a slug it does not list has none). The Worker checks it inside its write. When the row holds another status, because a removal or another unretire landed between the read and the write, the Worker answers `409 status_mismatch` and writes nothing. The command exits 1 with the code `status_mismatch` (in the audit log and the `--json` error), does not retry, and leaves the local files as they were. The message begins `unretire of <slug> not applied: the directory holds another status than this command expected (expected→actual):` and names each slug as `slug expected→actual`, with `(no row)` for `null` (for example `my-conf-2026 searchable→(no row)` after a removal finished). It then says `nothing was written by this attempt` and ends with one of three things:

- `something else changed the conference after this command read it (another remove, unretire, hide or unhide, or an ingest run)`: check it with `caddie-admin conferences list --all`, and run `conferences unretire` again only if it is still wanted.
- `an earlier attempt of this command <answer> and may have been applied`, or `earlier attempts of this command may have been applied (<answers>)`, where each answer is one such as `got no answer (ECONNRESET)` or `answered status 502 (...)`: every slug already holds the status this command sent, so an earlier attempt whose answer did not arrive may be what set it. Run `conferences unretire --event <slug>` `again until it answers 200: each run re-reads the status and expects that`.
- `so the Worker and this CLI are not from the same version; do not run the unretire again until they are`: the Worker answered a status that a directory row never holds in this CLI's version. Deploy the Worker and run the CLI from the same version of the repository first; a re-run before that cannot help.

A re-run reads the listing again and expects what it finds. There is no `--expect-status` override: the listing and the row agree, so a re-run that still mismatches has met a real change, which you look at rather than override. An automatic retry differs only after an answer that proves the first attempt was stored (a `502 unretire_incomplete`, or a 2xx whose body was lost): it then expects the stored status, so it finishes the unretire instead of refusing it.

**`not applied (retired)` (a tier 2 unretire, exit 1).** `unretire of <slug> not applied (retired): the Worker answered status 200 and listed <slug> under skipped_retired`, with the code `skipped_retired`, means the Worker kept the tombstone and applied nothing of the document, which only a Worker without the `unretire` flag does. No local file is written. Deploy the current Worker ([TIER2_CLOUDFLARE.md](fork/TIER2_CLOUDFLARE.md#3-deploy-the-worker)), then run the unretire again.

**`unretire_refused` (a tier 2 unretire, exit 1).** The command read the listing and sent nothing, for one of two reasons:

- `<slug> is listed on the Worker as <status>, and the unretire would send it as <status>; refused, because that would change a live conference`: the local `data/<slug>/conference.json` has another status than the listed one. Change the status with `conferences hide`, `unhide` or `refresh`, or update the local file first.
- `<slug> is listed on the Worker as <status>, which is not one status a directory row stores (searchable or unavailable), so this command cannot tell what to expect; refused, nothing was sent`: the listing shows the slug with a status a directory row never stores, or shows it twice with two statuses. Check `GET /api/conferences`, and that the Worker and this CLI are from the same version.

**"already done".** On tier 2 a write that failed with a network error or a 5xx is retried with a fresh signature, and the first attempt may have reached the Worker. If the retry then answers `not_found`, the tool prints `<what>: already done (an earlier attempt may have run and its answer was lost; the retry answered not_found)`, exits 0 and records the audit `note`. A not-found answer on a first attempt is a real `no such target` (exit 4): the ref or slug was wrong.

**A command exits 1 with a warning after a delete.** On tier 3 the second pass of a profile delete is best effort. The profile is already gone; the warning says what could not be done. Run `caddie-admin moderation purge-expired --yes --confirm purge-expired` or `npm run people:purge` to finish it.

**`conferences add` or `refresh` fails on tier 2 with "gh could not start" or "gh exited".** Install the GitHub CLI, run `gh auth login`, and make sure `gh repo set-default` names your fork. The ingest workflow needs the secret `CADDIE_ADMIN_TOKEN` and the variable `CADDIE_API_BASE` in the repository.

**`stats usage` fails on tier 3 with a 403.** The key lacks the cluster actions `cluster:monitor/health` and `cluster:monitor/state`, or the index privilege `monitor` on `caddie-*`, which `_cluster/health` and `_cat/indices` with document counts need. The operator key from `scripts/create-es-keys.mjs --operator` has them; mint a new one if yours came from elsewhere.

**The Worker refuses a refresh with 409 (a short feed).** Finalize refuses to delete more than 10 talks and more than 10 percent of a conference's talks, so that a short feed cannot erase people's sharing. If the schedule really shrank, run `conferences refresh --event <slug> --allow-shrink`.

## Key rotation

**Tier 2.** The admin token is the HMAC key. Rotate it with `node worker/scripts/setup-secrets.mjs --rotate-admin-token`, then the two finishing commands it prints. The Worker accepts the old and the new token during the change, so no client is ever refused. The new value goes to your token file and the repository secret; copy it to any other computer that runs the CLI. The full procedure and the recovery cases are in [TIER2_CLOUDFLARE.md](fork/TIER2_CLOUDFLARE.md#rotating-the-admin-token).

**Tier 3.** The operator key expires by itself (90 days unless you chose another time), which is the rotation reminder. To rotate it, make a short-lived setup key as in [TIER3_GCP_ELASTIC.md](fork/TIER3_GCP_ELASTIC.md#2-elastic-deployment-a-short-lived-setup-key-and-the-inference-endpoint), move the old file away (`d="${CADDIE_ADMIN_HOME:-${XDG_CONFIG_HOME:-$HOME/.config}/conference-caddie}"; mv -n "$d/es-admin-key" "$d/es-admin-key.old"`, because the script never overwrites a key file; `-n` leaves an older `.old` file in place rather than overwrite it, and the script then refuses to run until you have dealt with both), run `node scripts/create-es-keys.mjs --operator`, check that `caddie-admin stats usage` works, then invalidate the old key (Elastic's `DELETE /_security/api_key`, or Kibana's API keys page), delete the `.old` file and end the setup key. The deployed service holds neither of these. To rotate the two scoped keys that the service holds, run `GC_PROJECT=<id> node scripts/create-es-keys.mjs --only caddie-es-readonly` (or `caddie-es-people`) with a setup key in `ELASTISEARCH_API_KEY`, deploy again with `npm run deploy` so the new secret version is mounted, and invalidate the old key.

After any suspected leak, rotate first, then look at `audit.jsonl` and your Cloudflare or Elastic logs for activity you do not recognise.
