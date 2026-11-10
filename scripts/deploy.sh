#!/usr/bin/env bash
# Deploys the real app to Cloud Run from source. Never touches key values:
# both Elasticsearch keys are mounted from Secret Manager by name. The read-only key
# (caddie-es-readonly) becomes ES_API_KEY and the people key (caddie-es-people) becomes
# ES_PEOPLE_API_KEY. scripts/create-es-keys.mjs creates both secrets.
#
# Web Push nudges: when the secret caddie-vapid-private exists (scripts/vapid-keys.mjs creates
# both VAPID secrets), it is mounted as VAPID_PRIVATE_KEY, the public key is read from
# caddie-vapid-public into the env var VAPID_PUBLIC_KEY (every browser receives it; it is not a
# secret) and VAPID_SUBJECT is set from the shell's VAPID_SUBJECT (a mailto: address) or the
# repository URL. Without the secret the app deploys with nudges off.
#
# Native push (official deployment only): when the secret caddie-apns-key exists (the .p8 key
# file Apple issued), its newest enabled version at deploy time is mounted as APNS_KEY_P8, and the
# key id and team id are read from caddie-apns-ids ("<key id> <team id>", not secret) into the env
# vars APNS_KEY_ID and APNS_TEAM_ID; APNS_BUNDLE_ID comes from the shell (default
# app.conferencecaddie). The key is pinned like the Bluetooth keyring, because the ids are read
# here: a key version added later reaches the instances only with a deploy that reads its ids too.
# When the secret caddie-fcm-service-account exists (the JSON key of a service account of the
# app's Firebase project), it is mounted as FCM_SERVICE_ACCOUNT_JSON; it names its own project, so
# "latest" is safe. Without them the app deploys with push.apns and push.fcm false. A third-party
# operator never creates either secret. This script never reads either key's value.
#
# GitHub import: when the secret caddie-github-token exists (a read-only public-scope token, see
# docs/CONTRACT.md), it is mounted as GITHUB_TOKEN; without it the server calls GitHub
# unauthenticated at 60 requests an hour.
#
# Android companion: BLE_NEAR_RSSI is the Bluetooth "a few metres" threshold of server/ble.mjs,
# applied on the server so it can be tuned at the venue without an app update.
#
# People matching: PEOPLE_SEMANTIC_MIN_SIMILARITY (searches with a query),
# PEOPLE_SEMANTIC_PROFILE_MIN_SIMILARITY (matches without a query, circle members) and
# PEOPLE_SEMANTIC_PUSH_MIN_SIMILARITY (the push nudge, Bluetooth sightings) set the lowest cosine a
# semantic people leg keeps (server/people.mjs, SEMANTIC_FLOORS). Each is passed through from the
# environment of this script; empty means the server's default (0.82, 0.84 and 0.87), and "off"
# turns that floor off.
#
# Bluetooth derived tokens: when the secret caddie-ble-master exists (scripts/ble-master.mjs
# creates and rotates it), its newest enabled version at deploy time is mounted as
# BLE_MASTER_KEYRING and the server advertises ble.mode derived-v1. Without it the server serves
# only the legacy server-minted tokens (server-rotate). The keyring is only ever mounted by name
# and version; this script never reads its value.
#
# The service name comes from the shell's SERVICE (default conference-caddie), so
# SERVICE=conference-caddie-test npm run deploy deploys a second service for testing without
# touching the live one.
set -euo pipefail

PROJECT="project-9205d6eb-366e-4844-b77"
REGION="us-west1"
# The Cloud Run service name; SERVICE=conference-caddie-test npm run deploy deploys a second
# service for testing without touching the live one.
SERVICE="${SERVICE:-conference-caddie}"
READ_SECRET="caddie-es-readonly"
PEOPLE_SECRET="caddie-es-people"
VAPID_PRIVATE_SECRET="caddie-vapid-private"
VAPID_PUBLIC_SECRET="caddie-vapid-public"
GITHUB_SECRET="caddie-github-token"
APNS_KEY_SECRET="caddie-apns-key"
APNS_IDS_SECRET="caddie-apns-ids"
FCM_SECRET="caddie-fcm-service-account"
APNS_BUNDLE_ID="${APNS_BUNDLE_ID:-app.conferencecaddie}"
BLE_MASTER_SECRET="caddie-ble-master"
BLE_NEAR_RSSI="${BLE_NEAR_RSSI:--75}"
PEOPLE_SEMANTIC_MIN_SIMILARITY="${PEOPLE_SEMANTIC_MIN_SIMILARITY:-}"
PEOPLE_SEMANTIC_PROFILE_MIN_SIMILARITY="${PEOPLE_SEMANTIC_PROFILE_MIN_SIMILARITY:-}"
PEOPLE_SEMANTIC_PUSH_MIN_SIMILARITY="${PEOPLE_SEMANTIC_PUSH_MIN_SIMILARITY:-}"
VAPID_SUBJECT="${VAPID_SUBJECT:-https://github.com/KurtLehnardt/conferenceCaddie}"
ES_URL="https://fc875c88f9f44f159f1a359ee724d82b.us-west1.gcp.cloud.es.io:443"
ES_INDEX="caddie-talks"

# Filter (server/moderation.mjs). The rules index is read with the people key, so it stays
# caddie-people-rules*; create it once with `node scripts/es-setup-rules.mjs` and fill it with
# `node scripts/moderation-rules.mjs --reload-rules`. Without it the in-process wordlist decides.
ES_RULES_INDEX="caddie-people-rules"
# The classifier is Google Cloud Natural Language moderateText, called with the runtime service
# account's own token from the metadata server: no key and no secret. Run ONCE per project before
# the first deploy with the classifier:
#   gcloud services enable language.googleapis.com --project "$PROJECT"
# Google's docs define no IAM role or permission for calling the pretrained Natural Language API
# (the moderateText reference lists only the OAuth scopes cloud-language and cloud-platform, and
# the setup guide names roles only for enabling the API and, for a separate quota project,
# roles/serviceusage.serviceUsageConsumer). A service account calling inside its own project
# uses that project for quota, so caddie-runtime needs no role beyond the API being enabled. If
# a call ever fails with PERMISSION_DENIED naming serviceusage.services.use, grant that one
# role to caddie-runtime on this project; nothing else.
# MOD_CLASSIFIER: off (the default, because it needs the billed language.googleapis.com API), auto (on when the metadata server answers), or on. Scores at or above
# MOD_REJECT reject, at or above MOD_HOLD hold ("Waiting for the filter"), and any classifier
# error or timeout (MOD_TIMEOUT_MS) holds too. MOD_CATEGORIES (default Toxic, Insult, Profanity,
# Derogatory, Sexual, Violent) holds commas, so set it only with gcloud's "^|^" delimiter syntax.
MOD_CLASSIFIER="off"
MOD_REJECT="0.8"
MOD_HOLD="0.5"
MOD_TIMEOUT_MS="3000"

cd "$(dirname "$0")/.."

# The runtime identity is always the dedicated caddie-runtime service account. It holds no project-level roles.
RUNTIME_SA="caddie-runtime@$PROJECT.iam.gserviceaccount.com"

ENV_VARS="ES_URL=$ES_URL,ES_INDEX=$ES_INDEX,ES_RULES_INDEX=$ES_RULES_INDEX,MOD_CLASSIFIER=$MOD_CLASSIFIER,MOD_REJECT=$MOD_REJECT,MOD_HOLD=$MOD_HOLD,MOD_TIMEOUT_MS=$MOD_TIMEOUT_MS,BLE_NEAR_RSSI=$BLE_NEAR_RSSI,PEOPLE_SEMANTIC_MIN_SIMILARITY=$PEOPLE_SEMANTIC_MIN_SIMILARITY,PEOPLE_SEMANTIC_PROFILE_MIN_SIMILARITY=$PEOPLE_SEMANTIC_PROFILE_MIN_SIMILARITY,PEOPLE_SEMANTIC_PUSH_MIN_SIMILARITY=$PEOPLE_SEMANTIC_PUSH_MIN_SIMILARITY"
SECRETS="ES_API_KEY=$READ_SECRET:latest,ES_PEOPLE_API_KEY=$PEOPLE_SECRET:latest"
RUNTIME_SECRETS=("$READ_SECRET" "$PEOPLE_SECRET")

# Push nudges need the VAPID pair. The public key is read here and passed as a plain env var;
# the private key is only ever mounted by name.
if gcloud secrets describe "$VAPID_PRIVATE_SECRET" --project "$PROJECT" --quiet >/dev/null 2>&1; then
  VAPID_PUBLIC_KEY="$(gcloud secrets versions access latest --secret "$VAPID_PUBLIC_SECRET" --project "$PROJECT")"
  if [ -z "$VAPID_PUBLIC_KEY" ]; then
    echo "The secret $VAPID_PUBLIC_SECRET is empty or missing; run node scripts/vapid-keys.mjs first." >&2
    exit 1
  fi
  ENV_VARS="$ENV_VARS,VAPID_PUBLIC_KEY=$VAPID_PUBLIC_KEY,VAPID_SUBJECT=$VAPID_SUBJECT"
  SECRETS="$SECRETS,VAPID_PRIVATE_KEY=$VAPID_PRIVATE_SECRET:latest"
  RUNTIME_SECRETS+=("$VAPID_PRIVATE_SECRET")
else
  echo "No $VAPID_PRIVATE_SECRET secret: deploying with push nudges off (node scripts/vapid-keys.mjs creates it)." >&2
fi

# Native push to the official apps. The key is mounted by name and version only; the ids are not
# secret and become plain env vars.
if gcloud secrets describe "$APNS_KEY_SECRET" --project "$PROJECT" --quiet >/dev/null 2>&1; then
  APNS_KEY_VERSION="$(gcloud secrets versions list "$APNS_KEY_SECRET" --project "$PROJECT" --filter=state:enabled --sort-by=~createTime --limit=1 --format='value(name)')"
  APNS_KEY_VERSION="${APNS_KEY_VERSION##*/}"
  if ! [[ "$APNS_KEY_VERSION" =~ ^[0-9]+$ ]]; then
    echo "The secret $APNS_KEY_SECRET has no enabled version; see step 7a of docs/OPERATOR_CHECKLIST.md." >&2
    exit 1
  fi
  APNS_IDS="$(gcloud secrets versions access latest --secret "$APNS_IDS_SECRET" --project "$PROJECT" || true)"
  read -r APNS_KEY_ID APNS_TEAM_ID APNS_EXTRA <<< "$APNS_IDS" || true
  if ! [[ "${APNS_KEY_ID:-}" =~ ^[A-Z0-9]{10}$ && "${APNS_TEAM_ID:-}" =~ ^[A-Z0-9]{10}$ && -z "${APNS_EXTRA:-}" ]]; then
    echo "The secret $APNS_IDS_SECRET must hold \"<key id> <team id>\" (10 characters each); see step 7a of docs/OPERATOR_CHECKLIST.md." >&2
    exit 1
  fi
  if ! [[ "$APNS_BUNDLE_ID" =~ ^[A-Za-z0-9][A-Za-z0-9.-]*$ ]]; then
    echo "APNS_BUNDLE_ID must be a bundle id." >&2
    exit 1
  fi
  ENV_VARS="$ENV_VARS,APNS_KEY_ID=$APNS_KEY_ID,APNS_TEAM_ID=$APNS_TEAM_ID,APNS_BUNDLE_ID=$APNS_BUNDLE_ID"
  SECRETS="$SECRETS,APNS_KEY_P8=$APNS_KEY_SECRET:$APNS_KEY_VERSION"
  RUNTIME_SECRETS+=("$APNS_KEY_SECRET")
else
  echo "No $APNS_KEY_SECRET secret: deploying without APNs push (push.apns false)." >&2
fi
if gcloud secrets describe "$FCM_SECRET" --project "$PROJECT" --quiet >/dev/null 2>&1; then
  SECRETS="$SECRETS,FCM_SERVICE_ACCOUNT_JSON=$FCM_SECRET:latest"
  RUNTIME_SECRETS+=("$FCM_SECRET")
else
  echo "No $FCM_SECRET secret: deploying without FCM push (push.fcm false)." >&2
fi

# The optional GitHub token raises the import's rate limit; the server works without it.
if gcloud secrets describe "$GITHUB_SECRET" --project "$PROJECT" --quiet >/dev/null 2>&1; then
  SECRETS="$SECRETS,GITHUB_TOKEN=$GITHUB_SECRET:latest"
  RUNTIME_SECRETS+=("$GITHUB_SECRET")
else
  echo "No $GITHUB_SECRET secret: the GitHub import runs unauthenticated (60 requests an hour)." >&2
fi

# The Bluetooth master keyring turns on derived tokens; the legacy tokens are served either way.
# It is pinned to the newest enabled version now, not mounted as "latest": Cloud Run resolves
# "latest" whenever an instance starts, so an instance started by autoscaling after a keyring
# change would hold another keyring than its siblings. Pinned, a keyring change reaches the
# instances only with a deploy, which is what the rotation steps of scripts/ble-master.mjs rely
# on (it reads the pinned version back from the service). Only the versions' metadata is read
# here, never a payload.
if gcloud secrets describe "$BLE_MASTER_SECRET" --project "$PROJECT" --quiet >/dev/null 2>&1; then
  BLE_MASTER_VERSION="$(gcloud secrets versions list "$BLE_MASTER_SECRET" --project "$PROJECT" --filter=state:enabled --sort-by=~createTime --limit=1 --format='value(name)')"
  BLE_MASTER_VERSION="${BLE_MASTER_VERSION##*/}"
  if ! [[ "$BLE_MASTER_VERSION" =~ ^[0-9]+$ ]]; then
    echo "The secret $BLE_MASTER_SECRET has no enabled version; run node scripts/ble-master.mjs --init first." >&2
    exit 1
  fi
  SECRETS="$SECRETS,BLE_MASTER_KEYRING=$BLE_MASTER_SECRET:$BLE_MASTER_VERSION"
  RUNTIME_SECRETS+=("$BLE_MASTER_SECRET")
else
  echo "No $BLE_MASTER_SECRET secret: deploying with Bluetooth in the legacy server-rotate mode (node scripts/ble-master.mjs --init creates it)." >&2
fi

# The runtime service account may read these secrets and nothing else in Secret Manager.
for secret in "${RUNTIME_SECRETS[@]}"; do
  gcloud secrets add-iam-policy-binding "$secret" \
    --project "$PROJECT" \
    --member "serviceAccount:$RUNTIME_SA" \
    --role roles/secretmanager.secretAccessor \
    --quiet >/dev/null
done

gcloud run deploy "$SERVICE" \
  --source . \
  --region "$REGION" \
  --project "$PROJECT" \
  --allow-unauthenticated \
  --min-instances 0 \
  --max-instances 2 \
  --concurrency 80 \
  --cpu 1 \
  --memory 512Mi \
  --timeout 30 \
  --set-env-vars "$ENV_VARS" \
  --set-secrets "$SECRETS" \
  --service-account "$RUNTIME_SA" \
  --quiet

gcloud run services describe "$SERVICE" --region "$REGION" --project "$PROJECT" --format='value(status.url)'
