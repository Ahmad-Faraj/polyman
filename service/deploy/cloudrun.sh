#!/bin/sh
# Deploys the verify service to Cloud Run from CI. Signs in with the job's OIDC
# token through Workload Identity Federation, so no Google key is stored.
#
#   service/deploy/cloudrun.sh candidate   new revision, no traffic, tagged c-<sha>
#   service/deploy/cloudrun.sh promote     all traffic to that revision
#   service/deploy/cloudrun.sh rollback    all traffic back to $PREVIOUS_REVISION
#
# A release is checked twice: the candidate on its own URL before any user
# reaches it, and production again after the switch.
#
# Needs: GCP_PROJECT_ID, GCP_WIF_PROVIDER, GCP_SERVICE_ACCOUNT, GCP_ID_TOKEN,
# and SERVICE_IMAGE (the image built in this pipeline) for candidate.
set -eu
MODE="${1:?usage: cloudrun.sh candidate|promote|rollback}"
. "$(dirname "$0")/cloudrun.conf"

printf '%s' "$GCP_ID_TOKEN" > .gcp-oidc-token
trap 'rm -f .gcp-oidc-token .gcp-creds.json' EXIT
gcloud iam workload-identity-pools create-cred-config "$GCP_WIF_PROVIDER" \
  --service-account="$GCP_SERVICE_ACCOUNT" --credential-source-file=.gcp-oidc-token \
  --output-file=.gcp-creds.json --quiet
gcloud auth login --cred-file=.gcp-creds.json --quiet
gcloud config set project "$GCP_PROJECT_ID" --quiet

AR_IMAGE="$REGION-docker.pkg.dev/$GCP_PROJECT_ID/$REPOSITORY/$SERVICE:$CI_COMMIT_SHORT_SHA"
TAG="c-$CI_COMMIT_SHORT_SHA"

describe() { gcloud run services describe "$SERVICE" --region "$REGION" --format="$1" 2>/dev/null; }

# the revision that serves all traffic now (not just the newest one)
serving() {
  describe json | python3 -c 'import json,sys
for t in json.load(sys.stdin).get("status", {}).get("traffic", []):
    if t.get("percent") == 100 and t.get("revisionName"):
        print(t["revisionName"])'
}

copy_image() {
  # Cloud Run pulls from Artifact Registry, so copy the image this pipeline built
  curl -sSfL "https://github.com/google/go-containerregistry/releases/download/v0.20.2/go-containerregistry_Linux_x86_64.tar.gz" | tar -xz crane
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
  candidate)
    copy_image
    if describe 'value(metadata.name)' >/dev/null; then
      deploy --no-traffic --tag "$TAG"
    else
      # the first deploy creates the service, which can't start with no traffic
      deploy --tag "$TAG"
    fi
    URL=$(describe 'value(status.url)' | sed "s#https://#https://$TAG---#")
    REVISION=$(describe 'value(status.latestCreatedRevisionName)')
    printf 'CANDIDATE_URL=%s\nCANDIDATE_REVISION=%s\n' "$URL" "$REVISION" > deploy.env
    ;;
  promote)
    PREVIOUS=$(serving || true)
    gcloud run services update-traffic "$SERVICE" --region "$REGION" --to-revisions "${CANDIDATE_REVISION:?}=100" --quiet
    printf 'SERVICE_URL=%s\nPREVIOUS_REVISION=%s\n' "$(describe 'value(status.url)')" "$PREVIOUS" > deploy.env
    ;;
  rollback)
    if [ -z "${PREVIOUS_REVISION:-}" ] || [ "$PREVIOUS_REVISION" = "${CANDIDATE_REVISION:-}" ]; then
      echo "nothing to roll back to (first release, or the promote step never ran)"
      exit 0
    fi
    gcloud run services update-traffic "$SERVICE" --region "$REGION" --to-revisions "$PREVIOUS_REVISION=100" --quiet
    ;;
  *) echo "unknown mode $MODE" >&2; exit 2 ;;
esac
