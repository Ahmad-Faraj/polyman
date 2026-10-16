#!/bin/sh
# Deploys the verify service to Cloud Run from CI. Signs in with the job's OIDC
# token through Workload Identity Federation, so no Google key is stored.
#
#   service/deploy/cloudrun.sh review       revision tagged mr-<iid>, no traffic
#   service/deploy/cloudrun.sh production   revision with all traffic
#   service/deploy/cloudrun.sh rollback     all traffic back to $PREVIOUS_REVISION
#
# Needs: GCP_PROJECT_ID, GCP_WIF_PROVIDER, GCP_SERVICE_ACCOUNT, GCP_ID_TOKEN,
# and SERVICE_IMAGE (the image built in this pipeline).
set -eu
MODE="${1:?usage: cloudrun.sh review|production|rollback}"
. "$(dirname "$0")/cloudrun.conf"

printf '%s' "$GCP_ID_TOKEN" > .gcp-oidc-token
trap 'rm -f .gcp-oidc-token .gcp-creds.json' EXIT
gcloud iam workload-identity-pools create-cred-config "$GCP_WIF_PROVIDER" \
  --service-account="$GCP_SERVICE_ACCOUNT" --credential-source-file=.gcp-oidc-token \
  --output-file=.gcp-creds.json --quiet
gcloud auth login --cred-file=.gcp-creds.json --quiet
gcloud config set project "$GCP_PROJECT_ID" --quiet

AR_IMAGE="$REGION-docker.pkg.dev/$GCP_PROJECT_ID/$REPOSITORY/$SERVICE:$CI_COMMIT_SHORT_SHA"

copy_image() {
  # Cloud Run pulls from Artifact Registry, so copy the image this pipeline built
  CRANE=v0.20.2
  curl -sSfL "https://github.com/google/go-containerregistry/releases/download/$CRANE/go-containerregistry_Linux_x86_64.tar.gz" | tar -xz crane
  ./crane auth login "$CI_REGISTRY" -u "$CI_REGISTRY_USER" -p "$CI_REGISTRY_PASSWORD"
  ./crane auth login "$REGION-docker.pkg.dev" -u oauth2accesstoken -p "$(gcloud auth print-access-token)"
  ./crane copy "${SERVICE_IMAGE:?}" "$AR_IMAGE"
}

deploy() {
  gcloud run deploy "$SERVICE" --image "$AR_IMAGE" --region "$REGION" --quiet \
    --service-account "$RUNTIME_SA" \
    --execution-environment "$EXECUTION_ENVIRONMENT" \
    --concurrency "$CONCURRENCY" --cpu "$CPU" --memory "$MEMORY" --timeout "$TIMEOUT" \
    --min-instances "$MIN_INSTANCES" --max-instances "$MAX_INSTANCES" \
    --network "$NETWORK" --subnet "$SUBNET" --vpc-egress all-traffic \
    --allow-unauthenticated \
    --set-env-vars "APP_COMMIT=$CI_COMMIT_SHORT_SHA,PROBLEM_TIMEOUT_MS=$PROBLEM_TIMEOUT_MS" \
    "$@"
}

case "$MODE" in
  review)
    copy_image
    TAG="mr-${CI_MERGE_REQUEST_IID:?}"
    deploy --tag "$TAG" --no-traffic
    # a tagged revision answers at https://TAG---HOST
    URL=$(gcloud run services describe "$SERVICE" --region "$REGION" --format='value(status.url)' | sed "s#https://#https://$TAG---#")
    printf 'SERVICE_URL=%s\n' "$URL" > deploy.env
    ;;
  production)
    PREVIOUS=$(gcloud run services describe "$SERVICE" --region "$REGION" --format='value(status.latestReadyRevisionName)' 2>/dev/null || true)
    copy_image
    deploy
    URL=$(gcloud run services describe "$SERVICE" --region "$REGION" --format='value(status.url)')
    printf 'SERVICE_URL=%s\nPREVIOUS_REVISION=%s\n' "$URL" "$PREVIOUS" > deploy.env
    ;;
  rollback)
    gcloud run services update-traffic "$SERVICE" --region "$REGION" --to-revisions "${PREVIOUS_REVISION:?}=100" --quiet
    ;;
  *) echo "unknown mode $MODE" >&2; exit 2 ;;
esac
