# Tier 3: the paid backend on Google Cloud Run and Elastic Cloud

**Tier 3 is a paid option.** It runs a Node service on Google Cloud Run in front of an Elasticsearch deployment on Elastic Cloud. Elastic Cloud has a time-limited trial and then a paid subscription, and it has no free-forever tier (https://www.elastic.co/pricing). The design is tied to Elastic Cloud by the inference endpoint `caddie-e5-small`, which runs the E5 embedding model on the deployment's own machine-learning node, and that node is part of the bill. Google Cloud Run has a free tier, but a Google Cloud project needs a billing account to use it (https://cloud.google.com/run/pricing). If you want the people features at no cost, run [tier 2](TIER2_CLOUDFLARE.md) instead. Choose tier 3 only when you want Elasticsearch ranking, the percolator word rules, the optional text classifier and no daily request ceilings.

This guide is the fork-friendly version of `docs/OPERATOR_CHECKLIST.md`, which stays the exhaustive step list and records the maintainer's own deployment. Use this page to set up your own and the checklist for the detail of each step.

## What you need

- A Google Cloud project with a billing account, the `gcloud` command line signed in to it, and permission to create service accounts, secrets and Cloud Run services.
- An Elastic Cloud deployment (Elasticsearch 9 with a machine-learning node) and an admin API key for it.
- Node 22 or later and a clone of your fork. Finish [tier 1](TIER1_PAGES.md) first, because the service points the apps at your published talk bundles.

## Order of steps

1. Create the Google Cloud project, enable its APIs and create the runtime service account.
2. Create the Elastic deployment, its admin key and the `caddie-e5-small` endpoint.
3. Write `deploy.env` with your own values.
4. Create the indices.
5. Mint the two scoped Elasticsearch keys and the push keys.
6. Deploy to Cloud Run.
7. Load a conference and run the smoke test.
8. Install the operator command line ([ADMIN_CLI.md](../ADMIN_CLI.md)).

## 1. Google Cloud project, APIs and service account

Create a project, link a billing account and sign `gcloud` in. The repository does not script this part, so follow Google's documentation for the exact current commands. In outline:

```sh
export GC_PROJECT=<your project id>
gcloud config set project "$GC_PROJECT"
gcloud services enable run.googleapis.com secretmanager.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com
gcloud iam service-accounts create caddie-runtime --project "$GC_PROJECT"
```

The service runs as the dedicated service account `caddie-runtime@<project>.iam.gserviceaccount.com` (`scripts/deploy.sh`). It holds no project-level roles. `scripts/deploy.sh` grants it access to exactly the secrets it mounts and to nothing else. Do not give it broader roles.

## 2. Elastic deployment, admin key and the inference endpoint

In the Elastic Cloud console, create a deployment with a machine-learning node. The maintainer's deployment runs Elasticsearch 9.5.6 and its ML node has 2 vCPU and about 1.2 GB of ML memory (`DECISIONS.md`, "In-cluster embeddings"); size yours for the E5 small model. Note the Elasticsearch endpoint, which looks like `https://<deployment-id>.<region>.<provider>.cloud.es.io:443`. Then create an API key with enough privileges to create indices, roles, users and inference endpoints. This is the **admin key**. Its encoded value goes in the environment variable `ELASTISEARCH_API_KEY` (the spelling is the project's own). It is used by your terminal only and is never deployed.

```sh
export ES_URL="https://<deployment-id>.<region>.<provider>.cloud.es.io:443"
export ELASTISEARCH_API_KEY=...        # the encoded admin key; do not echo it
```

`ES_URL` has no default anywhere in the repository. A script that needs it stops with "Set ES_URL." and the server does not start without it, so a fork can never send a key to somebody else's cluster.

Create the inference endpoint that every `semantic_text` field uses. The repository has no script for it. `DECISIONS.md`, "In-cluster embeddings: caddie-e5-small", records the maintainer's request: service `elasticsearch`, the built-in multilingual E5 small model (`.multilingual-e5-small_linux-x86_64`, 384 dimensions), one thread per allocation and adaptive allocations from one to four. Check Elastic's documentation for the model id on your deployment's version, and send, with the key kept out of the command line history by the variable:

```sh
curl -sS -X PUT "$ES_URL/_inference/text_embedding/caddie-e5-small" \
  -H "Authorization: ApiKey $ELASTISEARCH_API_KEY" -H 'Content-Type: application/json' \
  -d '{"service":"elasticsearch","service_settings":{"model_id":".multilingual-e5-small_linux-x86_64","num_threads":1,"adaptive_allocations":{"enabled":true,"min_number_of_allocations":1,"max_number_of_allocations":4}}}'
```

A different endpoint name works too: the setup scripts take `--inference-id <id>` or `ES_INFERENCE_ID`. Keeping `caddie-e5-small` avoids that.

## 3. `deploy.env`

`scripts/deploy.sh` reads its settings from the environment or, for the ones that are not set there, from an optional file of `KEY=VALUE` lines at `~/.config/conference-caddie/deploy.env`. The file is never committed and is not executed; only five keys are read from it. `CADDIE_DEPLOY_ENV` changes its path. The environment wins over the file, and the script prints which one it used before it calls `gcloud`. Create it with mode 0600:

```sh
umask 077
mkdir -p ~/.config/conference-caddie
cat > ~/.config/conference-caddie/deploy.env <<'EOT'
GC_PROJECT=<your project id>
GC_REGION=us-west1
ES_URL=https://<deployment-id>.<region>.<provider>.cloud.es.io:443
CADDIE_BUNDLE_BASE=https://<owner>.github.io/<repository>/bundles/
FCM_PROJECT_ID=
EOT
```

| Key | Meaning |
|---|---|
| `GC_PROJECT` | Your Google Cloud project id. Required. |
| `GC_REGION` | The Cloud Run region. Defaults to `us-west1`. |
| `ES_URL` | The Elasticsearch address. Required. The script checks that it is `https://<host>[:port]` with no path. |
| `CADDIE_BUNDLE_BASE` | Where your talk bundles are published: an https address ending in `/`. Required. It is passed to the service as `TALKS_BUNDLE_BASE`. |
| `FCM_PROJECT_ID` | Optional. A Firebase project id, used only when a deploy sets `NATIVE_PUSH_FCM=1`. Leave it empty if you do not send native push. |

`SERVICE` names the Cloud Run service (default `conference-caddie`) and is read from the shell. `SERVICE=conference-caddie-test npm run deploy` deploys a second service beside the first.

## 4. Create the indices

Run these from the repository root. Each script is safe to repeat. They all read `ES_URL` and the admin key:

```sh
npm ci && npm --prefix web ci
ELASTISEARCH_API_KEY="$ELASTISEARCH_API_KEY" npm run es:setup         # talks, conferences, topics
ELASTISEARCH_API_KEY="$ELASTISEARCH_API_KEY" npm run people:setup     # people, presence, meets, blocks
ELASTISEARCH_API_KEY="$ELASTISEARCH_API_KEY" npm run reports:setup    # reports; hidden flags
ELASTISEARCH_API_KEY="$ELASTISEARCH_API_KEY" npm run rules:setup      # percolator index for the word rules
ELASTISEARCH_API_KEY="$ELASTISEARCH_API_KEY" npm run rules:reload     # load config/moderation-words.json
ELASTISEARCH_API_KEY="$ELASTISEARCH_API_KEY" npm run push:setup       # push subscription and nudge indices
```

`docs/OPERATOR_CHECKLIST.md` steps 2 to 6 describe each of them, the variables they read and what to check afterwards. The rules index is optional: without it the server's built-in word list decides.

## 5. The two scoped Elasticsearch keys and the push keys

The deployed service never gets the admin key. `scripts/create-es-keys.mjs` mints two scoped keys through two throw-away native users with exactly the privileges each key needs, stores them in Google Secret Manager as `caddie-es-readonly` and `caddie-es-people`, and checks that each key can do what it should and nothing more. It prints PASS or FAIL for each check and never a key value:

```sh
GC_PROJECT="$GC_PROJECT" ELASTISEARCH_API_KEY="$ELASTISEARCH_API_KEY" node scripts/create-es-keys.mjs
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

## 6. Deploy

```sh
npm run deploy
```

The script validates every setting before any `gcloud` call, mounts the secrets that exist by name (never by value), grants `caddie-runtime` access to those secrets only, sets the environment variables of the service, and runs `gcloud run deploy --source .` with unauthenticated access, because the app is public and its own device secrets protect the people features. It prints one line saying which native push channels it turned on and off. The Cloud Run service URL it prints is your tier 3 address.

After the first deploy, check once that the revision's environment holds no key in plain text: `gcloud run services describe conference-caddie --region "$GC_REGION" --format yaml` shows secrets by name only. Also check that `GET <service url>/api/capabilities` answers the tier you expect.

## 7. Load a conference and run the smoke test

```sh
ELASTISEARCH_API_KEY="$ELASTISEARCH_API_KEY" npm run ingest -- --event <slug>
ELASTISEARCH_API_KEY="$ELASTISEARCH_API_KEY" node scripts/build-facets.mjs <slug>
BASE_URL=<your service URL> CADDIE_SMOKE_CONFERENCE=<slug> CADDIE_BUNDLE_BASE="$CADDIE_BUNDLE_BASE" npm run smoke
```

`npm run ingest -- --list` lists the upcoming Linux Foundation events. The ingest builds the talk files under `data/`, indexes them and builds each conference's topic list; the facets script rebuilds the names used for suggested chips. Commit the new `data/<slug>/` folder so that tier 1 publishes the same bundle. The smoke creates and deletes its own test profiles. It reads `ES_URL` and an Elasticsearch key for the one expired-profile document it writes and removes, so keep those set. `SMOKE_SKIP_BUNDLE=1` skips the bundle scan when you did not build `web/dist` locally.

Once the operator command line is installed, you can do the ingest with `caddie-admin conferences add --event <slug>` on a tier 3 backend entry. It runs `scripts/ingest.mjs` and then `scripts/build-facets.mjs` for you.

## Running it

- After a conference ends: `npm run people:purge` finishes profile deletes that failed part way and deletes expired profiles, presence, meets, push subscriptions, nudge records and blocks (`caddie-admin moderation purge-expired` wraps it), and `caddie-admin moderation purge-reports --event <slug>` deletes the reports.
- Rotating the Bluetooth master: three steps with a deploy after each; see `docs/OPERATOR_CHECKLIST.md`, "Rotating the Bluetooth master".
- Admin access is a key you hold, not a route: the tier 3 server has no admin endpoint at all. The operator command line talks to Elasticsearch directly with your admin key. Keep that key in `ELASTISEARCH_API_KEY` or in `~/.config/conference-caddie/es-admin-key` with mode 0600, as [ADMIN_CLI.md](../ADMIN_CLI.md#install-and-configuration) describes.

## Cost control

Cloud Run bills for the time requests take, and Elastic Cloud bills for the deployment whether or not anyone uses it. When the conference is over, shrink or delete the deployment in the Elastic Cloud console, and delete the Cloud Run service and the secrets you no longer need. Deleting paid resources is irreversible, so look at what is there before you do it.

## Next

Install the operator command line: [ADMIN_CLI.md](../ADMIN_CLI.md). Build the apps against your service: [APPS.md](APPS.md).
