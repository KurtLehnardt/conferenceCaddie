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
   backup holds personal data. It never sends an `unretire` key, whatever the backup holds, and
   it ends with a summary that names every conference it skipped. It exits 0 when everything was
   sent (a conference the Worker holds as removed is skipped by design), 3 when the run finished
   but a conference was skipped because its object answered `400 conference is not available`
   (its data was not all sent; check that the Worker lists it and run the migration again), 2 when
   a request failed and the run stopped, and 1 on a usage error.

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
request idempotently, with three exceptions: on `POST /admin/moderation`, `"action": "delete"`
answers 404 when the target is already gone, and `"action": "unhide"` of a target that no longer
exists answers 404 once its reports are gone; and `POST /admin/people/block` with
`"action": "unblock"` answers 404 once the operator report is gone. Each, when its first answer was
lost, reports 404 on the retry. When both `CF_ACCESS_CLIENT_ID` and `CF_ACCESS_CLIENT_SECRET` are set, `adminClient` and
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

Two reports from different people hide a profile, a spot line or a meet, and one report from the
operator hides a profile or a spot line on its own ([Operator routes](#operator-routes)). The
operator reviews and
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
never printed. `--unhide` also removes the target's reports, the operator's included, so it needs
two new ones to be hidden again; it answers `{"ok": true, "found": <bool>, "removed": <n>}`, and for
a profile that was deleted since (reports outlive it) it still removes the reports, with `found`
false, so a profile made again from the same device is not hidden by them. Only a target with
neither a row nor a report is 404. `--delete profile:<ref>` deletes the profile everywhere, as a
profile delete does. `--purge` deletes the reports of a conference that has ended.

The word list in `config/moderation-words.json` is compiled into the Worker; changing it needs a
deploy.

## Operator routes

These admin routes serve the `caddie-admin` CLI's Worker backend. Each is an admin request like any
other ([Admin requests](#admin-requests)): signed, its nonce recorded by the Durable Object that
serves it before anything runs, and safe to repeat, because a client signs every retry afresh;
applying the same request twice answers success both times and leaves the same stored state, except
where a route below says a retry answers 404. The answers name people by `ref` and display name
only: none carries a `profile_id`, a secret hash, a reporter id, a push endpoint or key, a zone, a
position, a cell or any Bluetooth field. Every stored string they answer with (names, profile
text, a spot line, a link, report reasons, as values or as keys) has its control characters
removed on the way out, also for rows written before people text was stripped on write; the CLI
escapes what it prints as well, which is the layer that protects the terminal. An unknown `ref`
answers `404 {"error":"not_found"}`, and a malformed parameter, an unknown or repeated query
parameter, or an unknown body key answers 400. Nothing here is logged beyond the Worker's usual
line (method, path template, status, duration).

- `GET /admin/people/search?event=<slug>&q64=<text>[&limit=<n>][&include_hidden=0|1]` finds people
  by name. `q64` is the search text as base64url without padding, 1 to 200 bytes of UTF-8 with no
  NUL, because the signer allows no free text in a query string. The text matches anywhere in
  `display_name` (`instr(lower(display_name), lower(text))`), ignoring case for ASCII letters only
  (`É` does not match `é`); every character, `%`, `_` and `\` included, matches itself. Hidden
  profiles are left out unless `include_hidden=1`. The answer is `{"people": [{"ref",
  "display_name", "hidden", "spot_hidden", "open_to_meet", "sample", "visible_until"}], "matched":
  <n>}`, in `display_name` order, at most `limit` rows (default 50, at most 200); `matched` counts
  every match before the limit. With `ref=<ref>` instead of `q64`, the answer holds that one
  person, hidden or not, and an unknown ref is 404; `limit` and `include_hidden` are checked in both
  forms.
- `GET /admin/people/view?event=<slug>&ref=<ref>[&fields=text,contact]` answers `{"person": {...}}`
  with `ref`, `display_name`, `hidden`, `spot_hidden`, `open_to_meet`, `sample`, `visible_until`,
  `updated_at`, `presence` (`"on"` or `"off"`, never where) and `counts`: `shared_talks`; `meets` as
  `requested`, `accepted` (stored as active), `declined`, `ended` (found, which is how a meet that
  worked ends, cancelled, expired, an open meet past its time, and the `accepted` state older
  versions stored) and `other`; `blocks_made` and `blocks_received` that have not run out;
  `push.web` (live Web Push subscriptions, the only channel the Worker stores); and `reports` as
  `total` and `reasons` (reports on the profile, the spot line and the meets the person took part
  in, the operator's included as reason `operator`). `fields=text` adds `about`, `interests`,
  `expertise`, `contact_note`, `spot` (the spot line while the person is around) and `pending` (an
  object of the lines held back for moderation, `{}` when there is none), each cut to 300
  characters; `fields=contact` adds `linkedin_url`.
- `POST /admin/people/block?event=<slug>` with `{"ref": "<ref>", "action": "block"}` files the
  operator's report on the profile (id `profile:<ref>:operator`, reporter and reason `operator`) and
  hides it: `{"ok": true, "hidden": true}`, or 404 `not_found` when no person has the ref. One
  operator report reaches the hide threshold on its own and reports outlive the profile row, so a
  blocked profile stays hidden through the owner's profile writes and when the same device makes it
  again. A new device is a new person. `{"action": "unblock"}` deletes that one report and no other:
  - the person exists: `hidden` becomes what the remaining reports say (two other distinct
    reporters keep the profile hidden), and the answer is `{"ok": true, "hidden": <bool>, "found":
    true, "removed": true}`;
  - the profile was deleted since and its operator report is left: the report is deleted, so a
    profile made again from that device is not hidden by it, and the answer is `{"ok": true,
    "hidden": null, "found": false, "removed": true}`;
  - the person exists without an operator report: `404 {"error":"no_operator_block"}`, nothing
    changes;
  - neither: `404 {"error":"not_found"}`.

  An unblock retried after its first answer was lost therefore answers 404 the second time.
- `POST /admin/moderation?event=<slug>` with `{"action": "hide", "kind": "profile" | "spot", "id":
  "<ref>"}` hides the profile or the spot line (which it also clears) and files the operator's
  report of that kind, so the hide survives in the same way; it answers `{"ok": true}`. `kind`
  `meet` is 400. For `profile` it is the same operator report as a block.
- `DELETE /admin/conference?event=<slug>` removes a conference in three steps, so that no failure
  can let it come back:
  1. The DirectoryDO records the request's nonce (a replayed removal is `401 admin_replay` and
     writes nothing) and writes or refreshes the tombstone `retired(slug, at_ms)`, keeping the
     conference row. From here on `PUT /admin/conferences` skips the slug. In the same
     transaction the removal takes the next number of the directory's order sequence (below),
     which the Worker passes to steps 2 and 3 and never answers.
  2. The conference's object records the nonce in its own table, deletes every row of every table
     except `admin_nonces` (talks, vectors, topics, facets, people and everything that hangs off
     them, reports, the meter's `usage_days`, and `meta` but for `schema_version` and the two order
     numbers), writes the marker `meta.retired_at` and the removal's number as `meta.wipe_seq`, and
     drops its caches, its conference document and its rate-limit buckets. A request that was
     waiting on an await when the wipe ran writes nothing afterwards: it answers `400 conference is
     not available`. When the object already took an unretire with a higher number, it deletes
     nothing (see below).
  3. The DirectoryDO deletes the conference row, but only while a tombstone is there and no
     unretire of the slug took a higher number than the removal's; it never writes a tombstone.

  The order sequence ranks removals and unretires of a conference in the order the directory
  committed them: a counter in the DirectoryDO's `meta` (`order_seq`) that only grows, taken by
  each removal at step 1 and by each unretire for each slug it unretires. When the two overlap,
  the later of them by this number wins everywhere: in the directory, which also keeps each slug's
  latest unretire number (`meta` `unretired_seq:<slug>`) for step 3, and in the object, which
  takes an unretire's document only when its number is above its last wipe's, and refuses a wipe
  whose number is below the last unretire it took. So an unretire and a removal that overlap end
  either removed (tombstone, no row, object wiped and marked) or live (no tombstone, the row, the
  object with its document), never with a live object that no directory row names. A directory or
  an object from before the sequence has none of these rows and reads them as 0.

  The answer is `{"ok": true, "deleted": {"<table>": <rows>}, "directory": 1 | 0, "retired": true,
  "already_retired_at": "<ISO>" | null}`. `directory` is 0 when the directory did not know the
  slug, whose object is tombstoned and wiped all the same. `already_retired_at` is the time of an
  earlier removal of the same slug, so a removal retried after its first answer was lost, whose
  counts are all zero, says it had already happened. A failure of step 1 is answered as it is, and
  nothing changed. A failure of step 2 or 3 answers that step's status (with its `Retry-After`)
  and `{"error": "removal_incomplete", "step": "wipe" | "directory", "retired": true, "wiped":
  <bool>, "cause": "<the step's error>", "deleted": {...} (after the wipe)}`, `cause` first so a
  client that reads the start of a 503 sees `daily_limit`: the tombstone holds, and sending the
  removal again finishes it. If an unretire of the slug ran during the removal, it came later by
  the order sequence and won, and the answer is `409 {"error": "removal_superseded", "step":
  "wipe" | "directory", "retired": <bool> | null, "wiped": <bool>, "deleted": {...}}`: step
  `wipe` when the object had already taken the unretire and refused the wipe (`wiped` false,
  nothing deleted, no `deleted`), step `directory` when the object was wiped first and then took
  the unretire, so step 3 kept the row (`wiped` true, with the counts). Either way the conference
  is live as the unretire left it (its object emptied in the second case) and nothing is left to
  finish. `retired` is whether the directory holds a tombstone for the slug now: false, unless
  another removal of the slug ran since (null when the directory could not say). Decide whether
  to remove it again. The tables stay (no `storage.deleteAll()`), so the
  object can take the conference again. While `retired_at` is set, the object refuses a conference
  document from the fan-out of `PUT /admin/conferences` (`409 conference_retired`) unless that
  fan-out unretired it with a number above the wipe's, so an ingest that read the directory before the removal cannot make the
  object searchable again, and it refuses every admin write with `400 conference is not available`
  (an object without a conference document always does); admin reads still answer. Until the
  Worker's directory cache expires (5 minutes), a public request for the slug reaches the empty
  object and answers `400 conference is not available`; afterwards the Worker answers the same
  from the directory.
- `GET /admin/stats` without `event` is served by the DirectoryDO, which records the nonce: it
  answers `{"day": "<UTC day>" | null, "usage": {"<slug>": {"requests", "rows_read",
  "rows_written"}}, "holds": {"<slug>": true}}` from what the cron stored on its last run (every 10
  minutes): the day's totals of each conference and the conferences whose object still held
  personal data. Totals of another UTC day than the cron's are left out. Any query parameter is
  400, so a misspelt `event` never answers the totals. With `event` the route is the conference's
  own, as before.
- `PUT /admin/conferences` skips a slug that has a tombstone and answers it in `skipped_retired`
  (beside `upserted`, `searchable` and `synced`; the list is empty when nothing was skipped), so the
  weekly ingest cannot bring a removed conference back. When any document of that slug in the
  request carries the top-level key `"unretire": true`, the tombstone is deleted, in the same
  transaction as the upsert and after it, the slug takes the next number of the order sequence,
  and the conference's object is sent the document whatever its status, with that number as the
  flag that lets it drop its `retired_at` marker. That happens whenever the request unretires the
  slug, with or without a tombstone, so on a slug without a tombstone the flag still sends the
  object its document and clears a marker left there (for example by an unretire whose fan-out
  failed). The object refuses the flag when a removal with a higher number already wiped it
  (`409 unretire_superseded` internally): that removal came later and won. When the document of an
  unretired slug does not reach its object or is refused, the answer is `502 {"cause": "<the
  object's error>", "error": "unretire_incomplete", "unretire_failed": ["<slug>"], "upserted",
  "searchable", "synced", "skipped_retired"}`, so the client repeats the request, and the repeat,
  with a new and higher number, repairs the object. When any fan-out of the request hit the
  account's daily limit, the answer is `503` with `"cause": "daily_limit"` first and `Retry-After`
  instead, so `adminClient` stops until the reset. `cause` comes first in either body, and
  `adminClient` names the cause and the slugs of `unretire_failed` in its error. The rest of the
  batch was stored either way. The key is never stored, and it must be a boolean when present (otherwise the
  whole request is 400 and nothing is written). `push-ingest.mjs` never sends it, whatever a
  conference document holds, so no ingest run can unretire. `push-ingest.mjs` and
  `migrate-from-backup.mjs` log each skipped slug by name and send nothing more for it, and
  `push-ingest.mjs` lists it under `skipped_retired` in its `--report`, not under `upserted`.
- `PUT /admin/conferences` takes an optional precondition per document, the top-level key
  `"expect_status"`: the status the operator expects the slug's directory row to have now, as the
  directory stores it (`"searchable"` or `"unavailable"`), or `null` for no row, which is the state
  after a completed removal. The body is `{"conferences": [{...document, "expect_status":
  "searchable" | "unavailable" | null, "unretire"?: true}]}`; the key may be sent with or without
  `"unretire"`, and a document without it is upserted as before. The DirectoryDO checks every
  precondition of the request inside the upsert's transaction, before any write, against the rows
  as stored at that moment. When any document does not match, the whole request answers `409
  {"error": "status_mismatch", "mismatched": [{"slug", "expected", "actual"}]}`, with one entry per
  mismatching document in the order of the request and `actual` `null` when the slug has no row,
  and nothing is written: no row, no tombstone, no number of the order sequence, and no fan-out to
  any object. A value that is neither a non-empty string nor `null` answers `400 {"error":
  "expect_status must be a non-empty string or null"}` and nothing is written, and so does a key
  that differs from `"expect_status"` or `"unretire"` only in letter case or surrounding whitespace
  (`400 {"error": "the key must be written exactly \"expect_status\""}`, or the same with
  `unretire`). A removal that did not finish (`removal_incomplete`) leaves both the tombstone and
  the row, so the slug's actual status is the one the row stores and `null` mismatches. A matching
  precondition does not override the tombstone: a document of a slug with a tombstone and
  without `"unretire": true` whose precondition matches still answers 200 with the slug under
  `skipped_retired`, and nothing of it was applied. The key is never stored or sent to an object.
  `push-ingest.mjs` and `migrate-from-backup.mjs` strip it, as they strip `unretire`, so no ingest
  run or migration ever sends a precondition.

People text is stored without control characters: every write of a display name, profile text, a
contact note, a spot line, a meet note or a how-to-spot-me line drops the C0 controls except tab
and newline, DEL and the C1 controls (U+0080 to U+009F), after turning CRLF and a lone CR into a
newline. Bidirectional marks stay. The line filter sees the text after this, so a control
character can no longer split a listed word. That holds for control characters only: any other
character the filter turns into a space (punctuation, a zero-width space, a line separator) still
splits a word, as before.

To bring a removed conference back, clear its tombstone with a signed `PUT /admin/conferences`
whose document carries `"unretire": true`, then push the conference again. The CLI does both with
`caddie-admin conferences unretire --event <slug>` and then `conferences refresh --event <slug>`
once it has its Worker backend; `unretire` also deletes the slug's `removed` entry in
`data/conference-operator.json`, which otherwise keeps `scripts/ingest.mjs` from fetching it
(delete that entry by hand and commit it if the CLI is not used). Until then, from the repository
root, with `CADDIE_API_BASE` and `ADMIN_TOKEN_FILE` set, this sends the local document with the
flag and prints the counts:

```sh
node --input-type=module -e "
import { readFileSync } from 'node:fs';
import { adminClient, readAdminToken } from './worker/ingest/lib.mjs';
const doc = JSON.parse(readFileSync('data/<slug>/conference.json', 'utf8'));
const admin = adminClient(process.env.CADDIE_API_BASE, readAdminToken());
console.log(await admin('PUT', '/admin/conferences', { conferences: [{ ...doc, unretire: true }] }));
"
gh workflow run ingest.yml -f events=<slug>
```

The tombstone is the `retired` table of the DirectoryDO; nothing else reads or writes it.

Before removing a conference: do it well away from the daily written-rows limit, because a wipe
deletes every row of the conference (several thousand for a large one) and every deleted row is a
written row; do not remove it while an ingest run is pushing it; never unretire a conference
while its removal is running; and if the answer is `removal_incomplete`, send the same removal
again (the CLI re-signs it) until it answers 200. The later of an overlapping removal and unretire
wins, and an automatic retry counts as a new, later request: `adminClient` repeats a removal that
answered a 503 other than `daily_limit` (or a 5xx, or no answer), so a retried removal can undo an
unretire that the operator ran in between, and a repeated unretire can undo a removal. After any
overlap, check the conference's state (`GET /api/conferences` lists it only while the directory
has its row, and a signed `GET /admin/stats?event=<slug>` answers `400 conference is not
available` once it is removed) and run the operation you intended again. Neither check can tell a
live conference from one whose directory row exists while its object is still marked as removed,
which is what an unretire that answered 502 or 503 and was not repeated leaves: both list the
conference and answer the stats. So repeat an unretire until it answers 200.

`expect_status` lets the operator say what they believe the conference's state is before they
change it: `null` when unretiring a conference whose removal finished, and the status its row
stores (`"searchable"` or `"unavailable"`) when changing a listed one or when unretiring one whose
removal did not finish (after `removal_incomplete` the tombstone and the row are both still there).
If someone else changed it in the meantime, the request answers `409 status_mismatch` with the
expected and the actual status of each slug, and nothing happens. Check the conference and send
the request again with the status it has now, or without the key. A 200 that lists the slug under `skipped_retired` was not applied either: the slug has a
tombstone, and only a document with `"unretire": true` brings it back.

A retry can also mismatch, and this is a known effect, not hidden: `adminClient` re-signs and
repeats a request that answered a 5xx or no answer, and when the first attempt was applied (its
answer was lost, or an unretire answered `502 unretire_incomplete` after storing the row), the
repeat finds the row in the state the first attempt set and answers `409 status_mismatch` when
that state is not the one expected (always for an unretire with `null`, whose first attempt stored
the row). `adminClient` then throws an `AdminError` whose `body` is the 409's JSON object and whose message
names each mismatching slug as `slug expected→actual` (`null` for no row; only well-formed slugs
and statuses are named) and every earlier attempt that failed and was retried, which `earlier`
also lists. For an unretire whose first attempt answered `502 unretire_incomplete`, the message
reads (on one line):

```text
PUT /admin/conferences: status 409 (status_mismatch): the directory holds another status
(expected→actual, null for no row): <slug> null→searchable. An earlier attempt answered status 502
(unretire_incomplete, cause unretire_superseded); it may have been applied, so the actual status
can be the one it set; repeat the unretire without expect_status until it answers 200.
```

When an earlier attempt answered a 5xx or no answer, the message says it may have been applied,
and for a request that does not unretire, it says to check the conference and send the request
again with the actual status or without the key. After an `unretire_incomplete` the
object may still be marked as removed: send the unretire again with `expect_status` set to the
actual status the 409 showed, or without the key, until it answers 200. Nothing in the message
comes from the request or a header. The `caddie-admin` CLI does not use `adminClient`; it has its
own client and shows these answers in its own way.

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
(requests, rows read, rows written and the current pace); `GET /admin/stats` without `event`
returns every conference's totals as the cron last stored them.

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
