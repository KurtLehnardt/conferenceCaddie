# Tier 2: the free backend on your own Cloudflare account

Tier 2 is one Cloudflare Worker, `conference-caddie`, that serves the web app as static assets and the API on the same origin, at `https://conference-caddie.<your-subdomain>.workers.dev`. All storage is in SQLite-backed Durable Objects: one `ConferenceDO` per conference and one `DirectoryDO` for the list of conferences. There is no D1 database, no KV and no Vectorize. Embeddings come from Workers AI, and a Cron Trigger every ten minutes purges expired profiles and adds up the day's usage. GitHub Actions pushes the talk schedules to the Worker once a week.

This guide needs a Cloudflare account on the free plan, a GitHub account with your fork, the GitHub CLI (`gh`) signed in, and Node 22 or later. It costs nothing within the Workers Free limits: 100,000 Worker requests a day, 100,000 Durable Object requests a day, 5 million SQLite rows read and 100,000 written a day, and 10,000 Workers AI neurons a day. The sizing assumes about 2,000 attendees on one conference day. [FORK.md](../FORK.md#what-each-thing-costs) has the sources, and `docs/FREE_HOSTING.md` ("Free limits and how the app degrades") explains how the app slows down and degrades before it reaches a limit.

Do [TIER1_PAGES.md](TIER1_PAGES.md) first. The Worker serves the people features, and the talk features still come from the bundles published there.

## Order of steps

1. Create a Cloudflare API token and note your account id.
2. Edit two values in `worker/wrangler.toml`.
3. Deploy the Worker.
4. Install the secrets, including the admin key.
5. Set the repository variables and the secret for the ingest workflow, then load the first conference.
6. Run the smoke test.
7. Install the operator command line ([ADMIN_CLI.md](../ADMIN_CLI.md)).

Run every command from the repository root unless a step says otherwise. Install the packages first, before any key is in your shell: `npm ci` runs the packages' install steps, and you should not run them in an environment that holds a token. `bash worker/scripts/deploy.sh` installs what it needs for the web app and the Worker itself when they are missing.

## 1. The API token and the account id

In the Cloudflare dashboard, create an API token with as little reach as possible:

- Use an account-owned token, or a user token, and under "Account Resources" include only this one account (not "All accounts").
- Give it a time to live (an expiry date a few weeks away). You can make a new one for the next rotation or release.
- Start with the single account permission "Workers Scripts: Edit". That covers the deploy, the secrets, the Cron Trigger and the Durable Objects. `worker/README.md` also lists "Workers AI: Read" and "Account Settings: Read"; `deploy.sh` and `setup-secrets.mjs` do not ask for them as far as this guide could check, so add one only if a step answers 403 and names it. "Workers AI: Read" is used by the local real-embedding proxy (`worker/scripts/dev-ai-proxy.mjs`), and "Workers Tail: Read" only if you want CPU readings from `wrangler tail`.

The account id is shown in the dashboard. Put both in your shell without echoing them and without writing them to a file in the repository, and unset them when you are done:

```sh
read -rs CLOUDFLARE_API_TOKEN && export CLOUDFLARE_API_TOKEN     # paste the token; nothing is shown or stored in history
export CLOUDFLARE_ACCOUNT_ID=<your account id>                   # an identifier, not a secret
```

If the token cannot read or create the account's `workers.dev` subdomain, create it once in the dashboard (Workers & Pages, Overview). A token that can list Workers but answers 403 "No access to the specified resource" on a named script lacks "Workers Scripts: Edit"; `deploy.sh` says so when that happens.

## 2. Edit `worker/wrangler.toml`

Two values in the `[vars]` section name the maintainer's repository and must be yours:

- `VAPID_SUBJECT` is the contact that the push services receive with every Web Push request. It must be an `https:` address or a `mailto:` address that you control.
- `TALKS_BUNDLE_BASE` is where the talk bundles live: your bundle base from tier 1, an https address ending in `/`. Add the line yourself, for example `TALKS_BUNDLE_BASE = "https://<owner>.github.io/<repository>/bundles/"`. When it is not set, the Worker's capabilities document falls back to the maintainer's address (`DEFAULT_BUNDLE_BASE` in `worker/src/capabilities.js`).

Leave `ADMIN_TEST_ROUTES` out of the file. It must never be set in `wrangler.toml` (see [ADMIN_TEST_ROUTES](#admin_test_routes-the-smoke-fixtures)).

## 3. Deploy the Worker

```sh
bash worker/scripts/deploy.sh
```

The script makes sure your account has a `workers.dev` subdomain. If the account has none, it creates the one named by the optional variable `CADDIE_WORKERS_SUBDOMAIN`, or `conference-caddie-<six random letters>` when the variable is unset or the name is taken; an account that already has a subdomain keeps it. It then builds the web app in Worker mode into `web/dist-worker/` and runs `npx wrangler deploy`. It prints the subdomain and the app URL, which is also the API base, and nothing secret. Keep that URL:

```sh
export CADDIE_APP_URL="https://conference-caddie.<your-subdomain>.workers.dev"
export CADDIE_API_BASE="$CADDIE_APP_URL"
export CADDIE_BUNDLE_BASE="https://<owner, lowercased>.github.io/<repository>/bundles/"     # from tier 1; the smoke test and other scripts read it
```

`bash worker/scripts/deploy.sh --subdomain-only` checks only the subdomain step. Until step 4 has run, the admin routes answer 404, because admin fails closed when `ADMIN_TOKEN` is missing.

The Worker is bound to two Durable Object classes, `ConferenceDO` and `DirectoryDO`, created by the migration tag `v1` in `worker/wrangler.toml` (`new_sqlite_classes`). You do not create them yourself. The first deploy creates the classes, and objects appear on first use.

## 4. Install the secrets

```sh
node worker/scripts/setup-secrets.mjs --dry-run         # names and target commands only; changes nothing
node worker/scripts/setup-secrets.mjs --only-missing
```

The script generates each value with Web Crypto and writes it to the standard input of `npx wrangler secret put <NAME>`, never to a command line, a log or the terminal. It sets:

| Secret | What it is |
|---|---|
| `ADMIN_TOKEN` | 32 random bytes as hex. It is the HMAC key that signs every request to the `/admin/*` routes (ingest, moderation, the operator command line, the smoke fixtures). It is never sent over the network. |
| `ADMIN_TOKEN_NEXT` | Exists only during a rotation. A second key that the Worker accepts beside `ADMIN_TOKEN`. |
| `REF_SALT` | 32 random bytes as hex. It salts every person's public ref. Changing it changes every ref, so an existing value is kept unless you pass `--rotate-ref-salt`. |
| `VAPID_PRIVATE_KEY`, `VAPID_PUBLIC_KEY` | The Web Push key pair, always set together. |
| `BLE_MASTER_KEYRING` | The Bluetooth master keyring for derived tokens. The first one is created when the Worker has none and is never replaced by this script. |

`ADMIN_TOKEN` is also stored in two other places, and the output names them. It goes to the repository secret `CADDIE_ADMIN_TOKEN` through the GitHub CLI's secret command (the weekly ingest uses it), and to the file `~/.config/conference-caddie/admin-token` with mode 0600 (the smoke test, the migration scripts and the operator command line read it). The GitHub secret goes to the repository named by `CADDIE_GH_REPO` (`<owner>/<name>`), or, when that variable is unset, to the github.com repository that the git remote `origin` of your clone names (in a clone made by `gh repo fork --clone`, `origin` is your fork); the script prints which one before it changes anything. Set `CADDIE_GH_REPO=<owner>/<repo>` to be sure. `--skip-gh` leaves the GitHub secret alone.

A follow-up worth considering once everything works: the workflow `ingest.yml` reads `CADDIE_ADMIN_TOKEN` as a repository secret, so any workflow on any branch of your fork can read it. Moving it into a GitHub environment that only `main` may deploy to, as [APPS.md](APPS.md) does for signing keys, would narrow that, at the cost of editing the workflow to name the environment. The repository does not do this today.

Never print the token file or put its content in a command line, an issue or a chat.

## 5. Repository variables, the ingest secret and the first conference

The ingest workflow `.github/workflows/ingest.yml` needs the secret `CADDIE_ADMIN_TOKEN` (set by step 4) and one variable:

```sh
gh variable set CADDIE_APP_URL --repo <owner>/<repo> --body "$CADDIE_APP_URL"
gh variable set CADDIE_API_BASE --repo <owner>/<repo> --body "$CADDIE_API_BASE"
gh variable set CADDIE_USER_AGENT --repo <owner>/<repo> --body "my-caddie-ingest (+mailto:you@example.org)"     # your own contact
gh workflow run pages.yml --repo <owner>/<repo>                            # the landing page now links to the app
gh workflow run ingest.yml --repo <owner>/<repo> -f events=<slug>          # load one conference
gh run list --workflow ingest.yml --repo <owner>/<repo>
```

The slug is the conference's name in this repository, for example the name of a folder under `data/`. `node scripts/ingest.mjs --list` lists the upcoming Linux Foundation events. The ingest workflow discovers the schedule on Sessionize with `scripts/ingest.mjs --dry-run` (no Elasticsearch involved), pushes it to the Worker with `worker/ingest/push-ingest.mjs`, and then calls the Pages workflow so the talk bundles follow what the Worker now serves. With an empty `events` input it refreshes every upcoming event; on a schedule it runs every Monday at 09:17 UTC. Until `CADDIE_ADMIN_TOKEN` and `CADDIE_API_BASE` are both set, a scheduled run only logs a notice and succeeds, and a manual run fails and says which one is missing. GitHub switches off scheduled workflows after 60 days without repository activity; running the workflow by hand switches it on again.

You can also push from your own machine, with the token file that step 4 wrote. This is also how you load the data the smoke test needs (next step). Run `node scripts/ingest.mjs --event <slug> --dry-run --skip-topics` first for a conference that is not yet under `data/`, so that its talk files exist:

```sh
ADMIN_TOKEN_FILE=~/.config/conference-caddie/admin-token \
  node worker/ingest/push-ingest.mjs --api "$CADDIE_API_BASE" --event <slug> --dry-run     # counts only, nothing is sent
ADMIN_TOKEN_FILE=~/.config/conference-caddie/admin-token \
  node worker/ingest/push-ingest.mjs --api "$CADDIE_API_BASE" --event <slug>
```

The Worker embeds only talks whose text changed, so a rerun costs almost no writes. If a feed shrinks by more than 10 talks and more than 10 percent, the Worker refuses to delete them (409) so that a short feed cannot erase people's sharing; if the schedule really shrank, rerun with the `allow_shrink` input (`gh workflow run ingest.yml --repo <owner>/<repo> -f events=<slug> -f allow_shrink=true`) or with `--allow-shrink`.

From now on the operator command line can add a conference for you: `caddie-admin conferences add --event <slug>` starts the workflow above. It starts the `ingest.yml` workflow with the GitHub CLI, without `--repo`, so it acts on the repository that `gh` treats as the default, which is why `gh repo set-default <owner>/<repo>` in [TIER1_PAGES.md](TIER1_PAGES.md) matters here too.

## 6. Run the smoke test

The smoke test checks the live Worker against three conferences whose data is committed in this repository (it defaults to `kubecon-cloudnativecon-north-america-2026`, with `mcp-dev-summit-nairobi-2026` and `pytorch-day-japan-2026` as extras), and it needs at least one conference that is listed as not searchable (check `u`). Keep those defaults (`SMOKE_CONFERENCE` and `SMOKE_EXTRA`) and load the committed data into your Worker first. Leave out `--event`, so that every committed conference document is pushed, which includes the unavailable ones; only the searchable conferences' talks are embedded, and that spends neurons from your free daily allowance (if the Worker reports `degraded` on a first run, the cron retries the pending embeddings and a rerun the next day finishes the job):

```sh
export ADMIN_TOKEN_FILE=~/.config/conference-caddie/admin-token
node worker/ingest/push-ingest.mjs --api "$CADDIE_API_BASE" --dry-run      # counts only
node worker/ingest/push-ingest.mjs --api "$CADDIE_API_BASE"
```

The talk checks read your published bundles (tier 1 must have run first, and the three conferences must be in your `conferences.json`). Then run the smoke:

```sh
BASE_URL="$CADDIE_APP_URL" \
SMOKE_BUNDLE_BASE="$CADDIE_BUNDLE_BASE" \
ADMIN_TOKEN_FILE=~/.config/conference-caddie/admin-token \
node scripts/smoke.mjs
```

`BASE_URL` is the app; the API is on the same origin. The admin token makes it a Worker run. Name the token file as shown: the smoke reads the caddie-admin token file by itself only for a deployed Worker that caddie-admin's `config.json` lists ([ADMIN_CLI.md](../ADMIN_CLI.md#the-smoke-test-and-the-token-file)). Its admin calls are signed with version 2, bound to the app's origin ([below](#the-admin-key-and-how-requests-are-signed)); there is no bearer mode. `caddie-admin stats health` prints a smoke command with the token file already named. `SMOKE_BUNDLE_BASE` is your bundle base, which the smoke compares with what your Worker's capabilities document says (check `cap1`) and uses to read the bundles. The smoke tests the people features with test profiles that it creates and deletes itself, checks the static files' security headers, and scans `web/dist-worker/` for leaked keys. A line that starts with FAIL needs attention. On a deployed Worker some checks print SKIP and name `ADMIN_TEST_ROUTES`; that is expected and explained next.

### ADMIN_TEST_ROUTES: the smoke fixtures

Four routes under `/admin/test/` (`POST` and `DELETE /admin/test/profile`, `POST /admin/test/age-presence` and `POST /admin/test/meter-restart`) exist only for the smoke test. They create expired profiles, age presence and restart the usage meter, which nobody should be able to do on a live conference. The Worker serves them only when its variable `ADMIN_TEST_ROUTES` is the string `"1"`. Otherwise they answer 404, even to a correctly signed request, before the conference is looked up. `worker/wrangler.toml` does not set the variable, and a local `wrangler dev` run sets it in `.dev.vars`, so a local run has every check, while against a deployed Worker the smoke prints SKIP for the checks that need a fixture (`meter1`, the expired profile, the aged presence and `unav1`).

To run them against a deployed Worker, deploy once with the variable, run the smoke, and deploy again without it. Every `wrangler deploy` replaces the Worker's variables with those of `wrangler.toml`, so the second deploy switches the routes off again. Wrap the sequence in a `trap`, so that the routes are switched off again even if the smoke is interrupted or fails:

```sh
(
  set -u
  trap 'bash worker/scripts/deploy.sh' EXIT      # always redeploy without the variable, on success, failure or Ctrl-C
  (cd worker && npx wrangler deploy --var ADMIN_TEST_ROUTES:1)
  BASE_URL="$CADDIE_APP_URL" SMOKE_BUNDLE_BASE="$CADDIE_BUNDLE_BASE" ADMIN_TOKEN_FILE=~/.config/conference-caddie/admin-token node scripts/smoke.mjs
)
```

Never set `ADMIN_TEST_ROUTES` with `wrangler secret put`. A secret survives every deploy, so the fixtures would stay on until someone deleted it. Do not run this against a conference that is in use: while the routes are on, anyone who can sign admin requests (which means only you) can create expired profiles and restart the meter. If the trap's redeploy itself fails, run `bash worker/scripts/deploy.sh` again by hand and check that `POST /admin/test/profile` answers 404.

## The admin key and how requests are signed

Every request to an `/admin/*` route carries one header and no other credential:

```
X-Caddie-Admin: v2 <ts> <nonce> <bodySha256> <sig>
```

`ts` is the Unix time in seconds, `nonce` is 16 random bytes as base64url, `bodySha256` is the SHA-256 of the body bytes (the empty-body hash for GET, HEAD and DELETE), and `sig` is an HMAC-SHA256 over the method, the path with its query, the body hash, the time, the nonce and the origin the request is sent to (for example `https://conference-caddie.<your-subdomain>.workers.dev`), keyed with the admin token after trimming. The token itself never travels, and the origin is not in the header: the Worker checks the signature against the origins it serves (the Worker's `ADMIN_ORIGIN` setting when it is set, else the origin of the request), so a signed request that reaches another host, through a typo or a hostile mirror, cannot be replayed to your Worker. The Worker checks the signature and the time, which must be within five minutes of its own clock, before it reads any body, and its Durable Object refuses a nonce it has seen, so a captured header works at most once and only briefly. A wrong or missing signature, or one made for another origin, answers `404`, the same as an unknown path, so a scanner learns nothing. The exact rules are in `worker/README.md`, "Admin requests" and "Signature v2"; a Worker on a custom domain, a zone route or behind a proxy that forwards another `Host` needs `ADMIN_ORIGIN` there. Clients that sign are the ingest scripts, `caddie-admin` and the smoke; they all use the same module, `scripts/lib/admin-sign.mjs`. A client that sends the token as a bearer gets 404, and the smoke has no bearer mode any more.

### Version 1, the temporary rollback

Version 1 (`v1` in the header) is the same HMAC without the origin. The Worker accepts both versions until step d of the migration (DECISIONS.md, "Admin signature v2"), which makes it refuse version 1. Until then, `CADDIE_ADMIN_SIG_VERSION=1` makes `caddie-admin` and the smoke sign version 1 again, for example if a Worker you roll back to does not accept version 2 yet:

```sh
CADDIE_ADMIN_SIG_VERSION=1 caddie-admin stats counts --event <slug>
BASE_URL="$CADDIE_APP_URL" SMOKE_BUNDLE_BASE="$CADDIE_BUNDLE_BASE" ADMIN_TOKEN_FILE=~/.config/conference-caddie/admin-token CADDIE_ADMIN_SIG_VERSION=1 node scripts/smoke.mjs
```

Unset or empty means version 2, and `2` means version 2. Any other value is refused with exit code 2 before anything is sent, never read as a default.

This is the whole admin surface of the Worker. There is no web admin page and no other credential. The CLI is the only intended client.

### Rotating the admin token

Rotate the token when someone who held it leaves, after any suspected leak, and from time to time. The Worker accepts a second key, `ADMIN_TOKEN_NEXT`, beside `ADMIN_TOKEN` during the change, so no client is ever refused. From the repository root, with `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` set and no ingest or smoke run in progress:

```sh
node worker/scripts/setup-secrets.mjs --rotate-admin-token --dry-run   # names only, changes nothing
node worker/scripts/setup-secrets.mjs --rotate-admin-token
```

The script generates a new value and, in this order, puts it as `ADMIN_TOKEN_NEXT` (so the Worker accepts the old and the new token), writes it to `~/.config/conference-caddie/admin-token` with mode 0600, and sets the repository secret `CADDIE_ADMIN_TOKEN`. It prints the two commands that finish the rotation. Run them from `worker/` once any running ingest or smoke has finished, in this order, and only run the second after the first has succeeded:

```sh
cd worker
npx wrangler secret put ADMIN_TOKEN < ~/.config/conference-caddie/admin-token
npx wrangler secret delete ADMIN_TOKEN_NEXT
```

Never print the token file. If a step of the script fails, it says which state that left and what to run; the full recovery recipes, including what to do when the Worker already has an `ADMIN_TOKEN_NEXT` from an earlier rotation (`--replace-next`), are in `worker/README.md`, "Rotating the admin token". Other computers that run the operator command line need the new value in their own token file. Copy the file over a channel you trust, set mode 0600, and do not paste it into a chat.

### If admin calls suddenly answer 404

A failed signature takes one token from a per-address bucket of ten a minute in the Worker, and an empty bucket makes the Worker answer 404 before it computes anything. Valid requests never take from it. The usual cause is a CI runner that sends bad signatures, for example the ingest workflow with a stale `CADDIE_ADMIN_TOKEN` after a rotation. Ten bad signatures within a minute empty the bucket, and then every admin call from that address, valid or not, answers 404 until it refills (one token every six seconds). The symptom is that `push-ingest.mjs` reports 404 on every admin call. A clock that is far off shows up as `401 admin_skew` instead. Either way the fix is the secret or the clock, not the Worker: check that the repository secret `CADDIE_ADMIN_TOKEN` holds the value in your token file, and that the machine's clock is right.

## Optional: Cloudflare Access in front of `/admin/*`

You do not need this. Cloudflare may ask for a payment method before it enables a Zero Trust plan, even the free one, so check before you start. The HMAC check is the control that matters, it is mandatory, and the Worker never validates Access tokens. Access can add an edge layer that stops scanners before the Worker runs, and it also keeps their requests out of your daily request count (this billing behavior is not confirmed). If you use it, read this whole section first, because a mistake takes the public app offline.

**The rule: if Cloudflare Access cannot be scoped to `/admin/*` on your `workers.dev` hostname, do not enable it at all.** The web app, the public API and the admin routes all live on one origin, `conference-caddie.<your-subdomain>.workers.dev`. An Access application that covers the whole hostname, or the Worker-level setting that protects the Worker through Access, would put a login page in front of every attendee and block the public app. Cloudflare's Workers documentation says hostname-based Access can protect a `workers.dev` hostname or a single path on it, which makes a path-scoped application possible. The self-hosted application page, however, still says that domains must belong to an active zone in your account, which conflicts with that for `workers.dev`. Because the documentation disagrees with itself, test it rather than trust it.

If you go ahead:

1. In Cloudflare Zero Trust, create a self-hosted application whose destination is the hostname `conference-caddie.<your-subdomain>.workers.dev` with the path `/admin/*` only. Do not use the one-click setting on the Worker's own settings page, which protects the entire hostname.
2. Add a policy with the action `Service Auth` and a service token. Cloudflare shows the token's client id and secret once.
3. Give the operator command line and the ingest workflow the two values. In your shell for the CLI, set `CF_ACCESS_CLIENT_ID` and `CF_ACCESS_CLIENT_SECRET` (use `read -rs` for the secret). In the repository, set them as the secrets `CF_ACCESS_CLIENT_ID` and `CF_ACCESS_CLIENT_SECRET` with `gh secret set <NAME> --repo <owner>/<repo>`, which `ingest.yml` already passes to `push-ingest.mjs`. The clients send the two headers `CF-Access-Client-Id` and `CF-Access-Client-Secret` only when both values are set, and never log them. The service token secret travels in a header, so a leak of it is as bad as a leak of the old bearer scheme would have been; the HMAC check still holds.
4. **Verify that the public app still works.** Open the app address in a private browser window that is not signed in to Cloudflare, with no cookies. The app must load. Then open `<app address>/api/health`, which must answer normally. **If either one shows a login page, delete the Access application immediately.** Then check again.
5. Check that the admin path is protected: `curl -s -o /dev/null -w '%{http_code}\n' "<app address>/admin/stats"` should not return the Worker's own 404 body any more but an Access response. Run `caddie-admin stats counts --event <slug>` with the two variables set. That is the check that proves the service token lets the CLI through, because it makes a signed admin request; `stats health` reads only the public endpoints, which Access does not cover, so it succeeds whether or not the token works.

If Access cannot be scoped to `/admin/*`, skip it and rely on the signature. Rotating an Access service token has its own grace period of one hour to 30 days (https://developers.cloudflare.com/cloudflare-one/identity/service-tokens/).

## Logs and CPU

The Worker logs one line per request (method, path template, status and duration) and never a body, header value, query text, profile field or token. Never run `wrangler tail` without a filter, because its raw output can show request headers, including device secrets. `worker/README.md`, "Logs and CPU", has a ready filter to save outside the repository. `caddie-admin stats health` prints the exact command for your backend.

## What stays removed

When you remove a conference with the operator command line, the Worker keeps a small tombstone for the slug, and the weekly ingest skips it. A removed conference stays removed on both tiers until you run `caddie-admin conferences unretire`. See [ADMIN_CLI.md](../ADMIN_CLI.md#troubleshooting).

## Rolling back

A Worker from before version 2 of the signature reads only version 1: set `CADDIE_ADMIN_SIG_VERSION=1` for `caddie-admin` and the smoke ([above](#version-1-the-temporary-rollback)) until the Worker is current again. A Worker from before signed admin requests reads only the bearer, and current clients send only the signature, so rolling the Worker back that far also means rolling the clients back; `worker/README.md`, "Admin requests", describes it. The smoke of this version has no bearer mode, so run the smoke from the commit you roll back to. In normal operation you never need this.

## Next

Install the operator command line: [ADMIN_CLI.md](../ADMIN_CLI.md). Build the apps against your Worker: [APPS.md](APPS.md).
