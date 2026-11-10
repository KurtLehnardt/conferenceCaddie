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
# GitHub import: when the secret caddie-github-token exists (a read-only public-scope token, see
# docs/CONTRACT.md), it is mounted as GITHUB_TOKEN; without it the server calls GitHub
# unauthenticated at 60 requests an hour.
#
# Android companion: BLE_NEAR_RSSI is the Bluetooth "a few metres" threshold of server/ble.mjs,
# applied on the server so it can be tuned at the venue without an app update.
set -euo pipefail

PROJECT="project-9205d6eb-366e-4844-b77"
REGION="us-west1"
SERVICE="conference-caddie"
READ_SECRET="caddie-es-readonly"
PEOPLE_SECRET="caddie-es-people"
VAPID_PRIVATE_SECRET="caddie-vapid-private"
VAPID_PUBLIC_SECRET="caddie-vapid-public"
GITHUB_SECRET="caddie-github-token"
BLE_NEAR_RSSI="${BLE_NEAR_RSSI:--75}"
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
# MOD_CLASSIFIER: auto (on when the metadata server answers), on, or off. Scores at or above
# MOD_REJECT reject, at or above MOD_HOLD hold ("Waiting for the filter"), and any classifier
# error or timeout (MOD_TIMEOUT_MS) holds too. MOD_CATEGORIES (default Toxic, Insult, Profanity,
# Derogatory, Sexual, Violent) holds commas, so set it only with gcloud's "^|^" delimiter syntax.
MOD_CLASSIFIER="auto"
MOD_REJECT="0.8"
MOD_HOLD="0.5"
MOD_TIMEOUT_MS="3000"

cd "$(dirname "$0")/.."

# The runtime identity is always the dedicated caddie-runtime service account. It holds no project-level roles.
RUNTIME_SA="caddie-runtime@$PROJECT.iam.gserviceaccount.com"

ENV_VARS="ES_URL=$ES_URL,ES_INDEX=$ES_INDEX,ES_RULES_INDEX=$ES_RULES_INDEX,MOD_CLASSIFIER=$MOD_CLASSIFIER,MOD_REJECT=$MOD_REJECT,MOD_HOLD=$MOD_HOLD,MOD_TIMEOUT_MS=$MOD_TIMEOUT_MS,BLE_NEAR_RSSI=$BLE_NEAR_RSSI"
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

# The optional GitHub token raises the import's rate limit; the server works without it.
if gcloud secrets describe "$GITHUB_SECRET" --project "$PROJECT" --quiet >/dev/null 2>&1; then
  SECRETS="$SECRETS,GITHUB_TOKEN=$GITHUB_SECRET:latest"
  RUNTIME_SECRETS+=("$GITHUB_SECRET")
else
  echo "No $GITHUB_SECRET secret: the GitHub import runs unauthenticated (60 requests an hour)." >&2
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
