# Conference Caddie API on Cloudflare (the free stack)

This directory holds the free hosting of Conference Caddie: one Cloudflare Worker,
`conference-caddie`, that serves the web app as static assets and the API on the same origin
(`https://conference-caddie.<subdomain>.workers.dev`), with SQLite-backed Durable Objects for all
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
  pair, and `EMBED_FAKE=1`. With `EMBED_FAKE=1` embeddings are deterministic feature-hashed vectors
  and no Workers AI call is made.
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
- Parallel local runs use port 8787 plus a task number, so they do not collide.
- To exercise the Cron Trigger, start with `npx wrangler dev --local --port 8787 --test-scheduled`
  and request `http://localhost:8787/__scheduled?cron=*/10+*+*+*+*`.
- To call the admin routes of a local run, load the development token into the shell without
  echoing it:

  ```sh
  export ADMIN_TOKEN="$(sed -n 's/^ADMIN_TOKEN="\{0,1\}\([^"]*\)"\{0,1\}$/\1/p' worker/.dev.vars)"
  ```

  Then load data with the migration script below, pointing `--api` at `http://localhost:8787`.
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
   Cloudflare API and, when there is none, creates `kurtlehnardt`, or
   `conference-caddie-<6 random letters>` if that name is taken), builds the web app in Worker
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
   The output names secrets only.

3. **Migrate the data** from the Elasticsearch backup (one time).

   ```sh
   export CADDIE_APP_URL=https://conference-caddie.<subdomain>.workers.dev   # the URL deploy.sh printed
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
   skips with a notice while `CADDIE_API_BASE` is empty, and a manual run fails then. The weekly
   talk ingest (`.github/workflows/ingest.yml`) uses `CADDIE_API_BASE` and the
   `CADDIE_ADMIN_TOKEN` repository secret; start it by hand with `gh workflow run ingest.yml`.

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
node scripts/smoke.mjs
```

`BASE_URL` is the app, and the API defaults to the same origin. The admin token makes it a Worker
run (without one, set `SMOKE_API=worker`); the smoke then uses the `/admin/test/*` fixtures, sends
the app's own origin as `Origin` (`SMOKE_ORIGIN` changes it), checks the static files' security
and cache headers (`host1`), and scans `web/dist-worker/` for leaked keys (`SMOKE_DIST` changes
it). For a local run, build the app with `npm --prefix web run build:worker`, start
`npx wrangler dev --local --port 8787` as above, load the data, and use
`BASE_URL=http://localhost:8787`.

The Cloud Run command line is unchanged: `BASE_URL=<Cloud Run URL> node scripts/smoke.mjs`.

## Moderation

Two reports from different people hide a profile, a spot line or a meet. The operator reviews and
undoes or confirms hides with `worker/scripts/moderation.mjs`, which calls
`GET` and `POST /admin/moderation` with the admin token from `ADMIN_TOKEN` or `ADMIN_TOKEN_FILE`
(default `~/.config/conference-caddie/admin-token`):

```sh
export CADDIE_API_BASE=https://conference-caddie.<subdomain>.workers.dev
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
