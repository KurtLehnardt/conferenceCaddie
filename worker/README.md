# Conference Caddie API on Cloudflare (the free stack)

This directory holds the free hosting of Conference Caddie: one Cloudflare Worker,
`conference-caddie`, that serves the web app as static assets and the API on the same origin
(`https://conference-caddie.krlehnardt.workers.dev`), with SQLite-backed Durable Objects for all
storage (FTS5 for keyword search, float32 vectors with brute-force cosine in code), Workers AI for
embeddings, a Cron Trigger for purges and expiry, and VAPID Web Push sent from the Worker. GitHub
Pages publishes only the public talk bundles and a landing page that links to the app; the app is
not served there, because that origin is shared with other sites (docs/FREE_HOSTING.md, Where the
app lives).

Static assets come from `web/dist-worker/`, the Worker-mode build (`npm --prefix web run
build:worker`), as `[assets]` in `wrangler.toml` says. They never run the Worker's code: only
`/api`, `/admin` and their subpaths do (`run_worker_first`), and any other path with no file gets
`index.html`, so deep links work. Their headers (Content-Security-Policy, the other security
headers and Cache-Control) come from the `_headers` file that build writes. Build the app before
any `wrangler dev` or `wrangler deploy`, or wrangler refuses the missing directory.

The Cloud Run plus Elasticsearch stack in `server/` and `scripts/deploy.sh` is unchanged and stays
deployable from `main`. `worker/` is listed in `.gcloudignore` and `.dockerignore`, so the Cloud
Run upload and image never include it.

## Requirements

- Node 22 or later. Wrangler is a dev dependency of `worker/package.json`; always run it as
  `npx wrangler`, never from a global install.
- `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` in the environment. The token needs the
  account permissions "Workers Scripts: Edit" (deploy, secrets, Cron Triggers, Durable Objects)
  and "Workers AI: Read" (or Edit), plus "Workers Tail: Read" for the CPU readings in
  [Logs and CPU](#logs-and-cpu). If the token cannot read or create the account's `workers.dev`
  subdomain, create the subdomain once in the dashboard. D1, KV, Vectorize and Pages are not used. A token that can
  list Workers but answers 403 "No access to the specified resource" on
  `/workers/scripts/<name>` lacks "Workers Scripts: Edit"; `deploy.sh` says so when it fails.
- The GitHub CLI (`gh`), logged in with access to `KurtLehnardt/conferenceCaddie`, for the
  repository secret, variable, Pages and workflow steps.

Never print a token, a secret or a device secret: no `set -x`, no `curl -v`, no `env` or
`printenv`, and no unfiltered `wrangler tail` (see [Logs and CPU](#logs-and-cpu)).

## Local run

```sh
npm --prefix web ci && npm --prefix web run build:worker   # the app, into web/dist-worker/
cd worker
npm ci
node scripts/dev-vars.mjs            # writes the git-ignored .dev.vars (EMBED_FAKE=1 unless --real-ai)
npx wrangler dev --local --port 8787
```

The app and the API are then both on http://localhost:8787 (`npm run dev` in `worker/` does the
build and the start in one go). Rebuild the app after a change under `web/`; wrangler picks up
the new files. For hot reload while working on the app, run the Vite dev server instead
(`npm --prefix web run dev`, which proxies `/api` to port 8080; point it at the Worker by changing
`server.proxy` locally, or build with `VITE_API_BASE=http://localhost:8787`, an origin the
Worker allows through `ALLOWED_ORIGINS`).

- `.dev.vars` holds development-only values: a random `ADMIN_TOKEN` and `REF_SALT`, a fresh VAPID
  pair, `ADMIN_TEST_ROUTES=1` (the smoke's `/admin/test/*` fixtures, which a deployed Worker serves
  only when that variable is `"1"`; see [Smoke](#smoke)) and `EMBED_FAKE=1`. With `EMBED_FAKE=1`
  embeddings are deterministic feature-hashed vectors and no Workers AI call is made. Running
  `dev-vars.mjs` again adds a name the file lacks and keeps the ones it has. After pulling the
  change that added `ADMIN_TEST_ROUTES`, re-run `npm --prefix worker run dev-vars` (or add
  `ADMIN_TEST_ROUTES=1` to your existing `.dev.vars` by hand): without it the local smoke silently
  skips its fixture checks, because the local Worker answers 404 to them.
- Real embeddings in a local run (needed for the smoke's semantic checks): `wrangler dev --local`
  cannot reach the AI binding, and a remote dev session cannot be authenticated with an account
  API token, so the Worker sends its embedding calls to a small local proxy instead:

  ```sh
  node scripts/dev-vars.mjs --real-ai          # drops EMBED_FAKE, sets EMBED_PROXY=http://127.0.0.1:8786
  node scripts/dev-ai-proxy.mjs --port 8786 &  # forwards to the Workers AI REST API (spends neurons)
  npx wrangler dev --local --port 8787
  ```

  The proxy reads `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` from its own environment, so
  the token never enters the Worker or `.dev.vars`. `node scripts/dev-vars.mjs` without
  `--real-ai` switches back to fake vectors. `EMBED_PROXY` is never set in `wrangler.toml`. The
  proxy forwards the Worker's `pooling: "cls"`, so local vectors match the deployed Worker's and
  the talk bundles' (`src/lib/embed.js`, Embedding conventions).
- Bluetooth derived tokens v1 in a local run: `node scripts/dev-vars.mjs --ble` adds a random
  development `BLE_MASTER_KEYRING`; without it the local Worker serves legacy tokens only
  (`ble.mode: server-rotate` in `GET /api/capabilities`). `node scripts/ble-parity.mjs` checks the
  Worker's Bluetooth code against `contracts/fixtures/ble/` with no Worker running.
- `npm test` in `worker/` runs the Worker's unit tests (`test/*.test.mjs`, node:test with
  node:sqlite and no Worker running), such as the usage meter's test with several instances
  sharing one database. They need Node 22.13 or later (node:sqlite without a flag). The root
  `npm test` also runs them, and CI runs the root `npm test` in `test.yml`.
- Parallel local runs use port 8787 plus a task number, so they do not collide.
- To exercise the Cron Trigger, start with `npx wrangler dev --local --port 8787 --test-scheduled`
  and request `http://localhost:8787/__scheduled?cron=*/10+*+*+*+*`.
- To call the admin routes of a local run, load the development token into the shell without
  echoing it:

  ```sh
  export ADMIN_TOKEN="$(sed -n 's/^ADMIN_TOKEN="\{0,1\}\([^"]*\)"\{0,1\}$/\1/p' worker/.dev.vars)"
  ```

  Then load data with the migration script below, pointing `--api` at `http://localhost:8787`.
  The scripts sign every admin request with the token ([Admin requests](#admin-requests)); the
  token itself is never sent, and a request that carries it as a bearer gets 404.
- Without the backup (which holds personal data and should not be loaded on a laptop), load the
  committed talk data instead. Leave out `--event`, so every conference document is pushed: the
  smoke's check `u` needs the conferences that are not searchable. The test profiles the smoke
  needs are created by the smoke itself.

  ```sh
  node worker/ingest/push-ingest.mjs --api http://localhost:8787
  ```

- The Worker always accepts its own origin. To call it from a web app on another local port
  that `wrangler.toml` does not list, add that origin to the local allow-list, for example
  `node scripts/dev-vars.mjs --set ALLOWED_ORIGINS=http://127.0.0.1:8792,http://localhost:4173`,
  and run the smoke with `SMOKE_ORIGIN` set to the same origin. Values in `.dev.vars` override
  `[vars]` only in local runs.

## Deploy order

Run these from the repository root, in this order. Each step is safe to repeat.

1. **Build the app and deploy the Worker.**

   ```sh
   bash worker/scripts/deploy.sh
   ```

   The script makes sure the account has a `workers.dev` subdomain (it reads it with the
   Cloudflare API and, when there is none, creates the one named by the optional environment
   variable `CADDIE_WORKERS_SUBDOMAIN`, or `conference-caddie-<6 random letters>` when the variable
   is unset or that name is taken; an account that already has a subdomain keeps it, whatever the
   variable says), builds the web app in Worker
   mode into `web/dist-worker/`, then runs `npx wrangler deploy`, which uploads the app with the
   Worker. It prints only the subdomain and the app URL, which is also the API's base. Until
   step 2 has run, the admin routes answer 404, because admin fails closed without `ADMIN_TOKEN`.

   If the token cannot read or create the subdomain (HTTP 403 from the subdomain API), create it
   once in the Cloudflare dashboard (Workers & Pages, Overview, `workers.dev` subdomain) and run the
   script again. `bash worker/scripts/deploy.sh --subdomain-only` checks only this step.

2. **Install the secrets.**

   ```sh
   node worker/scripts/setup-secrets.mjs --dry-run        # names and target commands only
   node worker/scripts/setup-secrets.mjs --only-missing
   ```

   It generates `ADMIN_TOKEN` and `REF_SALT` (32 random bytes each, hex) and a VAPID P-256 pair
   with Web Crypto, and writes each value to the standard input of `npx wrangler secret put NAME`,
   never to a command line, a log or the terminal. `ADMIN_TOKEN` also goes to
   `gh secret set CADDIE_ADMIN_TOKEN` (for the ingest workflow) and to
   `~/.config/conference-caddie/admin-token` with mode 0600 (for the smoke, migration and
   moderation runs). `--only-missing` skips names the Worker already has. An existing `REF_SALT`
   is kept unless `--rotate-ref-salt` is given, because changing it changes every person's ref.
   The first `BLE_MASTER_KEYRING` (Bluetooth derived tokens v1, one random master) is created
   when the Worker has none and never replaced; rotate it by hand (docs/FREE_HOSTING.md).
   The output names secrets only. The GitHub secret goes to the repository in `CADDIE_GH_REPO`
   (`<owner>/<name>`) or, when that is unset, the github.com repository that the git remote
   `origin` of the clone names (https or ssh form, parsed strictly; it is printed before anything
   is changed); if neither works the script stops and names the variable (`--skip-gh` needs
   neither). `gh repo view` is not used, because in a clone made by `gh repo fork --clone` it names
   the original repository (`upstream`), not the fork. To replace `ADMIN_TOKEN` later without an
   outage, see [Rotating the admin token](#rotating-the-admin-token).

   For a fork or a copy, also edit `VAPID_SUBJECT` in `worker/wrangler.toml` (the contact the push
   services receive: an `https:` URL or a `mailto:` address; it names this repository's page), set
   `TALKS_BUNDLE_BASE` in its `[vars]` to your own bundle address (the capabilities document's
   `talks.bundle_base` defaults to `https://kurtlehnardt.github.io/conferenceCaddie/bundles/`,
   `src/capabilities.js`), and see the repository variables `CADDIE_SITE_URL`,
   `CADDIE_BUNDLE_BASE` and `CADDIE_TAKEDOWN_URL` of `.github/workflows/pages.yml`, which override
   the addresses it derives from the repository.

3. **Migrate the data** from the Elasticsearch backup (one time).

   ```sh
   export CADDIE_APP_URL=https://conference-caddie.krlehnardt.workers.dev   # the URL deploy.sh printed
   export CADDIE_API_BASE="$CADDIE_APP_URL"
   export ADMIN_TOKEN_FILE=~/.config/conference-caddie/admin-token
   node worker/ingest/migrate-from-backup.mjs --backup data/exports/backup-2026-11-10T08-25-32 --api "$CADDIE_API_BASE" --dry-run
   node worker/ingest/migrate-from-backup.mjs --backup data/exports/backup-2026-11-10T08-25-32 --api "$CADDIE_API_BASE"
   ```

   Conferences, talks, topics and facets are copied as they are, so topic ids stay identical.
   Only sample profiles are copied by default (`--include-real` copies the others too); presence,
   location and Bluetooth fields are never copied; embeddings are recomputed in the Worker. The
   script prints counts only. `data/exports/` is git-ignored and must stay that way, because the
   backup holds personal data.

4. **Set the repository variables and publish the talk bundles on GitHub Pages.**

   ```sh
   gh variable set CADDIE_APP_URL --body "$CADDIE_APP_URL"
   gh variable set CADDIE_API_BASE --body "$CADDIE_API_BASE"
   gh api -X POST repos/KurtLehnardt/conferenceCaddie/pages -f build_type=workflow \
     || gh api -X PUT repos/KurtLehnardt/conferenceCaddie/pages -f build_type=workflow   # on HTTP 409
   gh workflow run pages.yml
   ```

   The Pages workflow publishes only the talk bundles (docs/BUNDLES.md), `conferences.json`, the
   tier 1 `capabilities.json` and a landing page with no script that links to `CADDIE_APP_URL`. It
   does not need the Worker and runs on every push to the data or the bundle builder, so the native
   apps can fetch the bundles before the Worker is deployed. The weekly talk ingest
   (`.github/workflows/ingest.yml`) uses `CADDIE_API_BASE` and the `CADDIE_ADMIN_TOKEN` repository
   secret; start it by hand with `gh workflow run ingest.yml`.

5. **Run the smoke** against the live Worker (next section).

6. **Regenerate the demo QR code** for the new app URL, and commit it through a pull request:

   ```sh
   node worker/scripts/make-qr.mjs --app-url "$CADDIE_APP_URL"
   ```

   It writes `docs/demo/qr-kubecon.png` (1280 px) and `qr-kubecon.svg`, high error correction,
   for `<app URL>/e/kubecon-cloudnativecon-north-america-2026`, with a pinned one-off `npx`
   QR code tool, so the repository gains no dependency.

## Smoke

The smoke script in `scripts/smoke.mjs` is the only verification. Against the free stack:

```sh
BASE_URL="$CADDIE_APP_URL" \
ADMIN_TOKEN_FILE=~/.config/conference-caddie/admin-token \
SMOKE_ADMIN_AUTH=signed \
node scripts/smoke.mjs
```

`BASE_URL` is the app, and the API defaults to the same origin. The admin token makes it a Worker
run (without one, set `SMOKE_API=worker`); the smoke then uses the `/admin/test/*` fixtures (see
below), sends the app's own origin as `Origin` (`SMOKE_ORIGIN` changes it), checks the static files' security
and cache headers (`host1`), and scans `web/dist-worker/` for leaked keys (`SMOKE_DIST` changes
it). For a local run, build the app with `npm --prefix web run build:worker`, start
`npx wrangler dev --local --port 8787` as above, load the data, and use
`BASE_URL=http://localhost:8787`.

The four `/admin/test/*` routes (`POST` and `DELETE /admin/test/profile`,
`POST /admin/test/age-presence`, `POST /admin/test/meter-restart`) are the smoke's fixtures. The
Worker serves them only when its variable `ADMIN_TEST_ROUTES` is the string `"1"`; otherwise they
answer 404, to a correctly signed request as to any other, before the conference is looked up.
`wrangler.toml` does not set the variable and `dev-vars.mjs` writes it into `.dev.vars`, so a local
run has every check, while against the deployed Worker the smoke prints SKIP, naming the variable,
for the checks that need a fixture (`meter1`, the expired profile, the aged presence and `unav1`)
instead of FAIL, once it sees that `GET /admin/stats` answers 200 with the same credentials. To
run them against the deployed Worker, deploy once with the variable and once without:
`cd worker && npx wrangler deploy --var ADMIN_TEST_ROUTES:1` (the app already built by an earlier
`deploy.sh`), run the smoke, then `bash worker/scripts/deploy.sh` again, because every wrangler
deploy replaces the Worker's variables with those of `wrangler.toml`. Never set it with
`wrangler secret put`: a secret survives every deploy, so the fixtures would stay on until someone
deleted it.

`SMOKE_ADMIN_AUTH=signed` makes the smoke sign its admin calls ([Admin requests](#admin-requests)).
Its default is still the old bearer, which this Worker answers with 404, until the smoke's own
change makes signing the default.

The Cloud Run command line is unchanged: `BASE_URL=<Cloud Run URL> node scripts/smoke.mjs`.

## Admin requests

Every request to an `/admin/*` route carries one header and no other credential:

```
X-Caddie-Admin: v1 <ts> <nonce> <bodySha256> <sig>
```

`ts` is the Unix time in seconds, `nonce` 16 random bytes as base64url (22 characters),
`bodySha256` the lowercase hex SHA-256 of the body bytes (for GET, HEAD and DELETE the hash of the
empty body), and `sig` the lowercase hex HMAC-SHA256, keyed with the admin token after trimming,
over the lines `caddie-admin-v1`, the method, the path with its query, `bodySha256`, `ts` and
`nonce`, each followed by a newline. The token never travels. A header that leaks from a log can
be used at most once, for the same method, path, query and body, and only while its timestamp is
within five minutes of the Worker's clock. `scripts/lib/admin-sign.mjs` signs and
`src/lib/admin-auth.js` verifies; both are tested against `test/fixtures/admin-sign.v1.json`. The
signer refuses a path or query that would be percent-encoded, so both sides always sign the same
bytes, and flags such as `allow_shrink` travel in the JSON body, which the hash covers.

The Worker checks, in this order: an `Origin` header, an `ADMIN_TOKEN` of at least 32 characters,
the shape of the header, the empty-body hash on GET, HEAD and DELETE, the failed-auth limit of the
caller's address, and the signature, which it compares in constant time with `ADMIN_TOKEN` and,
during a rotation, `ADMIN_TOKEN_NEXT`. Any failure so far answers `404 {"error":"Not found"}`, as
an unknown path does, and the body has not been read. A valid signature whose timestamp is more
than 300 seconds from the Worker's clock answers `401 admin_skew`. Only then does the Worker read
the body (at most 4 MB). It checks the clock again once the body is in, because a body can be
held back for any time, and answers `401 admin_skew` for a timestamp that has left the window
meanwhile. Then it hashes the body: another hash than the signed one answers `401 admin_body`.
It forwards the bytes it read, with the verified nonce and timestamp, to the Durable Object. The
object refuses a timestamp more than 305 seconds from its own clock (`401 admin_skew`), then
records the nonce in its own `admin_nonces` table before any handler runs and answers
`401 admin_replay` to a nonce it has seen; it keeps nonces for 15 minutes from their signed time,
so every nonce it accepts is one it would still remember. A 401 needs a valid signature: it
comes back to a key holder, or to someone replaying a captured header while its timestamp is
still fresh, who can see `admin_skew`, `admin_body` or `admin_replay`; everyone else gets 404.
The `Authorization` header is not read.

Recording the nonce writes a row, so once the account's daily written-rows limit is reached every
admin request, `GET /admin/stats` and `GET /admin/moderation` included, answers
`503 {"error":"daily_limit"}` until 00:00 UTC. The check fails closed: a read does not skip the
nonce. The cron records no nonce and keeps its meter readings (`src/lib/meter.js`).

The clients that sign are `worker/ingest/push-ingest.mjs`, `topics-local.mjs` and
`migrate-from-backup.mjs` (through `adminClient` in `worker/ingest/lib.mjs`),
`worker/scripts/moderation.mjs` and the smoke (with `SMOKE_ADMIN_AUTH=signed`); the `caddie-admin`
CLI signs with the same module once it gains its Worker backend. They read the token from
`ADMIN_TOKEN` or `ADMIN_TOKEN_FILE`, and their `--api` base must be the Worker's origin, with no
path, over https (plain http for localhost only). `adminClient` and `moderation.mjs` never follow a
redirect: fetch drops only `Authorization` on a cross-origin redirect, so following one would hand
the signed header and the Access secret to another origin; a 3xx answer is an error as soon as its
headers arrive, never retried. The smoke (`scripts/smoke.mjs`) still follows redirects until its own
change lands, so point it only at the Worker's own origin. A retry is signed afresh with a new nonce
and timestamp, so it is a new request to the Worker, and every admin route handles a repeated
request idempotently, with one exception: `POST /admin/moderation` with `"action": "delete"` answers
404 when the target is already gone, so a delete whose first answer was lost reports 404 on the
retry. When both `CF_ACCESS_CLIENT_ID` and `CF_ACCESS_CLIENT_SECRET` are set, `adminClient` and
`moderation.mjs` also send them as `CF-Access-Client-Id` and `CF-Access-Client-Secret`, for a
Cloudflare Access application in front of `/admin/*`; the Worker does not check them, and the
signature stays the check that matters. To rotate the token without an outage, see
[Rotating the admin token](#rotating-the-admin-token).

A failed signature takes one token from a bucket of ten per minute per `CF-Connecting-IP`, and an
empty bucket makes the Worker answer 404 before it computes anything; valid requests never take
from it. The buckets live in each Worker isolate and protect CPU, not the key. The symptom to
recognise: if a CI runner's address sends ten bad signatures within a minute, for example with a
stale `CADDIE_ADMIN_TOKEN` after a rotation, every admin call from it, valid or not, answers 404
until the bucket refills (one failure's worth every six seconds, all ten within a minute), so
`push-ingest.mjs` reports 404s on every admin call. A clock far off shows up as `401 admin_skew`
instead, because the timestamp is checked only after a valid signature. Either way the fix is the
secret or the clock, not the Worker.

A Worker from before signed admin requests reads only the bearer, and the clients from that change
on send only the signature, so rolling the Worker back means rolling the clients back too: run
`push-ingest.mjs`, `migrate-from-backup.mjs`, `topics-local.mjs` and `moderation.mjs` from the
commit before the merge (and revert the merge on `main`, so the weekly ingest sends the bearer
again), and run the smoke with `SMOKE_ADMIN_AUTH=bearer`. Otherwise every ingest and moderation call
gets a 404 that looks like a wrong token. The `admin_nonces` table and its index stay in the objects
and are harmless to the older code, which never reads them. After a rollback the conference objects
stay at `schema_version` 3, so the next schema change must use version 4: a later change that bumps
to 3 again would be skipped silently, because `migrate()` in `src/schema.js` does nothing when the
stored version is at least `SCHEMA_VERSION`.

### Rotating the admin token

The Worker verifies a signature with `ADMIN_TOKEN` and, when `ADMIN_TOKEN_NEXT` is also set (at
least 32 characters after trimming), with that one too. It still needs a valid `ADMIN_TOKEN`:
without one every admin request answers 404, whatever `ADMIN_TOKEN_NEXT` holds. A rotation starts
with one command and ends with two. Each step of the script leaves the token file and the
repository secret holding a value the Worker accepts, so no client is refused, as long as the
Worker has no `ADMIN_TOKEN_NEXT` yet when it starts (see the end of this section for the case where
it has). From the repository root, with `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` set:

```sh
node worker/scripts/setup-secrets.mjs --rotate-admin-token --dry-run   # names only, changes nothing
node worker/scripts/setup-secrets.mjs --rotate-admin-token
```

The script generates 32 random bytes as hex and, in this order: puts them as `ADMIN_TOKEN_NEXT`
(`npx wrangler secret put`, on standard input, no trailing newline), which makes the Worker accept
the old and the new token; writes them to `~/.config/conference-caddie/admin-token` (mode 0600,
`ADMIN_TOKEN_FILE` changes the path), only after the Worker put succeeded; and sets the repository
secret `CADDIE_ADMIN_TOKEN` (`--skip-gh` leaves it). It never prints the value, and it does nothing
else: no other secret is touched, and it cannot be combined with `--only-missing` or
`--rotate-ref-salt`. It prints where the repository secret goes before it changes anything, then
the two commands that finish the rotation, which you run from
`worker/` once any running ingest or smoke has finished (a client signs with the token it read when
it started), in this order:

```sh
cd worker
npx wrangler secret put ADMIN_TOKEN < ~/.config/conference-caddie/admin-token
npx wrangler secret delete ADMIN_TOKEN_NEXT
```

Run the `delete` only after the `put` succeeded, and never print the token file. If a step of the
script fails, it says which state that left: after the Worker step nothing changed, so run it
again; after the file step the Worker holds an `ADMIN_TOKEN_NEXT` that was saved nowhere and the old
token still works everywhere, so run it again with `--replace-next` (the second run would
otherwise stop, because `ADMIN_TOKEN_NEXT` is now set); a put can store its value and still fail (a
timeout), which the next run then meets as an `ADMIN_TOKEN_NEXT` that is already set; after the
repository-secret step the file holds the new value and `CADDIE_ADMIN_TOKEN` the old one (or the
new one, if the set went through before it failed), so run the
`gh secret set CADDIE_ADMIN_TOKEN --repo <owner>/<name> < <token file>` command it prints before the
two finishing commands. Running `setup-secrets.mjs --only-missing` at any point is safe: it never
looks at `ADMIN_TOKEN_NEXT`, and only because the Worker accepts both keys during the overlap, a run
that skips `ADMIN_TOKEN` or sets a missing repository secret from the file still leaves every
client with a token the Worker accepts. A stale `CADDIE_ADMIN_TOKEN` after the last command is the
failed-signature symptom described above. Every value the script writes has no whitespace around
it, the Worker trims each secret it reads, and the clients trim what they read.

If the Worker already has an `ADMIN_TOKEN_NEXT`, an earlier rotation was started, and the script
exits 1 without changing anything: replacing its value would make the Worker refuse a token file
and a repository secret that may hold exactly that value. It cannot read the Worker's or GitHub's
secrets, so it cannot tell where the earlier rotation stopped, and it leads with one recipe that is
safe wherever it stopped: it makes the value in the token file the only admin token, everywhere. It
prints it with the resolved repository and the real path, never the value:

```sh
gh secret set CADDIE_ADMIN_TOKEN --repo <owner>/<name> < ~/.config/conference-caddie/admin-token
cd worker
npx wrangler secret put ADMIN_TOKEN < ~/.config/conference-caddie/admin-token
npx wrangler secret delete ADMIN_TOKEN_NEXT
```

Run the three in this order, once any running ingest or smoke has finished, and only if the token
file holds the token your clients should use. A new rotation then starts normally. If the token file
is missing, empty or shorter than 32 characters, the script does not print the recipe (with a bad
file it would make the Worker refuse every admin request) and says to stop: put the value you last
set back into the file from your own copy, then run the command again.
`--replace-next` is the other way on, for someone who wants to keep rotating without finishing the
earlier rotation first: until the run has been through all three steps, the token file and the
repository secret may hold the old `ADMIN_TOKEN_NEXT`, which the Worker then no longer accepts, and
the output says so at every failure point (after a failed put, that the put may have gone through
and that the command should be run again at once). It is refused with `--skip-gh` and without
`--rotate-admin-token` (exit 2). A plain run (without `--rotate-admin-token`) that finds an
`ADMIN_TOKEN` replaces it outright, with no overlap: if its GitHub step fails, the ingest is refused
until the secret is set, and the output says so. The same recipe is in docs/FREE_HOSTING.md
(Operations runbook).

## Moderation

Two reports from different people hide a profile, a spot line or a meet. The operator reviews and
undoes or confirms hides with `worker/scripts/moderation.mjs`, which calls
`GET` and `POST /admin/moderation`, signing each request with the admin token from `ADMIN_TOKEN`
or `ADMIN_TOKEN_FILE` (default `~/.config/conference-caddie/admin-token`):

```sh
export CADDIE_API_BASE=https://conference-caddie.krlehnardt.workers.dev
node worker/scripts/moderation.mjs --event <slug> --hidden
node worker/scripts/moderation.mjs --event <slug> --since 2026-11-10T08:00:00Z
node worker/scripts/moderation.mjs --event <slug> --hidden --show-content
node worker/scripts/moderation.mjs --event <slug> --unhide profile:<ref>
node worker/scripts/moderation.mjs --event <slug> --delete spot:<ref>
node worker/scripts/moderation.mjs --event <slug> --delete meet:<meet id>
node worker/scripts/moderation.mjs --event <slug> --purge
```

By default the output holds kinds, refs, meet ids, times and report counts only. Display names and
report reasons are printed only with `--show-content`. Profile ids, reporter ids and the token are
never printed. `--unhide` also removes the target's reports, so it needs two new ones to be hidden
again. `--delete profile:<ref>` deletes the profile everywhere, as a profile delete does.
`--purge` deletes the reports of a conference that has ended.

The word list in `config/moderation-words.json` is compiled into the Worker; changing it needs a
deploy.

## Logs and CPU

The Worker logs one line per request (method, path template, status and duration) and never a
body, header value, query text, profile field or token. Workers Logs keeps those lines with
invocation logs turned off, because invocation logs can record the `X-Caddie-Device` header.

`wrangler tail` is only ever run through a filter. Its raw output can show request headers,
including device secrets, so never run it on its own or with `--format pretty`. Save this filter
outside the repository (for example in a scratch directory) as `tail-filter.mjs`:

```js
// Prints the outcome, CPU time, wall time, method and a path template of each tail event, and
// nothing else: no headers, query strings, bodies or log lines.
import readline from 'node:readline';

const template = (url) => {
  let path;
  try { path = new URL(url).pathname; } catch { return '(unparsable)'; }
  if (!/^\/(api|admin)\//.test(path)) return '(other)';
  return path.split('/').map((s) => (s.length > 20 ? ':id' : s)).join('/');
};

let buffer = '';
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  buffer += line + '\n';
  let e;
  try { e = JSON.parse(buffer); } catch { if (buffer.length > 1_000_000) buffer = ''; return; }
  buffer = '';
  const req = e.event?.request;
  const what = req ? `${req.method} ${template(req.url)}` : e.event?.cron ? 'cron' : '(event)';
  console.log(`${e.outcome ?? '?'}  cpu=${e.cpuTime ?? '?'}ms  wall=${e.wallTime ?? '?'}ms  ${what}`);
});
```

and run, from `worker/`:

```sh
npx wrangler tail --format json | node /path/to/scratch/tail-filter.mjs
```

If the token lacks the tail permission, CPU problems show up instead as Error 1102 failures in the
live smoke. `GET /admin/stats?event=<slug>` returns row counts and the day's usage meter
(requests, rows read, rows written and the current pace).

## Free-plan limits

The Worker is designed to stay inside the Free plan: 100,000 Worker requests and 100,000 Durable
Object requests a day, 10 ms CPU per Worker request, 5,000,000 SQLite rows read and 100,000 rows
written a day, and 10,000 Workers AI neurons a day. Before a cap is reached the service slows down
instead of failing: responses carry `X-Caddie-Pace`, which the web app uses to stretch its polls;
lexical search falls back to an in-memory match near the rows-read cap; nudges stop near the
rows-written cap; and every route answers keyword-only with `degraded` when Workers AI is out of
quota. If a cap is hit anyway, the Worker answers `503 {error:'daily_limit'}` with `Retry-After`
until 00:00 UTC, and the static app and offline schedule keep working.

## Before every commit

Check the staged diff for secret values without printing them, from the repository root:

```sh
SCRATCH="$(mktemp -d)"
git diff --cached > "$SCRATCH/staged.diff"
for v in ELASTISEARCH_API_KEY GC_API_KEY CLOUDFLARE_API_TOKEN; do
  eval "val=\${$v:-}"
  if [ -n "$val" ] && grep -qF -- "$val" "$SCRATCH/staged.diff"; then echo "LEAK: $v"; fi
done
unset val
rm -f "$SCRATCH/staged.diff"; rmdir "$SCRATCH"
```

Add the value of `~/.config/conference-caddie/admin-token` to the same check once it exists, and
make sure nothing under `data/exports/` and no `.dev.vars` file is staged.

## Shutting down the paid stack

Shutting down or deleting any paid resource needs the user's explicit approval, step by step;
no script, workflow or agent does it on its own, and several of the steps are irreversible. That
covers the Cloud Run service and its images, the Secret Manager secrets and service accounts, the
Elasticsearch indices, API keys and deployment, the Google Cloud billing account, and the local
backup in `data/exports/`. Do it only after the free stack has passed the smoke against the live
Worker for at least one full day, and after the Android build's API origin points at the
Worker. The ordered checklist is section 8 of the free-hosting plan, and the morning report of the
free-stack rollout repeats it.
