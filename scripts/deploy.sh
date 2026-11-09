#!/usr/bin/env bash
# Deploys the real app to Cloud Run from source. Never touches key values:
# the Elasticsearch read-only key is mounted from Secret Manager by name.
set -euo pipefail

PROJECT="project-9205d6eb-366e-4844-b77"
REGION="us-west1"
SERVICE="conference-caddie"
SECRET="caddie-es-readonly"
ES_URL="https://fc875c88f9f44f159f1a359ee724d82b.us-west1.gcp.cloud.es.io:443"
ES_INDEX="caddie-talks"

cd "$(dirname "$0")/.."

# Use the dedicated runtime service account when it exists, else the default compute one.
if [ -n "${GC_SERVICE_USER:-}" ] && gcloud iam service-accounts describe "$GC_SERVICE_USER" --project "$PROJECT" >/dev/null 2>&1; then
  RUNTIME_SA="$GC_SERVICE_USER"
  echo "Runtime service account: GC_SERVICE_USER"
else
  RUNTIME_SA="265846417372-compute@developer.gserviceaccount.com"
  echo "Runtime service account: compute default"
fi

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
  --set-secrets "ES_API_KEY=$SECRET:latest" \
  --service-account "$RUNTIME_SA" \
  --quiet

gcloud run services describe "$SERVICE" --region "$REGION" --project "$PROJECT" --format='value(status.url)'
