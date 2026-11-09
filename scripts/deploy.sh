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
  --set-env-vars "ES_URL=$ES_URL,ES_INDEX=$ES_INDEX" \
  --set-secrets "ES_API_KEY=$READ_SECRET:latest,ES_PEOPLE_API_KEY=$PEOPLE_SECRET:latest" \
  --service-account "$RUNTIME_SA" \
  --quiet

gcloud run services describe "$SERVICE" --region "$REGION" --project "$PROJECT" --format='value(status.url)'
