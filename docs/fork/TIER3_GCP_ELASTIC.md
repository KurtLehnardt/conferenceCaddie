# Tier 3: the paid backend on Google Cloud Run and Elastic Cloud

**Tier 3 is a paid option.** It runs a Node service on Google Cloud Run in front of an Elasticsearch deployment on Elastic Cloud. Elastic Cloud has a time-limited trial and then a paid subscription, and it has no free-forever tier (https://www.elastic.co/pricing). The design is tied to Elastic Cloud by the inference endpoint `caddie-e5-small`, which runs the E5 embedding model on the deployment's own machine-learning node, and that node is part of the bill. Google Cloud Run has a free tier, but a Google Cloud project needs a billing account to use it (https://cloud.google.com/run/pricing). If you want the people features at no cost, run [tier 2](TIER2_CLOUDFLARE.md) instead. Choose tier 3 only when you want Elasticsearch ranking, the percolator word rules, the optional text classifier and no daily request ceilings.

This guide is the fork-friendly version of `docs/OPERATOR_CHECKLIST.md`, which stays the exhaustive step list and records the maintainer's own deployment. Use this page to set up your own and the checklist for the detail of each step.

## What you need

- A Google Cloud project with a billing account, the `gcloud` command line signed in to it, and permission to create service accounts, secrets and Cloud Run services.
- An Elastic Cloud deployment (Elasticsearch 9 with a machine-learning node) and an admin API key for it.
- Node 22 or later and a clone of your fork. Finish [tier 1](TIER1_PAGES.md) first, because the service points the apps at your published talk bundles.

## Order of steps

1. Install the packages, then create the Google Cloud project, enable its APIs and create the runtime service account.
2. Create the Elastic deployment, a short-lived setup key and the `caddie-e5-small` endpoint.
3. Write `deploy.env` with your own values.
4. Create the indices.
5. Mint the two scoped service keys and the push keys, then the limited operator key, and invalidate the setup key.
6. Deploy to Cloud Run.
7. Load the conferences and run the smoke test.
8. Install the operator command line ([ADMIN_CLI.md](../ADMIN_CLI.md)).

## 1. Packages, Google Cloud project, APIs and service account

Install the packages first, before any key is in your shell, because `npm ci` runs install steps of third-party packages (`npm ci --ignore-scripts` is an alternative, but the web build may need the scripts). The web app is built by the Cloud Run source deploy, so you do not need `npm --prefix web ci` for tier 3 unless you want to run the web app locally or run the smoke test's bundle scan:

```sh
npm ci
```

Create a project, link a billing account and sign `gcloud` in. The repository does not script this part, so follow Google's documentation for the exact current commands. In outline:

```sh
export GC_PROJECT=<your project id>
export GC_REGION=us-west1            # or the region you chose; deploy.env (step 3) can hold it instead, and the commands below read the shell
gcloud config set project "$GC_PROJECT"
gcloud services enable run.googleapis.com secretmanager.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com iam.googleapis.com
gcloud iam service-accounts create caddie-runtime --project "$GC_PROJECT"
```

The service runs as the dedicated service account `caddie-runtime@<project>.iam.gserviceaccount.com` (`scripts/deploy.sh`). It holds no project-level roles. `scripts/deploy.sh` grants it access to exactly the secrets it mounts and to nothing else. Do not give it broader roles.

Who runs the deploy matters. A project Owner can do everything above. If you deploy as a less privileged user, that user needs, besides the roles to deploy to Cloud Run and to manage secrets, the role Service Account User (`roles/iam.serviceAccountUser`) on `caddie-runtime`, so that Cloud Run may run the service as it. In an organisation with the "secure by default" build policy, the Cloud Build service account used by `gcloud run deploy --source` also needs the role Cloud Run Builder (`roles/run.builder`). If a deploy fails with a permission error, the message names the missing permission.

## 2. Elastic deployment, a short-lived setup key and the inference endpoint

In the Elastic Cloud console, create a deployment with a machine-learning node. The maintainer's deployment runs Elasticsearch 9.5.6 and its ML node has 2 vCPU and about 1.2 GB of ML memory (`DECISIONS.md`, "In-cluster embeddings"); size yours for the E5 small model. Note the Elasticsearch endpoint, which looks like `https://<deployment-id>.<region>.<provider>.cloud.es.io:443`.

You need two kinds of key, and they must not be the same key:

- A **setup key**, used only for the first-time steps 2 to 5 (creating indices, roles, users and the inference endpoint). It needs broad privileges, so make it short-lived: in Kibana (Stack Management, API keys) or with the API, create it with an **expiration of one day** and delete it in step 5 when you are done. Never keep it afterwards.
- An **operator key**, used by the `caddie-admin` command line for every day work. It is limited to the `caddie-*` indices and has no security privileges. Step 5 mints it for you.

The deployed service holds neither: it holds the two scoped service keys of step 5.

Put the setup key in the environment without echoing it or writing it to your shell history, and set the address (not a secret):

```sh
export ES_URL="https://<deployment-id>.<region>.<provider>.cloud.es.io:443"
read -rs ELASTISEARCH_API_KEY && export ELASTISEARCH_API_KEY     # paste the setup key (the encoded value); nothing is shown
```

`ES_URL` has no default anywhere in the repository. A script that needs it stops with "Set ES_URL." and the server does not start without it, so a fork can never send a key to somebody else's cluster. The variable name `ELASTISEARCH_API_KEY` is the project's own spelling.

Create the inference endpoint that every `semantic_text` field uses. The repository has no script for it. `DECISIONS.md`, "In-cluster embeddings: caddie-e5-small", records the maintainer's request: service `elasticsearch`, the built-in multilingual E5 small model (`.multilingual-e5-small_linux-x86_64`, 384 dimensions), one thread per allocation and adaptive allocations from one to four. Check Elastic's documentation for the model id on your deployment's version. Send the request with `curl -K -`, which reads the authorization header from standard input, so the key never appears in the process list or in your shell history:

```sh
printf 'header = "Authorization: ApiKey %s"\n' "$ELASTISEARCH_API_KEY" | \
  curl -sS -K - -X PUT "$ES_URL/_inference/text_embedding/caddie-e5-small" \
  -H 'Content-Type: application/json' \
  -d '{"service":"elasticsearch","service_settings":{"model_id":".multilingual-e5-small_linux-x86_64","num_threads":1,"adaptive_allocations":{"enabled":true,"min_number_of_allocations":1,"max_number_of_allocations":4}}}'
```

A different endpoint name works too: the setup scripts take `--inference-id <id>` or `ES_INFERENCE_ID`. Keeping `caddie-e5-small` avoids that.

## 3. `deploy.env`

`scripts/deploy.sh` reads its settings from the environment or, for the ones that are not set there, from an optional file of `KEY=VALUE` lines at `~/.config/conference-caddie/deploy.env`. The file is never committed and is not executed; only six keys are read from it. `CADDIE_DEPLOY_ENV` changes its path. The environment wins over the file, and the script prints which one it used before it calls `gcloud`. Create it with mode 0600:

```sh
(
  umask 077
  mkdir -m 700 -p ~/.config/conference-caddie
  cat > ~/.config/conference-caddie/deploy.env <<'EOT'
GC_PROJECT=<your project id>
GC_REGION=us-west1
ES_URL=https://<deployment-id>.<region>.<provider>.cloud.es.io:443
CADDIE_BUNDLE_BASE=https://<owner, lowercased>.github.io/<repository>/bundles/
VAPID_SUBJECT=mailto:<an address you read>
FCM_PROJECT_ID=
EOT
)
```

None of these values is a secret, so a plain `cat` is fine here (unlike a key file). The script reads this file itself. Your shell does not, so a command that needs one of these values outside `deploy.sh` (the smoke test in step 7 reads `CADDIE_BUNDLE_BASE`, for example) needs it exported: `export CADDIE_BUNDLE_BASE=...`, or read it from the file with `export CADDIE_BUNDLE_BASE="$(sed -n 's/^CADDIE_BUNDLE_BASE=//p' ~/.config/conference-caddie/deploy.env)"`.

| Key | Meaning |
|---|---|
| `GC_PROJECT` | Your Google Cloud project id. Required. |
| `GC_REGION` | The Cloud Run region. Defaults to `us-west1`. |
| `ES_URL` | The Elasticsearch address. Required. The script checks that it is `https://<host>[:port]` with no path. |
| `CADDIE_BUNDLE_BASE` | Where your talk bundles are published: an https address ending in `/`. Required. It is passed to the service as `TALKS_BUNDLE_BASE`. |
| `VAPID_SUBJECT` | The contact the push services receive with every Web Push request: an https URL or a `mailto:` address that you control. Required, with no default, so that a fork never presents itself under the original project's name. |
| `FCM_PROJECT_ID` | Optional. A Firebase project id, used only when a deploy sets `NATIVE_PUSH_FCM=1`. Leave it empty if you do not send native push. |

`SERVICE` names the Cloud Run service (default `conference-caddie`) and is read from the shell. `SERVICE=conference-caddie-test npm run deploy` deploys a second service beside the first.

## 4. Create the indices

Run these from the repository root with the setup key in `ELASTISEARCH_API_KEY`. Each script is safe to repeat. They all read `ES_URL` and the key:

```sh
ELASTISEARCH_API_KEY="$ELASTISEARCH_API_KEY" npm run es:setup         # talks, conferences, topics
ELASTISEARCH_API_KEY="$ELASTISEARCH_API_KEY" npm run people:setup     # people, presence, meets, blocks
ELASTISEARCH_API_KEY="$ELASTISEARCH_API_KEY" npm run reports:setup    # reports; hidden flags
ELASTISEARCH_API_KEY="$ELASTISEARCH_API_KEY" npm run rules:setup      # percolator index for the word rules
ELASTISEARCH_API_KEY="$ELASTISEARCH_API_KEY" npm run rules:reload     # load config/moderation-words.json
ELASTISEARCH_API_KEY="$ELASTISEARCH_API_KEY" npm run push:setup       # push subscription and nudge indices
```

`docs/OPERATOR_CHECKLIST.md` steps 2 to 6 describe each of them, the variables they read and what to check afterwards. The rules index is optional: without it the server's built-in word list decides.

## 5. The service keys, the push keys, the operator key and ending the setup key

The deployed service never gets a broad key. `scripts/create-es-keys.mjs` mints two scoped keys through two throw-away native users with exactly the privileges each key needs, stores them in Google Secret Manager as `caddie-es-readonly` and `caddie-es-people`, and checks that each key can do what it should and nothing more. It prints PASS or FAIL for each check and never a key value:

```sh
GC_PROJECT="$GC_PROJECT" node scripts/create-es-keys.mjs
```

`--verify-only` checks existing keys, and `--only caddie-es-readonly` or `--only caddie-es-people` re-mints one of them.

Web Push needs a VAPID key pair, once per project. The script writes `vapid-public.key` and `vapid-private.key` to the current directory (both are git-ignored) and prints the `gcloud secrets create` commands and the `rm` that you then run as printed. Skip it to deploy with nudges off:

```sh
GC_PROJECT="$GC_PROJECT" npm run push:vapid-keys
```

Bluetooth derived tokens are optional. The script creates the secret `caddie-ble-master`, writes the key ring through `gcloud`'s standard input and prints no key. Without it the server keeps the legacy mode:

```sh
GC_PROJECT="$GC_PROJECT" node scripts/ble-master.mjs --init
GC_PROJECT="$GC_PROJECT" node scripts/ble-master.mjs --status
```

Native push to iOS and Android (APNs and FCM) is off unless a deploy sets `NATIVE_PUSH_APNS=1` or `NATIVE_PUSH_FCM=1`, and it needs your own Apple and Firebase credentials. See [APPS.md](APPS.md#optional-native-push-from-your-own-backend). Leave both unset to deploy with native push off; `/api/capabilities` then answers `push.apns: false` and `push.fcm: false`.

### The operator key

The command line needs its own key, much narrower than the setup key. This mints it and writes it to `~/.config/conference-caddie/es-admin-key` with mode 0600, without printing it (it refuses to overwrite an existing file):

```sh
node scripts/create-es-keys.mjs --operator                    # expires in 90 days
node scripts/create-es-keys.mjs --operator --expiration 30d   # or choose the lifetime
```

The key is limited to the `caddie-*` indices with the privileges `read`, `write`, `delete`, `maintenance` and `view_index_metadata`, plus the cluster privilege `monitor`. It has no security privilege (it cannot create users, roles or keys), no inference privilege and no index-management privilege, so a leaked operator key cannot take over your cluster. The script then checks that, and prints PASS or FAIL for each check. The privileges are what the CLI uses: documents are read and written, `_delete_by_query` with a refresh needs `delete` and `maintenance`, `stats usage` reads `_cluster/health` and `_cat/indices` (`monitor`), and the word-list reload writes the rules index. Creating indices is a setup step and is done in step 4 with the setup key.

Verify it with the CLI after you have installed it ([ADMIN_CLI.md](../ADMIN_CLI.md)); all of these are read-only or previews:

```sh
caddie-admin stats usage
caddie-admin attendees delete --event <slug> <a ref> --reason spam          # a preview; deletes nothing
caddie-admin conferences remove --event <slug>                              # a preview; deletes nothing
caddie-admin moderation rules reload                                        # a preview; changes nothing
```

If one of them answers 403, the operator key lacks a privilege that command needs; report it as a bug rather than switching to the setup key.

### End the setup key

When steps 2 to 5 are done, delete the setup key. With the Elasticsearch API, using the key's id from Kibana or from `GET /_security/api_key`:

```sh
printf 'header = "Authorization: ApiKey %s"\n' "$ELASTISEARCH_API_KEY" | \
  curl -sS -K - -X DELETE "$ES_URL/_security/api_key" -H 'Content-Type: application/json' \
  -d '{"ids":["<the setup key id>"]}'
unset ELASTISEARCH_API_KEY
```

(Invalidating the key with itself works only if it has the privilege to; otherwise use Kibana's API keys page.) The key would also expire on its own after its one day. For any later setup step (a new index, a key re-mint), make a new short-lived setup key.

## 6. Deploy

```sh
npm run deploy
```

`deploy.sh` needs `GC_PROJECT`, `ES_URL`, `CADDIE_BUNDLE_BASE` and `VAPID_SUBJECT`, from `deploy.env` or the environment, and stops before any `gcloud` call if one is missing or malformed. `VAPID_SUBJECT` has no default: it is the contact the push services receive, so give an address you read.

The script validates every setting before any `gcloud` call, mounts the secrets that exist by name (never by value), grants `caddie-runtime` access to those secrets only, sets the environment variables of the service, and runs `gcloud run deploy --source .` with unauthenticated access, because the app is public and its own device secrets protect the people features. It prints one line saying which native push channels it turned on and off. The Cloud Run service URL it prints is your tier 3 address.

After the first deploy, check once that the revision's environment holds no key in plain text: `gcloud run services describe conference-caddie --project "$GC_PROJECT" --region "$GC_REGION" --format yaml` (`GC_REGION` is the shell variable of step 1, or the value in `deploy.env`; `deploy.sh` defaults to `us-west1`) shows secrets by name only. Also check that `GET <service url>/api/capabilities` answers the tier you expect.

## 7. Load the conferences and run the smoke test

From here on use the operator key, not the setup key (which you ended in step 5). Read it from its file into the environment of one shell, without printing it:

```sh
export ELASTISEARCH_API_KEY="$(cat ~/.config/conference-caddie/es-admin-key)"
export CADDIE_BUNDLE_BASE="$(sed -n 's/^CADDIE_BUNDLE_BASE=//p' ~/.config/conference-caddie/deploy.env)"
```

The smoke test checks the live service against three conferences whose data is committed (its defaults: `kubecon-cloudnativecon-north-america-2026`, `mcp-dev-summit-nairobi-2026` and `pytorch-day-japan-2026`), so ingest those first, and any conference of your own after them. `npm run ingest -- --list` lists the upcoming Linux Foundation events:

```sh
npm run ingest -- --event kubecon-cloudnativecon-north-america-2026 --event mcp-dev-summit-nairobi-2026 --event pytorch-day-japan-2026
node scripts/build-facets.mjs kubecon-cloudnativecon-north-america-2026 mcp-dev-summit-nairobi-2026 pytorch-day-japan-2026
BASE_URL=<your service URL> SMOKE_BUNDLE_BASE="$CADDIE_BUNDLE_BASE" npm run smoke
```

The ingest builds the talk files under `data/`, indexes them and builds each conference's topic list; the facets script rebuilds the names used for suggested chips. Commit any new `data/<slug>/` folder so that tier 1 publishes the same bundle. The smoke creates and deletes its own test profiles. It reads `ES_URL` and the Elasticsearch key for the one expired-profile document it writes and removes, so keep those set. `SMOKE_BUNDLE_BASE` is your bundle base, which the smoke compares with the capabilities document of your service. `SMOKE_SKIP_BUNDLE=1` skips the bundle scan when you did not build `web/dist` locally.

Once the operator command line is installed, you can do the ingest with `caddie-admin conferences add --event <slug>` on a tier 3 backend entry. It runs `scripts/ingest.mjs` and then `scripts/build-facets.mjs` for you.

## Running it

- After a conference ends: `npm run people:purge` finishes profile deletes that failed part way and deletes expired profiles, presence, meets, push subscriptions, nudge records and blocks (`caddie-admin moderation purge-expired` wraps it), and `caddie-admin moderation purge-reports --event <slug>` deletes the reports.
- Rotating the Bluetooth master: three steps with a deploy after each; see `docs/OPERATOR_CHECKLIST.md`, "Rotating the Bluetooth master".
- Admin access is a key you hold, not a route: the tier 3 server has no admin endpoint at all. The operator command line talks to Elasticsearch directly with your operator key. Keep that key in `~/.config/conference-caddie/es-admin-key` with mode 0600 (step 5 wrote it there), or in `ELASTISEARCH_API_KEY` for one shell, as [ADMIN_CLI.md](../ADMIN_CLI.md#install-and-configuration) describes.

## Cost control

Cloud Run bills for the time requests take, and Elastic Cloud bills for the deployment whether or not anyone uses it. When the conference is over, shrink or delete the deployment in the Elastic Cloud console, and delete the Cloud Run service and the secrets you no longer need. Deleting paid resources is irreversible, so look at what is there before you do it.

## Next

Install the operator command line: [ADMIN_CLI.md](../ADMIN_CLI.md). Build the apps against your service: [APPS.md](APPS.md).
