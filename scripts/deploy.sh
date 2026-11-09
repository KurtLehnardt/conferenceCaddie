#!/usr/bin/env bash
# Deploys the real app to Cloud Run from source. Never touches key values:
# both Elasticsearch keys are mounted from Secret Manager by name. The read-only key
# (caddie-es-readonly) becomes ES_API_KEY and the people key (caddie-es-people) becomes
# ES_PEOPLE_API_KEY. scripts/create-es-keys.mjs creates both secrets.
set -euo pipefail

PROJECT="project-9205d6eb-366e-4844-b77"
REGION="us-west1"
SERVICE="conference-caddie"
READ_SECRET="caddie-es-readonly"
PEOPLE_SECRET="caddie-es-people"
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

# The runtime service account may read these two secrets and nothing else in Secret Manager.
for secret in "$READ_SECRET" "$PEOPLE_SECRET"; do
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
  --set-env-vars "ES_URL=$ES_URL,ES_INDEX=$ES_INDEX,ES_RULES_INDEX=$ES_RULES_INDEX,MOD_CLASSIFIER=$MOD_CLASSIFIER,MOD_REJECT=$MOD_REJECT,MOD_HOLD=$MOD_HOLD,MOD_TIMEOUT_MS=$MOD_TIMEOUT_MS" \
  --set-secrets "ES_API_KEY=$READ_SECRET:latest,ES_PEOPLE_API_KEY=$PEOPLE_SECRET:latest" \
  --service-account "$RUNTIME_SA" \
  --quiet

gcloud run services describe "$SERVICE" --region "$REGION" --project "$PROJECT" --format='value(status.url)'
