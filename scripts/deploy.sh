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
set -euo pipefail

PROJECT="project-9205d6eb-366e-4844-b77"
REGION="us-west1"
SERVICE="conference-caddie"
READ_SECRET="caddie-es-readonly"
PEOPLE_SECRET="caddie-es-people"
VAPID_PRIVATE_SECRET="caddie-vapid-private"
VAPID_PUBLIC_SECRET="caddie-vapid-public"
VAPID_SUBJECT="${VAPID_SUBJECT:-https://github.com/KurtLehnardt/conferenceCaddie}"
ES_URL="https://fc875c88f9f44f159f1a359ee724d82b.us-west1.gcp.cloud.es.io:443"
ES_INDEX="caddie-talks"

cd "$(dirname "$0")/.."

# The runtime identity is always the dedicated caddie-runtime service account. It holds no project-level roles.
RUNTIME_SA="caddie-runtime@$PROJECT.iam.gserviceaccount.com"

ENV_VARS="ES_URL=$ES_URL,ES_INDEX=$ES_INDEX"
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
