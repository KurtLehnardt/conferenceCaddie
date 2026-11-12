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
# Native push (official deployment only) is off unless this deploy turns it on, one channel at a
# time, from the shell: NATIVE_PUSH_APNS=1 for APNs and NATIVE_PUSH_FCM=1 for FCM. Unset or 0
# deploys that channel off (push.apns or push.fcm false), whatever secrets exist and whatever
# FCM_PROJECT_ID the shell happens to hold; any other value stops the script. Every deploy prints
# one line saying which native channels it turns on and which off, without a secret value.
# APNs (NATIVE_PUSH_APNS=1): the secret caddie-apns-key (the .p8 key file Apple issued) must exist;
# its newest enabled version at deploy time is mounted as the file /secrets/apns/AuthKey.p8, which
# the env var APNS_KEY_FILE names (the key is never an env var), and the newest enabled version of
# caddie-apns-ids ("<key id> <team id>", not secret) is read into the env vars APNS_KEY_ID and
# APNS_TEAM_ID; APNS_BUNDLE_ID comes from the shell (default app.conferencecaddie). Both secrets are
# pinned to the versions read now, like the Bluetooth keyring, so the ids always belong to the
# mounted key: a key version added later reaches the instances only with a deploy that reads its
# ids too. FCM (NATIVE_PUSH_FCM=1) has no key and no secret: the server sends with the runtime
# service account's own token from the metadata server, and FCM_PROJECT_ID (below, or from the
# shell) names the app's Firebase project, in which caddie-runtime holds the role Firebase Cloud
# Messaging API Admin (step 7a of docs/OPERATOR_CHECKLIST.md). A third-party operator never sets
# either switch. This script never reads the APNs key's value.
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

# Deployment settings come from the environment or, for the ones not set there, from an optional
# local file of KEY=VALUE lines (never committed; override the path with CADDIE_DEPLOY_ENV):
#   ${XDG_CONFIG_HOME:-~/.config}/conference-caddie/deploy.env
# Only these keys are read from it, as plain text (the file is not executed; see the parser below):
#   GC_PROJECT          Google Cloud project id (required)
#   GC_REGION           Cloud Run region (default us-west1)
#   ES_URL              the Elasticsearch address, https://<deployment>.es.io:443 (required, no default)
#   FCM_PROJECT_ID      the Firebase project id of the Android app (optional; used only with
#                       NATIVE_PUSH_FCM=1, step 7a of docs/OPERATOR_CHECKLIST.md)
#   CADDIE_BUNDLE_BASE  the published talk bundles' base URL, an https URL ending in "/" (required;
#                       passed to the service as TALKS_BUNDLE_BASE)
if [ -n "${CADDIE_DEPLOY_ENV:-}" ]; then DEPLOY_ENV_FILE="$CADDIE_DEPLOY_ENV"
elif [ -n "${XDG_CONFIG_HOME:-}" ]; then DEPLOY_ENV_FILE="$XDG_CONFIG_HOME/conference-caddie/deploy.env"
elif [ -n "${HOME:-}" ]; then DEPLOY_ENV_FILE="$HOME/.config/conference-caddie/deploy.env"
else DEPLOY_ENV_FILE=""; fi
# What the messages below call the file; HOME may be unset (a bare cron or container shell).
DEPLOY_ENV_LABEL="${DEPLOY_ENV_FILE:-the deploy.env file (HOME is unset: set CADDIE_DEPLOY_ENV to its path)}"
# Lines are KEY=VALUE, optionally with a leading "export " and leading spaces, CRLF line ends, and
# exactly one pair of matching single or double quotes around the value (nothing inside it is
# unquoted or unescaped), and a UTF-8 byte order mark on the first line. A key given twice takes its
# last value, as in a shell. Anything else in the file is ignored; a known key with blanks before
# the "=" is reported, since a shell would not read it either.
BOM="$(printf '\357\273\277')"
if [ -n "$DEPLOY_ENV_FILE" ] && [ -f "$DEPLOY_ENV_FILE" ]; then
  first=1
  # tr drops CR and sed strips leading and trailing blanks and a leading "export ".
  while IFS= read -r line || [ -n "$line" ]; do
    if [ "$first" = 1 ]; then line="${line#$BOM}"; first=0; fi
    line="$(printf '%s' "$line" | tr -d '\r' | sed -e 's/^[[:space:]]*//' -e 's/^export[[:space:]][[:space:]]*//' -e 's/[[:space:]]*$//')"
    case "$line" in
      GC_PROJECT=*|GC_REGION=*|ES_URL=*|CADDIE_BUNDLE_BASE=*|FCM_PROJECT_ID=*)
        key="${line%%=*}"
        value="${line#*=}"
        # One pair of matching quotes around the value.
        value="$(printf '%s' "$value" | sed -e "s/^\"\(.*\)\"$/\1/" -e "s/^'\(.*\)'$/\1/")"
        printf -v "FILE_$key" '%s' "$value"
        ;;
      GC_PROJECT[[:space:]]*=*|GC_REGION[[:space:]]*=*|ES_URL[[:space:]]*=*|CADDIE_BUNDLE_BASE[[:space:]]*=*|FCM_PROJECT_ID[[:space:]]*=*)
        echo "Ignoring the line of ${line%%[[:space:]=]*} in $DEPLOY_ENV_FILE: no blanks are allowed before the =." >&2
        ;;
    esac
  done < "$DEPLOY_ENV_FILE"
fi
# The environment wins over the file. SETTINGS_FROM says which of the two supplied the values.
USED_ENV=0
USED_FILE=0
for key in GC_PROJECT GC_REGION ES_URL CADDIE_BUNDLE_BASE FCM_PROJECT_ID; do
  if [ -n "${!key:-}" ]; then
    USED_ENV=1
  elif file_key="FILE_$key"; [ -n "${!file_key:-}" ]; then
    export "$key=${!file_key}"
    USED_FILE=1
  fi
done
if [ "$USED_ENV" = 1 ] && [ "$USED_FILE" = 1 ]; then SETTINGS_FROM="environment and $DEPLOY_ENV_FILE"
elif [ "$USED_FILE" = 1 ]; then SETTINGS_FROM="$DEPLOY_ENV_FILE"
else SETTINGS_FROM="environment"; fi
: "${GC_PROJECT:?Set GC_PROJECT to your Google Cloud project id (environment or $DEPLOY_ENV_LABEL).}"
: "${ES_URL:?Set ES_URL to your Elasticsearch address, https://<deployment>.es.io:443 (environment or $DEPLOY_ENV_LABEL).}"
: "${CADDIE_BUNDLE_BASE:?Set CADDIE_BUNDLE_BASE to the published talk bundles base URL, an https URL ending in / (environment or $DEPLOY_ENV_LABEL).}"
PROJECT="$GC_PROJECT"
REGION="${GC_REGION:-us-west1}"
TALKS_BUNDLE_BASE="$CADDIE_BUNDLE_BASE"
# A bad value must stop the script here, before any gcloud call, not deploy and fail at run time.
# No comma or = in it: ENV_VARS is a comma-separated list of KEY=VALUE.
BUNDLE_BASE_RE='^https://[^/[:space:]?#@,=]+(/[^[:space:]?#,=]*)?/$'
if ! [[ "$ES_URL" =~ ^https://[A-Za-z0-9.-]+(:[0-9]+)?/?$ ]]; then
  echo "ES_URL must be https://<host>[:port] with no quotes, path or spaces." >&2
  exit 1
fi
ES_URL="${ES_URL%/}"
if ! [[ "$PROJECT" =~ ^[a-z][a-z0-9-]{4,61}[a-z0-9]$ ]]; then
  echo "GC_PROJECT must be a Google Cloud project id." >&2
  exit 1
fi
if ! [[ "$REGION" =~ ^[a-z]+-[a-z]+[0-9]+$ ]]; then
  echo "GC_REGION must be a Google Cloud region such as us-west1." >&2
  exit 1
fi
if ! [[ "$TALKS_BUNDLE_BASE" =~ $BUNDLE_BASE_RE ]] || [ "${#TALKS_BUNDLE_BASE}" -gt 2048 ]; then
  echo "CADDIE_BUNDLE_BASE must be an https URL ending in \"/\" without credentials, query, fragment, comma or =." >&2
  exit 1
fi
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
# Where Cloud Run mounts the APNs key: a file in a directory of its own, so the volume hides nothing
# of the image.
APNS_KEY_PATH="/secrets/apns/AuthKey.p8"
# The switches of the two native push channels: 1 turns the channel on for this deploy, unset or 0
# deploys it off.
NATIVE_PUSH_APNS="${NATIVE_PUSH_APNS:-0}"
NATIVE_PUSH_FCM="${NATIVE_PUSH_FCM:-0}"
# The Firebase project of the Android app (not a secret), from the shell or deploy.env (above) once
# step 7a is done. It is used only with NATIVE_PUSH_FCM=1.
FCM_PROJECT_ID="${FCM_PROJECT_ID:-}"
APNS_BUNDLE_ID="${APNS_BUNDLE_ID:-app.conferencecaddie}"
BLE_MASTER_SECRET="caddie-ble-master"
BLE_NEAR_RSSI="${BLE_NEAR_RSSI:--75}"
PEOPLE_SEMANTIC_MIN_SIMILARITY="${PEOPLE_SEMANTIC_MIN_SIMILARITY:-}"
PEOPLE_SEMANTIC_PROFILE_MIN_SIMILARITY="${PEOPLE_SEMANTIC_PROFILE_MIN_SIMILARITY:-}"
PEOPLE_SEMANTIC_PUSH_MIN_SIMILARITY="${PEOPLE_SEMANTIC_PUSH_MIN_SIMILARITY:-}"
VAPID_SUBJECT="${VAPID_SUBJECT:-https://github.com/KurtLehnardt/conferenceCaddie}"
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

# A mistyped switch must not deploy a channel the operator meant to change.
for switch in NATIVE_PUSH_APNS NATIVE_PUSH_FCM; do
  if ! [[ "${!switch}" =~ ^[01]$ ]]; then
    echo "$switch must be 1 (on) or 0 (off, the default)." >&2
    exit 1
  fi
done

# The newest enabled version of a secret, as a number, read from the versions' metadata only, never
# a payload. Fails when the secret has no enabled version.
newest_enabled_version() {
  local name
  name="$(gcloud secrets versions list "$1" --project "$PROJECT" --filter=state:enabled --sort-by=~createTime --limit=1 --format='value(name)')" || return 1
  name="${name##*/}"
  [[ "$name" =~ ^[0-9]+$ ]] || return 1
  printf '%s' "$name"
}

# The runtime identity is always the dedicated caddie-runtime service account. It holds no
# project-level roles in this project; on the official deployment with FCM it holds Firebase Cloud
# Messaging API Admin on the Firebase project (step 7a of docs/OPERATOR_CHECKLIST.md), nothing else.
RUNTIME_SA="caddie-runtime@$PROJECT.iam.gserviceaccount.com"

echo "Deploying $SERVICE to $PROJECT ($REGION), ES_URL=$ES_URL, bundles=$TALKS_BUNDLE_BASE (from: $SETTINGS_FROM)" >&2

ENV_VARS="ES_URL=$ES_URL,ES_INDEX=$ES_INDEX,ES_RULES_INDEX=$ES_RULES_INDEX,MOD_CLASSIFIER=$MOD_CLASSIFIER,MOD_REJECT=$MOD_REJECT,MOD_HOLD=$MOD_HOLD,MOD_TIMEOUT_MS=$MOD_TIMEOUT_MS,BLE_NEAR_RSSI=$BLE_NEAR_RSSI,PEOPLE_SEMANTIC_MIN_SIMILARITY=$PEOPLE_SEMANTIC_MIN_SIMILARITY,PEOPLE_SEMANTIC_PROFILE_MIN_SIMILARITY=$PEOPLE_SEMANTIC_PROFILE_MIN_SIMILARITY,PEOPLE_SEMANTIC_PUSH_MIN_SIMILARITY=$PEOPLE_SEMANTIC_PUSH_MIN_SIMILARITY,TALKS_BUNDLE_BASE=$TALKS_BUNDLE_BASE"
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

# Native push to the official apps, each channel only when this deploy turns it on. The APNs key is
# mounted by name and version only, as a file in a secret volume rather than an env var; the ids
# are not secret and become plain env vars.
if [ "$NATIVE_PUSH_APNS" = 1 ]; then
  if ! gcloud secrets describe "$APNS_KEY_SECRET" --project "$PROJECT" --quiet >/dev/null 2>&1; then
    echo "NATIVE_PUSH_APNS=1, but there is no $APNS_KEY_SECRET secret; see step 7a of docs/OPERATOR_CHECKLIST.md." >&2
    exit 1
  fi
  if ! APNS_KEY_VERSION="$(newest_enabled_version "$APNS_KEY_SECRET")"; then
    echo "The secret $APNS_KEY_SECRET has no enabled version; see step 7a of docs/OPERATOR_CHECKLIST.md." >&2
    exit 1
  fi
  if ! APNS_IDS_VERSION="$(newest_enabled_version "$APNS_IDS_SECRET")"; then
    echo "The secret $APNS_IDS_SECRET is missing or has no enabled version; see step 7a of docs/OPERATOR_CHECKLIST.md." >&2
    exit 1
  fi
  APNS_IDS="$(gcloud secrets versions access "$APNS_IDS_VERSION" --secret "$APNS_IDS_SECRET" --project "$PROJECT" || true)"
  read -r APNS_KEY_ID APNS_TEAM_ID APNS_EXTRA <<< "$APNS_IDS" || true
  if ! [[ "${APNS_KEY_ID:-}" =~ ^[A-Z0-9]{10}$ && "${APNS_TEAM_ID:-}" =~ ^[A-Z0-9]{10}$ && -z "${APNS_EXTRA:-}" ]]; then
    echo "The secret $APNS_IDS_SECRET must hold \"<key id> <team id>\" (10 characters each); see step 7a of docs/OPERATOR_CHECKLIST.md." >&2
    exit 1
  fi
  if ! [[ "$APNS_BUNDLE_ID" =~ ^[A-Za-z0-9][A-Za-z0-9.-]*$ ]]; then
    echo "APNS_BUNDLE_ID must be a bundle id." >&2
    exit 1
  fi
  ENV_VARS="$ENV_VARS,APNS_KEY_ID=$APNS_KEY_ID,APNS_TEAM_ID=$APNS_TEAM_ID,APNS_BUNDLE_ID=$APNS_BUNDLE_ID,APNS_KEY_FILE=$APNS_KEY_PATH"
  # A key that starts with / is a mount path: gcloud mounts the secret version there as a file.
  SECRETS="$SECRETS,$APNS_KEY_PATH=$APNS_KEY_SECRET:$APNS_KEY_VERSION"
  RUNTIME_SECRETS+=("$APNS_KEY_SECRET")
  APNS_STATE="on ($APNS_KEY_SECRET version $APNS_KEY_VERSION, $APNS_IDS_SECRET version $APNS_IDS_VERSION, bundle id $APNS_BUNDLE_ID)"
else
  APNS_STATE="off (NATIVE_PUSH_APNS is not 1; nothing is mounted)"
fi
# FCM through the runtime service account: only the project id is passed, never a key.
if [ "$NATIVE_PUSH_FCM" = 1 ]; then
  if [ -z "$FCM_PROJECT_ID" ]; then
    echo "NATIVE_PUSH_FCM=1 needs FCM_PROJECT_ID, the Firebase project id; see step 7a of docs/OPERATOR_CHECKLIST.md." >&2
    exit 1
  fi
  if ! [[ "$FCM_PROJECT_ID" =~ ^[a-z][a-z0-9-]{4,28}[a-z0-9]$ ]]; then
    echo "FCM_PROJECT_ID must be a Google Cloud project id; see step 7a of docs/OPERATOR_CHECKLIST.md." >&2
    exit 1
  fi
  ENV_VARS="$ENV_VARS,FCM_PROJECT_ID=$FCM_PROJECT_ID"
  FCM_STATE="on (Firebase project $FCM_PROJECT_ID)"
elif [ -n "$FCM_PROJECT_ID" ]; then
  FCM_STATE="off (NATIVE_PUSH_FCM is not 1; FCM_PROJECT_ID is set and ignored)"
else
  FCM_STATE="off (NATIVE_PUSH_FCM is not 1)"
fi
echo "Native push: APNs $APNS_STATE; FCM $FCM_STATE." >&2

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
  if ! BLE_MASTER_VERSION="$(newest_enabled_version "$BLE_MASTER_SECRET")"; then
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
